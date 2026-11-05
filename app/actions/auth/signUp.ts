"use server";

import { headers } from "next/headers";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { cadastroExigeEscolhaDePlano, lerPlanosDoCadastro } from "@/lib/cobranca/cadastro";
import {
  signupSchema,
  signupComConviteSchema,
  type SignupInput,
  type SignupComConviteInput,
} from "@/lib/auth/schemas";
import { verifyInviteToken, type InvitePayload } from "@/lib/auth/invite-token";
import { criarContaDeConvite } from "@/lib/auth/convite-no-gotrue";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { motivosDaSenhaRecusada } from "@/lib/auth/senha-recusada";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";

export type SignUpResult =
  | {
      ok: true;
      /**
       * O provedor de auth JÁ abriu a sessão neste `signUp()` — quer dizer,
       * "Confirm email" está DESLIGADO nele e não vai existir link nenhum para
       * clicar. Quem chama precisa saber disto: a tela de "confirme seu e-mail"
       * é uma instrução impossível de cumprir nesse estado, e a pessoa fica
       * esperando para sempre um e-mail que nunca sai — autenticada, sem
       * organização, sem motivo para navegar até a saída que existe.
       *
       * Medido em 2026-09-05 na `origin/main` @ `4d50f63f`, com
       * `GOTRUE_MAILER_AUTOCONFIRM=true`: a tela dizia "Enviamos um link de
       * confirmação para …", e ao mesmo tempo o cookie `sb-deskcomm-auth`
       * estava no browser e `user_organizations` do usuário vinha `[]`.
       *
       * Achado de @KIRAzinx566, com um cliente real travado nessa tela.
       */
      sessao_ativa: boolean;
      /**
       * Só no caminho do CONVITE: a pessoa já é membro da empresa que a
       * convidou — a tela vai direto para o CRM. `false` com sessão aberta =
       * a conta e a sessão existem, mas o aceite não fechou (convite revogado,
       * limite do plano): a tela de aceite explica cada caso.
       */
      convite_aceito?: boolean;
      /**
       * Só no caminho do CONVITE: a conta nasceu, mas a sessão não abriu aqui.
       * A pessoa entra pelo login com a senha que acabou de criar, e o `next`
       * a leva de volta ao aceite. Nunca há e-mail para esperar nesse caminho.
       */
      entrar_pelo_login?: boolean;
    }
  | {
      ok: false;
      /**
       * `somente_convite`: a instalação está em modo `so_convite` e esta
       * tentativa não trouxe convite válido. É recusa de POLÍTICA, não de
       * dado — por isso não vira `validation_error`: a pessoa não tem o que
       * corrigir no formulário.
       *
       * `conta_ja_existe`: só acontece COM convite na mão. Sem convite a
       * resposta continua indistinguível de sucesso — ver o parágrafo de
       * anti-enumeração abaixo. Os dois convivem sem se confundir: a recusa por
       * política é decidida ANTES de tocar no GoTrue, então numa instalação
       * fechada quem chega sem convite nunca chega a saber se o e-mail existe.
       *
       * `email_indisponivel`: o provedor de auth não conseguiu mandar o e-mail
       * de confirmação — é a instalação sem e-mail configurado no serviço de
       * login, não um soluço. Tentar de novo nunca funciona; quem resolve é
       * quem administra.
       *
       * `senha_fraca`: o provedor recusou a SENHA (vazada, curta ou simples
       * demais). `details.motivos` diz qual — ver `lib/auth/senha-recusada.ts`.
       * Separado de `signup_failed` porque "tente novamente" com a mesma senha
       * nunca funciona: foi o que travou os convidados da Souza Rodrigues em
       * 05/11/2026.
       */
      error:
        | "validation_error"
        | "rate_limited"
        | "signup_failed"
        | "somente_convite"
        | "conta_ja_existe"
        | "email_indisponivel"
        | "senha_fraca";
      details?: Record<string, unknown>;
    };

/**
 * Signup self-service: cria o usuário no GoTrue e dispara o e-mail de
 * confirmação. O tenant só é provisionado quando o link é confirmado em
 * /auth/confirm (evita orgs órfãs de cadastros nunca confirmados).
 *
 * Anti-enumeração: e-mail já cadastrado recebe a MESMA resposta de sucesso —
 * o GoTrue devolve um usuário ofuscado (identities vazio) sem erro, e nós não
 * diferenciamos. Rate limit de envio de e-mail é do próprio GoTrue.
 */
export async function signUp(
  input: SignupInput | SignupComConviteInput,
  /**
   * Token de convite, quando a conta está sendo criada para ACEITAR um convite.
   * Ele só vale se a assinatura verificar E o e-mail do token for o do
   * formulário; aí a conta nasce confirmada, a sessão abre e o convite é
   * aplicado aqui mesmo (ver o bloco "CONVITE" abaixo). O token também vai no
   * `user_metadata`, como antes, para quem investiga achar a origem da conta.
   */
  inviteToken?: string,
): Promise<SignUpResult> {
  const temConvite = typeof inviteToken === "string" && inviteToken.trim() !== "";
  const parsed = temConvite
    ? signupComConviteSchema.safeParse(input)
    : signupSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const hdrs = await headers();
  const origin = hdrs.get("origin") ?? env.NEXT_PUBLIC_APP_URL;
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  // Criar conta é fluxo raro por pessoa: teto baixo por IP evita fábrica de
  // organizações (cada signup provisiona tenant). Issue #64.
  if (await authRateLimited("signup", null, AUTH_LIMITS.signup)) {
    return { ok: false, error: "rate_limited" };
  }

  // Só vira convite se o token verificar E for para este e-mail. Divergência
  // aqui não é erro do usuário — é tentativa de entrar em organização alheia
  // colando um token que chegou para outra pessoa.
  let convite: string | null = null;
  let payloadDoConvite: InvitePayload | null = null;
  if (temConvite && inviteToken) {
    const payload = verifyInviteToken(inviteToken);
    if (!payload) {
      return { ok: false, error: "validation_error", details: { invite: ["convite_invalido"] } };
    }
    if (payload.email.trim().toLowerCase() !== parsed.data.email.trim().toLowerCase()) {
      return { ok: false, error: "validation_error", details: { invite: ["email_divergente"] } };
    }
    convite = inviteToken;
    payloadDoConvite = payload;
  }

  // ── A AUTORIDADE da política de cadastro ──────────────────────────────────
  // A tela também recusa, mas a tela é adulterável: esta action é chamável
  // direto, e sem esta guarda o modo `so_convite` seria decoração. A ordem
  // importa — só se pergunta a política DEPOIS de o convite ter sido validado
  // acima, senão um convite legítimo seria barrado.
  if (convite === null && (await modoDeCadastro()) === "so_convite") {
    await audit({
      action: "auth.signup_failed",
      metadata: { email_hash: hashEmail(parsed.data.email), reason: "somente_convite" },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "somente_convite" };
  }

  const planoEscolhido = !convite && "cobranca_plan_id" in parsed.data ? parsed.data.cobranca_plan_id : undefined;
  if (!convite) {
    const admin = createAdminClient();
    if (await moduloLigado(admin, "cobranca")) {
      // Recusa ANTES de criar a conta no GoTrue o que o gatilho da 0679 recusaria
      // depois — senão o usuário ficaria órfão, sem organização. Leitura dos
      // PLANOS que falha recusa: é ação, não informação. A da CHAVE do módulo, não:
      // `moduloLigado` trata a falha como "desligado", e aí a conta nasce e quem
      // decide é o gatilho; se ele recusar, a saída é /get-started, que pede o plano.
      const planos = await lerPlanosDoCadastro(admin);
      if (planoEscolhido) {
        if (!planos?.oferecidos.some((p) => p.id === planoEscolhido)) {
          return { ok: false, error: "validation_error", details: { cobranca_plan_id: ["plano_indisponivel"] } };
        }
      } else if (!planos || cadastroExigeEscolhaDePlano(planos)) {
        return { ok: false, error: "validation_error", details: { cobranca_plan_id: ["plano_obrigatorio"] } };
      }
    }
  }

  // ── CONVITE: a conta nasce pronta e a pessoa entra no mesmo passo ─────────
  //
  // Decisão de 05/11/2026 — o porquê inteiro está no cabeçalho de
  // `lib/auth/convite-no-gotrue.ts`. O link do convite, assinado e enviado ao
  // endereço convidado, já é a prova de caixa postal; o segundo e-mail (de
  // confirmação) não provava mais nada e custava convidados de verdade.
  //
  // Então: a conta nasce CONFIRMADA pela admin API (que também não depende do
  // cadastro público do GoTrue — issue #1653), a sessão abre aqui com a senha
  // que a pessoa acabou de escolher, e o convite é aplicado. Da tela do convite
  // à tela do CRM, um formulário.
  //
  // A ordem em relação à trava de política acima continua a mesma: sem convite
  // válido não se chega aqui.
  if (convite !== null && payloadDoConvite !== null) {
    const criada = await criarContaDeConvite({
      email: parsed.data.email,
      password: parsed.data.password,
      inviteToken: convite,
      fullName: (parsed.data as SignupComConviteInput).full_name,
    });

    if (!criada.ok) {
      await audit({
        action: "auth.signup_failed",
        metadata: {
          email_hash: hashEmail(parsed.data.email),
          // `conta_ja_existe_com_convite` já é o vocabulário de quem chega
          // com convite na mão — a trilha continua legível sem mapa novo.
          reason: criada.motivo === "conta_ja_existe" ? "conta_ja_existe_com_convite" : criada.motivo,
          detalhe: criada.detalhe ?? null,
          via: "convite_direto",
        },
        requestId,
        ip,
        userAgent,
      });
      if (criada.motivo === "conta_ja_existe") return { ok: false, error: "conta_ja_existe" };
      if (criada.motivo === "rate_limited") return { ok: false, error: "rate_limited" };
      if (criada.motivo === "senha_fraca") {
        return { ok: false, error: "senha_fraca", details: { motivos: criada.motivosDaSenha ?? [] } };
      }
      return { ok: false, error: "signup_failed" };
    }

    await audit({
      action: "auth.signup_requested",
      actorUserId: criada.userId,
      metadata: { email_hash: hashEmail(parsed.data.email), via: "convite_direto" },
      requestId,
      ip,
      userAgent,
    });

    // A sessão, com a senha que a pessoa digitou neste mesmo formulário — o
    // mesmo `signInWithPassword` da tela de login, pelo client de servidor que
    // grava os cookies.
    const supabase = await createClient();
    const { data: entrada, error: erroDeEntrada } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    if (erroDeEntrada || !entrada?.session) {
      // A conta existe e está confirmada; só a sessão não abriu aqui. Não há
      // e-mail para esperar: a saída é entrar com a senha recém-criada.
      return { ok: true, sessao_ativa: false, entrar_pelo_login: true };
    }

    // O vínculo com a empresa. Revogação, limite do plano e replay são
    // tratados dentro de `aplicarConvite`, igual ao botão "Aceitar convite" e
    // ao `/auth/confirm`.
    const aceite = await aplicarConvite({
      userId: criada.userId,
      payload: payloadDoConvite,
      requestId,
    });
    return { ok: true, sessao_ativa: true, convite_aceito: aceite.ok };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Ver comentário equivalente em requestPasswordReset.ts: ?type=signup
      // sobrevive ao redirect do GoTrue e é o que distingue este fluxo do de
      // recovery quando a verificação chega via `code` (PKCE), não `token_hash`.
      emailRedirectTo: `${origin}/auth/confirm?type=signup`,
      // Daqui para baixo é só quem ABRE empresa: o convite saiu no bloco
      // "CONVITE" acima, com a conta pronta e sem e-mail de confirmação.
      data: { org_name: (parsed.data as SignupInput).org_name, ...(planoEscolhido ? { cobranca_plan_id: planoEscolhido } : {}) },
    },
  });

  if (error) {
    if (error.status === 429) return { ok: false, error: "rate_limited" };

    // Senha recusada pelo provedor: dizer POR QUÊ. "Tente novamente" com a
    // mesma senha nunca funciona. Não fura a anti-enumeração — o motivo é da
    // senha digitada, não do e-mail.
    const motivosDaSenha = motivosDaSenhaRecusada(error);
    if (motivosDaSenha) {
      await audit({
        action: "auth.signup_failed",
        metadata: { email_hash: hashEmail(parsed.data.email), reason: "senha_fraca" },
        requestId,
        ip,
        userAgent,
      });
      return { ok: false, error: "senha_fraca", details: { motivos: motivosDaSenha } };
    }

    // Quem já tem conta e chega COM convite não passa mais por aqui: o bloco
    // "CONVITE" acima devolve `conta_ja_existe` e a tela leva ao login com o
    // convite pendurado (achado de 2026-09-10, preservado lá). Sem convite, a
    // resposta segue indistinguível — é a anti-enumeração do cabeçalho.
    await audit({
      action: "auth.signup_failed",
      metadata: {
        email_hash: hashEmail(parsed.data.email),
        reason: error.message,
      },
      requestId,
      ip,
      userAgent,
    });
    // Medido numa VPS v1.85.0: GoTrue sem SMTP devolve 500 "Error sending
    // confirmation email", e a tela mandava "Tente novamente" — seis vezes na
    // trilha, nenhuma podia dar certo. Não fura a anti-enumeração: conta que já
    // existe recebe sucesso ofuscado sem e-mail, então nunca chega aqui.
    if (/error sending/i.test(error.message)) return { ok: false, error: "email_indisponivel" };
    return { ok: false, error: "signup_failed" };
  }

  await audit({
    action: "auth.signup_requested",
    actorUserId: data.user?.id ?? null,
    metadata: { email_hash: hashEmail(parsed.data.email) },
    requestId,
    ip,
    userAgent,
  });

  // `data.session` é o único sinal confiável de que o provedor não vai mandar
  // e-mail nenhum: ele vem preenchido exatamente quando a confirmação está
  // desligada (ou já resolvida) e o GoTrue devolveu tokens junto do usuário.
  return { ok: true, sessao_ativa: data.session !== null };
}

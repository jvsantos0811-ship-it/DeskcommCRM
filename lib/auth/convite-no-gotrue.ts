/**
 * A conta de quem foi CONVIDADO — criada pela admin API, já confirmada.
 *
 * ─── A decisão de 05/11/2026: o convite É a prova de caixa postal ──────────
 *
 * Até aqui, quem chegava pelo convite passava por DOIS e-mails: o do convite e,
 * depois de criar a senha, um segundo, de confirmação, para provar que o
 * endereço era dela. Medido em produção (Souza Rodrigues Advogados, 05/11): três
 * convidados, nenhum entrou. Entre o convite, a senha recusada sem motivo e o
 * segundo e-mail, o primeiro acesso tinha cinco passos — e cada passo perdia
 * gente.
 *
 * O segundo e-mail não provava nada que o primeiro já não provasse. O link do
 * convite carrega um token ASSINADO (HMAC), amarrado a UM endereço, e só chega
 * por e-mail àquele endereço. A confirmação ia para a MESMA caixa. É a mesma
 * régua que o próprio Supabase usa no `inviteUserByEmail`: abrir o link do
 * convite é a prova.
 *
 * O risco que o desenho antigo cobria — alguém que recebeu o link REENCAMINHADO
 * criar a conta daquele e-mail — é o mesmo de reencaminhar o e-mail de
 * confirmação, ou a própria senha: quem reencaminha está dando o acesso. O
 * convite continua com prazo, continua revogável na tela de Equipe (a revogação
 * é conferida no aceite, em `aplicarConvite`), e o token continua valendo para
 * um e-mail só.
 *
 * Por isso a conta nasce CONFIRMADA (`email_confirm: true`), quem chama abre a
 * sessão com a senha que a pessoa acabou de escolher e aplica o convite no
 * mesmo passo. Do link à tela do CRM: um formulário.
 *
 * ─── Por que admin API sempre, e não só com o cadastro público fechado ──────
 *
 * Até 05/11 este caminho só era usado com `disable_signup` ligado no GoTrue
 * (issue #1653), e o convite de instalação aberta seguia pelo
 * `supabase.auth.signUp()`, que obriga a confirmar o e-mail. Duas portas para o
 * mesmo convite davam duas experiências. Agora é uma: a admin API não depende
 * do cadastro público e cria a conta já confirmada.
 *
 * ─── Sobre usar o client admin num fluxo de usuário final ───────────────────
 *
 * O cabeçalho de `lib/supabase/admin.ts` proíbe o admin client "em fluxo normal"
 * por um motivo de ESCOPO: service_role bypassa RLS, então quem o usa tem de
 * resolver `organization_id` por conta própria. Aqui ele não lê nem escreve
 * dado de tenant nenhum — cria UMA conta de auth com o e-mail que o convite
 * ASSINADO já autorizou, e devolve. É o mesmo uso que `lib/auth/provision.ts`
 * faz (`auth.admin.createUser`).
 *
 * `lerConfigPublicaDoGoTrue` continua aqui porque o aviso da troca de modo de
 * cadastro (`lib/auth/aviso-da-troca-de-modo.ts`) lê a mesma configuração.
 */
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { motivosDaSenhaRecusada, type MotivoDaSenhaRecusada } from "@/lib/auth/senha-recusada";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";

/** O que o GoTrue conta de si no endpoint público de settings. */
export type ConfigPublicaDoGoTrue = {
  /** `true` = `POST /auth/v1/signup` recusa cadastro novo (inclusive por OAuth). */
  disable_signup: boolean;
};

/**
 * `GET /auth/v1/settings` — anon key, mesmo caminho que o navegador usa.
 *
 * NUNCA LANÇA e devolve `null` quando não deu para perguntar: "não sei" não
 * pode virar "cadastro aberto" (aí sairíamos pelo caminho errado) nem
 * "cadastro fechado" (aí quebraríamos o convite numa instalação que está
 * aberta). Quem chama trata `null` como "segue o de sempre".
 */
export async function lerConfigPublicaDoGoTrue(): Promise<ConfigPublicaDoGoTrue | null> {
  try {
    // Sem a barra final: `https://x/` + `/auth/v1/settings` vira `//auth`, o
    // gateway responde 404, e o `null` mandaria o convite para o caminho que o
    // GoTrue fechado recusa.
    // #1082: pelo mesmo resolvedor dos clients — vazia, vale a pública.
    const base = urlDoSupabaseNoServidor(
      env.SUPABASE_SERVER_URL,
      env.NEXT_PUBLIC_SUPABASE_URL,
    ).replace(/\/+$/, "");
    const resposta = await fetch(`${base}/auth/v1/settings`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: "no-store",
    });
    if (!resposta.ok) return null;
    const corpo = (await resposta.json()) as { disable_signup?: unknown };
    return typeof corpo.disable_signup === "boolean" ? { disable_signup: corpo.disable_signup } : null;
  } catch {
    return null;
  }
}

export type ResultadoDaContaDeConvite =
  | { ok: true; userId: string }
  | {
      ok: false;
      /**
       * `conta_ja_existe`: já havia conta para este e-mail (só acontece com
       * convite na mão, então não fura a anti-enumeração — o comentário disso
       * está em `signUp.ts`). `senha_fraca`: o provedor recusou a senha, e
       * `motivosDaSenha` diz por quê. Os outros dois são infraestrutura.
       */
      motivo: "conta_ja_existe" | "rate_limited" | "senha_fraca" | "criacao_recusada";
      motivosDaSenha?: MotivoDaSenhaRecusada[];
      detalhe?: string;
    };

/**
 * Cria a conta do convidado pela admin API, já com o e-mail confirmado (ver o
 * cabeçalho: o link do convite é a prova de caixa postal).
 *
 * Não manda e-mail nenhum e não abre sessão — quem chama abre a sessão com a
 * senha que a pessoa digitou e aplica o convite. Sem e-mail para mandar, não
 * existe mais a conta órfã de "o e-mail de confirmação não saiu" que a versão
 * anterior precisava apagar.
 */
export async function criarContaDeConvite(params: {
  email: string;
  password: string;
  inviteToken: string;
  fullName: string;
}): Promise<ResultadoDaContaDeConvite> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: params.email,
    password: params.password,
    email_confirm: true,
    user_metadata: { invite_token: params.inviteToken, full_name: params.fullName },
  });

  if (error || !data?.user) {
    const detalhe = error?.message ?? "sem usuário devolvido";
    if (error?.status === 429) return { ok: false, motivo: "rate_limited" };
    // `email_exists` é o código do GoTrue atual; versões anteriores só diziam
    // 422 com "already been registered" na mensagem (mesma régua de
    // `lib/auth/provision.ts`).
    const jaExiste =
      error?.code === "email_exists" || /already (been )?registered|already exists/i.test(detalhe);
    if (jaExiste) return { ok: false, motivo: "conta_ja_existe" };
    // A recusa que travou os convidados da Souza Rodrigues em 05/11: senha
    // vazada. Antes caía em `criacao_recusada` e a tela dizia "tente de novo".
    const motivosDaSenha = motivosDaSenhaRecusada(error);
    if (motivosDaSenha) return { ok: false, motivo: "senha_fraca", motivosDaSenha, detalhe };
    return { ok: false, motivo: "criacao_recusada", detalhe };
  }

  return { ok: true, userId: data.user.id };
}

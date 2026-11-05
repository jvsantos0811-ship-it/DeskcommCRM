/**
 * /team/accept-invite/[token] — public route (added to PUBLIC_PATHS).
 *
 * Behavior matrix:
 *  - Invalid/expired token         → render error
 *  - Unauthenticated user          → PRIMEIRO ACESSO em destaque: "Criar minha
 *                                    senha" (→ /signup?invite=…, que cria a conta
 *                                    já confirmada e entra), "Entrar com Google"
 *                                    e, menor, "Fazer login" para quem já tem senha
 *  - Authenticated, email mismatch → render mismatch + sign-out CTA
 *  - Authenticated, email match    → form posts to Server Action which inserts
 *                                    membership and redirects to /app/inbox
 */
import Link from "next/link";

import { EntrarComGoogle } from "@/components/auth/EntrarComGoogle";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { estadoDoProvedorGoogle } from "@/lib/auth/provedor-google";
import { lerConfigPublicaDoGoTrue } from "@/lib/auth/convite-no-gotrue";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { AcceptInviteForm } from "./AcceptInviteForm";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import type { Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function AcceptInvitePage({ params }: PageProps) {
  const { token } = await params;

  // Rota pública, fora da árvore de `app/app/layout.tsx` — sem o `IdiomaProvider` de lá,
  // então resolve o idioma direto, como `admin/forbidden/page.tsx`. Buscado
  // ANTES do teto de tentativas e da validação do token porque toda ramificação
  // abaixo (inclusive as de erro) precisa do mesmo idioma — quem ainda não tem
  // conta cai no ramo sem `user` e usa o `Accept-Language` do navegador antes
  // do padrão (`idiomaDoVisitante`).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  // O gargalo de enumeração é AQUI, não no aceite: a rota é pública e cada
  // GET testa um token. Sem teto, varrer o espaço de tokens sai de graça
  // (issue #64). Barrar antes de verificar mantém a resposta indistinguível
  // entre token válido e inválido para quem está varrendo.
  if (await authRateLimited("invite_accept", null, AUTH_LIMITS.invite_accept)) {
    return (
      <Shell idioma={idioma}>
        <h1 className="text-xl font-semibold">{t("Muitas tentativas")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Aguarde alguns minutos e abra o link do convite de novo.")}
        </p>
      </Shell>
    );
  }

  const payload = verifyInviteToken(token);

  if (!payload) {
    return (
      <Shell idioma={idioma}>
        <h1 className="text-xl font-semibold">{t("Convite inválido ou expirado")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "Este link não é válido ou já passou do prazo. Peça um novo convite a quem te convidou.",
          )}
        </p>
      </Shell>
    );
  }

  // O papel em palavras de gente. Antes a tela mostrava o código ("manager").
  // Literal por literal, para o guarda de i18n enxergar cada rótulo.
  const papel =
    payload.role === "viewer"
      ? t("Somente leitura")
      : payload.role === "agent"
        ? t("Atendente")
        : payload.role === "manager"
          ? t("Gerente")
          : t("Administrador");

  if (!user) {
    const next = encodeURIComponent(`/team/accept-invite/${token}`);
    // O Google só aparece onde ele de fato cria a conta de quem está chegando:
    // provedor ligado (só um `desligado` LIDO esconde — `desconhecido` mantém,
    // como sempre, ver `lib/auth/provedor-google.ts`) E cadastro público do
    // GoTrue aberto. Com `disable_signup` o GoTrue recusa conta nova também
    // pelo OAuth, e o botão seria um beco sem saída para o convidado novo.
    const [google, configDoGoTrue] = await Promise.all([
      estadoDoProvedorGoogle(),
      lerConfigPublicaDoGoTrue(),
    ]);
    const mostrarGoogle = google !== "desligado" && configDoGoTrue?.disable_signup !== true;
    // ── PRIMEIRO ACESSO (05/11/2026) ─────────────────────────────────────────
    //
    // Medido em produção (Souza Rodrigues Advogados): três convidados, nenhum
    // entrou. O botão em destaque aqui era "Fazer login" — e quem é convidado
    // quase nunca tem senha ainda. A pessoa clicava, digitava uma senha que não
    // existia, recebia "credenciais inválidas", ia em "Esqueci minha senha"
    // (que não faz nada para quem não tem conta) e desistia. O caminho certo,
    // "Ainda não tenho conta", era um link pequeno ao lado.
    //
    // Agora o destaque é do caso comum: criar a senha. Com ela a conta nasce
    // pronta e a pessoa entra no mesmo passo, sem segundo e-mail (ver
    // `lib/auth/convite-no-gotrue.ts`). O Google vem logo abaixo; quem já tem
    // senha neste sistema continua com o login, menor.
    return (
      <Shell idioma={idioma}>
        <h1 className="text-xl font-semibold">{t("Você foi convidado")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Você vai entrar na equipe como")} <strong>{papel}</strong>,{" "}
          {t("com o e-mail")} <strong>{payload.email}</strong>.
        </p>
        <p className="mt-4 text-sm">
          {t("É seu primeiro acesso? Crie sua senha e você já entra. Não precisa confirmar outro e-mail.")}
        </p>
        <div className="mt-4 space-y-4">
          <Link
            href={`/signup?invite=${encodeURIComponent(token)}`}
            className="block w-full rounded-md bg-primary px-4 py-2.5 text-center text-sm font-medium text-primary-foreground"
          >
            {t("Criar minha senha")}
          </Link>
          {mostrarGoogle && <EntrarComGoogle convite={token} />}
        </div>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          {t("Já tem senha neste sistema?")}{" "}
          <Link
            href={`/login?next=${next}`}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("Fazer login")}
          </Link>
        </p>
      </Shell>
    );
  }

  const userEmail = (user.email ?? "").trim().toLowerCase();
  if (userEmail !== payload.email.trim().toLowerCase()) {
    return (
      <Shell idioma={idioma}>
        <h1 className="text-xl font-semibold">{t("Email não corresponde")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Você está logado como")} <strong>{user.email}</strong>,{" "}
          {t("mas o convite foi enviado para")} <strong>{payload.email}</strong>.{" "}
          {t("Saia e faça login com o email correto.")}
        </p>
        <form action="/api/auth/signout" method="post" className="mt-4">
          <button
            type="submit"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            {t("Sair")}
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell idioma={idioma}>
      <h1 className="text-xl font-semibold">{t("Aceitar convite")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("Você foi convidado para entrar como")} <strong>{papel}</strong>.{" "}
        {t("Confirme abaixo para ativar seu acesso.")}
      </p>
      <AcceptInviteForm token={token} label={t("Aceitar convite")} pendingLabel={t("Confirmando…")} failureLabel={t("Não foi possível aceitar este convite. Ele pode ter vencido ou seu acesso foi revogado. Peça um novo link ao administrador.")} planLimitLabel={t("A empresa que te convidou atingiu o limite de pessoas do plano. Avise quem te convidou.")} />
    </Shell>
  );
}

// Toda ramificação passa por aqui, então é aqui que o idioma chega ao
// `IdiomaProvider` — o único que acerta o `lang` do documento (ver
// `admin/forbidden/page.tsx`). Sem ele, o convite em espanhol saía com
// `lang="pt-BR"`, na primeira tela que o convidado vê.
function Shell({ idioma, children }: { idioma: Idioma; children: React.ReactNode }) {
  return (
    <IdiomaProvider locale={idioma}>
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">{children}</div>
      </div>
    </IdiomaProvider>
  );
}

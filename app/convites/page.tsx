import { redirect } from "next/navigation";

import { signOut } from "@/app/actions/auth/signOut";
import { aceitarConvitePeloEmail } from "@/app/actions/team/aceitarConvitePeloEmail";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { convitesPendentesPeloEmail, emailComprovado, type ConvitePendente } from "@/lib/auth/convites-pelo-email";
import { marcaDaSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * "Você tem um convite": a saída de quem chegou SEM o link do convite (entrou
 * com o Google, ou criou a conta por fora) e tem um convite pendente para o
 * e-mail que o provedor de auth comprovou. Antes, essa pessoa caía em
 * `/login?error=cadastro_por_convite` — uma tela de erro, com o convite válido
 * esperando por ela em `team_invites`. Ver `lib/auth/convites-pelo-email.ts`.
 *
 * Um clique, e não vínculo automático: a pessoa vê em que escritório e com que
 * cargo vai entrar, escolhe quando há mais de um convite e tem como dizer
 * "não é para mim".
 *
 * FORA de `app/app/**`, como `/get-started` e `/team/accept-invite`: as portas
 * são os desvios de `/auth/confirm`, `/auth/callback` e `/get-started`.
 */
export const dynamic = "force-dynamic";

const ERROS = ["nao_encontrado", "limite_do_plano", "suporte", "falha"] as const;
type Erro = (typeof ERROS)[number];

export default async function ConvitesPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { erro: erroBruto } = await searchParams;
  const erro = (ERROS as readonly string[]).includes(erroBruto ?? "") ? (erroBruto as Erro) : null;

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const email = emailComprovado(authUser);

  let convites: ConvitePendente[] = [];
  let leituraFalhou = false;
  if (email) {
    try {
      convites = await convitesPendentesPeloEmail(createAdminClient(), email);
    } catch {
      leituraFalhou = true;
    }
  }

  // Sem convite e sem erro para explicar: esta tela não tem o que dizer. Quem já
  // é de algum escritório volta para ele; quem não é, para a saída de sempre.
  if (convites.length === 0 && !erro && !leituraFalhou) {
    redirect((await resolveActiveOrg(user)) ? "/app" : "/get-started");
  }

  const marca = await marcaDaSaida(null);

  const cargo = (papel: string): string => {
    switch (papel) {
      case "viewer":
        return t("Somente leitura");
      case "agent":
        return t("Atendente");
      case "manager":
        return t("Gerente");
      case "admin":
        return t("Administrador");
      default:
        return papel;
    }
  };

  const mensagemDeErro =
    erro === "limite_do_plano"
      ? t("A empresa que te convidou atingiu o limite de pessoas do plano. Avise quem te convidou.")
      : erro === "suporte"
        ? t("Saia do acompanhamento antes de aceitar o convite.")
        : erro === "nao_encontrado"
          ? t("Este convite não está mais disponível: ele pode ter vencido ou ter sido cancelado. Peça um novo a quem te convidou.")
          : erro === "falha" || leituraFalhou
            ? t("Não foi possível concluir agora. Tente de novo em alguns minutos.")
            : null;

  return (
    <IdiomaProvider locale={user.idioma}>
      <main className="bg-muted/40 flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-md space-y-6 rounded-lg border bg-background p-6 shadow-sm">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{marca.nome}</p>
            <h1 className="text-2xl font-semibold tracking-tight">
              {convites.length > 1 ? t("Você tem convites esperando") : t("Você tem um convite esperando")}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("Encontramos convite para o seu e-mail")} <strong>{email}</strong>.{" "}
              {convites.length > 1
                ? t("Escolha em qual empresa você quer entrar.")
                : t("Confirme abaixo para entrar na equipe.")}
            </p>
          </div>

          {mensagemDeErro && (
            <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              {mensagemDeErro}
            </p>
          )}

          <ul className="space-y-3" data-testid="convites-pelo-email">
            {convites.map((convite) => (
              <li key={convite.id} className="space-y-3 rounded-md border p-4">
                <div className="space-y-1">
                  <p className="font-medium">{convite.nome_da_organizacao || t("Empresa sem nome")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("Cargo:")} {cargo(convite.role)}
                    {convite.inviter_name ? (
                      <>
                        {" · "}
                        {t("Convidado por")} {convite.inviter_name}
                      </>
                    ) : null}
                  </p>
                </div>
                <form action={aceitarConvitePeloEmail.bind(null, convite.id)}>
                  <button
                    type="submit"
                    className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  >
                    {t("Aceitar convite")}
                  </button>
                </form>
              </li>
            ))}
          </ul>

          <form action={signOut} className="space-y-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("Não reconhece este convite? Saia e entre com outra conta.")}
            </p>
            <button
              type="submit"
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              {t("Não é para mim — sair")}
            </button>
          </form>
        </div>
      </main>
    </IdiomaProvider>
  );
}

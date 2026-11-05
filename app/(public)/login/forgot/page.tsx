import Link from "next/link";

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { createClient } from "@/lib/supabase/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Recuperar senha" };

export default async function ForgotPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Recuperar senha")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Informe seu e-mail e enviaremos um link de redefinição")}
        </p>
      </div>
      <ForgotPasswordForm />
      {/* Quem foi convidado e ainda não criou a senha não tem conta — e este
          formulário, por anti-enumeração, responde "enviado" sem mandar nada.
          Medido em 05/11/2026: duas tentativas aqui, nenhum e-mail, e a pessoa
          desistiu. A saída dela é o link do convite. */}
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
        {t(
          "Foi convidado e ainda não entrou nenhuma vez? Você ainda não tem senha para recuperar: abra o e-mail do convite e clique em Criar minha senha.",
        )}
      </p>
      <p className="text-center text-sm text-muted-foreground">
        {t("Lembrou a senha?")}{" "}
        <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
          {t("Entrar")}
        </Link>
      </p>
    </div>
  );
}

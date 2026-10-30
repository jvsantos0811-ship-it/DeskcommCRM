"use server";
/**
 * Aceitar um convite achado pelo E-MAIL, na tela `/convites` — o caminho de
 * quem chegou sem o link (ver `lib/auth/convites-pelo-email.ts`).
 *
 * O id do convite é a ÚNICA coisa que vem do formulário, e ele só escolhe entre
 * os convites que a própria sessão já tem direito de ver: a linha é relida pelo
 * servidor, filtrada pelo e-mail que o provedor de auth comprovou. Um id de
 * convite alheio simplesmente não está nessa lista. Organização, papel e
 * convidador saem da linha, nunca do formulário.
 */
import { redirect } from "next/navigation";

import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import {
  convitesPendentesPeloEmail,
  type ConvitePendente,
  emailComprovado,
  payloadDoConvitePendente,
} from "@/lib/auth/convites-pelo-email";
import { readSupportContext } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function aceitarConvitePeloEmail(conviteId: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fconvites");
  if (await readSupportContext(supabase)) redirect("/convites?erro=suporte");

  const email = emailComprovado(user);
  if (!email) redirect("/convites?erro=nao_encontrado");

  let convite: ConvitePendente | undefined;
  try {
    const pendentes = await convitesPendentesPeloEmail(createAdminClient(), email);
    convite = pendentes.find((c) => c.id === conviteId);
  } catch {
    redirect("/convites?erro=falha");
  }
  if (!convite) redirect("/convites?erro=nao_encontrado");

  const resultado = await aplicarConvite({
    userId: user.id,
    payload: payloadDoConvitePendente(convite, email),
  });
  if (!resultado.ok) {
    redirect(
      `/convites?erro=${
        resultado.motivo === "limite_do_plano"
          ? "limite_do_plano"
          : resultado.motivo === "invalid_or_expired"
            ? "nao_encontrado"
            : "falha"
      }`,
    );
  }

  redirect("/app");
}

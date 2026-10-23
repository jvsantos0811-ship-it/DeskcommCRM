import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";

import { ChatDaEquipeClient } from "./_components/ChatDaEquipeClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat da equipe" };

/**
 * CHAT DA EQUIPE — a conversa interna que antes ia para o WhatsApp pessoal.
 *
 * Duas formas de sala (migration 9002): a da equipe inteira e a conversa a
 * dois com cada colega. Todo papel conversa (`viewer` inclusive: perguntar ao
 * gestor é exatamente o que um viewer precisa fazer); o suporte somente
 * leitura vê e não escreve — a rota cobra `requireSupportWrite`.
 */
export default async function ChatDaEquipePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const somenteLeitura = user.support?.access_mode === "support_readonly";
  return <ChatDaEquipeClient meuId={user.id} somenteLeitura={somenteLeitura} />;
}

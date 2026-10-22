import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { RecuperacaoClient } from "./_components/RecuperacaoClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Recuperação" };

/**
 * RECUPERAÇÃO — os negócios perdidos do período, com o motivo, o valor que
 * ficou na mesa e o que fazer com cada um.
 *
 * O "fazer" reusa portas que já existem: "Retomar" é `POST /leads/:id/retomar`
 * (negócio NOVO, a origem perdida fica intacta como histórico), "Agendar
 * recontato" é uma tarefa em `POST /tasks`. `viewer` vê a lista; agir é
 * `agent`, e as duas rotas cobram de novo.
 */
export default async function RecuperacaoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const podeAgir = (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  return <RecuperacaoClient podeAgir={podeAgir} />;
}

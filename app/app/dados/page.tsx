import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { DadosClient } from "./_components/DadosClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dados" };

/**
 * DADOS — painéis que a própria organização monta: o que medir, como agrupar,
 * qual gráfico e qual a meta (migration 9004).
 *
 * Todo mundo VÊ (cada um com os números do que pode ver, pela RLS); montar é
 * de gestor para cima — a rota cobra de novo.
 */
export default async function DadosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const podeEditar = (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  return <DadosClient podeEditar={podeEditar} />;
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { Dados } from "./_components/Dados";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dados" };

/**
 * DADOS — as abas Qualidade do lead, Dinheiro em jogo, Gestão e Explorar, que
 * leem o retrato diário (v3 §4 e §8, migration 9020), e "Meus painéis", os
 * painéis que a própria organização monta (migration 9004).
 *
 * Todo mundo VÊ (cada um com os números do que pode ver, pela RLS); montar
 * painel e "Atualizar agora" são de gerente para cima — as rotas cobram de novo.
 */
export default async function DadosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const podeEditar = (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  return (
    <Suspense>
      <Dados podeEditar={podeEditar} />
    </Suspense>
  );
}

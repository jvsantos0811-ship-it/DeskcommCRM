import { ChavesDaAgenciaClient } from "./_client";

/**
 * Chaves da agência (migration 9014): a chave que alcança TODAS as empresas da
 * instalação pelas portas MCP Leitura e Admin. É da INSTALAÇÃO, e por isso mora
 * em /admin, com porta no `AdminSidebar`.
 */
export const metadata = { title: "Chaves da agência — Admin Plataforma" };
export const dynamic = "force-dynamic";

export default function ChavesDaAgenciaPage() {
  return <ChavesDaAgenciaClient />;
}

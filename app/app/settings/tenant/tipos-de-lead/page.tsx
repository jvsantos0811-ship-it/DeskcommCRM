/**
 * Configurações › Valor por tipo de lead (v3, seção 1.1).
 *
 * Uma lista simples: o tipo de lead (o que o cliente procura — Auxílio-acidente,
 * BPC/LOAS, Implante, Clareamento…), o valor médio por caso fechado e se o
 * cliente confirmou esse valor. Cada tipo é um item do catálogo com
 * `tipo_de_lead = true`.
 *
 * Por que importa: quando a IA identifica o interesse do lead, ela grava o nome
 * do tipo no negócio, e o banco preenche o valor do negócio com este valor
 * (migration 9018). Valor digitado por pessoa nunca é sobrescrito.
 *
 * Todos veem; só gerente e administrador editam — a rota cobra de novo, e a RLS
 * de escrita do catálogo também é `manager`.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DO_TIPO_DE_LEAD, type TipoDeLeadNaTela } from "@/lib/schemas/tipos-de-lead";
import { createClient } from "@/lib/supabase/server";

import { TiposDeLeadClient } from "./_client";

export const metadata = { title: "Valor por tipo de lead" };
export const dynamic = "force-dynamic";

export default async function TiposDeLeadPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const podeEditar = !user.support && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_products")
    .select(COLUNAS_DO_TIPO_DE_LEAD)
    .eq("organization_id", activeOrg.orgId)
    .eq("tipo_de_lead", true)
    .order("ativo", { ascending: false })
    .order("nome");

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Valor por tipo de lead")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "O valor médio que entra para a empresa em cada caso fechado, por tipo de lead. Quando a IA identifica o que o lead procura, o valor do negócio é preenchido com este valor. Valor digitado por uma pessoa no negócio nunca é trocado.",
          )}
        </p>
      </header>

      {error ? (
        // Falha de leitura não vira lista vazia: "nenhum tipo" convidaria a
        // cadastrar de novo o que já existe.
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {t("Não foi possível carregar os tipos de lead agora. Recarregue a página.")}
        </div>
      ) : (
        <TiposDeLeadClient inicial={(data ?? []) as unknown as TipoDeLeadNaTela[]} podeEditar={podeEditar} />
      )}
    </div>
  );
}

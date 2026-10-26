/**
 * O NÓ DE ETIQUETA DO FLUXO TROCA A TAG (fork, migration 9006).
 *
 * `edit_lead_tag` ganhou a lista `remover`: a caixa tira essas tags e DEPOIS
 * grava as de `tags`, pelas MESMAS ações do motor de automação (`remove_tag`,
 * `add_tag`). O caso que motivou: a régua da gestante troca `1o-trimestre` por
 * `2o-trimestre` sem deixar as duas no lead.
 *
 * Mede-se a escrita de PRODUÇÃO (`createSupabaseAdminClient(...).editarTagDoLead`)
 * contra um client de mentira que registra as chamadas: a ordem (tira antes de
 * pôr), o fluxo antigo sem `remover` (byte a byte igual: só `add_tag`) e a
 * caixa que só remove.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/atendimento/origem-automacao", () => ({
  originFromAutomationEvent: vi.fn(async () => null),
}));

import { createSupabaseAdminClient } from "@/lib/followup/engine";

const ORG = "org-1";
const CONTATO = "contato-1";
const LEAD = { id: "lead-1", contact_id: CONTATO, organization_id: ORG, tags: ["vip", "1o-trimestre"] };

function clienteFalso() {
  const rpcs: string[] = [];
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    order: () => cadeia,
    limit: () => cadeia,
    maybeSingle: async () => ({ data: { ...LEAD, tags: [...LEAD.tags] }, error: null }),
  };
  const admin = {
    from: () => cadeia,
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push(nome);
      if (nome === "emit_event") return { data: null, error: null };
      const etiquetas = (args.p_etiquetas as string[]) ?? [];
      if (nome === "fn_lead_remover_etiquetas") {
        return { data: { tags: ["vip"], removidas: etiquetas }, error: null };
      }
      if (nome === "fn_lead_adicionar_etiquetas") {
        return { data: { tags: ["vip", ...etiquetas], adicionadas: etiquetas }, error: null };
      }
      throw new Error(`rpc inesperada ${nome}`);
    },
  };
  return { admin, rpcs };
}

const item = (config: { tags: string[]; remover?: string[] }) => ({
  organization_id: ORG,
  contact_id: CONTATO,
  enrollment_id: "enr-1",
  config,
});

describe("edit_lead_tag com `remover`", () => {
  it("⭐ trocar: tira a tag antiga ANTES de gravar a nova", async () => {
    const c = clienteFalso();
    await createSupabaseAdminClient(c.admin as never).editarTagDoLead!(
      item({ tags: ["2o-trimestre"], remover: ["1o-trimestre"] }),
    );
    const escritas = c.rpcs.filter((r) => r !== "emit_event");
    expect(escritas).toEqual(["fn_lead_remover_etiquetas", "fn_lead_adicionar_etiquetas"]);
  });

  it("só remover: tira e não grava nada", async () => {
    const c = clienteFalso();
    await createSupabaseAdminClient(c.admin as never).editarTagDoLead!(item({ tags: [], remover: ["1o-trimestre"] }));
    expect(c.rpcs).toEqual(["fn_lead_remover_etiquetas"]);
  });

  it("controle: fluxo antigo (sem `remover`) segue só acrescentando", async () => {
    const c = clienteFalso();
    await createSupabaseAdminClient(c.admin as never).editarTagDoLead!(item({ tags: ["vip-2"] }));
    expect(c.rpcs.filter((r) => r !== "emit_event")).toEqual(["fn_lead_adicionar_etiquetas"]);
  });
});

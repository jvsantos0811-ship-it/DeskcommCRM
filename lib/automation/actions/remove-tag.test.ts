/**
 * `remove_tag` (fork, migration 9006) — o que a ação faz com a resposta da
 * função do banco, e para qual linha ela pede.
 *
 * A subtração em si mora em `fn_lead_remover_etiquetas` /
 * `fn_contato_remover_etiquetas`, DENTRO do `UPDATE`. O dublê abaixo emula o
 * contrato delas (comparação sem maiúsculas nem espaços nas pontas; nulo para
 * linha ausente ou de outra organização). A corrida com o `add_tag` é medida
 * contra o Postgres em `tests/invariants/remove-tag-atomico.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/remove-tag";
import type { ActionCtx } from "@/lib/automation/types";

const ORG = "org-1";

function banco(inicial: Record<string, string[]>, falha = false) {
  const linhas: Record<string, string[]> = { ...inicial };
  const chamadas: Array<{ rpc: string; args: Record<string, unknown> }> = [];
  const admin = {
    async rpc(nome: string, args: Record<string, unknown>) {
      if (nome !== "fn_lead_remover_etiquetas" && nome !== "fn_contato_remover_etiquetas") {
        throw new Error(`banco de mentira: rpc inesperada ${nome}`);
      }
      chamadas.push({ rpc: nome, args });
      if (falha) return { data: null, error: { message: "indisponível" } };
      const id = String(nome === "fn_lead_remover_etiquetas" ? args.p_lead : args.p_contato);
      if (!(id in linhas)) return { data: null, error: null };
      const tirar = new Set(((args.p_etiquetas as string[]) ?? []).map((t) => t.trim().toLowerCase()));
      const antes = linhas[id]!;
      const removidas = antes.filter((t) => tirar.has(t.trim().toLowerCase()));
      linhas[id] = antes.filter((t) => !tirar.has(t.trim().toLowerCase()));
      return { data: { tags: linhas[id], removidas }, error: null };
    },
  };
  return { admin, linhas, chamadas };
}

function ctx(admin: unknown, context: Record<string, unknown>): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "regra-1",
    ruleName: "Troca de trimestre",
    event: {},
    context,
    requestId: "req-1",
  } as unknown as ActionCtx;
}

const executar = (c: ActionCtx, config: Record<string, unknown>) => getAction("remove_tag")!.execute(c, config);

describe("ação remove_tag", () => {
  it("registrada no mesmo mapa do motor de automação", () => {
    expect(getAction("remove_tag")).toBeDefined();
  });

  it("⭐ tira do NEGÓCIO a etiqueta pedida, sem diferenciar maiúscula, e preserva as outras", async () => {
    const b = banco({ "lead-1": ["vip", "1o-Trimestre", "gestante"] });
    const lead = { id: "lead-1", contact_id: "contato-1", tags: ["vip", "1o-Trimestre", "gestante"] };

    const r = await executar(ctx(b.admin, { lead }), { tags: ["1o-trimestre"] });

    expect(r).toEqual({ type: "remove_tag", status: "success", detail: { removed: ["1o-Trimestre"] } });
    expect(b.chamadas).toEqual([
      { rpc: "fn_lead_remover_etiquetas", args: { p_org: ORG, p_lead: "lead-1", p_etiquetas: ["1o-trimestre"] } },
    ]);
    expect(b.linhas["lead-1"]).toEqual(["vip", "gestante"]);
    // As próximas regras do MESMO evento enxergam o que ficou gravado.
    expect(lead.tags).toEqual(["vip", "gestante"]);
  });

  it("destino contato: tira do CONTATO do negócio", async () => {
    const b = banco({ "contato-1": ["a", "b"] });

    const r = await executar(ctx(b.admin, { lead: { id: "lead-1", contact_id: "contato-1" } }), {
      tags: ["a"],
      destino: "contato",
    });

    expect(r.status).toBe("success");
    expect(b.chamadas[0]!.rpc).toBe("fn_contato_remover_etiquetas");
    expect(b.linhas["contato-1"]).toEqual(["b"]);
  });

  it("sem negócio no contexto, o alvo é o contato — a mesma regra do add_tag", async () => {
    const b = banco({ "contato-1": ["x"] });
    const r = await executar(ctx(b.admin, { contact: { id: "contato-1" } }), { tags: ["x"] });
    expect(r.status).toBe("success");
    expect(b.chamadas[0]!.rpc).toBe("fn_contato_remover_etiquetas");
  });

  it("tag que não estava lá: sucesso sem nada removido", async () => {
    const b = banco({ "lead-1": ["vip"] });
    const r = await executar(ctx(b.admin, { lead: { id: "lead-1" } }), { tags: ["outra"] });
    expect(r).toEqual({ type: "remove_tag", status: "success", detail: { removed: [] } });
    expect(b.linhas["lead-1"]).toEqual(["vip"]);
  });

  it("pulos com motivo: sem tags, sem alvo, sem contato no destino contato, linha de outra organização", async () => {
    const b = banco({});
    expect((await executar(ctx(b.admin, { lead: { id: "l" } }), { tags: [] })).detail).toEqual({ reason: "no_tags" });
    expect((await executar(ctx(b.admin, {}), { tags: ["x"] })).detail).toEqual({ reason: "no_target" });
    expect((await executar(ctx(b.admin, {}), { tags: ["x"], destino: "contato" })).detail).toEqual({
      reason: "no_contact",
    });
    expect((await executar(ctx(b.admin, { lead: { id: "de-outra-org" } }), { tags: ["x"] })).detail).toEqual({
      reason: "no_target",
    });
  });

  it("erro do banco vira `failed` com a mensagem — o motor registra a falha da regra", async () => {
    const b = banco({ "lead-1": ["vip"] }, true);
    const r = await executar(ctx(b.admin, { lead: { id: "lead-1" } }), { tags: ["vip"] });
    expect(r).toEqual({ type: "remove_tag", status: "failed", error: "indisponível" });
  });
});

/**
 * Ação `remove_tag` — o espelho de remoção do `add_tag` (fork, migration 9006).
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 *
 * Automação e fluxo só ACRESCENTAVAM etiqueta. Uma régua que acompanha a
 * gestante por trimestre (`1o-trimestre` → `2o-trimestre`) não tinha como TROCAR
 * a marca: a de antes ficava para sempre, e um filtro por `1o-trimestre` passava
 * a mentir a partir do quarto mês. Remover só existia na ferramenta MCP
 * `crm_manage_tags`, que lê, filtra e regrava o array inteiro — a corrida que a
 * 0682 fechou para o `add_tag`.
 *
 * ─── A escrita ─────────────────────────────────────────────────────────────
 *
 * Uma chamada a `fn_lead_remover_etiquetas` / `fn_contato_remover_etiquetas`: a
 * subtração acontece DENTRO do `UPDATE`, sob a trava da linha, e a função
 * devolve o que ficou gravado (`tags`) e o que ESTA chamada removeu
 * (`removidas`). Compara sem diferenciar maiúsculas nem espaços nas pontas.
 *
 * O alvo é o MESMO do `add_tag`, com o mesmo `config.destino` (`card` padrão,
 * `contato` opcional) e os mesmos motivos de pulo — uma regra que troca a
 * etiqueta põe as duas ações lado a lado, e alvos diferentes trocariam metade.
 *
 * ─── Sem evento, de propósito ──────────────────────────────────────────────
 *
 * O `add_tag` anuncia `lead.tag_added` porque há gatilho que o escuta. Não
 * existe gatilho para etiqueta removida, e emitir um evento sem consumidor é o
 * anti-pattern nº 3 da doutrina. O registro do que aconteceu é a própria
 * rodada da regra (`automation_rule_runs`, com `detail.removed`). Quando um
 * gatilho "etiqueta removida" for pedido, ele nasce junto com o evento.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

type Destino = "card" | "contato";

type RpcDaRemocao = "fn_lead_remover_etiquetas" | "fn_contato_remover_etiquetas";

type Alvo = {
  table: "crm_leads" | "contacts";
  id: string;
  rpc: RpcDaRemocao;
  /** A foto do CONTEXTO, quando o alvo é ela mesma — as próximas regras do mesmo evento a enxergam. */
  foto?: { tags?: string[] };
};

type RetornoDaRemocao = { tags?: unknown; removidas?: unknown };

function lista(valor: unknown): string[] {
  return Array.isArray(valor) ? valor.map(String) : [];
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  if (!tags.length) return { type: "remove_tag", status: "skipped", detail: { reason: "no_tags" } };

  const destino: Destino = config.destino === "contato" ? "contato" : "card";

  const lead = ctx.context.lead as { id: string; contact_id?: string; tags?: string[] } | undefined;
  const contact = ctx.context.contact as { id: string; tags?: string[] } | undefined;

  let target: Alvo;
  if (destino === "contato") {
    const contactId = lead?.contact_id ?? contact?.id;
    if (!contactId) return { type: "remove_tag", status: "skipped", detail: { reason: "no_contact" } };
    target = { table: "contacts", id: contactId, rpc: "fn_contato_remover_etiquetas" };
  } else if (lead) {
    target = { table: "crm_leads", id: lead.id, rpc: "fn_lead_remover_etiquetas", foto: lead };
  } else if (contact) {
    target = { table: "contacts", id: contact.id, rpc: "fn_contato_remover_etiquetas", foto: contact };
  } else {
    return { type: "remove_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const parametros =
    target.table === "contacts"
      ? { p_org: ctx.organizationId, p_contato: target.id, p_etiquetas: tags }
      : { p_org: ctx.organizationId, p_lead: target.id, p_etiquetas: tags };

  const { data, error } = await ctx.admin.rpc(target.rpc, parametros);
  if (error) return { type: "remove_tag", status: "failed", error: error.message };

  // Nulo = linha inexistente OU de outra organização: nada foi lido nem gravado.
  if (data === null || data === undefined) {
    if (destino === "contato") return { type: "remove_tag", status: "skipped", detail: { reason: "no_contact" } };
    return { type: "remove_tag", status: "skipped", detail: { reason: "no_target" } };
  }

  const retorno = data as RetornoDaRemocao;
  if (target.foto) target.foto.tags = lista(retorno.tags);
  return { type: "remove_tag", status: "success", detail: { removed: lista(retorno.removidas) } };
}

registerAction({ type: "remove_tag", execute });

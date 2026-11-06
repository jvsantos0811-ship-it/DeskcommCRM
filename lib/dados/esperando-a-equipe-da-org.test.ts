/**
 * "Esperando a equipe" de uma organização, com um banco em memória: as quatro
 * fontes lidas do banco, o alcance (com potencial, que voltou, bloqueado, funil
 * de clientes), a resposta automática do celular e o filtro por funil.
 *
 * Horário: o padrão (seg–sex, 8h–18h; 1 dia útil = 10 h), porque a organização
 * do teste não cadastrou o dela. "Agora" é sexta, 06/11/2026, 06:00.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Ler o caso com `awaiting_lead` também: o L3b (caso esperando o lead) entra e acusa.
 * - Esquecer o aviso `lead_voltou`: o L5 some e acusa.
 * - Decidir a automática mensagem a mensagem (até 60 s): a saudação atrasada do L9 vira pessoa, ele sai do painel e acusa.
 * - Não filtrar o contato bloqueado: o L7 entra e acusa.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehContatoDoNumeroInterno: vi.fn(async (_db: unknown, _org: string, contato: string) => contato === "c-interno"),
}));

import type { FichaDoLeitor } from "@/lib/dados/ficha";
import { MOTIVO_ATENDIMENTO_MANUAL } from "@/lib/escalacao/atendimento-manual";

import { esperandoAEquipeDaOrg } from "./esperando-a-equipe-da-org";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]>;

/** Um supabase-js de mentira, só com o que o painel usa. */
function bancoEmMemoria(t: Tabelas) {
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let ordem: { col: string; asc: boolean } | null = null;
    let limite: number | null = null;
    let faixa: [number, number] | null = null;
    let embed = false;
    const resultado = () => {
      let r = (t[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      if (ordem) {
        const { col, asc } = ordem;
        r = [...r].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (faixa) r = r.slice(faixa[0], faixa[1] + 1);
      if (limite !== null) r = r.slice(0, limite);
      if (embed && tabela === "crm_leads") {
        r = r.map((l) => ({ ...l, etapa: (t.crm_stages ?? []).find((s) => s.id === l.stage_id) ?? null }));
      }
      return { data: r, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: (cols?: string) => {
        if (cols?.includes("crm_stages!")) embed = true;
        return b;
      },
      eq: (col: string, v: unknown) => (filtros.push((l) => l[col] === v), b),
      in: (col: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[col])), b),
      gte: (col: string, v: string) => (filtros.push((l) => Date.parse(String(l[col] ?? "")) >= Date.parse(v)), b),
      order: (col: string, o?: { ascending?: boolean }) => ((ordem = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limite = n), b),
      range: (de: number, ate: number) => ((faixa = [de, ate]), b),
      maybeSingle: () => {
        const r = resultado();
        return Promise.resolve({ data: r.data[0] ?? null, error: null });
      },
      then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, erro),
    };
    return b;
  };
  // A contagem da migration 9024 (o SQL é provado em tests/invariants/textos-automaticos-do-celular.test.ts).
  const rpc = (nome: string) =>
    Promise.resolve(
      nome === "fn_textos_automaticos_do_celular"
        ? { data: t.textos_automaticos ?? [], error: null }
        : { data: null, error: { message: `rpc desconhecida: ${nome}` } },
    );
  return { from, rpc };
}

const ORG = "org-a";
const VENDAS = "funil-vendas";
const CLIENTES = "funil-clientes";
const AGORA = new Date("2026-11-06T06:00:00-03:00");
const iso = (s: string) => new Date(s).toISOString();

function ficha(espera: FichaDoLeitor["esperando_a_equipe"]): FichaDoLeitor {
  return {
    contato: "lead",
    interesse: null,
    interesse_texto: null,
    contou_o_caso: "parcial",
    requisitos: "a_confirmar",
    requisitos_faltando: [],
    requisito_em_risco: false,
    negociacao: "nenhuma",
    objecao: "nenhuma",
    fora_da_area: false,
    sem_caso: false,
    recusou: false,
    ja_atendido_por_outro: false,
    confirmar_assinatura: false,
    midia_nao_entendida: false,
    aguardando: null,
    proximo_passo_com: "escritorio",
    palavras_proprias: true,
    esperando_a_equipe: espera,
    provas: {},
  };
}
const espera = (motivo: NonNullable<FichaDoLeitor["esperando_a_equipe"]>["motivo"], desde: string) => ({
  motivo,
  desde: iso(desde),
  prova: "trecho",
});

const SAUDACAO = "Olá! Recebemos sua mensagem e em breve a equipe responde.";

function cenario(leitorLigado = true): Tabelas {
  const lead = (id: string, contato: string, etapa: string, funil = VENDAS, extra: Linha = {}) => ({
    id,
    organization_id: ORG,
    contact_id: contato,
    pipeline_id: funil,
    stage_id: etapa,
    tags: [],
    stage_changed_at: iso("2026-10-01T10:00-03:00"),
    ...extra,
  });
  const conversa = (contato: string, extra: Linha = {}) => ({
    id: `conv-${contato}`,
    organization_id: ORG,
    contact_id: contato,
    is_group: false,
    last_handoff_at: null,
    last_handoff_reason: null,
    ...extra,
  });
  const msg = (contato: string, direction: string, sent_via: string, em: string, body = "texto", status = "delivered") => ({
    organization_id: ORG,
    conversation_id: `conv-${contato}`,
    direction,
    sent_via,
    status,
    created_at: iso(em),
    body,
  });
  const contatos = ["c1", "c2", "c3", "c3b", "c4", "c5", "c6", "c7", "c8", "c9", "c-interno", "x1", "x2", "x3"];
  return {
    organizations: [
      {
        id: ORG,
        timezone: "America/Sao_Paulo",
        created_at: "2026-09-01T12:00:00.000Z",
        settings: {
          leitor: leitorLigado
            ? { escolha: "propria", ligado: true, ligado_em: "2026-10-01T12:00:00.000Z", modelo: { provider: "anthropic", model_id: "claude-haiku-5-5" } }
            : { ligado: false },
        },
      },
    ],
    crm_pipelines: [
      { id: VENDAS, organization_id: ORG, is_archived: false, is_client_pipeline: false },
      { id: CLIENTES, organization_id: ORG, is_archived: false, is_client_pipeline: true },
    ],
    crm_stages: [
      { id: "ativa", is_won: false, is_lost: false, is_archived: false, requires_human: false },
      { id: "so-humano", is_won: false, is_lost: false, is_archived: false, requires_human: true },
      { id: "perdida", is_won: false, is_lost: true, is_archived: false, requires_human: false },
    ],
    crm_leads: [
      lead("L1", "c1", "ativa"),
      lead("L2", "c2", "ativa"),
      lead("L3", "c3", "ativa"),
      lead("L3b", "c3b", "ativa"),
      lead("L4", "c4", "so-humano", VENDAS, { stage_changed_at: iso("2026-11-05T10:00-03:00") }),
      lead("L4b", "c4", "so-humano", VENDAS, { id: "L4b", stage_changed_at: iso("2026-10-30T10:00-03:00") }),
      lead("L5", "c5", "perdida"),
      lead("L6", "c6", "perdida"),
      lead("L7", "c7", "ativa"),
      lead("L8", "c8", "ativa", CLIENTES),
      lead("L9", "c9", "ativa"),
      lead("L10", "c-interno", "ativa"),
    ],
    contacts: contatos.map((id) => ({ id, organization_id: ORG, is_blocked: id === "c7" })),
    crm_lead_ficha: [
      { organization_id: ORG, lead_id: "L1", ficha: ficha(espera("ia_disse_que_equipe_chama", "2026-11-03T09:00-03:00")) },
      { organization_id: ORG, lead_id: "L5", ficha: ficha(espera("lead_pediu_pessoa", "2026-11-02T11:00-03:00")) },
      { organization_id: ORG, lead_id: "L6", ficha: ficha(espera("lead_pediu_pessoa", "2026-11-02T11:00-03:00")) },
      { organization_id: ORG, lead_id: "L7", ficha: ficha(espera("lead_pediu_pessoa", "2026-11-02T11:00-03:00")) },
      { organization_id: ORG, lead_id: "L8", ficha: ficha(espera("lead_pediu_pessoa", "2026-11-02T11:00-03:00")) },
      { organization_id: ORG, lead_id: "L9", ficha: ficha(espera("lead_pediu_pessoa", "2026-11-02T20:00-03:00")) },
      { organization_id: ORG, lead_id: "L10", ficha: ficha(espera("lead_pediu_pessoa", "2026-11-02T11:00-03:00")) },
    ],
    conversations: [
      ...contatos.filter((c) => c !== "c2").map((c) => conversa(c)),
      conversa("c2", { last_handoff_at: iso("2026-10-28T10:05-03:00"), last_handoff_reason: MOTIVO_ATENDIMENTO_MANUAL }),
    ],
    agent_cases: [
      { organization_id: ORG, conversation_id: "conv-c3", lead_id: "L3", status: "awaiting_human", opened_at: iso("2026-11-02T10:00-03:00") },
      { organization_id: ORG, conversation_id: "conv-c3b", lead_id: "L3b", status: "awaiting_lead", opened_at: iso("2026-11-02T10:00-03:00") },
    ],
    agent_inbox_items: [{ organization_id: ORG, kind: "lead_voltou", status: "open", ref_id: "L5" }],
    messages: [
      msg("c1", "outbound", "ai", "2026-11-03T09:00-03:00", "A equipe vai te chamar"),
      msg("c2", "outbound", "external_device", "2026-10-28T10:04-03:00"),
      msg("c2", "outbound", "ai", "2026-10-28T11:27-03:00"),
      msg("c2", "inbound", "external_device", "2026-10-28T11:51-03:00", "[áudio]"),
      msg("c3", "outbound", "external_device", "2026-11-04T09:00-03:00", "Oi, aqui é a Dra."),
      msg("c9", "inbound", "external_device", "2026-11-02T20:00:00-03:00", "quero falar com alguém"),
      // A saudação saiu ATRASADA (8 min): o texto é automático na organização, então conta como automática.
      msg("c9", "outbound", "external_device", "2026-11-02T20:08:22-03:00", SAUDACAO),
    ],
    // A saudação em 40 conversas, 95% das vezes até 60 s depois do lead.
    textos_automaticos: [{ texto: SAUDACAO.toLowerCase(), conversas: 40, vezes: 40, no_prazo: 38 }],
  };
}

describe("esperandoAEquipeDaOrg", () => {
  it("lê as quatro fontes, respeita o alcance e põe no painel só quem passou de 2 dias úteis", async () => {
    const admin = bancoEmMemoria(cenario());
    const r = await esperandoAEquipeDaOrg(admin as never, ORG, AGORA);
    expect(r.ligado).toBe(true);
    expect(r.falhas).toBe(0);
    const porLead = Object.fromEntries(r.leads.map((l) => [l.lead_id, l]));
    // Do que espera há mais tempo ao mais recente.
    expect(r.leads.map((l) => l.lead_id)).toEqual(["L2", "L4b", "L5", "L9", "L1"]);
    expect(porLead.L1).toMatchObject({ motivo: "ia_disse_que_equipe_chama", quem_falou_por_ultimo: "ia", dias_uteis: 2.9 });
    expect(porLead.L2).toMatchObject({ motivo: "passagem_para_humano", desde: iso("2026-10-28T11:51-03:00"), quem_falou_por_ultimo: "lead" });
    expect(porLead.L4b).toMatchObject({ motivo: "etapa_so_humano" });
    expect(porLead.L5).toMatchObject({ motivo: "lead_pediu_pessoa" });
    expect(porLead.L9).toMatchObject({ motivo: "lead_pediu_pessoa", quem_falou_por_ultimo: "automacao" });
    // L3: a pessoa respondeu pelo celular. L3b: caso esperando o LEAD. L4: só 1,8 dia útil.
    // L6: perdido sem o aviso. L7: bloqueado. L8: funil de clientes. L10: número interno.
    for (const fora of ["L3", "L3b", "L4", "L6", "L7", "L8", "L10"]) expect(porLead[fora]).toBeUndefined();
  });

  it("com o Leitor desligado o painel não existe", async () => {
    const r = await esperandoAEquipeDaOrg(bancoEmMemoria(cenario(false)) as never, ORG, AGORA);
    expect(r).toEqual({ ligado: false, leads: [], falhas: 0 });
  });

  it("quem nunca mexeu no Leitor e segue o modelo padrão da instalação também tem o painel", async () => {
    const t = cenario(false);
    t.organizations![0]!.settings = {};
    expect((await esperandoAEquipeDaOrg(bancoEmMemoria(t) as never, ORG, AGORA)).ligado).toBe(false);
    t.platform_config = [
      {
        chave: "LEITOR_MODELO_PADRAO",
        valor: JSON.stringify({
          modelo: { provider: "anthropic", model_id: "claude-haiku-5-5" },
          reserva: null,
          ativo_desde: "2026-10-01T12:00:00.000Z",
          definido_em: "2026-10-01T12:00:00.000Z",
        }),
      },
    ];
    const r = await esperandoAEquipeDaOrg(bancoEmMemoria(t) as never, ORG, AGORA);
    expect(r.ligado).toBe(true);
    expect(r.leads.map((l) => l.lead_id)).toEqual(["L2", "L4b", "L5", "L9", "L1"]);
  });

  it("com funil, só os leads dele (o quadro com ?esperando=equipe)", async () => {
    const admin = bancoEmMemoria(cenario());
    expect((await esperandoAEquipeDaOrg(admin as never, ORG, AGORA, { pipelineId: CLIENTES })).leads).toEqual([]);
    expect((await esperandoAEquipeDaOrg(admin as never, ORG, AGORA, { pipelineId: VENDAS })).leads).toHaveLength(5);
  });
});

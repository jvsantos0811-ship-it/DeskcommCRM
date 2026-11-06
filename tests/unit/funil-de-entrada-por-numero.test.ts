/**
 * O FUNIL DE CADA NÚMERO (migration 9025) — a regra, caso a caso.
 *
 * Briefing do Operador de 06/11/2026: cada número da empresa escolhe se a
 * conversa nova abre card no funil e em qual funil/etapa. Quem aplica é
 * `garantirLeadDaConversa`, o ponto comum de todo caminho que faz nascer card
 * de conversa. Aqui roda a FUNÇÃO REAL contra um banco de mentira que responde
 * pelos filtros — e não pela ordem das chamadas —, para a prova não depender de
 * como a função está escrita por dentro.
 *
 * A ordem que se congela (do mais específico ao mais geral):
 *   contato bloqueado / pessoal / card aberto → número "Não" → campanha com
 *   funil → funil de clientes (quem já é cliente) → funil do número → funil
 *   padrão. E o conserto: funil do número arquivado ou sem etapa → padrão;
 *   etapa indisponível → primeira etapa do funil do número.
 *
 * O invariante de banco (`tests/invariants/funil-de-entrada-por-numero.test.ts`)
 * prova o mesmo contra o schema real (FK composta, `on delete set null`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const campanha = vi.fn();
const clientePelaAgenda = vi.fn();
const atividades: Array<Record<string, unknown>> = [];

vi.mock("@/lib/campanhas/origem-do-lead", () => ({
  origemDeCampanhaDaConversa: (...a: unknown[]) => campanha(...a),
  marcaDaOrigem: (o: { campanhaId: string }) => ({ source: "campanha", source_metadata: { campanha_id: o.campanhaId } }),
}));
vi.mock("@/lib/contacts/cliente-pela-agenda", () => ({
  lerClientePelaAgenda: (...a: unknown[]) => clientePelaAgenda(...a),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: async (_db: unknown, a: Record<string, unknown>) => {
    atividades.push(a);
    return { ok: true };
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { destinoDoNumero, garantirLeadDaConversa, lerFunilDoNumero } from "@/lib/leads/nascimento-do-lead";

const ORG = "org-1";

interface Funil {
  id: string;
  is_default?: boolean;
  is_client_pipeline?: boolean;
  is_archived?: boolean;
}
interface Etapa {
  id: string;
  pipeline_id: string;
  position: number;
  is_won?: boolean;
  is_lost?: boolean;
  is_archived?: boolean;
}
interface Numero {
  id: string;
  abre_card: boolean;
  funil_de_entrada_id: string | null;
  etapa_de_entrada_id: string | null;
}

interface Banco {
  contato: Record<string, unknown>;
  leadAberto: boolean;
  funis: Funil[];
  etapas: Etapa[];
  numeros: Numero[];
  /** A leitura do número ESTOURA (rede, banco sem a 9025). */
  numeroFalha?: boolean;
  nascimentos: Array<Record<string, unknown>>;
  consultasAoNumero: number;
}

const CONTATO_NOVO = {
  is_blocked: false,
  is_personal: false,
  display_name: "Maria",
  name: null,
  phone_number: "5531999990000",
  source: null,
  source_metadata: null,
  first_service_at: null,
};

function banco(parcial: Partial<Banco> = {}): Banco {
  return {
    contato: CONTATO_NOVO,
    leadAberto: false,
    funis: [
      { id: "funil-padrao", is_default: true },
      { id: "funil-b" },
      { id: "funil-clientes", is_client_pipeline: true },
    ],
    etapas: [
      { id: "padrao-1", pipeline_id: "funil-padrao", position: 1 },
      { id: "padrao-ganho", pipeline_id: "funil-padrao", position: 0, is_won: true },
      { id: "b-1", pipeline_id: "funil-b", position: 1 },
      { id: "b-2", pipeline_id: "funil-b", position: 2 },
      { id: "b-ganho", pipeline_id: "funil-b", position: 9, is_won: true },
      { id: "clientes-1", pipeline_id: "funil-clientes", position: 1 },
      { id: "campanha-1", pipeline_id: "funil-campanha", position: 1 },
    ],
    numeros: [],
    nascimentos: [],
    consultasAoNumero: 0,
    ...parcial,
  };
}

/** Responde pelos FILTROS de cada consulta, como o PostgREST. */
function makeDb(b: Banco) {
  const table = (nome: string) => {
    const eq: Record<string, unknown> = {};
    let ordenar = false;
    const filtrar = <T extends Record<string, unknown>>(linhas: T[]) =>
      linhas.filter((l) =>
        Object.entries(eq).every(([k, v]) => {
          if (k === "organization_id") return v === ORG;
          const valor = l[k] ?? (typeof v === "boolean" ? false : null);
          return valor === v;
        }),
      );
    const resposta = (): { data: unknown; error: unknown } => {
      if (nome === "contacts") return { data: b.contato, error: null };
      if (nome === "crm_leads") return { data: b.leadAberto ? { id: "lead-aberto" } : null, error: null };
      if (nome === "channel_sessions") {
        b.consultasAoNumero++;
        if (b.numeroFalha) return { data: null, error: { message: "column abre_card does not exist" } };
        return { data: filtrar(b.numeros as unknown as Record<string, unknown>[])[0] ?? null, error: null };
      }
      if (nome === "crm_pipelines") return { data: filtrar(b.funis as unknown as Record<string, unknown>[])[0] ?? null, error: null };
      if (nome === "crm_stages") {
        let l = filtrar(b.etapas as unknown as Record<string, unknown>[]);
        if (ordenar) l = [...l].sort((x, y) => (x.position as number) - (y.position as number));
        return { data: l[0] ?? null, error: null };
      }
      return { data: null, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: unknown) => {
        eq[k] = v;
        return chain;
      },
      order: () => {
        ordenar = true;
        return chain;
      },
      limit: () => chain,
      maybeSingle: () => Promise.resolve(resposta()),
    };
    return chain;
  };
  return {
    from: (n: string) => table(n),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "fn_nascer_lead_da_conversa") {
        b.nascimentos.push(args);
        return { data: `lead-${b.nascimentos.length}`, error: null };
      }
      return { data: null, error: null };
    },
  } as never;
}

function nascer(b: Banco, channelSessionId?: string | null) {
  return garantirLeadDaConversa(makeDb(b), {
    organizationId: ORG,
    contactId: "contato-1",
    conversationId: "conversa-1",
    nomeDoContato: "Maria",
    channelSessionId,
  });
}

const NAO: Numero = { id: "numero-interno", abre_card: false, funil_de_entrada_id: null, etapa_de_entrada_id: null };
const SIM_B: Numero = { id: "numero-comercial", abre_card: true, funil_de_entrada_id: "funil-b", etapa_de_entrada_id: null };
const SEM_AJUSTE: Numero = { id: "numero-antigo", abre_card: true, funil_de_entrada_id: null, etapa_de_entrada_id: null };

beforeEach(() => {
  campanha.mockReset().mockResolvedValue(null);
  clientePelaAgenda.mockReset().mockResolvedValue(false);
  atividades.length = 0;
});

describe("o número decide se o card nasce", () => {
  it("número com \"Não\" → nenhum card, motivo numero_sem_funil", async () => {
    const b = banco({ numeros: [NAO] });
    const r = await nascer(b, NAO.id);
    expect(r).toEqual({ criado: false, motivo: "numero_sem_funil" });
    expect(b.nascimentos).toHaveLength(0);
    expect(atividades).toHaveLength(0);
  });

  it("\"Não\" vence a campanha com funil: o número é decisão explícita de quem configurou a conexão", async () => {
    campanha.mockResolvedValue({ campanhaId: "c1", nome: "Campanha", pipelineId: "funil-campanha", stageId: null });
    const b = banco({ numeros: [NAO] });
    const r = await nascer(b, NAO.id);
    expect(r).toMatchObject({ criado: false, motivo: "numero_sem_funil" });
    expect(b.nascimentos).toHaveLength(0);
  });

  it("contato com card aberto: \"já existe\" vem antes, e a leitura do número nem acontece", async () => {
    const b = banco({ numeros: [NAO], leadAberto: true });
    const r = await nascer(b, NAO.id);
    expect(r).toMatchObject({ criado: false, motivo: "ja_existe" });
    expect(b.consultasAoNumero).toBe(0);
  });

  it("contato bloqueado continua recusado pelo motivo dele, não pelo do número", async () => {
    const b = banco({ numeros: [NAO], contato: { ...CONTATO_NOVO, is_blocked: true } });
    expect(await nascer(b, NAO.id)).toMatchObject({ criado: false, motivo: "contato_bloqueado" });
  });
});

describe("o número decide em qual funil", () => {
  it("sem número (voice-agent, chamador antigo) → funil padrão, primeira etapa aberta — igual a antes", async () => {
    const b = banco();
    const r = await nascer(b, undefined);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-padrao", stageId: "padrao-1" });
    expect(b.consultasAoNumero).toBe(0);
    expect(atividades[0]?.payload).toEqual({ conversation_id: "conversa-1", cliente: false });
  });

  it("número sem ajuste → funil padrão — nada muda até alguém mexer", async () => {
    const b = banco({ numeros: [SEM_AJUSTE] });
    const r = await nascer(b, SEM_AJUSTE.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-padrao", stageId: "padrao-1" });
    expect(atividades[0]?.reason).toBe("primeira mensagem recebida no WhatsApp");
  });

  it("número \"Sim · funil B\" → primeira etapa ABERTA do funil B (nunca a de ganho)", async () => {
    const b = banco({ numeros: [SIM_B] });
    const r = await nascer(b, SIM_B.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-b", stageId: "b-1" });
    expect(b.nascimentos[0]).toMatchObject({ p_pipeline: "funil-b", p_stage: "b-1" });
    // A linha do tempo diz por que o card está ali, e não no funil padrão.
    expect(atividades[0]?.reason).toBe("primeira mensagem recebida no WhatsApp (funil escolhido para este número)");
    expect(atividades[0]?.payload).toMatchObject({ channel_session_id: SIM_B.id, funil_do_numero: true });
  });

  it("número \"Sim · funil B · etapa 2\" → etapa 2 do funil B", async () => {
    const n = { ...SIM_B, etapa_de_entrada_id: "b-2" };
    const r = await nascer(banco({ numeros: [n] }), n.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-b", stageId: "b-2" });
  });

  it("contato que escreve em dois números: no \"Não\" não nasce; no \"Sim · funil B\" nasce no B", async () => {
    const b = banco({ numeros: [NAO, SIM_B] });
    expect(await nascer(b, NAO.id)).toMatchObject({ criado: false, motivo: "numero_sem_funil" });
    expect(await nascer(b, SIM_B.id)).toMatchObject({ criado: true, pipelineId: "funil-b" });
    expect(b.nascimentos).toHaveLength(1);
  });
});

describe("a ordem: campanha → clientes → número → padrão", () => {
  it("campanha que declara funil vence o funil do número", async () => {
    campanha.mockResolvedValue({ campanhaId: "c1", nome: "Campanha", pipelineId: "funil-campanha", stageId: null });
    const r = await nascer(banco({ numeros: [SIM_B] }), SIM_B.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-campanha", stageId: "campanha-1" });
  });

  it("campanha SEM funil declarado não muda nada: vale o funil do número", async () => {
    campanha.mockResolvedValue({ campanhaId: "c1", nome: "Campanha", pipelineId: null, stageId: null });
    const r = await nascer(banco({ numeros: [SIM_B] }), SIM_B.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-b" });
  });

  it("cliente que volta (regra ligada + funil de clientes) vence o funil do número", async () => {
    clientePelaAgenda.mockResolvedValue(true);
    const b = banco({ numeros: [SIM_B], contato: { ...CONTATO_NOVO, first_service_at: "2026-10-01T10:00:00Z" } });
    const r = await nascer(b, SIM_B.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-clientes", stageId: "clientes-1" });
    expect(atividades[0]?.reason).toBe("cliente conhecido voltou a escrever");
  });

  it("cliente que volta SEM funil de clientes cai no funil do número (não no padrão)", async () => {
    clientePelaAgenda.mockResolvedValue(true);
    const b = banco({
      numeros: [SIM_B],
      contato: { ...CONTATO_NOVO, first_service_at: "2026-10-01T10:00:00Z" },
      funis: [{ id: "funil-padrao", is_default: true }, { id: "funil-b" }],
    });
    const r = await nascer(b, SIM_B.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-b" });
  });
});

describe("o conserto: perder o lead é pior que errar o funil", () => {
  it("funil do número ARQUIVADO → nasce no funil padrão, com aviso na linha do tempo", async () => {
    const b = banco({
      numeros: [SIM_B],
      funis: [{ id: "funil-padrao", is_default: true }, { id: "funil-b", is_archived: true }],
    });
    const r = await nascer(b, SIM_B.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-padrao", stageId: "padrao-1" });
    expect(atividades[0]?.payload).toMatchObject({ funil_do_numero: false, aviso_do_numero: "funil_arquivado" });
    expect(String(atividades[0]?.reason)).toContain("foi arquivado; entrou no funil padrão");
  });

  it("funil do número EXCLUÍDO (a FK zerou, mas a linha velha ainda aponta) → padrão", async () => {
    const b = banco({ numeros: [{ ...SIM_B, funil_de_entrada_id: "funil-que-nao-existe" }] });
    expect(await nascer(b, SIM_B.id)).toMatchObject({ criado: true, pipelineId: "funil-padrao" });
  });

  it("funil do número sem etapa aberta → padrão, aviso funil_sem_etapa", async () => {
    const b = banco({
      numeros: [SIM_B],
      etapas: [
        { id: "padrao-1", pipeline_id: "funil-padrao", position: 1 },
        { id: "b-ganho", pipeline_id: "funil-b", position: 1, is_won: true },
      ],
    });
    const r = await nascer(b, SIM_B.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-padrao" });
    expect(atividades[0]?.payload).toMatchObject({ aviso_do_numero: "funil_sem_etapa" });
  });

  it("etapa escolhida arquivada ou de ganho → primeira etapa do MESMO funil, aviso etapa_indisponivel", async () => {
    const n = { ...SIM_B, etapa_de_entrada_id: "b-ganho" };
    const b = banco({ numeros: [n] });
    const r = await nascer(b, n.id);
    expect(r).toMatchObject({ criado: true, pipelineId: "funil-b", stageId: "b-1" });
    expect(atividades[0]?.payload).toMatchObject({ funil_do_numero: true, aviso_do_numero: "etapa_indisponivel" });
  });

  it("leitura do número FALHA (banco sem a 9025, rede) → vale o padrão: o card nasce", async () => {
    const b = banco({ numeros: [NAO], numeroFalha: true });
    expect(await nascer(b, NAO.id)).toMatchObject({ criado: true, pipelineId: "funil-padrao" });
  });

  it("número de outra empresa (id que não é desta organização) → padrão, nunca o ajuste alheio", async () => {
    const r = await lerFunilDoNumero(makeDb(banco({ numeros: [NAO] })), "outra-org", NAO.id);
    expect(r).toEqual({ abreCard: true, funilId: null, etapaId: null });
  });
});

describe("destinoDoNumero — a mesma resposta que a tela mostra", () => {
  it("sem funil escolhido: o padrão, marcado como não sendo do número", async () => {
    const d = await destinoDoNumero(makeDb(banco()), ORG, { abreCard: true, funilId: null, etapaId: null });
    expect(d).toEqual({ pipelineId: "funil-padrao", stageId: "padrao-1", doNumero: false, aviso: null });
  });

  it("empresa sem funil padrão e número sem funil: o erro de configuração de sempre", async () => {
    const d = await destinoDoNumero(makeDb(banco({ funis: [{ id: "funil-b" }] })), ORG, {
      abreCard: true,
      funilId: null,
      etapaId: null,
    });
    expect(d).toEqual({ erro: "sem_funil_de_entrada", aviso: null });
  });
});

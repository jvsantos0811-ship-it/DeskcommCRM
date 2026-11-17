/**
 * Uma rodada por vez, de verdade — e contagens que não voltam para trás (PC-042).
 *
 * O defeito: com o banco lento, uma página de 100 conversas passou de 3 min.
 * O orçamento só era conferido entre PÁGINAS e o carimbo só era renovado no fim
 * de cada uma; o cron do minuto seguinte achou a rodada "perdida" e abriu outra
 * na mesma página (deadlock), e as duas regravavam `contagens` inteiras.
 *
 * Aqui o banco é um falso de UMA linha que aplica os filtros de verdade (eq,
 * in, or) — é o filtro da gravação que decide quem tem a importação, e um
 * falso que ignorasse filtros deixaria tudo verde.
 *
 * SABOTAGENS:
 *  - tirar o `if (acabouOTempo()) break paginas;` de dentro do laço de
 *    conversas = "página lenta" vermelho (a rodada anda a página inteira, e o
 *    carimbo envelhece muito além de `RODADA_PERDIDA_MS`);
 *  - tirar `.eq("atualizada_em", posse.carimbo)` de `salvar` = "carimbo velho"
 *    vermelho (a rodada velha regrava contagens e cursor por cima da nova);
 *  - tirar `.in("estado", ...)` de `salvar` = "cancelada" vermelho;
 *  - ignorar `CHAVE_DA_RETOMADA` ao abrir a página = "continua de onde parou"
 *    vermelho (refaz as conversas já feitas);
 *  - `pegar` deixar a linha em `na_fila` = "35 s" vermelho: a fila não olha o
 *    carimbo, e o cron seguinte pegava a mesma importação na primeira página.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./credentials", () => ({
  resolveZernioCreds: async () => ({ accountId: "conta-teste", apiKey: "chave-teste", baseUrl: "https://provedor.teste", source: "session" }),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  lerNumeroInternoDeAviso: async () => ({ destino: null, jid: null }),
  ehOChatDoAviso: () => false,
}));
vi.mock("./ingest", () => ({
  upsertContact: async () => "contato-teste",
  waIdentityFrom: () => "identidade-teste",
}));
vi.mock("./historico", () => ({
  lerPaginaDeConversas: (p: unknown) => p,
  lerPaginaDeMensagens: (p: unknown) => p,
}));
vi.mock("../triagem-do-historico", () => ({ triarLeadsImportados: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { audit } from "@/lib/audit";
import {
  CHAVE_DA_RETOMADA,
  ORCAMENTO_DA_RODADA_MS,
  RODADA_PERDIDA_MS,
  impressaoDoId,
  pegarImportacao,
  rodarImportacao,
  type Dependencias,
} from "./importar-historico";

type Linha = Record<string, unknown> & {
  estado: string;
  atualizada_em: string;
  contagens: Record<string, number>;
  cursor_conversas: string | null;
};

interface Banco {
  linha: Linha;
  /** Cada `update` que casou a linha, na ordem. */
  escritas: Array<Record<string, unknown>>;
  /** Threads gravadas pela função do banco, na ordem. */
  gravadas: string[];
  /** Quanto o relógio anda por conversa gravada. */
  conversaMs: number;
  /** Chamado dentro da gravação de cada conversa (antes de a rodada salvar). */
  aoGravar?: (thread: string) => Promise<void> | void;
  /** A próxima leitura da listagem falha (rede). */
  falharListagem: boolean;
}

const relogio = { t: 0 };

function igual(a: unknown, b: unknown, coluna: string): boolean {
  if (coluna === "atualizada_em") return Date.parse(String(a)) === Date.parse(String(b));
  return String(a) === String(b);
}

function avaliarOu(l: Record<string, unknown>, termo: string): boolean {
  const i1 = termo.indexOf(".");
  const col = termo.slice(0, i1);
  const resto = termo.slice(i1 + 1);
  const i2 = resto.indexOf(".");
  const op = resto.slice(0, i2);
  const valor = resto.slice(i2 + 1);
  if (op === "eq") return igual(l[col], valor, col);
  if (op === "lt") return Date.parse(String(l[col])) < Date.parse(valor);
  throw new Error(`operador não suportado no falso: ${op}`);
}

class Consulta {
  private filtros: Array<(l: Record<string, unknown>) => boolean> = [];
  private patch: Record<string, unknown> | null = null;
  private comSelect = false;
  constructor(
    private banco: Banco,
    private tabela: string,
  ) {}
  update(p: Record<string, unknown>) {
    this.patch = p;
    return this;
  }
  select() {
    this.comSelect = true;
    return this;
  }
  eq(col: string, v: unknown) {
    this.filtros.push((l) => igual(l[col], v, col));
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filtros.push((l) => vs.includes(l[col]));
    return this;
  }
  lt(col: string, v: string) {
    this.filtros.push((l) => Date.parse(String(l[col])) < Date.parse(v));
    return this;
  }
  or(expr: string) {
    const termos = expr.split(",");
    this.filtros.push((l) => termos.some((t) => avaliarOu(l, t)));
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    return this.executar();
  }
  then<A, B>(ok: (v: unknown) => A, erro?: (e: unknown) => B) {
    return this.executar().then(ok, erro);
  }
  private async executar(): Promise<{ data: unknown; error: null; count?: number }> {
    if (this.tabela === "importacoes_de_historico") {
      const l = this.banco.linha;
      const casa = this.filtros.every((f) => f(l));
      if (this.patch) {
        if (casa) {
          this.banco.escritas.push(structuredClone(this.patch));
          Object.assign(l, structuredClone(this.patch));
        }
        return { data: casa && this.comSelect ? structuredClone(l) : null, error: null };
      }
      return { data: casa ? structuredClone(l) : null, error: null };
    }
    if (this.tabela === "channel_sessions") return { data: { zernio_account_id: "conta-teste" }, error: null };
    if (this.tabela === "contacts") return { data: { created_at: "2026-01-01T00:00:00.000Z" }, error: null };
    return { data: null, error: null, count: 0 };
  }
}

function pagina(prefixo: string, n: number, proximo: string | null) {
  return {
    conversas: Array.from({ length: n }, (_, i) => ({
      id: `${prefixo}${i}`,
      isGroup: false,
      atualizadaEm: null,
      identity: { displayName: `Contato de teste ${prefixo}${i}`, phone: null },
    })),
    semIdentidade: 0,
    proximoCursor: proximo,
    contaRecusada: null,
  };
}

function montar(conversaMs: number) {
  const banco: Banco = {
    linha: {
      id: "imp-1",
      organization_id: "org-1",
      channel_session_id: "ses-1",
      pipeline_id: null,
      stage_id: null,
      triagem_ligada: false,
      estado: "na_fila",
      cursor_conversas: null,
      contagens: {},
      falhas: [],
      iniciada_por: null,
      criada_em: "2026-11-17T00:00:00.000Z",
      atualizada_em: "2026-11-17T00:00:00.000Z",
      concluida_em: null,
    },
    escritas: [],
    gravadas: [],
    conversaMs,
    falharListagem: false,
  };
  const admin = {
    from: (t: string) => new Consulta(banco, t),
    rpc: async (nome: string, args: { p_thread: string }) => {
      if (nome !== "fn_importar_conversa_historica") return { data: null, error: null };
      relogio.t += banco.conversaMs;
      await banco.aoGravar?.(args.p_thread);
      banco.gravadas.push(args.p_thread);
      return {
        data: {
          conversation_id: `conv-${args.p_thread}`,
          contact_id: "contato-teste",
          gravadas: 1,
          repetidas: 0,
          ultima_mensagem_em: null,
          lead_id: null,
          lead_motivo: "sem_destino",
          com_midia: [],
        },
        error: null,
      };
    },
  };
  const resposta = (corpo: unknown) =>
    ({ status: 200, ok: true, headers: new Headers(), json: async () => corpo }) as unknown as Response;
  const deps: Dependencias = {
    agora: () => relogio.t,
    fetch: (async (url: string) => {
      if (url.includes("/messages?")) {
        return resposta({
          mensagens: [
            {
              externalId: `m-${url.length}-${relogio.t}`,
              direction: "inbound",
              sentAt: "2026-10-01T10:00:00.000Z",
              type: "text",
              body: "texto de teste",
              status: "read",
              mediaUrl: null,
              mediaMime: null,
              midiaSemArquivo: false,
              metadata: {},
            },
          ],
          ignoradas: 0,
          proximoCursor: null,
        });
      }
      if (banco.falharListagem) {
        banco.falharListagem = false;
        throw new Error("rede_caiu");
      }
      return resposta(url.includes("cursor=p2") ? pagina("d", 10, null) : pagina("c", 100, "p2"));
    }) as unknown as typeof fetch,
  };
  // O cliente admin falso cobre só o que a importação usa.
  return { banco, admin: admin as never, deps };
}

const proximaRodada = () => {
  relogio.t += RODADA_PERDIDA_MS + 1_000;
};

const contadores = (c: Record<string, number>) => {
  const { [CHAVE_DA_RETOMADA]: _marca, ...resto } = c;
  void _marca;
  return resto;
};

describe("importação do histórico: uma rodada por vez (PC-042)", () => {
  beforeEach(() => {
    relogio.t = Date.parse("2026-11-17T12:00:00.000Z");
    vi.mocked(audit).mockClear();
  });

  it("página lenta: para pelo orçamento entre CONVERSAS e o carimbo nunca envelhece além de uma conversa", async () => {
    const { banco, admin, deps } = montar(15_000);
    const idades: number[] = [];
    banco.aoGravar = () => {
      idades.push(relogio.t - Date.parse(banco.linha.atualizada_em));
    };
    const inicio = relogio.t;
    const r = await rodarImportacao(admin, "imp-1", deps);

    expect(r.parouPor).toBe("tempo");
    expect(r.conversas).toBe(3);
    expect(relogio.t - inicio).toBeLessThanOrEqual(ORCAMENTO_DA_RODADA_MS + 15_000);
    expect(Math.max(...idades)).toBeLessThanOrEqual(15_000);
    // A página não terminou: o cursor não andou, e a marca diz onde parou.
    expect(banco.linha.cursor_conversas).toBeNull();
    expect(banco.linha.contagens[CHAVE_DA_RETOMADA]).toBe(impressaoDoId("c2"));
  });

  it("com conversas de 35 s, uma segunda rodada nunca consegue pegar a importação no meio", async () => {
    const { banco, admin, deps } = montar(35_000);
    const rivais: unknown[] = [];
    const idades: number[] = [];
    banco.aoGravar = async () => {
      idades.push(relogio.t - Date.parse(banco.linha.atualizada_em));
      rivais.push(await pegarImportacao(admin, "imp-1", deps));
    };
    await rodarImportacao(admin, "imp-1", deps);

    expect(Math.max(...idades)).toBeLessThan(RODADA_PERDIDA_MS);
    expect(rivais.every((r) => r === null)).toBe(true);
  });

  it("a rodada seguinte continua DEPOIS da última conversa feita, sem refazer", async () => {
    const { banco, admin, deps } = montar(15_000);
    await rodarImportacao(admin, "imp-1", deps);
    expect(banco.gravadas).toEqual(["c0", "c1", "c2"]);

    proximaRodada();
    banco.gravadas = [];
    await rodarImportacao(admin, "imp-1", deps);
    expect(banco.gravadas).toEqual(["c3", "c4", "c5"]);
  });

  it("rodada com carimbo velho não grava contagens nem cursor por cima da nova", async () => {
    const { banco, admin, deps } = montar(1_000);
    banco.aoGravar = (thread) => {
      if (thread !== "c1") return;
      // Outra rodada pegou a importação enquanto esta gravava a conversa c1.
      Object.assign(banco.linha, {
        atualizada_em: new Date(relogio.t).toISOString(),
        contagens: { conversas_lidas: 99 },
        cursor_conversas: "cursor-da-outra-rodada",
      });
    };
    const r = await rodarImportacao(admin, "imp-1", deps);

    expect(r.parouPor).toBe("perdeu_a_vez");
    expect(banco.gravadas).toEqual(["c0", "c1"]);
    expect(banco.linha.contagens).toEqual({ conversas_lidas: 99 });
    expect(banco.linha.cursor_conversas).toBe("cursor-da-outra-rodada");
  });

  it("importação cancelada no meio continua cancelada: a rodada para e não a ressuscita", async () => {
    const { banco, admin, deps } = montar(1_000);
    banco.aoGravar = (thread) => {
      if (thread === "c1") banco.linha.estado = "cancelada";
    };
    const r = await rodarImportacao(admin, "imp-1", deps);

    expect(r.parouPor).toBe("perdeu_a_vez");
    expect(banco.linha.estado).toBe("cancelada");
    expect(banco.gravadas).toEqual(["c0", "c1"]);
  });

  it("contagens nunca diminuem entre rodadas — nem quando uma rodada cai no meio", async () => {
    const { banco, admin, deps } = montar(15_000);
    await rodarImportacao(admin, "imp-1", deps);
    const s1 = contadores(banco.linha.contagens);
    expect(s1.mensagens_gravadas).toBe(3);

    proximaRodada();
    banco.falharListagem = true;
    const r2 = await rodarImportacao(admin, "imp-1", deps);
    expect(r2.parouPor).toBe("erro");
    const s2 = contadores(banco.linha.contagens);

    proximaRodada();
    await rodarImportacao(admin, "imp-1", deps);
    const s3 = contadores(banco.linha.contagens);

    for (const [antes, depois] of [
      [s1, s2],
      [s2, s3],
    ] as const) {
      for (const [k, v] of Object.entries(antes)) expect(depois[k] ?? 0, k).toBeGreaterThanOrEqual(v);
    }
    expect(s3.mensagens_gravadas).toBe(6);
  });

  it("chega ao fim: as duas páginas, a conclusão auditada e a marca de retomada fora das contagens", async () => {
    const { banco, admin, deps } = montar(100);
    const r = await rodarImportacao(admin, "imp-1", deps);

    expect(r.parouPor).toBe("fim");
    expect(banco.linha.estado).toBe("concluida");
    expect(banco.linha.cursor_conversas).toBeNull();
    expect(banco.linha.contagens.conversas_lidas).toBe(110);
    expect(CHAVE_DA_RETOMADA in banco.linha.contagens).toBe(false);
    const meta = vi.mocked(audit).mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(CHAVE_DA_RETOMADA in meta).toBe(false);
  });
});

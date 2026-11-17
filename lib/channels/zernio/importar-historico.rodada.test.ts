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
 *  - ignorar as chaves `feita_*` ao percorrer a página = "continua de onde
 *    parou" e "número movimentado" vermelhos (refaz as conversas já feitas, e a
 *    página 1 de um número ativo nunca termina);
 *  - retomar por POSIÇÃO ("depois da última feita") = "lista reordenada"
 *    vermelho (a conversa que subiu para o topo nunca entra);
 *  - não liberar a importação no fim por tempo = "libera para o minuto seguinte"
 *    vermelho;
 *  - não renovar o carimbo entre páginas de mensagens = "conversa longa"
 *    vermelho;
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
  ORCAMENTO_DA_RODADA_MS,
  PREFIXO_DA_FEITA,
  RODADA_PERDIDA_MS,
  impressao,
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
  /** Ordem da página 1 da listagem (ids); padrão c0..c99. */
  ordemDaPagina1: string[];
  /** Páginas de mensagens por conversa, e quanto o relógio anda em cada uma. */
  paginasDeMensagens: number;
  paginaDeMensagensMs: number;
  /** Chamado a cada página de mensagens buscada. */
  aoBuscarMensagens?: () => Promise<void> | void;
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

function pagina(ids: string[], proximo: string | null) {
  return {
    conversas: ids.map((id) => ({
      id,
      isGroup: false,
      atualizadaEm: null,
      identity: { displayName: `Contato de teste ${id}`, phone: null },
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
    ordemDaPagina1: Array.from({ length: 100 }, (_, i) => `c${i}`),
    paginasDeMensagens: 1,
    paginaDeMensagensMs: 0,
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
        relogio.t += banco.paginaDeMensagensMs;
        await banco.aoBuscarMensagens?.();
        const n = Number(new URL(url).searchParams.get("cursor")?.slice(1) ?? "0");
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
          proximoCursor: n + 1 < banco.paginasDeMensagens ? `m${n + 1}` : null,
        });
      }
      if (banco.falharListagem) {
        banco.falharListagem = false;
        throw new Error("rede_caiu");
      }
      return resposta(
        url.includes("cursor=p2")
          ? pagina(
              Array.from({ length: 10 }, (_, i) => `d${i}`),
              null,
            )
          : pagina(banco.ordemDaPagina1, "p2"),
      );
    }) as unknown as typeof fetch,
  };
  // O cliente admin falso cobre só o que a importação usa.
  return { banco, admin: admin as never, deps };
}

const proximaRodada = () => {
  relogio.t += RODADA_PERDIDA_MS + 1_000;
};

const feitas = (c: Record<string, unknown>) => Object.keys(c).filter((k) => k.startsWith(PREFIXO_DA_FEITA));

const contadores = (c: Record<string, number>) => {
  const resto = { ...c };
  for (const k of feitas(c)) delete resto[k];
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
    expect(feitas(banco.linha.contagens).sort()).toEqual(
      ["c0", "c1", "c2"].map((id) => `${PREFIXO_DA_FEITA}${impressao(id)}`).sort(),
    );
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
    expect(feitas(banco.linha.contagens)).toEqual([]);
    const meta = vi.mocked(audit).mock.calls[0]?.[0]?.metadata as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(feitas(meta)).toEqual([]);
  });
  it("lista reordenada no meio da página: a conversa que subiu para o topo é importada", async () => {
    const { banco, admin, deps } = montar(15_000);
    await rodarImportacao(admin, "imp-1", deps);
    expect(banco.gravadas).toEqual(["c0", "c1", "c2"]);

    // Uma conversa ainda não importada recebe mensagem e sobe para o topo.
    banco.ordemDaPagina1 = ["c50", ...banco.ordemDaPagina1.filter((id) => id !== "c50")];
    const todas = new Set<string>(banco.gravadas);
    for (let rodada = 0; rodada < 200 && banco.linha.estado !== "concluida"; rodada++) {
      proximaRodada();
      banco.gravadas = [];
      await rodarImportacao(admin, "imp-1", deps);
      for (const id of banco.gravadas) todas.add(id);
    }
    expect(banco.linha.estado).toBe("concluida");
    const faltando = [...banco.ordemDaPagina1, ...Array.from({ length: 10 }, (_, i) => `d${i}`)].filter(
      (id) => !todas.has(id),
    );
    expect(faltando).toEqual([]);
  });

  it("rodada que para pelo tempo libera a importação para o cron do minuto seguinte", async () => {
    const { admin, deps } = montar(15_000);
    const r = await rodarImportacao(admin, "imp-1", deps);
    expect(r.parouPor).toBe("tempo");
    relogio.t += 61_000;
    expect(await pegarImportacao(admin, "imp-1", deps)).not.toBeNull();
  });

  it("conversa longa (muitas páginas de mensagens) renova o carimbo e ninguém a pega no meio", async () => {
    const { banco, admin, deps } = montar(1_000);
    banco.paginasDeMensagens = 15;
    banco.paginaDeMensagensMs = 20_000;
    const idades: number[] = [];
    const rivais: unknown[] = [];
    banco.aoBuscarMensagens = async () => {
      idades.push(relogio.t - Date.parse(banco.linha.atualizada_em));
      rivais.push(await pegarImportacao(admin, "imp-1", deps));
    };
    const r = await rodarImportacao(admin, "imp-1", deps);

    // 15 páginas de 20 s = 300 s numa conversa só, mais que os 3 min de "perdida".
    expect(r.conversas).toBe(1);
    expect(Math.max(...idades)).toBeLessThanOrEqual(20_000);
    expect(rivais.every((x) => x === null)).toBe(true);
  });
  it("número movimentado (a ordem muda entre TODAS as rodadas): a importação anda e termina, sem deixar ninguém de fora", async () => {
    const { banco, admin, deps } = montar(2_000);
    const todas = new Set<string>();
    let rodadas = 0;
    let refeitas = 0;
    while (banco.linha.estado !== "concluida" && rodadas < 50) {
      // Uma mensagem nova numa conversa do meio da página 1 a cada rodada.
      const meio = banco.ordemDaPagina1[50]!;
      banco.ordemDaPagina1 = [meio, ...banco.ordemDaPagina1.filter((id) => id !== meio)];
      banco.gravadas = [];
      await rodarImportacao(admin, "imp-1", deps);
      for (const id of banco.gravadas) {
        if (todas.has(id)) refeitas++;
        todas.add(id);
      }
      rodadas++;
      proximaRodada();
    }
    expect(banco.linha.estado).toBe("concluida");
    // 110 conversas a 20 por rodada: 6 rodadas; folga para a conclusão.
    expect(rodadas).toBeLessThanOrEqual(8);
    expect(refeitas).toBe(0);
    expect(todas.size).toBe(110);
  });
});

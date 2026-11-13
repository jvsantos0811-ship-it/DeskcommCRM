import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  blocosDaAbertura,
  buildOpeningEmDuasPartes,
  linhaDoHistorico,
} from "@/lib/agent-engine/agent/abertura/duas-partes";
import type { LeadCheckpointRow } from "@/lib/agent-engine/agent/abertura/checkpoint";
import { buildOpeningMessage } from "@/lib/agent-engine/agent/abertura/ritual";
import { passadaEncerraOTurno } from "@/lib/agent-engine/agent/sem-passada-final";
import type { LeadContext, LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { cacheDaCauda } from "@/lib/agent-engine/edge/llm/run-model-call";
import { buildStablePrefix } from "@/lib/agent-engine/edge/llm/stable-prefix";
import { passadasDosPassos, type PassoDoSdk } from "@/lib/ai/usage/passadas";

/**
 * PC-035 — os critérios de aceite, medidos no CORPO que sai para o provedor,
 * sem rede e sem gastar API.
 *
 * O pedido passa pelo `generateText` de verdade e pelo `@ai-sdk/anthropic` de
 * verdade; só o `fetch` é trocado por um provedor de mentira que:
 *
 *   1. guarda cada corpo recebido;
 *   2. devolve as respostas de um roteiro (as ferramentas que o "modelo" pede);
 *   3. SIMULA o cache de prompt pela regra publicada pela Anthropic: o cache é
 *      GRAVADO só nos pontos marcados com `cache_control` (um prefixo inteiro
 *      até aquele bloco), e LIDO procurando, de cada ponto para trás, até 20
 *      fronteiras de bloco, um prefixo que um pedido anterior gravou.
 *
 * ⚠️ O que isto prova e o que não prova. Prova a ESTRUTURA: que o começo do
 * pedido do 2º turno é byte a byte o do 1º até o fim do histórico, que o ponto
 * de cache está lá, e que o laço faz uma chamada a menos. Os números de tokens
 * são do simulador (caracteres ÷ 3,5), não da Anthropic: a medida de verdade
 * sai de `llm_calls.passadas` na produção, com a chave ligada.
 */

// ─── O provedor de mentira ──────────────────────────────────────────────────

interface Bloco {
  texto: string;
  ponto: "1h" | "5m" | null;
}

const tokens = (texto: string): number => Math.ceil(texto.length / 3.5);

/** O pedido como a Anthropic o ordena para o cache: ferramentas → system → mensagens. */
function blocosDoPedido(corpo: Record<string, unknown>): Bloco[] {
  const blocos: Bloco[] = [];
  const ponto = (b: { cache_control?: { ttl?: string } }): Bloco["ponto"] =>
    b.cache_control ? (b.cache_control.ttl === "1h" ? "1h" : "5m") : null;
  for (const t of (corpo.tools ?? []) as Array<Record<string, unknown> & { cache_control?: { ttl?: string } }>) {
    const { cache_control: _c, ...resto } = t;
    blocos.push({ texto: JSON.stringify(resto), ponto: ponto(t) });
  }
  for (const s of (corpo.system ?? []) as Array<{ text: string; cache_control?: { ttl?: string } }>) {
    blocos.push({ texto: s.text, ponto: ponto(s) });
  }
  for (const m of (corpo.messages ?? []) as Array<{ role: string; content: unknown }>) {
    const conteudo = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Array<Record<string, unknown>>);
    for (const c of conteudo) {
      const { cache_control: _c, ...resto } = c as { cache_control?: { ttl?: string } };
      blocos.push({ texto: `${m.role}:${JSON.stringify(resto)}`, ponto: ponto(c as { cache_control?: { ttl?: string } }) });
    }
  }
  // O `cache_control` no nível do pedido (a cauda do laço) marca o último bloco.
  const doPedido = corpo.cache_control as { ttl?: string } | undefined;
  if (doPedido && blocos.length > 0 && blocos[blocos.length - 1]!.ponto === null) {
    blocos[blocos.length - 1]!.ponto = doPedido.ttl === "1h" ? "1h" : "5m";
  }
  return blocos;
}

interface UsoSimulado {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  output_tokens: number;
}

/** O cache de um "provedor": os prefixos já gravados. */
class CacheSimulado {
  private readonly gravados = new Set<string>();

  usar(corpo: Record<string, unknown>): UsoSimulado {
    const blocos = blocosDoPedido(corpo);
    const prefixo: string[] = [];
    let acumulado = "";
    for (const b of blocos) {
      acumulado += `\u0001${b.texto}`;
      prefixo.push(acumulado);
    }
    const tokensAte = (i: number): number => blocos.slice(0, i + 1).reduce((n, b) => n + tokens(b.texto), 0);
    const pontos = blocos.map((b, i) => (b.ponto ? i : -1)).filter((i) => i >= 0);
    expect(pontos.length, "a Anthropic aceita no máximo 4 pontos de cache por pedido").toBeLessThanOrEqual(4);

    // LEITURA: de cada ponto para trás, até 20 fronteiras de bloco.
    let lidoAte = -1;
    for (const p of pontos) {
      for (let j = p; j >= Math.max(0, p - 19); j -= 1) {
        if (this.gravados.has(prefixo[j]!)) {
          lidoAte = Math.max(lidoAte, j);
          break;
        }
      }
    }
    // GRAVAÇÃO: só nos pontos marcados, e só o que não foi lido.
    const ultimoPonto = pontos.length > 0 ? pontos[pontos.length - 1]! : -1;
    const ultimoDe1h = Math.max(-1, ...pontos.filter((p) => blocos[p]!.ponto === "1h"));
    for (const p of pontos) this.gravados.add(prefixo[p]!);
    const lido = lidoAte >= 0 ? tokensAte(lidoAte) : 0;
    const gravado = Math.max(0, (ultimoPonto >= 0 ? tokensAte(ultimoPonto) : 0) - lido);
    const gravadoA1h = Math.max(0, (ultimoDe1h >= 0 ? tokensAte(ultimoDe1h) : 0) - lido);
    const total = blocos.length > 0 ? tokensAte(blocos.length - 1) : 0;
    return {
      input_tokens: total - lido - gravado,
      cache_read_input_tokens: lido,
      cache_creation_input_tokens: gravado,
      cache_creation: { ephemeral_5m_input_tokens: gravado - gravadoA1h, ephemeral_1h_input_tokens: gravadoA1h },
      output_tokens: 40,
    };
  }
}

type Pedido = { name: string; input: Record<string, unknown> };

/** Roda um turno: o roteiro diz o que o "modelo" pede em cada passada ([] = só encerra). */
async function turno(args: {
  cache: CacheSimulado;
  mensagens: ModelMessage[];
  roteiro: Pedido[][];
  semPassadaFinal: boolean;
  resultadoDoEnvio?: Record<string, unknown>;
}): Promise<{ chamadas: number; usos: UsoSimulado[]; corpos: Array<Record<string, unknown>>; passos: PassoDoSdk[] }> {
  const corpos: Array<Record<string, unknown>> = [];
  const usos: UsoSimulado[] = [];
  let chamada = 0;
  const model = createAnthropic({
    apiKey: "chave-falsa-do-teste",
    fetch: async (_url, init) => {
      const corpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      corpos.push(corpo);
      const uso = args.cache.usar(corpo);
      usos.push(uso);
      const pedidos = args.roteiro[chamada] ?? [];
      chamada += 1;
      return new Response(
        JSON.stringify({
          id: `msg_${chamada}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content:
            pedidos.length === 0
              ? [{ type: "text", text: "Encerrado." }]
              : pedidos.map((p, i) => ({ type: "tool_use", id: `toolu_${chamada}_${i}`, name: p.name, input: p.input })),
          stop_reason: pedidos.length === 0 ? "end_turn" : "tool_use",
          stop_sequence: null,
          usage: uso,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  })("claude-sonnet-5");

  const prefixo = buildStablePrefix({
    system: "Você é a assistente virtual do escritório. ".repeat(400),
    tools: {
      send_message: tool({
        description: "Envia a mensagem ao cliente.",
        inputSchema: z.object({ body: z.string() }),
        execute: async () => args.resultadoDoEnvio ?? { ok: true, status: "enviada" },
      }),
      save_lead_note: tool({
        description: "Grava uma nota.",
        inputSchema: z.object({ headline: z.string() }),
        execute: async () => ({ ok: true }),
      }),
      crm_manage_tags: tool({
        description: "Aplica etiqueta.",
        inputSchema: z.object({ tag: z.string() }),
        execute: async () => ({ ok: true }),
      }),
      search_knowledge: tool({
        description: "Consulta o material.",
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ ok: true, results: [{ texto: "Documento necessário: RG." }] }),
      }),
    },
    cacheTtl: "1h",
  });
  const maxSteps = 8;
  const resultado = await generateText({
    model,
    system: prefixo.system,
    messages: args.mensagens,
    tools: prefixo.tools,
    maxOutputTokens: 256,
    // O MESMO `stopWhen` que `runModelCall` monta, com a regra do PC-035.
    stopWhen: args.semPassadaFinal
      ? [stepCountIs(maxSteps), ({ steps }) => passadaEncerraOTurno(steps[steps.length - 1])]
      : stepCountIs(maxSteps),
    ...cacheDaCauda("anthropic", maxSteps),
  });
  return { chamadas: chamada, usos, corpos, passos: resultado.steps as unknown as PassoDoSdk[] };
}

// ─── A conversa de teste ────────────────────────────────────────────────────

function mensagem(i: number, direction: "inbound" | "outbound"): LeadContextMessage {
  const minuto = String(i % 60).padStart(2, "0");
  return {
    direction,
    body:
      direction === "inbound"
        ? `Mensagem ${i} do cliente, contando o que aconteceu no trabalho e perguntando qual é o próximo passo do atendimento.`
        : `Resposta ${i} do atendimento, pedindo o documento que falta e explicando com calma o que acontece em seguida.`,
    sent_at: `2026-11-12T14:${minuto}:10-03:00`,
    ...(direction === "outbound" ? { de: "ia" as const } : {}),
  };
}

function contexto(quantas: number): LeadContext {
  return {
    lead_id: "c0ffee00-0000-4000-8000-000000000001",
    contact_id: "c0ffee00-0000-4000-8000-000000000001",
    contact: { name: "Maria de Teste", phone: "+5511999990000", email: null, tags: ["novo"], is_blocked: false, is_personal: false },
    conversation_id: "c0ffee00-0000-4000-8000-000000000002",
    last_human_decision: null,
    last_proposal: null,
    messages: Array.from({ length: quantas }, (_, i) => mensagem(i + 1, i % 2 === 0 ? "inbound" : "outbound")),
  };
}

function checkpoint(resumo: string, proxima: string): LeadCheckpointRow {
  return {
    id: "1",
    seq: "1",
    organization_id: "o",
    contact_id: "c",
    job_id: null,
    created_at: new Date("2026-11-12T17:00:00Z"),
    commitments: ["mandar a lista de documentos"],
    objections: [],
    next_action: proxima,
    rolling_summary: resumo,
    declaracao: null,
  } as unknown as LeadCheckpointRow;
}

const SUFIXOS_T1 = ["## Agora\nquinta-feira, 12/11/2026, 14:41 (America/Sao_Paulo)"];
const SUFIXOS_T2 = ["## Agora\nquinta-feira, 12/11/2026, 14:44 (America/Sao_Paulo)"];

function aberturaNova(quantas: number, cp: LeadCheckpointRow, sufixos: string[]): ModelMessage[] {
  const partes = buildOpeningEmDuasPartes(cp, null, contexto(quantas), "(sem notas)");
  return [{ role: "user", content: blocosDaAbertura(partes, sufixos) }];
}

function aberturaDeSempre(quantas: number, cp: LeadCheckpointRow, sufixos: string[]): ModelMessage[] {
  const texto = buildOpeningMessage(cp, null, contexto(quantas), "(sem notas)");
  return [{ role: "user", content: `${texto}\n\n${sufixos.join("\n\n")}` }];
}

const RESPONDE_E_REGISTRA: Pedido[][] = [
  [
    { name: "send_message", input: { body: "Recebi, Maria. Pode me mandar a foto do RG?" } },
    { name: "save_lead_note", input: { headline: "pediu RG" } },
    { name: "crm_manage_tags", input: { tag: "aguardando-documento" } },
  ],
  [],
];

// ─── Os critérios de aceite ─────────────────────────────────────────────────

describe("PC-035, aceite 1 — dois turnos seguidos do mesmo lead dentro de 5 min", () => {
  it("com a chave ligada, o 2º turno lê do cache o histórico inteiro do 1º e só grava o que entrou", async () => {
    const cache = new CacheSimulado();
    const t1 = await turno({
      cache,
      mensagens: aberturaNova(40, checkpoint("Resumo do turno 1.", "pedir o RG"), SUFIXOS_T1),
      roteiro: RESPONDE_E_REGISTRA,
      semPassadaFinal: true,
    });
    // O 2º turno: três mensagens novas (as duas bolhas nossas e a resposta do
    // cliente), outro checkpoint, outro resumo, outra hora.
    const t2 = await turno({
      cache,
      mensagens: aberturaNova(43, checkpoint("Resumo do turno 2, já diferente.", "conferir o RG"), SUFIXOS_T2),
      roteiro: RESPONDE_E_REGISTRA,
      semPassadaFinal: true,
    });

    // O começo do pedido do 2º turno é BYTE A BYTE o do 1º até o fim do histórico.
    const blocos1 = blocosDoPedido(t1.corpos[0]!);
    const blocos2 = blocosDoPedido(t2.corpos[0]!);
    const fimDoHistorico1 = blocos1.findLastIndex((b, i) => b.ponto === "5m" && i < blocos1.length - 1);
    expect(fimDoHistorico1).toBeGreaterThan(40);
    for (let i = 0; i <= fimDoHistorico1; i += 1) {
      const semPonto = (b: Bloco) => b.texto;
      expect(semPonto(blocos2[i]!), `bloco ${i}`).toBe(semPonto(blocos1[i]!));
    }

    const historico1 = blocos1.slice(0, fimDoHistorico1 + 1).reduce((n, b) => n + tokens(b.texto), 0);
    const u1 = t1.usos[0]!;
    const u2 = t2.usos[0]!;
    // 1º turno: nada no cache ainda; grava tudo.
    expect(u1.cache_read_input_tokens).toBe(0);
    // 2º turno, 1ª passada: lê do cache TUDO até o fim do histórico do 1º turno…
    expect(u2.cache_read_input_tokens).toBe(historico1);
    // …e só grava o que entrou: as 3 mensagens novas e a parte que muda.
    const novas = [41, 42, 43].map((i) => tokens(`user:${JSON.stringify({ type: "text", text: `${linhaDoHistorico(mensagem(i, i % 2 === 1 ? "inbound" : "outbound"))}\n` })}`));
    const parteQueMuda2 = tokens(blocos2[blocos2.length - 1]!.texto);
    expect(u2.cache_creation_input_tokens).toBe(novas.reduce((a, b) => a + b, 0) + parteQueMuda2);
    expect(u2.cache_creation_input_tokens).toBeLessThan(u1.cache_creation_input_tokens * 0.25);
    // A gravação do 2º turno é toda de 5 minutos (o prefixo de 1 hora já estava lá).
    expect(u2.cache_creation.ephemeral_1h_input_tokens).toBe(0);

    // Os números (do simulador), para o PR.
    console.info(
      "PC-035 aceite 1 (simulado, chars/3,5) — 1ª passada de cada turno:",
      JSON.stringify({
        turno_1: { lido: u1.cache_read_input_tokens, gravado: u1.cache_creation_input_tokens, sem_cache: u1.input_tokens },
        turno_2: { lido: u2.cache_read_input_tokens, gravado: u2.cache_creation_input_tokens, sem_cache: u2.input_tokens },
      }),
    );
  });

  it("controle: com a abertura de sempre, o 2º turno regrava a abertura inteira (só o prefixo fixo é lido)", async () => {
    const cache = new CacheSimulado();
    const t1 = await turno({
      cache,
      mensagens: aberturaDeSempre(40, checkpoint("Resumo do turno 1.", "pedir o RG"), SUFIXOS_T1),
      roteiro: RESPONDE_E_REGISTRA,
      semPassadaFinal: false,
    });
    const t2 = await turno({
      cache,
      mensagens: aberturaDeSempre(43, checkpoint("Resumo do turno 2, já diferente.", "conferir o RG"), SUFIXOS_T2),
      roteiro: RESPONDE_E_REGISTRA,
      semPassadaFinal: false,
    });
    const blocos2 = blocosDoPedido(t2.corpos[0]!);
    const abertura2 = tokens(blocos2[blocos2.length - 1]!.texto);
    const prefixoFixo = blocos2.slice(0, -1).reduce((n, b) => n + tokens(b.texto), 0);
    expect(t1.usos[0]!.cache_read_input_tokens).toBe(0);
    expect(t2.usos[0]!.cache_read_input_tokens).toBe(prefixoFixo);
    expect(t2.usos[0]!.cache_creation_input_tokens).toBe(abertura2);
    console.info(
      "PC-035 controle (abertura de sempre, simulado) — 1ª passada do turno 2:",
      JSON.stringify({ lido: t2.usos[0]!.cache_read_input_tokens, gravado: t2.usos[0]!.cache_creation_input_tokens }),
    );
  });
});

describe("PC-035, aceite 2 e 3 — sem passada final", () => {
  const abertura = () => aberturaNova(10, checkpoint("Resumo.", "pedir o RG"), SUFIXOS_T1);

  it("send_message + nota + etiqueta na MESMA passada → uma chamada ao modelo a menos, e as três executaram", async () => {
    const de_sempre = await turno({ cache: new CacheSimulado(), mensagens: abertura(), roteiro: RESPONDE_E_REGISTRA, semPassadaFinal: false });
    const novo = await turno({ cache: new CacheSimulado(), mensagens: abertura(), roteiro: RESPONDE_E_REGISTRA, semPassadaFinal: true });
    expect(de_sempre.chamadas).toBe(2);
    expect(novo.chamadas).toBe(1);
    // As ferramentas de registro pedidas junto executaram antes de o laço parar.
    const passadas = passadasDosPassos(novo.passos);
    expect(passadas).toHaveLength(1);
    expect(passadas[0]!.ferramentas).toEqual(["send_message", "save_lead_note", "crm_manage_tags"]);
    const resultados = (novo.passos[0] as unknown as { toolResults: Array<{ toolName: string; output: { ok: boolean } }> }).toolResults;
    expect(resultados.map((r) => [r.toolName, r.output.ok])).toEqual([
      ["send_message", true],
      ["save_lead_note", true],
      ["crm_manage_tags", true],
    ]);
  });

  it("resposta que pede search_knowledge → o laço segue como hoje (o modelo lê a consulta antes de responder)", async () => {
    const roteiro: Pedido[][] = [
      [{ name: "search_knowledge", input: { query: "documentos" } }],
      [{ name: "send_message", input: { body: "Precisa do RG." } }],
      [],
    ];
    const novo = await turno({ cache: new CacheSimulado(), mensagens: abertura(), roteiro, semPassadaFinal: true });
    // 1ª: consulta (segue). 2ª: envia sozinho → encerra. A 3ª (só para encerrar) não acontece.
    expect(novo.chamadas).toBe(2);
    // A 2ª chamada recebeu o resultado da consulta.
    expect(JSON.stringify(novo.corpos[1]!.messages)).toContain("Documento necessário: RG.");

    // Consulta e envio na MESMA passada: o modelo pediu para ler, então o laço segue.
    const junto: Pedido[][] = [
      [
        { name: "send_message", input: { body: "Um instante." } },
        { name: "search_knowledge", input: { query: "documentos" } },
      ],
      [],
    ];
    const comConsulta = await turno({ cache: new CacheSimulado(), mensagens: abertura(), roteiro: junto, semPassadaFinal: true });
    expect(comConsulta.chamadas).toBe(2);
  });

  it("mensagem vetada pela cadeia de travas volta ao modelo, como hoje", async () => {
    const roteiro: Pedido[][] = [
      [{ name: "send_message", input: { body: "Causa ganha!" } }],
      [],
    ];
    const vetada = await turno({
      cache: new CacheSimulado(),
      mensagens: abertura(),
      roteiro,
      semPassadaFinal: true,
      resultadoDoEnvio: { ok: false, error: { code: "promessa_de_resultado", message: "reescreva sem prometer resultado" } },
    });
    expect(vetada.chamadas).toBe(2);
    expect(JSON.stringify(vetada.corpos[1]!.messages)).toContain("reescreva sem prometer resultado");
  });
});

describe("PC-035 — os pontos de cache do pedido", () => {
  it("são 4, na ordem que a API exige: ferramentas e prompt em 1 h, fim do histórico e cauda em 5 min", async () => {
    const t = await turno({
      cache: new CacheSimulado(),
      mensagens: aberturaNova(10, checkpoint("Resumo.", "pedir o RG"), SUFIXOS_T1),
      roteiro: [[]],
      semPassadaFinal: true,
    });
    const pontos = blocosDoPedido(t.corpos[0]!).map((b) => b.ponto).filter((p) => p !== null);
    expect(pontos).toEqual(["1h", "1h", "5m", "5m"]);
  });
});

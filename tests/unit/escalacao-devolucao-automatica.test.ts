import { describe, expect, it } from "vitest";

import {
  avaliarDevolucao,
  lerPrazoDeDevolucaoMinutos,
  selecionarVencidas,
  ultimoSinalHumanoMs,
  type ConversaEmHandoff,
} from "@/lib/escalacao/devolucao-automatica";

/**
 * A IA VOLTA SOZINHA DEPOIS DO PRAZO — E SÓ DEPOIS DO PRAZO, E SÓ ONDE HÁ QUEM ATENDA.
 *
 * O que este arquivo guarda, na ordem em que custou:
 *
 *   1. O relógio conta do ÚLTIMO sinal humano, não da passagem. Um atendimento
 *      de 1h30 com a pessoa respondendo a cada 20 min NÃO é interrompido.
 *   2. A pausa por resposta pelo celular (silêncio finito) não entra aqui — ela
 *      vence sozinha por conta própria. Devolver por cima seria encurtá-la.
 *   3. Sessão sem agente publicado não recebe devolução: seria tirar a conversa
 *      da fila humana para deixá-la muda.
 *   4. Organização sem prazo = IA-06 de sempre. É o padrão de quem já instalou.
 *   5. (PC-014, regra do João de 03/11/2026) Conversa PASSADA para a equipe
 *      (`last_handoff_at` preenchido) nunca volta sozinha: só pelo clique em
 *      "Devolver para a IA". O prazo vale para a conversa que uma pessoa
 *      ASSUMIU da fila (sem passagem) e deixou parada — é a que os casos
 *      abaixo usam como base.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
const AGORA = Date.parse("2026-09-17T15:00:00Z");
const min = (n: number) => new Date(AGORA - n * 60_000).toISOString();

function conversa(sobrescreve: Partial<ConversaEmHandoff> = {}): ConversaEmHandoff {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organization_id: ORG,
    channel_session_id: SESSAO,
    status: "claimed",
    assignee_kind: "user",
    assigned_to_user_id: "11111111-1111-4111-8111-111111111111",
    assigned_at: min(90),
    bot_silenced_until: null,
    last_handoff_at: null,
    last_outbound_at: null,
    status_changed_at: min(90),
    ...sobrescreve,
  };
}

const selecao = (prazo = 60) => ({
  prazoPorOrg: new Map([[ORG, prazo]]),
  sessoesComAgente: new Map([[ORG, new Set([SESSAO])]]),
  agoraMs: AGORA,
});

describe("lerPrazoDeDevolucaoMinutos — o knob no jsonb", () => {
  it("ausente, nulo, fora da faixa ou de tipo errado é 'nunca'", () => {
    expect(lerPrazoDeDevolucaoMinutos(null)).toBeNull();
    expect(lerPrazoDeDevolucaoMinutos({})).toBeNull();
    expect(lerPrazoDeDevolucaoMinutos({ routing: {} })).toBeNull();
    expect(lerPrazoDeDevolucaoMinutos({ routing: { handoff_return_after_minutes: null } })).toBeNull();
    expect(lerPrazoDeDevolucaoMinutos({ routing: { handoff_return_after_minutes: "60" } })).toBeNull();
    expect(lerPrazoDeDevolucaoMinutos({ routing: { handoff_return_after_minutes: 2 } })).toBeNull();
    expect(lerPrazoDeDevolucaoMinutos({ routing: { handoff_return_after_minutes: 100_000 } })).toBeNull();
  });

  it("dentro da faixa devolve o inteiro", () => {
    expect(lerPrazoDeDevolucaoMinutos({ routing: { handoff_return_after_minutes: 60 } })).toBe(60);
    expect(lerPrazoDeDevolucaoMinutos({ routing: { handoff_return_after_minutes: 5 } })).toBe(5);
    expect(lerPrazoDeDevolucaoMinutos({ routing: { handoff_return_after_minutes: 1440 } })).toBe(1440);
  });
});

describe("ultimoSinalHumanoMs — de onde o relógio conta", () => {
  it("é o MAIOR entre passagem, assumir e última saída", () => {
    const c = conversa({ last_handoff_at: min(90), assigned_at: min(80), last_outbound_at: min(10) });
    expect(ultimoSinalHumanoMs(c)).toBe(AGORA - 10 * 60_000);
  });

  it("sem nenhum carimbo cai no status_changed_at; sem esse também, é null", () => {
    expect(
      ultimoSinalHumanoMs(conversa({ assigned_at: null, status_changed_at: min(70) })),
    ).toBe(AGORA - 70 * 60_000);
    expect(
      ultimoSinalHumanoMs(conversa({ assigned_at: null, status_changed_at: null })),
    ).toBeNull();
  });
});

describe("avaliarDevolucao — quem vence", () => {
  it("assumida e parada há mais que o prazo: devolve, e diz o prazo", () => {
    expect(avaliarDevolucao(conversa({ assigned_at: min(61) }), selecao(60))).toEqual({
      devolver: true,
      minutos: 60,
    });
  });

  it("PC-014: passada para a equipe NUNCA volta sozinha, nem muito depois do prazo", () => {
    const passada = conversa({
      status: "pending",
      assigned_to_user_id: null,
      assigned_at: null,
      bot_silenced_until: "infinity",
      last_handoff_at: min(5000),
    });
    expect(avaliarDevolucao(passada, selecao(60))).toEqual({
      devolver: false,
      motivo: "passada_para_a_equipe",
    });
    // Mesmo com uma pessoa assumindo depois da passagem: segue com a pessoa.
    expect(
      avaliarDevolucao(conversa({ last_handoff_at: min(5000), assigned_at: min(4000) }), selecao(60)),
    ).toEqual({ devolver: false, motivo: "passada_para_a_equipe" });
  });

  it("PC-014: passagem de um atendimento JÁ ENCERRADO (antes da reabertura) não segura a conversa", () => {
    const reaberta = conversa({ last_handoff_at: min(4000), service_started_at: min(70), assigned_at: min(70) });
    expect(avaliarDevolucao(reaberta, selecao(60))).toEqual({ devolver: true, minutos: 60 });
  });

  it("dentro do prazo: não devolve — inclusive no minuto exato anterior", () => {
    expect(avaliarDevolucao(conversa({ assigned_at: min(59) }), selecao(60))).toEqual({
      devolver: false,
      motivo: "dentro_do_prazo",
    });
  });

  it("a pessoa respondeu há pouco: o relógio reinicia, mesmo assumida há muito", () => {
    const c = conversa({ assigned_at: min(200), last_outbound_at: min(15) });
    expect(avaliarDevolucao(c, selecao(60))).toEqual({ devolver: false, motivo: "dentro_do_prazo" });
  });

  it("organização sem prazo: nunca (IA-06 de sempre)", () => {
    const sel = { ...selecao(60), prazoPorOrg: new Map<string, number>() };
    expect(avaliarDevolucao(conversa({ assigned_at: min(500) }), sel)).toEqual({
      devolver: false,
      motivo: "sem_prazo",
    });
  });

  it("pausa pelo celular (silêncio finito, sem dono) não é handoff durável: fica de fora", () => {
    const c = conversa({
      assignee_kind: null,
      assigned_to_user_id: null,
      bot_silenced_until: min(-30), // vence daqui a 30 min, sozinha
      last_handoff_at: min(90),
    });
    expect(avaliarDevolucao(c, selecao(60))).toEqual({
      devolver: false,
      motivo: "nao_esta_com_humano",
    });
  });

  it("dono humano atribuído conta como durável mesmo sem 'infinity'", () => {
    const c = conversa({
      assignee_kind: "user",
      assigned_to_user_id: "11111111-1111-4111-8111-111111111111",
      assigned_at: min(75),
      bot_silenced_until: null,
      last_handoff_at: null,
    });
    expect(avaliarDevolucao(c, selecao(60))).toEqual({ devolver: true, minutos: 60 });
  });

  it("conversa encerrada não é devolvida", () => {
    expect(avaliarDevolucao(conversa({ status: "closed", assigned_at: min(500) }), selecao(60))).toEqual({
      devolver: false,
      motivo: "status_nao_devolvivel",
    });
  });

  it("sessão sem agente publicado: não devolve para ninguém", () => {
    const sel = { ...selecao(60), sessoesComAgente: new Map<string, Set<string>>() };
    expect(avaliarDevolucao(conversa({ assigned_at: min(500) }), sel)).toEqual({
      devolver: false,
      motivo: "sessao_sem_agente",
    });
  });

  it("sem relógio nenhum: não devolve às cegas", () => {
    const c = conversa({ assigned_at: null, status_changed_at: null });
    expect(avaliarDevolucao(c, selecao(60))).toEqual({ devolver: false, motivo: "sem_relogio" });
  });
});

describe("selecionarVencidas — o lote", () => {
  it("devolve só as vencidas, cada uma com o prazo da própria organização", () => {
    const OUTRA = "55555555-5555-4555-8555-555555555555";
    const OUTRA_SESSAO = "66666666-6666-4666-8666-666666666666";
    const sel = {
      prazoPorOrg: new Map([
        [ORG, 60],
        [OUTRA, 15],
      ]),
      sessoesComAgente: new Map([
        [ORG, new Set([SESSAO])],
        [OUTRA, new Set([OUTRA_SESSAO])],
      ]),
      agoraMs: AGORA,
    };
    const lote = [
      conversa({ id: "a", assigned_at: min(61) }),
      conversa({ id: "b", assigned_at: min(30) }),
      conversa({
        id: "c",
        organization_id: OUTRA,
        channel_session_id: OUTRA_SESSAO,
        assigned_at: min(30),
      }),
      // passada para a equipe, vencida há muito: fica com a pessoa (PC-014)
      conversa({ id: "d", assigned_to_user_id: null, assigned_at: null, bot_silenced_until: "infinity", last_handoff_at: min(500) }),
    ];
    expect(selecionarVencidas(lote, sel).map((v) => [v.conversa.id, v.minutos])).toEqual([
      ["a", 60],
      ["c", 15],
    ]);
  });
});

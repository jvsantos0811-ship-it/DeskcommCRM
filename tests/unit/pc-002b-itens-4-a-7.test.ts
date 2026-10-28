/**
 * PC-002b, itens 4, 5 e 7(a) — as regras puras.
 *
 * - Item 4: a trava semântica de promessa aceita "a equipe vai assumir ainda
 *   hoje / a partir das 8h" QUANDO bate com o horário da equipe cadastrado, e
 *   segue barrando fora do horário ou com palavra comercial.
 * - Item 5: o Testar explica por que não saiu mensagem.
 * - Item 7(a): a frase da fila da organização substitui o fecho genérico
 *   quando ninguém pode assumir agora.
 */
import { describe, expect, it } from "vitest";

import { semanticPromiseGate } from "@/lib/agent-engine/guardrails/before-send";
import { explicarTesteSemMensagem, type PreviewResult } from "@/lib/agent-engine/agent/preview";
import { textoDoAviso, fraseDaFilaDaOrg } from "@/lib/escalacao/aviso-ao-lead";
import {
  horarioDaEquipeDaOrg,
  promessaDeHorarioConfere,
  referenciasDaPromessaDeHorario,
  type HorarioDaEquipe,
} from "@/lib/escalacao/horario-da-equipe";
import { acaoDaIrritacao, filaEIrritacaoEntradaSchema } from "@/lib/escalacao/irritacao";

// Segunda a sexta, 08:00–18:00, São Paulo.
const HORARIO: HorarioDaEquipe = {
  timezone: "America/Sao_Paulo",
  windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "08:00", end: "18:00" })),
};
const QUARTA_10H = new Date("2026-10-28T13:00:00Z"); // quarta, 10h em SP
const QUARTA_21H = new Date("2026-10-29T00:00:00Z"); // quarta, 21h em SP
const SABADO_10H = new Date("2026-10-31T13:00:00Z"); // sábado, 10h em SP
const SEXTA_21H = new Date("2026-10-31T00:00:00Z"); // sexta, 21h em SP

describe("item 4 — horário da equipe", () => {
  it("lê o horário do settings e ignora quando não há janelas", () => {
    expect(horarioDaEquipeDaOrg({ horario_da_equipe: HORARIO })).toEqual(HORARIO);
    expect(horarioDaEquipeDaOrg({ horario_da_equipe: { timezone: "America/Sao_Paulo", windows: [] } })).toBeNull();
    expect(horarioDaEquipeDaOrg({})).toBeNull();
    expect(horarioDaEquipeDaOrg(null)).toBeNull();
  });

  it("J1/J2/J5: 'ainda hoje' às 10h de quarta passa; às 21h e no sábado não", () => {
    const frase = "A nossa equipe vai assumir a conversa ainda hoje.";
    expect(promessaDeHorarioConfere(frase, HORARIO, QUARTA_10H)).toBe(true);
    expect(promessaDeHorarioConfere(frase, HORARIO, QUARTA_21H)).toBe(false);
    expect(promessaDeHorarioConfere(frase, HORARIO, SABADO_10H)).toBe(false);
  });

  it("'a partir das 8h' vale para o próximo dia com equipe; 'às 20h' não", () => {
    expect(promessaDeHorarioConfere("Um advogado vai te chamar a partir das 8h.", HORARIO, QUARTA_21H)).toBe(true);
    expect(promessaDeHorarioConfere("Um advogado vai te chamar às 20h.", HORARIO, QUARTA_10H)).toBe(false);
  });

  it("'amanhã' na sexta à noite não bate (sábado sem equipe); 'segunda às 9h' bate", () => {
    expect(promessaDeHorarioConfere("A equipe retorna amanhã.", HORARIO, SEXTA_21H)).toBe(false);
    expect(promessaDeHorarioConfere("A equipe retorna segunda às 9h.", HORARIO, SEXTA_21H)).toBe(true);
  });

  it("frase sem sujeito da equipe, sem tempo ou com palavra comercial não é promessa de horário", () => {
    expect(referenciasDaPromessaDeHorario("Resolvemos hoje.")).toBeNull();
    expect(referenciasDaPromessaDeHorario("A equipe vai assumir a conversa.")).toBeNull();
    expect(referenciasDaPromessaDeHorario("O advogado garante o resultado ainda hoje.")).toBeNull();
    expect(promessaDeHorarioConfere("A equipe te chama hoje sem custo, é grátis.", HORARIO, QUARTA_10H)).toBe(false);
  });

  it("sem horário cadastrado, nada passa", () => {
    expect(promessaDeHorarioConfere("A equipe vai assumir ainda hoje.", null, QUARTA_10H)).toBe(false);
  });
});

describe("item 4 — a trava semântica de promessa", () => {
  const ctx = (body: string, now: Date, horario: HorarioDaEquipe | null) =>
    ({
      body,
      now,
      horarioDaEquipe: horario,
      semanticPromise: { isPromise: true, suspectPhrase: body },
    }) as unknown as Parameters<typeof semanticPromiseGate.evaluate>[0];

  it("passa com o código 'horario_da_equipe' quando a frase bate com o horário", () => {
    const r = semanticPromiseGate.evaluate(ctx("A equipe vai assumir ainda hoje.", QUARTA_10H, HORARIO));
    expect(r).toEqual({ pass: true, skipped: "horario_da_equipe" });
  });

  it("segue vetando fora do horário, sem horário cadastrado e com palavra comercial", () => {
    expect(semanticPromiseGate.evaluate(ctx("A equipe vai assumir ainda hoje.", QUARTA_21H, HORARIO)).pass).toBe(false);
    expect(semanticPromiseGate.evaluate(ctx("A equipe vai assumir ainda hoje.", QUARTA_10H, null)).pass).toBe(false);
    expect(
      semanticPromiseGate.evaluate(ctx("A equipe vai assumir ainda hoje com desconto.", QUARTA_10H, HORARIO)).pass,
    ).toBe(false);
  });
});

describe("item 5 — o Testar explica a ausência de mensagem", () => {
  const vazio = (): PreviewResult =>
    ({ candidates: [], impediments: [], proposals: [] }) as unknown as PreviewResult;

  it("passagem para a equipe sem mensagem vira 'passou_para_a_equipe'", () => {
    const r = vazio();
    (r.proposals as unknown as { tool: string }[]).push({ tool: "request_human_handoff" });
    explicarTesteSemMensagem(r);
    expect(r.impediments.map((i) => i.code)).toEqual(["passou_para_a_equipe"]);
  });

  it("sem nada vira 'sem_mensagem'; com mensagem ou impedimento não mexe", () => {
    const r = vazio();
    explicarTesteSemMensagem(r);
    expect(r.impediments.map((i) => i.code)).toEqual(["sem_mensagem"]);
    explicarTesteSemMensagem(r);
    expect(r.impediments).toHaveLength(1);
  });
});

describe("itens 6 e 7(a) — irritação e frase da fila", () => {
  const LEAD = "00000000-0000-4000-8000-000000000001";

  it("a irritação só anota por padrão", () => {
    expect(acaoDaIrritacao({})).toBe("anotar");
    expect(acaoDaIrritacao({ irritacao: "passar" })).toBe("passar");
    expect(acaoDaIrritacao({ irritacao: "outra" })).toBe("anotar");
  });

  it("a entrada da tela limpa espaços e recusa ação desconhecida", () => {
    expect(filaEIrritacaoEntradaSchema.parse({ frase_da_fila: "  Já  te   chamo ", irritacao: "anotar" })).toEqual({
      frase_da_fila: "Já te chamo",
      irritacao: "anotar",
    });
    expect(filaEIrritacaoEntradaSchema.safeParse({ frase_da_fila: "", irritacao: "x" }).success).toBe(false);
  });

  it("a frase da fila entra quando ninguém pode assumir, e só aí", () => {
    const frase = fraseDaFilaDaOrg({ frase_da_fila: "Sua mensagem ficou registrada; a equipe responde no próximo horário." });
    expect(frase).not.toBeNull();
    const vazio = textoDoAviso("pediu_humano", { disponiveis: 0, total: 3 }, LEAD, "pt-BR", frase);
    expect(vazio.endsWith(frase!)).toBe(true);
    const comGente = textoDoAviso("pediu_humano", { disponiveis: 1, total: 3 }, LEAD, "pt-BR", frase);
    expect(comGente).not.toContain(frase!);
    const semFrase = textoDoAviso("pediu_humano", { disponiveis: 0, total: 3 }, LEAD, "pt-BR", null);
    expect(semFrase).not.toContain(frase!);
  });
});

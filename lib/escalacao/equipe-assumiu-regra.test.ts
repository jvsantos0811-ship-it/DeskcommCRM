import { describe, expect, it } from "vitest";

import {
  MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR,
  destinoQuandoAEquipeAssume,
  etapaQuandoAEquipeAssume,
  fraseDaLinhaDoTempo,
  type EtapaDoFunil,
} from "./equipe-assumiu-regra";
import { MOTIVO_ATENDIMENTO_MANUAL } from "./atendimento-manual";

const E = (id: string, position: number, extra: Partial<EtapaDoFunil> = {}): EtapaDoFunil => ({
  id,
  position,
  is_won: false,
  is_lost: false,
  ...extra,
});
const ETAPAS = [
  E("novo", 1),
  E("qualificado", 2),
  E("equipe", 3),
  E("contrato", 4),
  E("ganho", 5, { is_won: true }),
  E("perdido", 6, { is_lost: true }),
];

describe("PC-029 · a regra pura", () => {
  it("o motivo do celular é o espelho do que a tela e os painéis já reconhecem", () => {
    expect(MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR).toBe(MOTIVO_ATENDIMENTO_MANUAL);
  });

  it("a frase da linha do tempo diz o caminho e, quando se sabe, quem", () => {
    expect(fraseDaLinhaDoTempo("crm", "Ana")).toBe("Equipe assumiu respondendo pelo CRM (Ana)");
    expect(fraseDaLinhaDoTempo("crm", null)).toBe("Equipe assumiu respondendo pelo CRM");
    expect(fraseDaLinhaDoTempo("celular", null)).toBe("Equipe assumiu respondendo pelo celular");
  });

  it("o card só anda para a frente, até a etapa escolhida", () => {
    expect(destinoQuandoAEquipeAssume(ETAPAS, "novo", "equipe")).toBe("equipe");
    expect(destinoQuandoAEquipeAssume(ETAPAS, "qualificado", "equipe")).toBe("equipe");
    // Já está lá, ou depois dela: fica.
    expect(destinoQuandoAEquipeAssume(ETAPAS, "equipe", "equipe")).toBeNull();
    expect(destinoQuandoAEquipeAssume(ETAPAS, "contrato", "equipe")).toBeNull();
  });

  it("ganho e perda nunca se mexem, nem viram destino", () => {
    expect(destinoQuandoAEquipeAssume(ETAPAS, "ganho", "equipe")).toBeNull();
    expect(destinoQuandoAEquipeAssume(ETAPAS, "perdido", "equipe")).toBeNull();
    expect(destinoQuandoAEquipeAssume(ETAPAS, "novo", "ganho")).toBeNull();
  });

  it("sem etapa configurada, arquivada ou de outro funil: nada acontece", () => {
    expect(destinoQuandoAEquipeAssume(ETAPAS, "novo", null)).toBeNull();
    expect(destinoQuandoAEquipeAssume(ETAPAS, "novo", "nao-existe")).toBeNull();
    expect(
      destinoQuandoAEquipeAssume(
        [...ETAPAS, E("velha", 2.5, { is_archived: true })],
        "novo",
        "velha",
      ),
    ).toBeNull();
    expect(destinoQuandoAEquipeAssume(ETAPAS, null, "equipe")).toBeNull();
  });

  it("a configuração do funil é lida sem lançar e só aceita um id", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(etapaQuandoAEquipeAssume({ etapa_quando_equipe_assume: id })).toBe(id);
    expect(etapaQuandoAEquipeAssume({ etapa_quando_equipe_assume: "qualquer" })).toBeNull();
    expect(etapaQuandoAEquipeAssume({})).toBeNull();
    expect(etapaQuandoAEquipeAssume(null)).toBeNull();
    expect(etapaQuandoAEquipeAssume("lixo")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { blocoDoContrato } from "./contrato-no-turno";
import { resultadoDoEnvioParaOModelo } from "./enviar-pela-ia";
import { decidirEnvioPelaIa, destinoDaAnaliseHumana, etapaDoContrato, respostaSimNao } from "./regra-da-ia";

/**
 * PC-030 (item 4): quando a IA pode enviar o contrato — a regra pura, o que o
 * modelo ouve de cada desfecho e o bloco do turno.
 */

const ETAPA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";

const base = {
  etapaDoContrato: ETAPA,
  etapaAtual: ETAPA,
  nomeDaEtapaDoContrato: "Aguardando assinatura",
  campoAdvogado: { existe: true, status: "CONFIRMADO" as const, valor: "não" },
};

describe("decidirEnvioPelaIa", () => {
  it("⭐ tudo certo (etapa configurada, advogado/processo = NÃO confirmado) → pode", () => {
    expect(decidirEnvioPelaIa(base)).toEqual({ pode: true });
  });

  it("⭐ advogado ou processo = SIM confirmado → não envia, passa para a equipe (de qualquer etapa)", () => {
    const d = decidirEnvioPelaIa({ ...base, etapaAtual: OUTRA, campoAdvogado: { existe: true, status: "CONFIRMADO", valor: "sim, tenho um processo" } });
    expect(d).toMatchObject({ pode: false, motivo: "tem_advogado_ou_processo" });
  });

  it("⭐ sem NÃO confirmado (vazio, pendente ou campo ausente) → pergunta antes", () => {
    for (const campoAdvogado of [
      { existe: true, status: null, valor: undefined },
      { existe: true, status: "PENDENTE" as const, valor: "não" },
      { existe: false, status: null, valor: undefined },
      { existe: true, status: "CONFIRMADO" as const, valor: "talvez" },
    ]) {
      const d = decidirEnvioPelaIa({ ...base, campoAdvogado });
      expect(d, JSON.stringify(campoAdvogado)).toMatchObject({ pode: false, motivo: "falta_conferir_advogado" });
      expect(d.pode ? "" : d.mensagem).toMatch(/advogado ou processo/);
    }
  });

  it("fora da etapa configurada → não envia, e diz a etapa", () => {
    const d = decidirEnvioPelaIa({ ...base, etapaAtual: OUTRA });
    expect(d).toMatchObject({ pode: false, motivo: "fora_da_etapa" });
    expect(d.pode ? "" : d.mensagem).toContain("Aguardando assinatura");
  });

  it("sem etapa configurada no funil → a IA não envia contrato neste funil", () => {
    expect(decidirEnvioPelaIa({ ...base, etapaDoContrato: null })).toMatchObject({ pode: false, motivo: "sem_etapa_configurada" });
  });
});

describe("respostaSimNao e a configuração", () => {
  it.each([
    ["Não", "nao"],
    ["nao tenho", "nao"],
    [false, "nao"],
    ["Sim", "sim"],
    ["já tenho advogado", "sim"],
    [true, "sim"],
    ["", null],
    ["talvez", null],
  ])("%s → %s", (v, esperado) => {
    expect(respostaSimNao(v)).toBe(esperado);
  });

  it("etapa do contrato só vale como uuid", () => {
    expect(etapaDoContrato({ etapa_do_contrato: ETAPA })).toBe(ETAPA);
    expect(etapaDoContrato({ etapa_do_contrato: "Aguardando" })).toBeNull();
    expect(etapaDoContrato(null)).toBeNull();
  });
});

describe("destinoDaAnaliseHumana", () => {
  const etapas = [
    { id: "a", position: 1, is_won: false, is_lost: false },
    { id: "analise", position: 2, is_won: false, is_lost: false },
    { id: "aguardando", position: 3, is_won: false, is_lost: false },
    { id: "ganho", position: 4, is_won: true, is_lost: false },
  ];

  it("⭐ sai de Aguardando assinatura para trás (sem a trava de 'só para frente')", () => {
    expect(destinoDaAnaliseHumana(etapas, "aguardando", "analise")).toBe("analise");
    expect(destinoDaAnaliseHumana(etapas, "a", "analise")).toBe("analise");
  });

  it("nunca de ganho/perda, nem para a mesma etapa, nem sem configuração", () => {
    expect(destinoDaAnaliseHumana(etapas, "ganho", "analise")).toBeNull();
    expect(destinoDaAnaliseHumana(etapas, "analise", "analise")).toBeNull();
    expect(destinoDaAnaliseHumana(etapas, "aguardando", null)).toBeNull();
  });
});

describe("o que o modelo ouve", () => {
  it("faltam dados → a lista do que perguntar", () => {
    const r = resultadoDoEnvioParaOModelo({ status: "faltam_dados", faltas: ["CPF: falta perguntar ao cliente."] });
    expect(r).toMatchObject({ ok: false, error: { code: "faltam_dados" } });
    expect(JSON.stringify(r)).toContain("CPF: falta perguntar ao cliente.");
  });

  it("⭐ falha → nunca silêncio: a IA diz que a equipe manda", () => {
    const r = resultadoDoEnvioParaOModelo({ status: "falhou", motivo: "serviço fora" });
    expect(JSON.stringify(r)).toMatch(/equipe vai mandar/);
  });

  it("enviado → explicar como assinar, sem prometer resultado", () => {
    const r = resultadoDoEnvioParaOModelo({ status: "enviado", contratoId: "c", leadId: "l" });
    expect(JSON.stringify(r)).toMatch(/como assinar/);
    expect(JSON.stringify(r)).toMatch(/sem prometer/);
  });
});

describe("blocoDoContrato", () => {
  const contrato = {
    id: "c",
    lead_id: "l",
    titulo: "Contrato BPC",
    status: "enviado" as const,
    enviado_em: "2026-11-10T17:00:00Z",
    visualizado_em: null,
    decidido_em: null,
  };

  it("⭐ contrato enviado: situação com hora e a regra da reclamação (e da dúvida de como assinar)", () => {
    const b = blocoDoContrato({ enviarDisponivel: true, contrato, leadId: "l" }, "America/Sao_Paulo");
    expect(b).toContain("enviado em 10/11 às 14:00");
    expect(b).toContain("reclamacao_do_contrato");
    expect(b).toContain("Dúvida de COMO assinar não é reclamação");
    // Já enviado: não manda usar enviar_contrato de novo.
    expect(b).not.toContain("use `enviar_contrato`");
  });

  it("assinado: a IA segue o bloco de depois da assinatura", () => {
    const b = blocoDoContrato(
      { enviarDisponivel: true, contrato: { ...contrato, status: "assinado", decidido_em: "2026-11-11T12:00:00Z" }, leadId: "l" },
      "America/Sao_Paulo",
    );
    expect(b).toMatch(/ASSINADO em 11\/11/);
    expect(b).toMatch(/depois da assinatura/);
  });

  it("sem contrato e sem envio disponível: nada", () => {
    expect(blocoDoContrato({ enviarDisponivel: false, contrato: null, leadId: null }, "America/Sao_Paulo")).toBe("");
  });

  it("envio disponível e nenhum contrato: lembra de perguntar sobre advogado/processo", () => {
    const b = blocoDoContrato({ enviarDisponivel: true, contrato: null, leadId: "l" }, "America/Sao_Paulo");
    expect(b).toContain("enviar_contrato");
    expect(b).toContain("advogado ou processo");
  });
});

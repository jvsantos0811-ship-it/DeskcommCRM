/**
 * O RETRATO DE DADOS (v3 §4, §5 e §8) — os totais e agrupamentos, puros.
 *
 * A nota de cada lead é a de `calcularQualidade` (provada em `qualidade.test.ts`);
 * aqui fica o que o painel soma em cima dela: níveis, temperaturas, dinheiro,
 * parado, esfriou, o dia no fuso da organização, o funil, as etapas, o Explorar,
 * a comparação e o rótulo "Atualizado hoje às".
 */
import { describe, expect, it } from "vitest";

import { montarResposta, proximoAtualizar } from "./resposta";
import {
  agrupar,
  diaNoFuso,
  faixaDaPrimeiraResposta,
  finalDoTelefone,
  leadDoRetrato,
  linkDoFunil,
  mediana,
  MINUTOS_ENTRE_ATUALIZACOES,
  montarPaineis,
  montarRetrato,
  quandoFoiGerado,
  somarDias,
  valorEsperado,
  variacao,
  variacaoEmPontos,
  VERSAO_DA_REGRA,
  type LinhaDoRetrato,
} from "./retrato";

// 13:00 UTC = 10:00 em São Paulo, 05/11/2026.
const AGORA = new Date("2026-11-05T13:00:00.000Z");
const FUSO = "America/Sao_Paulo";
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();

let seq = 0;
function linha(extra: Partial<LinhaDoRetrato> = {}): LinhaDoRetrato {
  seq += 1;
  return {
    lead_id: `lead-${String(seq).padStart(3, "0")}`,
    pipeline_id: "funil",
    status: "open",
    criado_em: horasAtras(2),
    etapa_desde: horasAtras(2),
    chance_da_etapa: 10,
    prazo_da_etapa_horas: null,
    chance_da_ia: null,
    faixa_da_ia: null,
    mensagens_da_empresa: 0,
    respostas: 0,
    primeira_mensagem_do_lead_em: null,
    primeira_resposta_da_empresa_em: null,
    ultima_resposta_em: null,
    duplicado_de_desqualificado: false,
    interesse: null,
    interesse_registrado: false,
    etapa_id: "triagem",
    etapa: "Triagem",
    etapa_posicao: 1,
    origem: "meta_ads",
    anuncio_id: null,
    anuncio_texto: null,
    valor_cents: null,
    moeda: "BRL",
    motivo_da_perda: null,
    fechado_em: null,
    qualificado_em: null,
    ...extra,
  };
}

/** A Joana da prévia: 86, nível A, esperando fechamento, R$ 6.000 a 70%. */
const joana = () =>
  linha({
    etapa_id: "proposta",
    etapa: "Proposta",
    chance_da_etapa: 70,
    prazo_da_etapa_horas: 48,
    etapa_desde: horasAtras(96),
    criado_em: horasAtras(50),
    chance_da_ia: 70,
    mensagens_da_empresa: 3,
    respostas: 4,
    primeira_mensagem_do_lead_em: horasAtras(48),
    primeira_resposta_da_empresa_em: new Date(Date.parse(horasAtras(48)) + 60_000).toISOString(),
    ultima_resposta_em: horasAtras(30),
    interesse: "Auxílio-acidente",
    interesse_registrado: true,
    valor_cents: 600000,
    qualificado_em: horasAtras(96),
  });

const ETAPAS = [
  { id: "triagem", nome: "Triagem", posicao: 1 },
  { id: "proposta", nome: "Proposta", posicao: 2 },
  { id: "contratado", nome: "Contratado", posicao: 3 },
];

function retrato(linhas: LinhaDoRetrato[]) {
  return montarRetrato({
    linhas,
    agora: AGORA,
    fuso: FUSO,
    pipelineId: "funil",
    moeda: "BRL",
    tipos: [
      { nome: "Auxílio-acidente", preco_cents: 600000 },
      { nome: "BPC/LOAS", preco_cents: 380000 },
    ],
    etapas: ETAPAS,
  });
}

describe("o lead do retrato", () => {
  it("a nota é a da regra única; o valor esperado é valor × chance", () => {
    const l = leadDoRetrato(joana(), AGORA, FUSO);
    expect(l).toMatchObject({ nota: 86, nivel: "A", temperatura: "quente", chance: 70, valor_cents: 600000 });
    expect(l.situacoes).toEqual(["esperando_fechamento", "parado"]);
    expect(l.parado_na_fila).toBe(true);
    expect(valorEsperado(l)).toBe(420000);
    expect(l.porque.map(([c]) => c)).toEqual(["chance", "etapa", "interesse", "respondeu_engajado", "janela_longa"]);
    expect(l.faixa_primeira_resposta).toBe("ate_5_min");
    expect(l.primeira_resposta_seg).toBe(60);
  });

  it("o dia, o dia da semana e a hora são os do FUSO da organização", () => {
    // 02:30 UTC de 05/11 = 23:30 de 04/11 (quarta) em São Paulo.
    const l = leadDoRetrato(linha({ criado_em: "2026-11-05T02:30:00.000Z" }), AGORA, FUSO);
    expect(l).toMatchObject({ dia: "2026-11-04", dia_da_semana: 3, hora: 23 });
    const t = leadDoRetrato(linha({ criado_em: "2026-11-05T02:30:00.000Z" }), AGORA, "Asia/Tokyo");
    expect(t).toMatchObject({ dia: "2026-11-05", hora: 11 });
  });

  it("ganho tem chance 100; perdido e card duplicado, 0", () => {
    expect(leadDoRetrato(linha({ status: "won", fechado_em: horasAtras(1) }), AGORA, FUSO).chance).toBe(100);
    expect(leadDoRetrato(linha({ status: "lost", chance_da_etapa: 70 }), AGORA, FUSO).chance).toBe(0);
    const dup = leadDoRetrato(linha({ duplicado_de_desqualificado: true, chance_da_etapa: 70 }), AGORA, FUSO);
    expect(dup).toMatchObject({ chance: 0, nivel: "D", nota: 0 });
  });

  it("esfriou: conversou 3 vezes ou mais e está frio (aberto, não duplicado)", () => {
    const frio = linha({ mensagens_da_empresa: 2, respostas: 3, ultima_resposta_em: horasAtras(200) });
    expect(leadDoRetrato(frio, AGORA, FUSO).esfriou).toBe(true);
    const morno = linha({ mensagens_da_empresa: 2, respostas: 3, ultima_resposta_em: horasAtras(10) });
    expect(leadDoRetrato(morno, AGORA, FUSO).esfriou).toBe(false);
    expect(leadDoRetrato({ ...frio, duplicado_de_desqualificado: true }, AGORA, FUSO).esfriou).toBe(false);
  });

  it("faixas da 1ª resposta (regra do painel do Gestor)", () => {
    expect(faixaDaPrimeiraResposta(299, 1)).toBe("ate_5_min");
    expect(faixaDaPrimeiraResposta(300, 1)).toBe("5_a_30_min");
    expect(faixaDaPrimeiraResposta(1800, 1)).toBe("30_min_a_2_h");
    expect(faixaDaPrimeiraResposta(7200, 1)).toBe("mais_de_2_h");
    expect(faixaDaPrimeiraResposta(10, 0)).toBe("sem_resposta");
    expect(faixaDaPrimeiraResposta(null, 3)).toBe("sem_resposta");
  });

  it("o valor zero ou negativo conta como sem valor", () => {
    expect(leadDoRetrato(linha({ valor_cents: "0" }), AGORA, FUSO).valor_cents).toBeNull();
    expect(leadDoRetrato(linha({ valor_cents: "380000" }), AGORA, FUSO).valor_cents).toBe(380000);
  });
});

describe("o resumo do retrato", () => {
  const linhas = () => [
    joana(),
    linha({ interesse: "BPC/LOAS", valor_cents: 380000, mensagens_da_empresa: 1, respostas: 1, ultima_resposta_em: horasAtras(5) }),
    linha({ criado_em: horasAtras(30) }), // ontem
    linha({ criado_em: horasAtras(24 * 9) }), // 7 dias anteriores
    linha({ status: "lost", motivo_da_perda: "Sem direito aparente", criado_em: horasAtras(26) }),
    linha({ status: "won", fechado_em: horasAtras(20), qualificado_em: horasAtras(40), criado_em: horasAtras(60) }),
    linha({ mensagens_da_empresa: 2, respostas: 3, ultima_resposta_em: horasAtras(24 * 8), valor_cents: 250000, interesse: "BPC/LOAS" }),
  ];

  it("níveis e temperaturas contam os ABERTOS; desqualificados e ganhos à parte", () => {
    const { resumo: r } = retrato(linhas());
    expect(r.leads).toBe(7);
    expect(r.abertos).toBe(5);
    expect(r.desqualificados).toBe(1);
    expect(r.ganhos).toBe(1);
    expect(Object.values(r.niveis).reduce((a, b) => a + b, 0)).toBe(r.abertos);
    expect(Object.values(r.temperaturas).reduce((a, b) => a + b, 0)).toBe(r.abertos);
    expect(r.niveis.A).toBe(1);
    expect(r.versao_regra).toBe(VERSAO_DA_REGRA);
  });

  it("dinheiro: em jogo = soma dos abertos; previsão = valor × chance; parado; esfriou; sem valor", () => {
    const { resumo: r } = retrato(linhas());
    // 6.000 + 3.800 + 2.500 abertos com valor.
    expect(r.em_jogo_cents).toBe(1_230_000);
    // 6.000 × 70% + 3.800 × 10% + 2.500 × 10%.
    expect(r.previsao_cents).toBe(420_000 + 38_000 + 25_000);
    expect(r.abertos_com_valor).toBe(3);
    expect(r.abertos_sem_valor).toBe(2);
    expect(r.esfriou_leads).toBe(1);
    expect(r.esfriou_cents).toBe(250_000);
    // A Joana (esperando e fora do prazo) e os dois que a empresa nunca respondeu.
    expect(r.parado_na_fila_leads).toBe(3);
    expect(r.parado_na_fila_cents).toBe(600_000);
    expect(r.esperando_fechamento).toBe(1);
    expect(r.parado).toBe(1);
    expect(r.sem_resposta).toBe(2);
  });

  it("gestão: hoje, ontem, 7 dias e os 7 anteriores — no dia da organização", () => {
    const { resumo: r } = retrato(linhas());
    // 10:00 em São Paulo: hoje entraram o BPC e o esfriado (2 h atrás); ontem, os de 26 h e 30 h.
    expect(r.leads_hoje).toBe(2);
    expect(r.leads_ontem).toBe(2);
    expect(r.leads_7_dias).toBe(r.leads - 1);
    expect(r.leads_7_dias_anteriores).toBe(1);
    expect(r.qualificados).toBe(2);
    expect(r.fechados_7_dias).toBe(1);
    expect(r.responderam).toBe(3);
    expect(r.engajados).toBe(2);
    expect(r.mediana_primeira_resposta_seg).toBe(60);
  });

  it("as séries: 14 dias até hoje, o funil do lead ao contrato, as etapas (com a vazia) e os motivos", () => {
    const c = retrato(linhas());
    expect(c.por_dia).toHaveLength(14);
    expect(c.por_dia.at(-1)).toEqual({ dia: "2026-11-05", leads: 2 });
    expect(c.por_dia[0]!.dia).toBe("2026-10-23");
    expect(c.funil.map((p) => [p.passo, p.leads])).toEqual([
      ["entraram", 7],
      ["responderam", 3],
      ["engajaram", 2],
      ["qualificados", 2],
      ["fechados", 1],
    ]);
    expect(c.por_etapa.map((e) => [e.etapa, e.leads])).toEqual([
      ["Triagem", 6],
      ["Proposta", 1],
      ["Contratado", 0],
    ]);
    expect(c.motivos).toEqual([{ motivo: "Sem direito aparente", leads: 1 }]);
    // A lista sai da maior nota para a menor.
    const notas = c.leads.map((l) => l.nota);
    expect(notas).toEqual([...notas].sort((a, b) => b - a));
    expect(notas.slice(0, 2)).toEqual([100, 86]); // o ganho, depois a Joana
  });
});

describe("os painéis montados no servidor", () => {
  it("por interesse: valor médio do catálogo, em jogo, previsão, parado; 'não identificado' por último", () => {
    const c = retrato([joana(), linha({ interesse: "BPC/LOAS", valor_cents: 380000 }), linha()]);
    const p = montarPaineis(c);
    expect(p.por_interesse.map((x) => x.interesse)).toEqual(["Auxílio-acidente", "BPC/LOAS", null]);
    expect(p.por_interesse[0]).toMatchObject({
      valor_medio_cents: 600000,
      em_jogo_cents: 600000,
      previsao_cents: 420000,
      parado_cents: 600000,
    });
    expect(p.por_interesse[0]!.niveis.A).toBe(1);
    expect(p.por_interesse[2]!.valor_medio_cents).toBeNull();
  });

  it("onde está o dinheiro: os abertos de maior valor esperado, no máximo 10", () => {
    const ls = Array.from({ length: 12 }, (_, i) => linha({ valor_cents: (i + 1) * 100000, chance_da_etapa: 10 }));
    const c = retrato(ls);
    const p = montarPaineis(c);
    expect(p.onde_esta_o_dinheiro).toHaveLength(10);
    const porId = new Map(c.leads.map((l) => [l.id, l]));
    expect(porId.get(p.onde_esta_o_dinheiro[0]!)!.valor_cents).toBe(1_200_000);
  });

  it("precisam de ação: esperando e fora do prazo primeiro, depois sem resposta, depois esfriou", () => {
    const esfriou = linha({ mensagens_da_empresa: 2, respostas: 3, ultima_resposta_em: horasAtras(300) });
    const semResposta = linha();
    const j = joana();
    const c = retrato([esfriou, semResposta, j]);
    expect(montarPaineis(c).precisam_de_acao).toEqual([j.lead_id, semResposta.lead_id, esfriou.lead_id]);
  });

  it("Explorar: agrupa e mede cada grupo; ordem natural nos eixos que têm ordem; o grupo vazio por último", () => {
    const c = retrato([joana(), linha({ interesse: "BPC/LOAS" }), linha(), linha({ status: "lost" })]);
    const porNivel = agrupar(c.leads, "nivel");
    expect(porNivel.map((g) => g.chave)).toEqual(["A", "D", "desqualificado"]);
    const porInteresse = agrupar(c.leads, "interesse");
    expect(porInteresse.at(-1)!.chave).toBe("");
    const a = porNivel[0]!;
    expect(a).toMatchObject({ leads: 1, pct_resposta: 100, pct_qualificacao: 100, nota_media: 86, leads_ab: 1, em_jogo_cents: 600000 });
    const faixas = agrupar(c.leads, "primeira_resposta").map((g) => g.chave);
    expect(faixas).toEqual(["ate_5_min", "sem_resposta"]);
    const p = montarPaineis(c);
    expect(Object.keys(p.explorar)).toHaveLength(9);
  });
});

describe("a comparação, o rótulo e os links", () => {
  it("variação simples e em pontos; sem retrato anterior, nula", () => {
    expect(variacao(26, 24)).toBe(2);
    expect(variacao(26, null)).toBeNull();
    expect(variacaoEmPontos(28, 46, 25, 46)).toBe(7);
    expect(variacaoEmPontos(28, 46, undefined, undefined)).toBeNull();
  });

  it("\"Atualizado hoje às 06:00\" no relógio da organização; ontem; passadas 30 h, o aviso com a data", () => {
    expect(quandoFoiGerado("2026-11-05T09:00:00.000Z", AGORA, FUSO)).toEqual({ tipo: "hoje", hora: "06:00" });
    expect(quandoFoiGerado("2026-11-04T09:00:00.000Z", AGORA, FUSO)).toEqual({ tipo: "ontem", hora: "06:00" });
    expect(quandoFoiGerado("2026-11-03T09:00:00.000Z", AGORA, FUSO)).toEqual({ tipo: "velho", data: "03/11" });
    // 02:30 UTC de 05/11 ainda é 04/11 em São Paulo: "ontem às 23:30".
    expect(quandoFoiGerado("2026-11-05T02:30:00.000Z", AGORA, FUSO)).toEqual({ tipo: "ontem", hora: "23:30" });
  });

  it("todo link do painel leva o recorte do painel; o ?lead= vai por último", () => {
    expect(linkDoFunil("p1", { nivel: "A" })).toBe("/app/pipelines/p1?nivel=A&recorte=painel");
    expect(linkDoFunil("p1", { servico: "BPC/LOAS" })).toBe("/app/pipelines/p1?servico=BPC%2FLOAS&recorte=painel");
    expect(linkDoFunil("p1", { status: "lost", motivo: "other" })).toBe("/app/pipelines/p1?status=lost&motivo=other&recorte=painel");
    expect(linkDoFunil("p1", { lead: "x" })).toBe("/app/pipelines/p1?recorte=painel&lead=x");
  });

  it("\"Sem nome · final 4821\" só para título que é telefone", () => {
    expect(finalDoTelefone("+55 31 99876-4821")).toBe("4821");
    expect(finalDoTelefone("Joana P.")).toBeNull();
    expect(finalDoTelefone("1234")).toBeNull();
  });

  it("datas de calendário e mediana", () => {
    expect(somarDias("2026-11-01", -1)).toBe("2026-10-31");
    expect(diaNoFuso(new Date("2026-11-05T02:00:00Z"), FUSO)).toBe("2026-11-04");
    expect(mediana([])).toBeNull();
    expect(mediana([3, 1, 2])).toBe(2);
    expect(mediana([1, 2, 3, 4])).toBe(3);
  });
});

describe("a resposta da rota", () => {
  it(`"Atualizar agora" volta a valer ${MINUTOS_ENTRE_ATUALIZACOES} min depois do último retrato`, () => {
    expect(proximoAtualizar("2026-11-05T12:50:00.000Z", AGORA)).toBe("2026-11-05T13:20:00.000Z");
    expect(proximoAtualizar("2026-11-05T12:00:00.000Z", AGORA)).toBeNull();
    expect(proximoAtualizar(null, AGORA)).toBeNull();
  });

  it("compara só com retrato da mesma regra; ao vivo não compara; o nome vem de fora", () => {
    const c = retrato([joana()]);
    const base = {
      agora: AGORA,
      fuso: FUSO,
      retrato: { dia: "2026-11-05", gerado_em: "2026-11-05T09:00:00.000Z", origem: "cron", versao_regra: VERSAO_DA_REGRA },
      conteudo: c,
      ontem: { ...c.resumo, nota_media_abertos: 80 },
      seteDias: { ...c.resumo, versao_regra: VERSAO_DA_REGRA + 99 },
      nomes: new Map([[c.leads[0]!.id, "Joana P."]]),
      podeAtualizar: true,
      rotuloDoInteresse: "Benefício",
    };
    const r = montarResposta({ ...base, modo: "retrato" });
    expect(r.ontem?.nota_media_abertos).toBe(80);
    expect(r.sete_dias).toBeNull();
    expect(r.leads[0]!.nome).toBe("Joana P.");
    expect(r.pipeline_id).toBe("funil");
    expect(r.paineis?.por_interesse).toHaveLength(1);
    const vivo = montarResposta({ ...base, modo: "ao_vivo", podeAtualizar: false });
    expect(vivo.ontem).toBeNull();
    expect(vivo.proximo_atualizar_em).toBeNull();
  });
});

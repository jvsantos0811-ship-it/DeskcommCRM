import { describe, expect, it } from "vitest";

import { periodoNoFuso } from "@/lib/datas/periodo-no-fuso";
import {
  diasDoPeriodo,
  parametrosDoPeriodo,
  periodoDosParametros,
  resolverPeriodo,
  rotuloDoPeriodo,
} from "./periodo";
import { classificarParouAntes, etapasForaDaMedida, marcoDeQualificacao, type LinhaDoRitmo } from "./parou-antes";
import { contarPorMotivo, filtrarPerdas, quemMarcou, SEM_MOTIVO, type PerdaNoPeriodo } from "./perdas";
import { recortarPeloPeriodo } from "./recorte-do-periodo";
import type { ConteudoDoRetrato, LeadDoRetrato } from "./retrato";

const busca = (o: Record<string, string>) => new URLSearchParams(o);

describe("período do painel (PC-025 item 2)", () => {
  it("atalhos a partir do 'hoje' da organização", () => {
    const hoje = "2026-11-10";
    expect(resolverPeriodo({ atalho: "hoje" }, hoje)).toEqual({ atalho: "hoje", de: hoje, ate: hoje });
    expect(resolverPeriodo({ atalho: "7d" }, hoje)).toMatchObject({ de: "2026-11-04", ate: hoje });
    expect(resolverPeriodo({ atalho: "30d" }, hoje)).toMatchObject({ de: "2026-10-12", ate: hoje });
    expect(resolverPeriodo({ atalho: "mes" }, hoje)).toMatchObject({ de: "2026-11-01", ate: hoje });
    expect(resolverPeriodo({ atalho: "mes_passado" }, hoje)).toMatchObject({ de: "2026-10-01", ate: "2026-10-31" });
    expect(resolverPeriodo({ atalho: "mes_passado" }, "2026-03-15")).toMatchObject({ de: "2026-02-01", ate: "2026-02-28" });
    expect(resolverPeriodo(null, hoje)).toBeNull();
  });

  it("personalizado: datas inclusivas; invertidas viram o recorte entre as duas", () => {
    expect(resolverPeriodo({ atalho: "personalizado", de: "2026-11-07", ate: "2026-11-01" }, "2026-11-10")).toMatchObject({
      de: "2026-11-01",
      ate: "2026-11-07",
    });
    expect(diasDoPeriodo({ atalho: "personalizado", de: "2026-11-01", ate: "2026-11-07" })).toHaveLength(7);
  });

  it("01/11 a 07/11 em Brasília = de 01/11 00:00 a 07/11 23:59:59 (instantes)", () => {
    const p = resolverPeriodo({ atalho: "personalizado", de: "2026-11-01", ate: "2026-11-07" }, "2026-11-10")!;
    const { inicio, fimExclusivo } = periodoNoFuso(p.de, p.ate, "America/Sao_Paulo");
    expect(inicio?.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(fimExclusivo?.toISOString()).toBe("2026-11-08T03:00:00.000Z");
  });

  it("o endereço guarda e devolve o mesmo período (o link copiado abre igual)", () => {
    const pedido = { atalho: "personalizado" as const, de: "2026-11-01", ate: "2026-11-07" };
    const volta = periodoDosParametros(busca(parametrosDoPeriodo(pedido)));
    expect(volta).toEqual(pedido);
    expect(periodoDosParametros(busca({ periodo: "7d" }))).toEqual({ atalho: "7d" });
    expect(periodoDosParametros(busca({}))).toBeNull();
    expect(periodoDosParametros(busca({ periodo: "personalizado", de: "2026-02-31", ate: "2026-03-01" }))).toBeNull();
    expect(periodoDosParametros(busca({ periodo: "qualquer" }))).toBeNull();
  });

  it("rótulo", () => {
    expect(rotuloDoPeriodo({ atalho: "7d", de: "2026-11-04", ate: "2026-11-10" })).toBe("04/11 a 10/11/2026");
    expect(rotuloDoPeriodo({ atalho: "hoje", de: "2026-11-10", ate: "2026-11-10" })).toBe("10/11/2026");
  });
});

function leadDoTeste(id: string, dia: string, extra: Partial<LeadDoRetrato> = {}): LeadDoRetrato {
  return {
    id,
    status: "open",
    estado: "com_nota",
    nota: 50,
    nivel: "B",
    temperatura: "morno",
    situacoes: [],
    porque: [],
    interesse: null,
    interesse_registrado: false,
    etapa_id: "e1",
    etapa: "Triagem",
    origem: "whatsapp",
    anuncio_id: null,
    anuncio_texto: null,
    criado_em: `${dia}T15:00:00.000Z`,
    dia,
    dia_da_semana: 1,
    hora: 12,
    valor_cents: null,
    chance: 10,
    respostas: 1,
    mensagens_da_empresa: 1,
    ultima_resposta_em: null,
    horas_na_etapa: 1,
    prazo_da_etapa_horas: null,
    qualificado_em: null,
    fechado_em: null,
    primeira_resposta_seg: 60,
    faixa_primeira_resposta: "ate_5_min",
    esfriou: false,
    parado_na_fila: false,
    motivo_da_perda: null,
    ...extra,
  } as LeadDoRetrato;
}

describe("o retrato recortado pelo período", () => {
  it("só os leads que entraram no período; contas refeitas pela mesma régua", () => {
    const c: ConteudoDoRetrato = {
      resumo: { pipeline_id: "p", moeda: "BRL", tipos: [] } as unknown as ConteudoDoRetrato["resumo"],
      leads: [
        leadDoTeste("a", "2026-10-31"),
        leadDoTeste("b", "2026-11-01"),
        leadDoTeste("c", "2026-11-07", { status: "lost", motivo_da_perda: "preco" }),
        leadDoTeste("d", "2026-11-08"),
      ],
      por_dia: [],
      funil: [],
      por_etapa: [{ etapa_id: "e1", etapa: "Triagem", posicao: 1, leads: 4 }],
      motivos: [],
    };
    const p = { atalho: "personalizado" as const, de: "2026-11-01", ate: "2026-11-07" };
    const r = recortarPeloPeriodo(c, p, new Date("2026-11-10T12:00:00Z"), "America/Sao_Paulo");
    expect(r.leads.map((l) => l.id)).toEqual(["b", "c"]);
    expect(r.resumo.leads).toBe(2);
    expect(r.resumo.desqualificados).toBe(1);
    expect(r.por_etapa[0]).toMatchObject({ etapa: "Triagem", leads: 2 });
    expect(r.motivos).toEqual([{ motivo: "preco", leads: 1 }]);
    expect(r.por_dia).toHaveLength(7);
    expect(r.por_dia[0]).toEqual({ dia: "2026-11-01", leads: 1 });
  });
});

describe("motivo de perda (PC-025 item 1)", () => {
  const base: Omit<PerdaNoPeriodo, "id" | "motivo"> = {
    titulo: "x",
    pipeline_id: "p",
    perdido_em: "2026-11-05T12:00:00Z",
    etapa_de_onde_saiu: "triagem",
    marcou: "pessoa",
    agente_id: null,
    origem: "whatsapp",
    anuncio_id: null,
  };
  const perdas: PerdaNoPeriodo[] = [
    { ...base, id: "1", motivo: "preco" },
    { ...base, id: "2", motivo: "preco", marcou: "ia", agente_id: "laura" },
    { ...base, id: "3", motivo: "sem_resposta", anuncio_id: "123456" },
    { ...base, id: "4", motivo: "ja_tem_advogado", etapa_de_onde_saiu: "proposta" },
    { ...base, id: "5", motivo: "  " },
  ];

  it("conta por motivo com % do total e 'sem motivo'", () => {
    const r = contarPorMotivo(perdas);
    expect(r.total).toBe(5);
    expect(r.motivos[0]).toEqual({ motivo: "preco", leads: 2, pct: 40, ids: ["1", "2"] });
    expect(r.motivos.find((m) => m.motivo === SEM_MOTIVO)).toMatchObject({ leads: 1, pct: 20 });
    expect(r.motivos.reduce((a, m) => a + m.leads, 0)).toBe(5);
  });

  it("filtros: etapa de onde saiu, quem marcou, agente, origem/anúncio", () => {
    expect(filtrarPerdas(perdas, { etapa: "proposta" }).map((p) => p.id)).toEqual(["4"]);
    expect(filtrarPerdas(perdas, { marcou: "ia" }).map((p) => p.id)).toEqual(["2"]);
    expect(filtrarPerdas(perdas, { agente: "laura" }).map((p) => p.id)).toEqual(["2"]);
    expect(filtrarPerdas(perdas, { origem: "anuncio:123456" }).map((p) => p.id)).toEqual(["3"]);
  });

  it("quem marcou, pelo ator da linha do tempo", () => {
    expect(quemMarcou("ai")).toBe("ia");
    expect(quemMarcou("user")).toBe("pessoa");
    expect(quemMarcou("rule")).toBe("outro");
    expect(quemMarcou(null)).toBe("outro");
  });
});

describe("parou antes da qualificação (PC-025 item 3)", () => {
  const agora = new Date("2026-11-10T12:00:00Z");
  const horasAtras = (h: number) => new Date(agora.getTime() - h * 3_600_000).toISOString();
  const linha = (id: string, extra: Partial<LinhaDoRitmo>): LinhaDoRitmo => ({
    lead_id: id,
    titulo: `Card ${id}`,
    status: "open",
    stage_id: "triagem",
    etapa_posicao: 1,
    criado_em: horasAtras(100),
    origem: "whatsapp",
    anuncio_id: null,
    primeira_do_cliente_em: horasAtras(100),
    primeira_resposta_em: horasAtras(99),
    respostas_depois: 0,
    ultima_do_cliente_em: horasAtras(100),
    agente_id: "recepcao",
    chegou_ao_marco: false,
    ...extra,
  });
  // O cenário do aceite: só 1ª mensagem; conversou e parou; chegou ao Qualificado; perdido.
  const cenario = [
    linha("so-primeira", {}),
    linha("parou", { respostas_depois: 3, ultima_do_cliente_em: horasAtras(30) }),
    linha("qualificado", { respostas_depois: 5, ultima_do_cliente_em: horasAtras(30), chegou_ao_marco: true, stage_id: "qualificado" }),
    linha("perdido", { status: "lost", respostas_depois: 2, ultima_do_cliente_em: horasAtras(30) }),
  ];
  const opcoes = { agora, horas: 24, fora: new Set<string>(), diaDe: (iso: string) => iso.slice(0, 10) };

  it("a) = 1 e b) = 1; o qualificado e o perdido ficam fora", () => {
    const r = classificarParouAntes(cenario, opcoes);
    expect(r.so_primeira).toBe(1);
    expect(r.parou).toBe(1);
    expect(r.cards.map((c) => c.id).sort()).toEqual(["parou", "so-primeira"]);
    expect(r.conversaram).toBe(4);
    expect(r.pct_parou).toBe(25);
  });

  it("N de 24 para 72 h: quem parou há 30 h sai de b)", () => {
    const r = classificarParouAntes(cenario, { ...opcoes, horas: 72 });
    expect(r.parou).toBe(0);
    expect(r.so_primeira).toBe(1); // parou há 100 h
  });

  it("card em etapa fora da medida não entra (nem na base)", () => {
    const r = classificarParouAntes(
      [...cenario, linha("demanda-futura", { stage_id: "futura", respostas_depois: 2, ultima_do_cliente_em: horasAtras(30) })],
      { ...opcoes, fora: new Set(["futura"]) },
    );
    expect(r.parou).toBe(1);
    expect(r.conversaram).toBe(4);
  });

  it("quem acabou de receber a 1ª resposta ainda não conta como desistente", () => {
    const r = classificarParouAntes([linha("agora", { primeira_do_cliente_em: horasAtras(1), ultima_do_cliente_em: horasAtras(1) })], opcoes);
    expect(r.so_primeira).toBe(0);
    expect(r.conversaram).toBe(1);
  });

  it("quebras por etapa, agente, origem/anúncio e dia de entrada", () => {
    const r = classificarParouAntes(cenario, opcoes);
    expect(r.quebras.parou.etapa).toEqual([{ chave: "triagem", leads: 1 }]);
    expect(r.quebras.parou.agente).toEqual([{ chave: "recepcao", leads: 1 }]);
    expect(r.quebras.parou.origem).toEqual([{ chave: "whatsapp", leads: 1 }]);
    expect(r.quebras.parou.dia).toHaveLength(1);
  });

  it("configuração do funil lida sem lançar", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(marcoDeQualificacao({ marco_de_qualificacao: id })).toBe(id);
    expect(marcoDeQualificacao({ marco_de_qualificacao: "x" })).toBeNull();
    expect(marcoDeQualificacao(null)).toBeNull();
    expect(etapasForaDaMedida({ etapas_fora_da_medida: [id, id, 3, "y"] })).toEqual([id]);
  });
});

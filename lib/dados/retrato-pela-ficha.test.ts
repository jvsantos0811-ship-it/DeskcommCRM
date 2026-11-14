/**
 * O RETRATO PELA FICHA (Regra v2 §3 e PC-037 §1) — a régua v2 do painel de Dados.
 *
 * Casos de aceite da PC-037 que não chamam modelo:
 *   - T-PM031-1: anúncio + "oi" sem contar o caso → engajado = não;
 *   - T-PM031-2: lead do anúncio "benefício negado" que contou BPC → interesse = BPC;
 *   - lead sem ficha fica em "sem leitura" e não infla contador nenhum;
 *   - organização na régua v1 continua igual (sem a chave, nada muda).
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Contar `respostas >= 3` como engajado na régua v2: T-PM031-1 acusa.
 * - Usar o `interesse` do banco (o tema do anúncio) na régua v2: T-PM031-2 acusa.
 * - Deixar o lead sem ficha com o nível da nota: "sem leitura" acusa.
 * - Guardar a ação inteira (com o evento ou o que falta) no retrato: o caso LGPD acusa.
 * - Aceitar interesse fora do catálogo: o caso LGPD acusa.
 * - Agrupar o aberto sem leitura como "desqualificado" no Explorar: o caso do Explorar acusa.
 */
import { describe, expect, it } from "vitest";

import type { FichaDoLeitor } from "./ficha";
import { montarRetrato, VERSAO_DA_REGRA, type LinhaDoRetrato } from "./retrato";
import { montarPaineis } from "./retrato";
import { REGUA_PELA_FICHA, REGUA_POR_MENSAGENS, textoDaAcaoNoRetrato, type EntradaPelaFicha } from "./retrato-pela-ficha";
import { recortarPeloPeriodo } from "./recorte-do-periodo";

// 13:00 UTC = 10:00 em São Paulo, 14/11/2026.
const AGORA = new Date("2026-11-14T13:00:00.000Z");
const FUSO = "America/Sao_Paulo";
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();

let seq = 0;
function linha(extra: Partial<LinhaDoRetrato> = {}): LinhaDoRetrato {
  seq += 1;
  return {
    lead_id: `lead-${String(seq).padStart(3, "0")}`,
    pipeline_id: "funil",
    status: "open",
    criado_em: horasAtras(30),
    etapa_desde: horasAtras(30),
    chance_da_etapa: 10,
    prazo_da_etapa_horas: null,
    chance_da_ia: null,
    faixa_da_ia: null,
    mensagens_da_empresa: 2,
    respostas: 4,
    primeira_mensagem_do_lead_em: horasAtras(30),
    primeira_resposta_da_empresa_em: horasAtras(29),
    ultima_resposta_em: horasAtras(5),
    duplicado_de_desqualificado: false,
    interesse: "Benefício negado",
    interesse_registrado: true,
    etapa_id: "recepcao",
    etapa: "Recepção",
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

function ficha(extra: Partial<FichaDoLeitor> = {}): FichaDoLeitor {
  return {
    contato: "lead",
    interesse: null,
    interesse_texto: null,
    contou_o_caso: "nao",
    requisitos: "a_confirmar",
    requisitos_faltando: [],
    requisito_em_risco: false,
    negociacao: "nenhuma",
    objecao: "nenhuma",
    fora_da_area: false,
    sem_caso: false,
    recusou: false,
    ja_atendido_por_outro: false,
    confirmar_assinatura: false,
    midia_nao_entendida: false,
    aguardando: null,
    proximo_passo_com: "lead",
    palavras_proprias: false,
    esperando_a_equipe: null,
    provas: {},
    ...extra,
  };
}

function retrato(linhas: LinhaDoRetrato[], pelaFicha?: EntradaPelaFicha) {
  return montarRetrato({
    linhas,
    agora: AGORA,
    fuso: FUSO,
    pipelineId: "funil",
    moeda: "BRL",
    tipos: [],
    etapas: [{ id: "recepcao", nome: "Recepção", posicao: 1 }],
    ...(pelaFicha ? { pelaFicha } : {}),
  });
}

describe("retrato pela ficha (régua v2)", () => {
  it("LGPD: o retrato guarda só códigos — nem o evento esperado, nem o que falta, nem interesse fora do catálogo", () => {
    const aguardando = linha();
    const morno = linha({ ultima_resposta_em: horasAtras(30) });
    const fichas = new Map<string, FichaDoLeitor>([
      [aguardando.lead_id, ficha({ contou_o_caso: "sim", aguardando: { evento: "perícia do INSS por depressão", data: "04/12" } })],
      [
        morno.lead_id,
        ficha({
          contou_o_caso: "sim",
          palavras_proprias: true,
          interesse: "auxílio-doença por câncer de mama",
          requisitos_faltando: ["laudo do oncologista"],
        }),
      ],
    ]);
    const c = retrato([aguardando, morno], { fichas, duplicados: new Set(), tipos: new Set(["BPC/LOAS"]) });
    const texto = JSON.stringify(c.leads.map((l) => l.ficha));
    for (const proibido of ["perícia", "depressão", "04/12", "câncer", "oncologista", "laudo"]) expect(texto).not.toContain(proibido);
    for (const l of c.leads) {
      expect(Object.keys(l.ficha!.acao).every((k) => k === "tipo" || k === "confirmar_assinatura")).toBe(true);
      expect(l.ficha!.interesse).toBeNull();
    }
    const acoes = c.leads.map((l) => textoDaAcaoNoRetrato(l.ficha!.acao, (x) => x));
    expect(acoes).toContain("Chamar depois do evento esperado");
  });

  it("Explorar e listas: o aberto sem leitura, agendado ou fora do funil não vira \"desqualificado\" nem \"Fechado\"; a nota antiga some", () => {
    const semLeitura = linha();
    const agendado = linha();
    const cliente = linha();
    const lido = linha();
    const c = retrato([semLeitura, agendado, cliente, lido], {
      fichas: new Map<string, FichaDoLeitor>([
        [agendado.lead_id, ficha({ contou_o_caso: "sim", aguardando: { evento: "alta", data: null } })],
        [cliente.lead_id, ficha({ contato: "cliente" })],
        [lido.lead_id, ficha({ contou_o_caso: "sim", palavras_proprias: true })],
      ]),
      duplicados: new Set(),
    });
    const p = montarPaineis(c);
    const chaves = (g: "temperatura" | "nivel") => Object.fromEntries(p.explorar[g].flatMap((x) => x.ids.map((id) => [id, x.chave])));
    for (const g of ["temperatura", "nivel"] as const) {
      expect(chaves(g)[semLeitura.lead_id]).toBe("sem_leitura");
      expect(chaves(g)[cliente.lead_id]).toBe("fora_do_funil");
      expect(Object.values(chaves(g))).not.toContain("desqualificado");
    }
    // Agendado não tem temperatura de venda, mas tem qualidade (contou o caso → B).
    expect(chaves("temperatura")[agendado.lead_id]).toBe("agendado");
    expect(chaves("nivel")[agendado.lead_id]).toBe("B");
    expect(p.explorar.nivel.every((x) => x.nota_media === null)).toBe(true);
  });

  it("esfriou pela ficha: contou o caso e está Frio; quem só chegou e esfriou não entra", () => {
    const contouEFrio = linha({ ultima_resposta_em: horasAtras(24 * 20), respostas: 1 });
    const soChegou = linha({ ultima_resposta_em: horasAtras(24 * 20), respostas: 9 });
    const c = retrato([contouEFrio, soChegou], {
      fichas: new Map<string, FichaDoLeitor>([
        [contouEFrio.lead_id, ficha({ contou_o_caso: "sim" })],
        [soChegou.lead_id, ficha({ contou_o_caso: "nao" })],
      ]),
      duplicados: new Set(),
    });
    const porId = new Map(c.leads.map((l) => [l.id, l]));
    expect(porId.get(contouEFrio.lead_id)!.esfriou).toBe(true);
    expect(porId.get(soChegou.lead_id)!.esfriou).toBe(false);
  });

  it("T-PM031-1: anúncio + oi + bom dia sem contar o caso NÃO é engajado, mesmo com 4 respostas", () => {
    const l = linha({ respostas: 4 });
    const pelaFicha = { fichas: new Map([[l.lead_id, ficha({ contou_o_caso: "nao", palavras_proprias: true })]]), duplicados: new Set<string>() };
    const v2 = retrato([l], pelaFicha).resumo;
    expect(v2.versao_regra).toBe(REGUA_PELA_FICHA);
    expect(v2.engajados).toBe(0);
    expect(v2.responderam).toBe(1);
    // Na régua v1 as 4 respostas contavam como engajado.
    expect(retrato([linha({ respostas: 4 })]).resumo.engajados).toBe(1);
  });

  it("T-PM031-2: o lead do anúncio \"benefício negado\" que contou BPC tem interesse BPC (o que contou, não o anúncio)", () => {
    const l = linha({ interesse: "Benefício negado" });
    const pelaFicha = {
      fichas: new Map([[l.lead_id, ficha({ interesse: "BPC/LOAS", contou_o_caso: "sim", palavras_proprias: true })]]),
      duplicados: new Set<string>(),
      tipos: new Set(["BPC/LOAS"]),
    };
    const c = retrato([l], pelaFicha);
    expect(c.leads[0]!.interesse).toBe("BPC/LOAS");
    expect(c.resumo.interesse_identificado).toBe(1);
    // "a_confirmar" não conta como interesse.
    const l2 = linha();
    const c2 = retrato([l2], { fichas: new Map([[l2.lead_id, ficha({ interesse: "a_confirmar" })]]), duplicados: new Set() });
    expect(c2.leads[0]!.interesse).toBeNull();
    expect(c2.resumo.interesse_identificado).toBe(0);
  });

  it("lead sem ficha fica em \"sem leitura\": sem nível, sem temperatura e fora dos contadores", () => {
    const lido = linha();
    const naoLido = linha({ respostas: 9, interesse: "BPC/LOAS" });
    const c = retrato([lido, naoLido], {
      fichas: new Map([[lido.lead_id, ficha({ contou_o_caso: "sim", palavras_proprias: true })]]),
      duplicados: new Set(),
    });
    const sem = c.leads.find((x) => x.id === naoLido.lead_id)!;
    expect(sem.ficha).toBeNull();
    expect(sem.nivel).toBeNull();
    expect(sem.temperatura).toBeNull();
    expect(sem.interesse).toBeNull();
    expect(c.resumo.pela_ficha).toMatchObject({ lidos: 1, sem_leitura: 1 });
    expect(c.resumo.engajados).toBe(1);
    expect(c.resumo.responderam).toBe(1);
    expect(c.resumo.interesse_identificado).toBe(0);
    // Os níveis contam só quem foi lido e segue na venda.
    expect(Object.values(c.resumo.niveis).reduce((a, b) => a + b, 0)).toBe(1);
    expect(c.resumo.nota_media_abertos).toBeNull();
  });

  it("cliente e duplicado saem da venda; aguardando evento é Agendado; a ordem é qualidade A → D", () => {
    const cliente = linha();
    const duplicado = linha();
    const pericia = linha();
    const qualificado = linha();
    const c = retrato([cliente, duplicado, pericia, qualificado], {
      fichas: new Map([
        [cliente.lead_id, ficha({ contato: "cliente" })],
        [duplicado.lead_id, ficha({ contou_o_caso: "sim" })],
        [pericia.lead_id, ficha({ contou_o_caso: "parcial", aguardando: { evento: "perícia do INSS", data: null } })],
        [qualificado.lead_id, ficha({ contou_o_caso: "sim", requisitos: "atende", palavras_proprias: true })],
      ]),
      duplicados: new Set([duplicado.lead_id]),
    });
    const pf = c.resumo.pela_ficha!;
    expect(pf.fora_do_funil).toBe(2);
    expect(pf.situacoes["Já é cliente"]).toBe(1);
    expect(pf.situacoes["Duplicado"]).toBe(1);
    expect(pf.agendados).toBe(1);
    expect(c.leads.find((x) => x.id === pericia.lead_id)!.temperatura).toBeNull();
    expect(c.leads.find((x) => x.id === cliente.lead_id)!.nivel).toBeNull();
    // Qualificado com fala de 5 h atrás: Quente, A — e primeiro da lista.
    expect(c.leads[0]!.id).toBe(qualificado.lead_id);
    expect(c.leads[0]!.ficha).toMatchObject({ situacao: "Qualificado", temperatura: "Quente", qualidade: "A" });
    expect(c.resumo.temperaturas.quente).toBe(1);
  });

  it("sem a chave (régua v1) nada muda: o lead não ganha ficha e a versão é a de sempre", () => {
    const l = linha();
    const c = retrato([l]);
    expect(c.resumo.versao_regra).toBe(VERSAO_DA_REGRA);
    expect(VERSAO_DA_REGRA).toBe(REGUA_POR_MENSAGENS);
    expect(c.resumo.pela_ficha).toBeUndefined();
    expect("ficha" in c.leads[0]!).toBe(false);
    expect(c.resumo.nota_media_abertos).not.toBeNull();
  });

  it("o recorte por período de um retrato pela ficha segue pela ficha, mesmo vazio", () => {
    const l = linha();
    const c = retrato([l], { fichas: new Map([[l.lead_id, ficha()]]), duplicados: new Set() });
    const vazio = recortarPeloPeriodo(c, { de: "2026-01-01", ate: "2026-01-02" } as never, AGORA, FUSO);
    expect(vazio.resumo.versao_regra).toBe(REGUA_PELA_FICHA);
    expect(vazio.leads).toHaveLength(0);
  });
});

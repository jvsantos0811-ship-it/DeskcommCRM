/**
 * A BATERIA DO LEITOR — Regra v2 §4 e PM-027 §8–§9: a régua que decide se um
 * modelo pode ler as conversas.
 *
 * Cada caso tem a conversa congelada (copiada para dentro do CRM, no escopo da
 * organização de origem) e um GABARITO: a ficha que uma pessoa escreveu lendo a
 * conversa inteira. O modelo lê a mesma conversa; esta régua compara:
 *
 *   - caso da Regra v2 (B01–B48, ficha inteira no gabarito): passa quando a
 *     REGRA FIXA dá a mesma Situação e a mesma Temperatura com a ficha do modelo
 *     e com a do gabarito (os fatos do banco e o relógio são os do caso). A
 *     Qualidade conta à parte: no mínimo 46 de 48 (Regra v2 §4);
 *   - caso do Gestor (ficha parcial no gabarito): passa quando cada campo que o
 *     gabarito afirma bate (e a Situação/Temperatura, quando o gabarito traz).
 *
 * Aprovado = 100% nos casos que bloqueiam + a Qualidade dos casos da Regra v2.
 * Divergência vai ao juiz (`juiz.ts`); o efeito da decisão é `aplicarDecisao`.
 *
 * Código puro: quem carrega os casos e chama o modelo é `bateria-rodada.ts`.
 */
import { z } from "zod";

import type { FatosDoBanco, FichaDoLeitor } from "@/lib/dados/ficha";
import { classificarFicha } from "@/lib/dados/regra-da-ficha";

// ─── A forma curta do Gestor (bateria_48.json) ────────────────────────────────

export const fichaCurtaSchema = z.object({
  contato: z.enum(["lead", "cliente", "interno", "engano", "ilegivel"]),
  interesse: z.string().optional(),
  contou: z.enum(["nao", "parcial", "sim"]).optional(),
  requisitos: z.enum(["atende", "a_confirmar", "nao_atende"]).optional(),
  falta: z.string().optional(),
  negociacao: z.enum(["nenhuma", "proposta", "contrato_enviado", "assinado"]).optional(),
  objecao: z.enum(["nenhuma", "confianca", "preco", "pensar", "familia", "documento", "outra"]).optional(),
  bola: z.enum(["lead", "escritorio"]).optional(),
  /** "dd/mm HH:MM" no fuso de São Paulo. */
  fala: z.string().optional(),
  palavras: z.boolean().optional(),
  risco: z.boolean().optional(),
  confirmar: z.boolean().optional(),
  duplicado: z.boolean().optional(),
  espera: z.string().optional(),
  fora_area: z.boolean().optional(),
  sem_caso: z.boolean().optional(),
  recusou: z.boolean().optional(),
  outro_advogado_ativo: z.boolean().optional(),
  ilegivel: z.boolean().optional(),
  nunca_respondido: z.boolean().optional(),
});
export type FichaCurta = z.infer<typeof fichaCurtaSchema>;

/** "29/10 10:15" → instante, no ano dado, em São Paulo (sem horário de verão desde 2019). */
export function instanteDaFalaCurta(fala: string | undefined, ano: number): Date | null {
  if (!fala) return null;
  const m = /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(fala.trim());
  if (!m) return null;
  return new Date(`${ano}-${m[2]}-${m[1]}T${m[3]}:${m[4]}:00-03:00`);
}

/** A ficha curta do Gestor como ficha do Leitor + os fatos do banco. */
export function daFormaCurta(f: FichaCurta, ano: number): { ficha: FichaDoLeitor; banco: FatosDoBanco } {
  return {
    ficha: {
      contato: f.contato,
      interesse: f.interesse ?? null,
      interesse_texto: null,
      contou_o_caso: f.contou ?? "nao",
      requisitos: f.requisitos ?? "a_confirmar",
      requisitos_faltando: f.falta ? [f.falta] : [],
      requisito_em_risco: f.risco ?? false,
      negociacao: f.negociacao ?? "nenhuma",
      objecao: f.objecao ?? "nenhuma",
      fora_da_area: f.fora_area ?? false,
      sem_caso: f.sem_caso ?? false,
      recusou: f.recusou ?? false,
      ja_atendido_por_outro: f.outro_advogado_ativo ?? false,
      confirmar_assinatura: f.confirmar ?? false,
      midia_nao_entendida: f.ilegivel ?? false,
      aguardando: f.espera ? { evento: f.espera, data: null } : null,
      proximo_passo_com: f.bola ?? "lead",
      palavras_proprias: f.palavras ?? false,
      esperando_a_equipe: null,
      provas: {},
    },
    banco: {
      ultima_fala_do_lead: instanteDaFalaCurta(f.fala, ano),
      duplicado: f.duplicado ?? false,
      nunca_respondido: f.nunca_respondido ?? false,
      midia_nao_entendida: false,
    },
  };
}

// ─── O caso ──────────────────────────────────────────────────────────────────

export const CAMPOS_COMPARAVEIS = [
  "contato",
  "interesse",
  "contou_o_caso",
  "requisitos",
  "negociacao",
  "objecao",
  "fora_da_area",
  "sem_caso",
  "recusou",
  "ja_atendido_por_outro",
  "confirmar_assinatura",
  "aguardando",
  "proximo_passo_com",
  "palavras_proprias",
  "esperando_a_equipe",
] as const;
export type CampoComparavel = (typeof CAMPOS_COMPARAVEIS)[number];

export interface GabaritoDoCaso {
  /** "regra_v2": ficha inteira, compara pela regra. "parcial": só os campos dados. */
  tipo: "regra_v2" | "parcial";
  ficha: Partial<FichaDoLeitor>;
  banco: FatosDoBanco;
  situacao?: string;
  temperatura?: string;
  qualidade?: string;
}

export interface CasoDaBateria {
  id: string;
  bloqueia: boolean;
  /** O relógio da regra: o instante em que a conversa foi congelada. */
  relogio: Date;
  gabarito: GabaritoDoCaso;
}

export interface Divergencia {
  campo: CampoComparavel | "situacao" | "temperatura";
  esperado: unknown;
  obtido: unknown;
}

export interface ConferenciaDoCaso {
  passou: boolean;
  /** Só nos casos da Regra v2. */
  qualidadeIgual: boolean | null;
  divergencias: Divergencia[];
}

/** Tolerância para o "desde" da espera: a hora da mensagem, lida pelo modelo. */
export const TOLERANCIA_DO_DESDE_MS = 15 * 60_000;

function normalizarTexto(v: unknown): unknown {
  return typeof v === "string" ? v.normalize("NFC").trim().toLowerCase() : v;
}

/** O modelo escreve "AAAA-MM-DDTHH:MM" no fuso da conversa; o gabarito traz o deslocamento. */
function instante(v: unknown, deslocamento = "-03:00"): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const s = v.trim();
  const comFuso = /([zZ]|[+-]\d{2}:\d{2})$/.test(s) ? s : `${s.length === 16 ? `${s}:00` : s}${deslocamento}`;
  const t = Date.parse(comFuso);
  return Number.isNaN(t) ? null : t;
}

export function campoBate(campo: CampoComparavel, esperado: unknown, obtido: unknown): boolean {
  if (esperado === null || esperado === undefined) return obtido === null || obtido === undefined;
  if (obtido === null || obtido === undefined) return false;
  if (campo === "esperando_a_equipe") {
    const e = esperado as { motivo: string; desde: string };
    const o = obtido as { motivo: string; desde: string };
    if (e.motivo !== o.motivo) return false;
    const te = instante(e.desde);
    const to = instante(o.desde);
    return te !== null && to !== null && Math.abs(te - to) <= TOLERANCIA_DO_DESDE_MS;
  }
  if (campo === "aguardando") {
    const e = esperado as { evento: string; data: string | null };
    const o = obtido as { evento: string; data: string | null };
    if (!e.data) return true; // o gabarito só afirma que há uma espera
    const te = instante(e.data);
    const to = instante(o.data);
    if (te === null || to === null) return false;
    return new Date(te).toISOString().slice(0, 10) === new Date(to).toISOString().slice(0, 10);
  }
  return normalizarTexto(esperado) === normalizarTexto(obtido);
}

function fichaCompleta(parcial: Partial<FichaDoLeitor>): FichaDoLeitor {
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
    ...parcial,
  };
}

export function conferirCaso(caso: CasoDaBateria, doModelo: FichaDoLeitor): ConferenciaDoCaso {
  const g = caso.gabarito;
  const divergencias: Divergencia[] = [];
  const pelaRegra = (ficha: FichaDoLeitor) => classificarFicha({ ficha, banco: g.banco }, caso.relogio);

  if (g.tipo === "regra_v2") {
    const esperado = pelaRegra(fichaCompleta(g.ficha));
    const obtido = pelaRegra(doModelo);
    if (esperado.situacao !== obtido.situacao) divergencias.push({ campo: "situacao", esperado: esperado.situacao, obtido: obtido.situacao });
    if (esperado.temperatura !== obtido.temperatura) {
      divergencias.push({ campo: "temperatura", esperado: esperado.temperatura, obtido: obtido.temperatura });
    }
    // O que explicaria a diferença: os campos da ficha que não batem.
    if (divergencias.length > 0) {
      for (const campo of CAMPOS_COMPARAVEIS) {
        if (!(campo in g.ficha)) continue;
        const e = (g.ficha as Record<string, unknown>)[campo];
        const o = (doModelo as Record<string, unknown>)[campo];
        if (!campoBate(campo, e, o)) divergencias.push({ campo, esperado: e, obtido: o });
      }
    }
    return {
      passou: esperado.situacao === obtido.situacao && esperado.temperatura === obtido.temperatura,
      qualidadeIgual: esperado.qualidade === obtido.qualidade,
      divergencias,
    };
  }

  for (const campo of CAMPOS_COMPARAVEIS) {
    if (!(campo in g.ficha)) continue;
    const e = (g.ficha as Record<string, unknown>)[campo];
    const o = (doModelo as Record<string, unknown>)[campo];
    if (!campoBate(campo, e, o)) divergencias.push({ campo, esperado: e, obtido: o });
  }
  if (g.situacao || g.temperatura) {
    const obtido = pelaRegra(doModelo);
    if (g.situacao && obtido.situacao !== g.situacao) divergencias.push({ campo: "situacao", esperado: g.situacao, obtido: obtido.situacao });
    if (g.temperatura && obtido.temperatura !== g.temperatura) {
      divergencias.push({ campo: "temperatura", esperado: g.temperatura, obtido: obtido.temperatura });
    }
  }
  return { passou: divergencias.length === 0, qualidadeIgual: null, divergencias };
}

// ─── O juiz e o efeito da decisão (PM-027 §9.1) ─────────────────────────────

export const DECISOES_DO_JUIZ = ["A", "B", "as_duas_erradas", "duvida"] as const;
export type DecisaoDoJuiz = (typeof DECISOES_DO_JUIZ)[number];

/** Qual lado é o gabarito. Sorteado por caso, para o juiz não saber. */
export type LadoDoGabarito = "A" | "B";

export interface EfeitoDaDecisao {
  /** O caso conta como acerto do modelo? */
  acerto: boolean;
  /** O gabarito passa a ser a resposta do modelo (nova versão da bateria). */
  corrigirGabarito: boolean;
  /** O Gestor precisa revisar o caso. */
  revisarGabarito: boolean;
}

export function aplicarDecisao(decisao: DecisaoDoJuiz, ladoDoGabarito: LadoDoGabarito): EfeitoDaDecisao {
  if (decisao === "as_duas_erradas") return { acerto: false, corrigirGabarito: false, revisarGabarito: true };
  if (decisao === "duvida") return { acerto: false, corrigirGabarito: false, revisarGabarito: true };
  const comOGabarito = decisao === ladoDoGabarito;
  return comOGabarito
    ? { acerto: false, corrigirGabarito: false, revisarGabarito: false }
    : { acerto: true, corrigirGabarito: true, revisarGabarito: false };
}

/** O juiz nunca é o modelo testado (§9.1): padrão Opus 5.5; testando o Opus, o GPT-6.1 Sol. */
export const JUIZ_PADRAO = { provider: "anthropic", model_id: "claude-opus-5-5" } as const;
export const JUIZ_QUANDO_O_TESTADO_E_O_PADRAO = { provider: "openai", model_id: "gpt-6.1-sol" } as const;

export function juizPara(
  testado: { model_id: string },
  escolhido: { provider: string; model_id: string } | null,
): { provider: string; model_id: string } {
  const mesmo = (a: string, b: string) => a.replace(/^[a-z0-9-]+\//, "").toLowerCase() === b.replace(/^[a-z0-9-]+\//, "").toLowerCase();
  if (escolhido && !mesmo(escolhido.model_id, testado.model_id)) return escolhido;
  return mesmo(JUIZ_PADRAO.model_id, testado.model_id) ? { ...JUIZ_QUANDO_O_TESTADO_E_O_PADRAO } : { ...JUIZ_PADRAO };
}

// ─── O placar ───────────────────────────────────────────────────────────────

export interface ResultadoDoCaso {
  caso: CasoDaBateria;
  /** Depois do juiz, quando houve. */
  acerto: boolean;
  qualidadeIgual: boolean | null;
}

export interface PlacarDaBateria {
  total: number;
  acertos: number;
  bloqueantes: number;
  bloqueantesAcertos: number;
  regraV2: number;
  qualidadeAcertos: number;
  aprovado: boolean;
}

/** Erros de Qualidade tolerados nos casos da Regra v2 (46 de 48). */
export const ERROS_DE_QUALIDADE_TOLERADOS = 2;

export function placarDaBateria(resultados: ResultadoDoCaso[]): PlacarDaBateria {
  const p: PlacarDaBateria = {
    total: resultados.length,
    acertos: 0,
    bloqueantes: 0,
    bloqueantesAcertos: 0,
    regraV2: 0,
    qualidadeAcertos: 0,
    aprovado: false,
  };
  for (const r of resultados) {
    if (r.acerto) p.acertos += 1;
    if (r.caso.bloqueia) {
      p.bloqueantes += 1;
      if (r.acerto) p.bloqueantesAcertos += 1;
    }
    if (r.caso.gabarito.tipo === "regra_v2") {
      p.regraV2 += 1;
      if (r.qualidadeIgual) p.qualidadeAcertos += 1;
    }
  }
  p.aprovado =
    p.total > 0 && p.bloqueantesAcertos === p.bloqueantes && p.regraV2 - p.qualidadeAcertos <= ERROS_DE_QUALIDADE_TOLERADOS;
  return p;
}

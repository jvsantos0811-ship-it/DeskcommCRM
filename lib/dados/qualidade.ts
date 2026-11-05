/**
 * NOTA DE QUALIDADE DO LEAD (0–100) E NÍVEL A–D — v3, seção 2.
 *
 * ─── Uma fonte da verdade, dividida em duas metades que não se repetem ──────
 *
 * O BANCO junta os FATOS de cada lead (`public.fn_dados_qualidade_do_lead`,
 * migration 9019): quantas vezes a empresa escreveu, quantas vezes o lead
 * respondeu depois disso, quando foi a última resposta, a chance da etapa e da
 * IA, o interesse identificado, se o contato já foi desqualificado em outro
 * card. Os fatos precisam do banco porque moram nas mensagens, e as mensagens
 * não vão para a tela.
 *
 * ESTE ARQUIVO transforma os fatos em nota, nível, temperatura e situação. Os
 * pesos vivem SÓ aqui (`PESOS_DA_NOTA`), para calibrar depois com as vendas
 * fechadas — mudar um número aqui muda o card do funil, o filtro `?nivel=` e o
 * painel de Dados ao mesmo tempo, porque os três chamam `calcularQualidade`.
 * Não há segunda cópia dos pesos em SQL para divergir.
 *
 * A regra é a do painel do Gestor (SQL de referência da ordem v3), com as
 * mesmas bordas: `round(chance × 0,4)`, janelas de 24 h, 72 h, 48 h e 7 dias,
 * limites 0–100, perdido ou card duplicado de contato desqualificado = 0,
 * ganho = 100.
 *
 * Puro: recebe `agora` por parâmetro. É isso que deixa o teste medir as bordas
 * (24/25, 44/45, 64/65) sem relógio.
 */

/** Os pesos da nota. A ordem das chaves é a ordem das parcelas no "por que". */
export const PESOS_DA_NOTA = {
  /** Base: chance de fechar × este fator, arredondada. */
  fatorDaChance: 0.4,
  /** Etapa com chance de pelo menos `chanceMinimaDaEtapa` %. */
  chanceMinimaDaEtapa: 50,
  etapaComChance: 15,
  interesseIdentificado: 15,
  /** Respondeu à IA (1 ou 2 vezes) / engajado (`respostasDeEngajado` ou mais). */
  respondeu: 10,
  respostasDeEngajado: 3,
  respondeuEngajado: 20,
  /** Última resposta dentro da janela (horas). Vale a maior que couber. */
  janelaCurtaHoras: 24,
  respondeuNaJanelaCurta: 15,
  janelaLongaHoras: 72,
  respondeuNaJanelaLonga: 8,
  iaMorno: 5,
  iaQuente: 10,
  /** Desconto: nunca respondeu e entrou há mais de N horas. */
  nuncaRespondeuDepoisDeHoras: 48,
  nuncaRespondeu: -10,
  /** Desconto: a última resposta tem mais de N dias. */
  semResponderDias: 7,
  semResponder: -10,
} as const;

export const NOTA_MINIMA = 0;
export const NOTA_MAXIMA = 100;

/** A nota mínima de cada nível. Abaixo de C é D. */
export const NOTA_MINIMA_DO_NIVEL = { A: 65, B: 45, C: 25 } as const;

export const NIVEIS = ["A", "B", "C", "D"] as const;
export type Nivel = (typeof NIVEIS)[number];

export const TEMPERATURAS = ["quente", "morno", "frio"] as const;
export type Temperatura = (typeof TEMPERATURAS)[number];

export const SITUACOES = ["esperando_fechamento", "parado", "sem_resposta"] as const;
export type Situacao = (typeof SITUACOES)[number];

/** O que fazer com cada nível — o texto que a tela passa pelo `t()`. */
export const ACAO_DO_NIVEL: Record<Nivel, string> = {
  A: "Fechar agora",
  B: "Empurrar",
  C: "Reaquecer",
  D: "Nutrir no automático",
};

/** Os fatos de um lead, como o banco os junta (uma linha da 9019). */
export interface SinaisDoLead {
  status: "open" | "won" | "lost";
  /** `crm_leads.created_at`, ISO. */
  criadoEm: string;
  /** `crm_leads.stage_changed_at`, ISO — para "parado além do prazo". */
  etapaDesde: string | null;
  /** `crm_stages.win_probability`, 0–100; sem número = 0. */
  chanceDaEtapa: number;
  /** `crm_stages.expected_duration_hours`. */
  prazoDaEtapaHoras: number | null;
  /** `crm_lead_scores.ai_probability`, 0–100, ou nulo quando a IA não calculou. */
  chanceDaIa: number | null;
  /** `crm_lead_scores.ai_probability_band`. */
  faixaDaIa: Temperatura | null;
  /** Mensagens que a empresa (IA ou pessoa) mandou ao contato. */
  mensagensDaEmpresa: number;
  /** Mensagens do lead DEPOIS da primeira da empresa — "respondeu". */
  respostas: number;
  /** A última mensagem do lead, ISO. */
  ultimaRespostaEm: string | null;
  /** Card aberto de um contato que já tem um card perdido (desqualificado). */
  duplicadoDeDesqualificado: boolean;
  /** O interesse identificado (nome do tipo de lead quando casa com o catálogo). */
  interesse: string | null;
}

export type ChaveDaParcela =
  | "chance"
  | "etapa"
  | "interesse"
  | "respondeu"
  | "respondeu_engajado"
  | "janela_curta"
  | "janela_longa"
  | "ia_quente"
  | "ia_morno"
  | "nunca_respondeu"
  | "sem_responder"
  | "limite"
  | "ganho"
  | "perdido"
  | "duplicado";

export interface Parcela {
  chave: ChaveDaParcela;
  /** Com sinal: +28, −10. Nas parcelas fixas (ganho, perdido, duplicado), a nota. */
  pontos: number;
  /** Só na parcela `chance`: a chance usada (0–100) e de onde ela veio. */
  chance?: number;
  origemDaChance?: "ia" | "etapa";
}

export type EstadoDaNota = "aberto" | "ganho" | "perdido" | "duplicado";

export interface QualidadeDoLead {
  nota: number;
  /** Nulo em ganho e perdido: nível é para quem ainda está no funil. */
  nivel: Nivel | null;
  estado: EstadoDaNota;
  /** Na ordem do "por que". Só as que valem alguma coisa. */
  parcelas: Parcela[];
  /** Nula em ganho e perdido. */
  temperatura: Temperatura | null;
  /** Só de lead aberto; pode ter mais de uma (esperando fechamento E parado). */
  situacoes: Situacao[];
  interesse: string | null;
}

const HORA = 3_600_000;

function horasDesde(iso: string | null, agora: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (agora.getTime() - t) / HORA;
}

/**
 * `round(chance × fator)` como o Postgres faz (`numeric`, metade para longe do
 * zero), sem o erro de ponto flutuante do JavaScript: a chance vira centésimos
 * inteiros e o fator, milésimos inteiros, antes da divisão.
 */
export function baseDaChance(chance: number, fator: number = PESOS_DA_NOTA.fatorDaChance): number {
  const centesimos = Math.round(chance * 100);
  const milesimos = Math.round(fator * 1000);
  const v = (centesimos * milesimos) / 100_000;
  return v >= 0 ? Math.round(v) : -Math.round(-v);
}

export function nivelDaNota(nota: number): Nivel {
  if (nota >= NOTA_MINIMA_DO_NIVEL.A) return "A";
  if (nota >= NOTA_MINIMA_DO_NIVEL.B) return "B";
  if (nota >= NOTA_MINIMA_DO_NIVEL.C) return "C";
  return "D";
}

/** A temperatura (regra 5 da ordem): etapa ≥ 50% ou IA quente; morno = IA morno ou respondeu em 72 h. */
export function temperaturaDoLead(s: SinaisDoLead, agora: Date): Temperatura | null {
  if (s.status !== "open") return null;
  if (s.duplicadoDeDesqualificado) return "frio";
  if (s.chanceDaEtapa >= PESOS_DA_NOTA.chanceMinimaDaEtapa) return "quente";
  if (s.faixaDaIa === "quente") return "quente";
  if (s.faixaDaIa === "morno") return "morno";
  const h = horasDesde(s.ultimaRespostaEm, agora);
  if (s.respostas >= 1 && h !== null && h < PESOS_DA_NOTA.janelaLongaHoras) return "morno";
  return "frio";
}

/**
 * As situações do filtro `?situacao=` (só lead aberto):
 *  - `sem_resposta`: a empresa nunca escreveu para o contato;
 *  - `esperando_fechamento`: já foi atendido e está numa etapa com chance ≥ 50%;
 *  - `parado`: está na etapa há mais tempo que o prazo dela (etapa com chance > 0).
 */
export function situacoesDoLead(s: SinaisDoLead, agora: Date): Situacao[] {
  if (s.status !== "open") return [];
  const out: Situacao[] = [];
  if (s.mensagensDaEmpresa === 0) out.push("sem_resposta");
  else if (s.chanceDaEtapa >= PESOS_DA_NOTA.chanceMinimaDaEtapa) out.push("esperando_fechamento");
  const naEtapa = horasDesde(s.etapaDesde, agora);
  if (
    s.prazoDaEtapaHoras !== null &&
    s.chanceDaEtapa > 0 &&
    naEtapa !== null &&
    naEtapa > s.prazoDaEtapaHoras
  ) {
    out.push("parado");
  }
  return out;
}

/** A nota, o nível e o "por que" de um lead. */
export function calcularQualidade(s: SinaisDoLead, agora: Date): QualidadeDoLead {
  const comum = {
    temperatura: temperaturaDoLead(s, agora),
    situacoes: situacoesDoLead(s, agora),
    interesse: s.interesse,
  };
  if (s.status === "won") {
    return { ...comum, nota: NOTA_MAXIMA, nivel: null, estado: "ganho", parcelas: [{ chave: "ganho", pontos: NOTA_MAXIMA }] };
  }
  if (s.status === "lost") {
    return { ...comum, nota: NOTA_MINIMA, nivel: null, estado: "perdido", parcelas: [{ chave: "perdido", pontos: NOTA_MINIMA }] };
  }
  if (s.duplicadoDeDesqualificado) {
    return { ...comum, nota: NOTA_MINIMA, nivel: "D", estado: "duplicado", parcelas: [{ chave: "duplicado", pontos: NOTA_MINIMA }] };
  }

  const P = PESOS_DA_NOTA;
  const parcelas: Parcela[] = [];
  const somar = (p: Parcela) => {
    if (p.pontos !== 0) parcelas.push(p);
  };

  const chance = s.chanceDaIa ?? s.chanceDaEtapa;
  somar({
    chave: "chance",
    pontos: baseDaChance(chance),
    chance,
    origemDaChance: s.chanceDaIa !== null ? "ia" : "etapa",
  });
  if (s.chanceDaEtapa >= P.chanceMinimaDaEtapa) somar({ chave: "etapa", pontos: P.etapaComChance });
  if (s.interesse) somar({ chave: "interesse", pontos: P.interesseIdentificado });
  if (s.respostas >= P.respostasDeEngajado) somar({ chave: "respondeu_engajado", pontos: P.respondeuEngajado });
  else if (s.respostas >= 1) somar({ chave: "respondeu", pontos: P.respondeu });

  const hResposta = horasDesde(s.ultimaRespostaEm, agora);
  if (s.respostas >= 1 && hResposta !== null && hResposta < P.janelaCurtaHoras) {
    somar({ chave: "janela_curta", pontos: P.respondeuNaJanelaCurta });
  } else if (s.respostas >= 1 && hResposta !== null && hResposta < P.janelaLongaHoras) {
    somar({ chave: "janela_longa", pontos: P.respondeuNaJanelaLonga });
  }
  if (s.faixaDaIa === "quente") somar({ chave: "ia_quente", pontos: P.iaQuente });
  else if (s.faixaDaIa === "morno") somar({ chave: "ia_morno", pontos: P.iaMorno });

  const hEntrou = horasDesde(s.criadoEm, agora);
  if (s.respostas === 0 && hEntrou !== null && hEntrou > P.nuncaRespondeuDepoisDeHoras) {
    somar({ chave: "nunca_respondeu", pontos: P.nuncaRespondeu });
  }
  if (hResposta !== null && hResposta > P.semResponderDias * 24) {
    somar({ chave: "sem_responder", pontos: P.semResponder });
  }

  const soma = parcelas.reduce((acc, p) => acc + p.pontos, 0);
  const nota = Math.max(NOTA_MINIMA, Math.min(NOTA_MAXIMA, soma));
  // O limite também se explica: sem esta linha, "−10 −10" somaria −20 e a tela
  // diria nota 0 sem dizer de onde veio a diferença.
  if (nota !== soma) parcelas.push({ chave: "limite", pontos: nota - soma });

  return { ...comum, nota, nivel: nivelDaNota(nota), estado: "aberto", parcelas };
}

/** A linha que a 9019 devolve, como o supabase-js a entrega (`numeric` chega como texto). */
export interface LinhaDaQualidade {
  lead_id: string;
  status: string;
  criado_em: string;
  etapa_desde: string | null;
  chance_da_etapa: number | string | null;
  prazo_da_etapa_horas: number | string | null;
  chance_da_ia: number | string | null;
  faixa_da_ia: string | null;
  mensagens_da_empresa: number | string | null;
  respostas: number | string | null;
  ultima_resposta_em: string | null;
  duplicado_de_desqualificado: boolean | null;
  interesse: string | null;
}

function numero(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A linha do banco vira os fatos. Status ou faixa fora do vocabulário viram o neutro. */
export function sinaisDaLinha(l: LinhaDaQualidade): SinaisDoLead {
  const status = l.status === "won" || l.status === "lost" ? l.status : "open";
  const faixa = (TEMPERATURAS as readonly string[]).includes(l.faixa_da_ia ?? "")
    ? (l.faixa_da_ia as Temperatura)
    : null;
  return {
    status,
    criadoEm: l.criado_em,
    etapaDesde: l.etapa_desde,
    chanceDaEtapa: numero(l.chance_da_etapa) ?? 0,
    prazoDaEtapaHoras: numero(l.prazo_da_etapa_horas),
    chanceDaIa: numero(l.chance_da_ia),
    faixaDaIa: faixa,
    mensagensDaEmpresa: numero(l.mensagens_da_empresa) ?? 0,
    respostas: numero(l.respostas) ?? 0,
    ultimaRespostaEm: l.ultima_resposta_em,
    duplicadoDeDesqualificado: Boolean(l.duplicado_de_desqualificado),
    interesse: l.interesse && l.interesse.trim() !== "" ? l.interesse.trim() : null,
  };
}

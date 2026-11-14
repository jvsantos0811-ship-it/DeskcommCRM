/**
 * O RETRATO DIÁRIO DOS PAINÉIS DE DADOS — v3, seções 4, 5 e 8.
 *
 * ─── Onde cada coisa mora ────────────────────────────────────────────────
 *
 *  - Os FATOS de cada lead: `public.fn_dados_leads_do_retrato` (migration 9020),
 *    que estende os da nota (`fn_dados_qualidade_do_lead`, 9019) com a etapa, a
 *    origem, o valor e quando o lead se qualificou — só do UNIVERSO do painel
 *    (funil padrão, sem base importada, cadastro manual nem card de teste).
 *  - A NOTA, o nível, a temperatura e a situação: `calcularQualidade`
 *    (`lib/dados/qualidade.ts`). É a mesma regra do card do funil e do filtro
 *    `?nivel=`, e é isso que faz o "Nível A · 7" do painel abrir os mesmos 7
 *    leads no funil.
 *  - Os TOTAIS e AGRUPAMENTOS: este arquivo. Puro: recebe `agora` e o fuso por
 *    parâmetro, não lê banco nem relógio, e o mesmo código monta o retrato das
 *    06:00 (cron), o "Atualizar agora" e a conta ao vivo do atendente em "só os
 *    seus".
 *
 * ─── O que o retrato NÃO guarda ──────────────────────────────────────────
 *
 * Nome de lead e texto de conversa (LGPD). O nome é lido ao vivo, pela RLS de
 * quem abre a tela; o lead anonimizado aparece anonimizado também no retrato
 * de ontem.
 */
import {
  calcularQualidade,
  NIVEIS,
  PESOS_DA_NOTA,
  sinaisDaLinha,
  TEMPERATURAS,
  type ChaveDaParcela,
  type EstadoDaNota,
  type LinhaDaQualidade,
  type Nivel,
  type Situacao,
  type Temperatura,
} from "@/lib/dados/qualidade";
import { partesNoFuso } from "@/lib/agenda/fuso";
import {
  chaveForaDaNota,
  contadoresPelaFicha,
  esfriouPelaFicha,
  fatosDoBancoDaLinha,
  fichaNoRetrato,
  nivelPelaFicha,
  ordemDaQualidade,
  REGUA_PELA_FICHA,
  REGUA_POR_MENSAGENS,
  resumoPelaFicha,
  temperaturaPelaFicha,
  type EntradaPelaFicha,
  type FichaNoRetrato,
  type ResumoPelaFicha,
} from "@/lib/dados/retrato-pela-ficha";

/**
 * Sobe quando a regra muda: comparar retratos de réguas diferentes engana. É a
 * régua que conta mensagens; a organização com o painel pela ficha grava a
 * `REGUA_PELA_FICHA` (2), e a comparação com ontem só junta retratos da mesma.
 */
export const VERSAO_DA_REGRA = REGUA_POR_MENSAGENS;
/** O retrato do dia é montado a partir desta hora, no relógio da organização. */
export const HORA_DO_RETRATO = 6;
/**
 * "Atualizar agora": no máximo uma vez a cada N minutos. Quem RECUSA é o banco
 * (`fn_dados_gravar_retrato`, 9020); este número é o da tela, e o invariante
 * `tests/invariants/retrato-de-dados.test.ts` prende os dois juntos.
 */
export const MINUTOS_ENTRE_ATUALIZACOES = 30;
/** Retratos guardados (o banco apaga os mais velhos). */
export const DIAS_GUARDADOS = 90;
/** Retrato mais velho que isto ganha o aviso "dados de [data]". */
export const HORAS_ATE_O_RETRATO_FICAR_VELHO = 30;
export const DIAS_DO_GRAFICO = 14;
export const TOP_DO_DINHEIRO = 10;
export const LIMITE_DE_PRECISAM_DE_ACAO = 30;

/** Uma linha da `fn_dados_leads_do_retrato`, como o supabase-js entrega (`numeric` como texto). */
export interface LinhaDoRetrato extends LinhaDaQualidade {
  pipeline_id: string | null;
  primeira_mensagem_do_lead_em: string | null;
  primeira_resposta_da_empresa_em: string | null;
  interesse_registrado: boolean | null;
  etapa_id: string;
  etapa: string;
  etapa_posicao: number | string | null;
  origem: string | null;
  anuncio_id: string | null;
  anuncio_texto: string | null;
  valor_cents: number | string | null;
  moeda: string | null;
  motivo_da_perda: string | null;
  fechado_em: string | null;
  qualificado_em: string | null;
}

export const FAIXAS_DA_PRIMEIRA_RESPOSTA = [
  "ate_5_min",
  "5_a_30_min",
  "30_min_a_2_h",
  "mais_de_2_h",
  "sem_resposta",
] as const;
export type FaixaDaPrimeiraResposta = (typeof FAIXAS_DA_PRIMEIRA_RESPOSTA)[number];

/** Um lead no retrato: os fatos e a nota, sem nome. */
export interface LeadDoRetrato {
  id: string;
  status: "open" | "won" | "lost";
  estado: EstadoDaNota;
  nota: number;
  nivel: Nivel | null;
  temperatura: Temperatura | null;
  situacoes: Situacao[];
  /** As parcelas da nota, na ordem do "por que": [chave, pontos]. */
  porque: Array<[ChaveDaParcela, number]>;
  interesse: string | null;
  interesse_registrado: boolean;
  etapa_id: string;
  etapa: string;
  origem: string;
  anuncio_id: string | null;
  anuncio_texto: string | null;
  criado_em: string;
  /** O dia em que entrou, no fuso da organização (AAAA-MM-DD). */
  dia: string;
  /** 0 = domingo. No fuso da organização. */
  dia_da_semana: number;
  hora: number;
  valor_cents: number | null;
  /** 0–100: a chance usada na nota (IA, senão etapa); ganho 100; perdido e card duplicado 0. */
  chance: number;
  respostas: number;
  mensagens_da_empresa: number;
  ultima_resposta_em: string | null;
  horas_na_etapa: number | null;
  prazo_da_etapa_horas: number | null;
  qualificado_em: string | null;
  fechado_em: string | null;
  primeira_resposta_seg: number | null;
  faixa_primeira_resposta: FaixaDaPrimeiraResposta;
  /** Conversou 3 vezes ou mais e está frio (aberto, não duplicado). */
  esfriou: boolean;
  /** Aberto e esperando fechamento, parado além do prazo ou sem resposta. */
  parado_na_fila: boolean;
  motivo_da_perda: string | null;
  /**
   * Régua v2 (painel pela ficha): o que a regra fixa devolveu para este lead, ou
   * `null` quando ele ainda não foi lido ("sem leitura"). Ausente na régua v1.
   */
  ficha?: FichaNoRetrato | null;
}

export interface TipoDoCatalogo {
  nome: string;
  preco_cents: number | null;
}

export interface EtapaDoFunil {
  id: string;
  nome: string;
  posicao: number;
}

/** Os números do retrato — o que a comparação com ontem e com 7 dias usa. */
export interface ResumoDoRetrato {
  versao_regra: number;
  pipeline_id: string | null;
  moeda: string;
  tipos: TipoDoCatalogo[];
  leads: number;
  abertos: number;
  ganhos: number;
  desqualificados: number;
  nota_media_abertos: number | null;
  responderam: number;
  engajados: number;
  interesse_identificado: number;
  interesse_registrado: number;
  niveis: Record<Nivel, number>;
  temperaturas: Record<Temperatura, number>;
  esperando_fechamento: number;
  parado: number;
  sem_resposta: number;
  em_jogo_cents: number;
  previsao_cents: number;
  parado_na_fila_cents: number;
  parado_na_fila_leads: number;
  esfriou_cents: number;
  esfriou_leads: number;
  abertos_com_valor: number;
  abertos_sem_valor: number;
  leads_hoje: number;
  leads_ontem: number;
  leads_7_dias: number;
  leads_7_dias_anteriores: number;
  qualificados: number;
  qualificados_7_dias: number;
  fechados_7_dias: number;
  mediana_primeira_resposta_seg: number | null;
  /** Só na régua v2: lidos, sem leitura, fora do funil de venda, agendados, situações e alertas. */
  pela_ficha?: ResumoPelaFicha;
}

export interface PontoPorDia {
  dia: string;
  leads: number;
}

export const PASSOS_DO_FUNIL = ["entraram", "responderam", "engajaram", "qualificados", "fechados"] as const;
export type PassoDoFunil = (typeof PASSOS_DO_FUNIL)[number];
export interface PassoDoFunilContado {
  passo: PassoDoFunil;
  leads: number;
}

export interface LeadsNaEtapa {
  etapa_id: string;
  etapa: string;
  posicao: number;
  leads: number;
}

export interface MotivoContado {
  motivo: string;
  leads: number;
}

/** O que a tabela `crm_dados_retrato` guarda (além do dia, do fuso e da origem). */
export interface ConteudoDoRetrato {
  resumo: ResumoDoRetrato;
  leads: LeadDoRetrato[];
  por_dia: PontoPorDia[];
  funil: PassoDoFunilContado[];
  por_etapa: LeadsNaEtapa[];
  motivos: MotivoContado[];
}

const HORA = 3_600_000;
const DIA = 24 * HORA;

function numero(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function doisDigitos(n: number): string {
  return String(n).padStart(2, "0");
}

/** O dia civil de um instante no fuso (AAAA-MM-DD). */
export function diaNoFuso(instante: Date, fuso: string): string {
  const p = partesNoFuso(instante, fuso);
  return `${p.ano}-${doisDigitos(p.mes)}-${doisDigitos(p.dia)}`;
}

/** Soma dias a um AAAA-MM-DD, no calendário (sem fuso: é data, não instante). */
export function somarDias(dia: string, n: number): string {
  const [a, m, d] = dia.split("-").map(Number);
  const t = Date.UTC(a ?? 1970, (m ?? 1) - 1, d ?? 1) + n * DIA;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${doisDigitos(x.getUTCMonth() + 1)}-${doisDigitos(x.getUTCDate())}`;
}

/** A faixa do tempo da 1ª resposta (regra do painel do Gestor). */
export function faixaDaPrimeiraResposta(segundos: number | null, mensagensDaEmpresa: number): FaixaDaPrimeiraResposta {
  if (mensagensDaEmpresa === 0 || segundos === null) return "sem_resposta";
  if (segundos < 300) return "ate_5_min";
  if (segundos < 1800) return "5_a_30_min";
  if (segundos < 7200) return "30_min_a_2_h";
  return "mais_de_2_h";
}

/** Uma linha do banco vira o lead do retrato, com a nota da regra única. */
export function leadDoRetrato(
  linha: LinhaDoRetrato,
  agora: Date,
  fuso: string,
  pelaFicha?: EntradaPelaFicha,
): LeadDoRetrato {
  const sinais = sinaisDaLinha(linha);
  const q = calcularQualidade(sinais, agora);
  const criado = new Date(linha.criado_em);
  const p = partesNoFuso(criado, fuso);
  const dia = `${p.ano}-${doisDigitos(p.mes)}-${doisDigitos(p.dia)}`;
  const diaDaSemana = new Date(Date.UTC(p.ano, p.mes - 1, p.dia)).getUTCDay();

  const t1 = linha.primeira_mensagem_do_lead_em ? Date.parse(linha.primeira_mensagem_do_lead_em) : NaN;
  const t2 = linha.primeira_resposta_da_empresa_em ? Date.parse(linha.primeira_resposta_da_empresa_em) : NaN;
  const primeiraResposta = Number.isFinite(t1) && Number.isFinite(t2) ? Math.max(0, Math.round((t2 - t1) / 1000)) : null;

  const etapaDesde = linha.etapa_desde ? Date.parse(linha.etapa_desde) : NaN;
  const horasNaEtapa = Number.isFinite(etapaDesde) ? Math.round((agora.getTime() - etapaDesde) / HORA) : null;

  const chance =
    q.estado === "ganho" ? 100 : q.estado === "perdido" || q.estado === "duplicado" ? 0 : (sinais.chanceDaIa ?? sinais.chanceDaEtapa);
  const aberto = sinais.status === "open";
  // A régua v2 decide "esfriou" pela ficha mais abaixo (Regra v2 §3: nada de contar mensagem).
  const esfriouPorMensagens =
    aberto && !sinais.duplicadoDeDesqualificado && sinais.respostas >= PESOS_DA_NOTA.respostasDeEngajado && q.temperatura === "frio";
  const valor = numero(linha.valor_cents);

  // Régua v2: a ficha manda no nível, na temperatura e no interesse. Lead sem
  // ficha fica "sem leitura" (nível e temperatura nulos): não entra em contador.
  let ficha: FichaNoRetrato | null | undefined;
  if (pelaFicha) {
    const f = pelaFicha.fichas.get(linha.lead_id);
    ficha = f
      ? fichaNoRetrato(
          f,
          fatosDoBancoDaLinha({
            ultimaFalaDoLead: sinais.ultimaRespostaEm,
            primeiraMensagemDoLeadEm: linha.primeira_mensagem_do_lead_em,
            primeiraRespostaDaEmpresaEm: linha.primeira_resposta_da_empresa_em,
            duplicado: pelaFicha.duplicados.has(linha.lead_id),
          }),
          agora,
          pelaFicha.tipos,
        )
      : null;
  }
  const nivel = ficha === undefined ? q.nivel : aberto ? nivelPelaFicha(ficha) : null;
  const temperatura = ficha === undefined ? q.temperatura : aberto ? temperaturaPelaFicha(ficha) : null;
  const interesse = ficha === undefined ? q.interesse : (ficha?.interesse ?? null);
  const esfriou = ficha === undefined ? esfriouPorMensagens : aberto && esfriouPelaFicha(ficha);

  return {
    id: linha.lead_id,
    status: sinais.status,
    estado: q.estado,
    nota: q.nota,
    nivel,
    temperatura,
    situacoes: q.situacoes,
    porque: q.parcelas.map((x) => [x.chave, x.pontos]),
    interesse,
    interesse_registrado: Boolean(linha.interesse_registrado),
    etapa_id: linha.etapa_id,
    etapa: linha.etapa,
    origem: linha.origem?.trim() || "outra",
    anuncio_id: linha.anuncio_id?.trim() || null,
    anuncio_texto: linha.anuncio_texto?.trim() || null,
    criado_em: linha.criado_em,
    dia,
    dia_da_semana: diaDaSemana,
    hora: p.hora,
    valor_cents: valor !== null && valor > 0 ? Math.round(valor) : null,
    chance,
    respostas: sinais.respostas,
    mensagens_da_empresa: sinais.mensagensDaEmpresa,
    ultima_resposta_em: sinais.ultimaRespostaEm,
    horas_na_etapa: aberto ? horasNaEtapa : null,
    prazo_da_etapa_horas: sinais.prazoDaEtapaHoras,
    qualificado_em: linha.qualificado_em,
    fechado_em: linha.fechado_em,
    primeira_resposta_seg: primeiraResposta,
    faixa_primeira_resposta: faixaDaPrimeiraResposta(primeiraResposta, sinais.mensagensDaEmpresa),
    esfriou,
    parado_na_fila: aberto && q.situacoes.length > 0,
    motivo_da_perda: sinais.status === "lost" ? linha.motivo_da_perda?.trim() || null : null,
    ...(ficha === undefined ? {} : { ficha }),
  };
}

/** Valor esperado em centavos: valor × chance, arredondado. */
export function valorEsperado(l: Pick<LeadDoRetrato, "valor_cents" | "chance">): number {
  return l.valor_cents === null ? 0 : Math.round((l.valor_cents * l.chance) / 100);
}

/** Mediana de uma lista (vazia = nulo). */
export function mediana(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 === 1 ? o[m]! : Math.round((o[m - 1]! + o[m]!) / 2);
}

function media(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function dentroDe(iso: string | null, desde: number, ate: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= desde && t < ate;
}

interface Contexto {
  agora: Date;
  fuso: string;
  pipelineId: string | null;
  moeda: string;
  tipos: TipoDoCatalogo[];
  /** A régua do retrato (1 = mensagens, 2 = ficha). */
  regua: number;
}

/** A régua de leads já montados: a v2 marca todo lead com `ficha` (objeto ou `null`). */
function reguaDosLeads(leads: LeadDoRetrato[], regua?: number): number {
  if (regua !== undefined) return regua;
  return leads.some((l) => l.ficha !== undefined) ? REGUA_PELA_FICHA : REGUA_POR_MENSAGENS;
}

/** Os números do retrato, a partir dos leads. */
export function resumir(leads: LeadDoRetrato[], ctx: Contexto): ResumoDoRetrato {
  const abertos = leads.filter((l) => l.status === "open");
  const hoje = diaNoFuso(ctx.agora, ctx.fuso);
  const ontem = somarDias(hoje, -1);
  const seisAtras = somarDias(hoje, -6);
  const trezeAtras = somarDias(hoje, -13);
  const agoraMs = ctx.agora.getTime();
  const seteDiasAtras = agoraMs - 7 * DIA;

  const niveis = Object.fromEntries(NIVEIS.map((n) => [n, 0])) as Record<Nivel, number>;
  const temperaturas = Object.fromEntries(TEMPERATURAS.map((t) => [t, 0])) as Record<Temperatura, number>;
  for (const l of abertos) {
    if (l.nivel) niveis[l.nivel] += 1;
    if (l.temperatura) temperaturas[l.temperatura] += 1;
  }
  const soma = (xs: LeadDoRetrato[], f: (l: LeadDoRetrato) => number) => xs.reduce((a, l) => a + f(l), 0);
  const paradoNaFila = abertos.filter((l) => l.parado_na_fila);
  const esfriaram = abertos.filter((l) => l.esfriou);
  const pelaFicha = ctx.regua === REGUA_PELA_FICHA;
  const contadores = pelaFicha ? contadoresPelaFicha(leads) : null;

  return {
    versao_regra: ctx.regua,
    pipeline_id: ctx.pipelineId,
    moeda: ctx.moeda,
    tipos: ctx.tipos,
    leads: leads.length,
    abertos: abertos.length,
    ganhos: leads.filter((l) => l.status === "won").length,
    desqualificados: leads.filter((l) => l.status === "lost").length,
    // A régua v2 não tem nota 0–100 (Regra v2 §3: "sai a nota").
    nota_media_abertos: pelaFicha ? null : media(abertos.map((l) => l.nota)),
    responderam: contadores ? contadores.responderam : leads.filter((l) => l.respostas >= 1).length,
    engajados: contadores ? contadores.engajados : leads.filter((l) => l.respostas >= PESOS_DA_NOTA.respostasDeEngajado).length,
    interesse_identificado: contadores ? contadores.interesse : leads.filter((l) => l.interesse !== null).length,
    interesse_registrado: leads.filter((l) => l.interesse_registrado).length,
    niveis,
    temperaturas,
    esperando_fechamento: abertos.filter((l) => l.situacoes.includes("esperando_fechamento")).length,
    parado: abertos.filter((l) => l.situacoes.includes("parado")).length,
    sem_resposta: abertos.filter((l) => l.situacoes.includes("sem_resposta")).length,
    em_jogo_cents: soma(abertos, (l) => l.valor_cents ?? 0),
    previsao_cents: soma(abertos, valorEsperado),
    parado_na_fila_cents: soma(paradoNaFila, (l) => l.valor_cents ?? 0),
    parado_na_fila_leads: paradoNaFila.length,
    esfriou_cents: soma(esfriaram, (l) => l.valor_cents ?? 0),
    esfriou_leads: esfriaram.length,
    abertos_com_valor: abertos.filter((l) => l.valor_cents !== null).length,
    abertos_sem_valor: abertos.filter((l) => l.valor_cents === null).length,
    leads_hoje: leads.filter((l) => l.dia === hoje).length,
    leads_ontem: leads.filter((l) => l.dia === ontem).length,
    leads_7_dias: leads.filter((l) => l.dia >= seisAtras && l.dia <= hoje).length,
    leads_7_dias_anteriores: leads.filter((l) => l.dia >= trezeAtras && l.dia < seisAtras).length,
    qualificados: leads.filter((l) => l.qualificado_em !== null).length,
    qualificados_7_dias: leads.filter((l) => dentroDe(l.qualificado_em, seteDiasAtras, agoraMs + 1)).length,
    fechados_7_dias: leads.filter((l) => l.status === "won" && dentroDe(l.fechado_em, seteDiasAtras, agoraMs + 1)).length,
    mediana_primeira_resposta_seg: mediana(
      leads.map((l) => l.primeira_resposta_seg).filter((s): s is number => s !== null),
    ),
    ...(pelaFicha ? { pela_ficha: resumoPelaFicha(leads) } : {}),
  };
}

export interface EntradaDoRetrato {
  linhas: LinhaDoRetrato[];
  agora: Date;
  fuso: string;
  pipelineId: string | null;
  moeda: string;
  tipos: TipoDoCatalogo[];
  /** As etapas do funil padrão, para "Leads por etapa" mostrar também a etapa vazia. */
  etapas: EtapaDoFunil[];
  /** Régua v2: as fichas e os duplicados. Ausente = régua v1 (conta mensagens). */
  pelaFicha?: EntradaPelaFicha;
}

/** O retrato inteiro: leads, resumo e as séries que a tela desenha. */
export function montarRetrato(e: EntradaDoRetrato): ConteudoDoRetrato {
  const leads = e.linhas.map((l) => leadDoRetrato(l, e.agora, e.fuso, e.pelaFicha));
  if (e.pelaFicha) {
    // Régua v2: qualidade A → D (sem leitura por último), depois o mais novo.
    leads.sort(
      (a, b) =>
        ordemDaQualidade(a.ficha) - ordemDaQualidade(b.ficha) || b.criado_em.localeCompare(a.criado_em) || a.id.localeCompare(b.id),
    );
  } else {
    // A ordem que a tela usa nas listas: maior nota primeiro, depois o mais novo.
    leads.sort((a, b) => b.nota - a.nota || b.criado_em.localeCompare(a.criado_em) || a.id.localeCompare(b.id));
  }
  return montarConteudo(leads, { ...e, regua: e.pelaFicha ? REGUA_PELA_FICHA : REGUA_POR_MENSAGENS });
}

/**
 * Resumo e séries a partir de leads JÁ montados (e já ordenados). É o miolo de
 * `montarRetrato` e o que o período do painel (PC-025) usa para refazer os
 * números só com os leads que entraram no período, sem reler o banco.
 *
 * `dias`: os dias do gráfico "por dia". Ausente = os últimos 14 até hoje.
 */
export function montarConteudo(
  leads: LeadDoRetrato[],
  e: Pick<EntradaDoRetrato, "agora" | "fuso" | "pipelineId" | "moeda" | "tipos" | "etapas"> & { regua?: number },
  dias?: readonly string[],
): ConteudoDoRetrato {
  const ctx: Contexto = {
    agora: e.agora,
    fuso: e.fuso,
    pipelineId: e.pipelineId,
    moeda: e.moeda,
    tipos: e.tipos,
    regua: reguaDosLeads(leads, e.regua),
  };
  const resumo = resumir(leads, ctx);

  const hoje = diaNoFuso(e.agora, e.fuso);
  const diasDoGrafico =
    dias ?? Array.from({ length: DIAS_DO_GRAFICO }, (_, i) => somarDias(hoje, i - (DIAS_DO_GRAFICO - 1)));
  const porDia = new Map<string, number>();
  for (const l of leads) porDia.set(l.dia, (porDia.get(l.dia) ?? 0) + 1);
  const por_dia: PontoPorDia[] = diasDoGrafico.map((dia) => ({ dia, leads: porDia.get(dia) ?? 0 }));

  const funil: PassoDoFunilContado[] = [
    { passo: "entraram", leads: resumo.leads },
    { passo: "responderam", leads: resumo.responderam },
    { passo: "engajaram", leads: resumo.engajados },
    { passo: "qualificados", leads: resumo.qualificados },
    { passo: "fechados", leads: resumo.ganhos },
  ];

  const etapas = new Map<string, LeadsNaEtapa>();
  for (const s of e.etapas) etapas.set(s.id, { etapa_id: s.id, etapa: s.nome, posicao: s.posicao, leads: 0 });
  for (const l of leads) {
    const atual = etapas.get(l.etapa_id);
    if (atual) atual.leads += 1;
    else etapas.set(l.etapa_id, { etapa_id: l.etapa_id, etapa: l.etapa, posicao: Number.MAX_SAFE_INTEGER, leads: 1 });
  }
  const por_etapa = [...etapas.values()].sort((a, b) => a.posicao - b.posicao || a.etapa.localeCompare(b.etapa));

  const motivosMap = new Map<string, number>();
  for (const l of leads) {
    if (l.status !== "lost") continue;
    const m = l.motivo_da_perda ?? "";
    motivosMap.set(m, (motivosMap.get(m) ?? 0) + 1);
  }
  const motivos = [...motivosMap.entries()]
    .map(([motivo, n]) => ({ motivo, leads: n }))
    .sort((a, b) => b.leads - a.leads || a.motivo.localeCompare(b.motivo));

  return { resumo, leads, por_dia, funil, por_etapa, motivos };
}

// ─── O que a tela mostra, montado no servidor a partir do retrato ──────────

export interface LinhaPorInteresse {
  /** Nulo = "Não identificado". */
  interesse: string | null;
  leads: number;
  abertos: number;
  niveis: Record<Nivel, number>;
  desqualificados: number;
  fechados: number;
  valor_medio_cents: number | null;
  em_jogo_cents: number;
  previsao_cents: number;
  parado_cents: number;
}

export interface LinhaPorOrigem {
  origem: string;
  leads: number;
  responderam: number;
  leads_ab: number;
  nota_media: number | null;
}

export const AGRUPAMENTOS = [
  "interesse",
  "nivel",
  "temperatura",
  "origem",
  "anuncio",
  "etapa",
  "primeira_resposta",
  "dia_da_semana",
  "hora",
] as const;
export type Agrupamento = (typeof AGRUPAMENTOS)[number];

export const MEDIDAS = ["leads", "pct_resposta", "pct_qualificacao", "nota_media", "leads_ab", "em_jogo_cents"] as const;
export type Medida = (typeof MEDIDAS)[number];

export interface GrupoDoExplorar {
  /** A chave do grupo ("" = sem valor: não identificado, sem anúncio…). */
  chave: string;
  ids: string[];
  leads: number;
  pct_resposta: number;
  pct_qualificacao: number;
  /** Nota média dos ABERTOS do grupo; nulo quando o grupo não tem aberto. */
  nota_media: number | null;
  leads_ab: number;
  em_jogo_cents: number;
}

export interface Paineis {
  por_interesse: LinhaPorInteresse[];
  por_origem: LinhaPorOrigem[];
  /** Ids dos 10 abertos de maior valor esperado. */
  onde_esta_o_dinheiro: string[];
  /** Ids dos abertos que precisam de ação, na ordem de urgência. */
  precisam_de_acao: string[];
  explorar: Record<Agrupamento, GrupoDoExplorar[]>;
}

function pct(parte: number, todo: number): number {
  return todo === 0 ? 0 : Math.round((parte / todo) * 100);
}

/** Régua v2 marca todo lead com `ficha` (objeto ou nulo); v1 não tem o campo. */
function pelaFicha(ls: LeadDoRetrato[]): boolean {
  return ls.some((l) => l.ficha !== undefined);
}

/** Respondeu: na régua v2, escreveu com as próprias palavras (PC-037); na v1, mandou 1 mensagem. */
function respondeu(l: LeadDoRetrato): boolean {
  return l.ficha === undefined ? l.respostas >= 1 : Boolean(l.ficha?.palavras_proprias);
}

function chaveDoGrupo(l: LeadDoRetrato, g: Agrupamento): string {
  switch (g) {
    case "interesse":
      return l.interesse ?? "";
    case "nivel":
      return l.status === "lost" ? "desqualificado" : l.status === "won" ? "fechado" : (l.nivel ?? chaveForaDaNota(l) ?? "");
    case "temperatura":
      return l.temperatura ?? chaveForaDaNota(l) ?? (l.status === "won" ? "fechado" : "desqualificado");
    case "origem":
      return l.origem;
    case "anuncio":
      return l.anuncio_id ?? "";
    case "etapa":
      return l.etapa_id;
    case "primeira_resposta":
      return l.faixa_primeira_resposta;
    case "dia_da_semana":
      return String(l.dia_da_semana);
    case "hora":
      return doisDigitos(l.hora);
  }
}

/** A ordem fixa dos grupos que têm ordem natural; os outros vão por tamanho. */
function ordemDoGrupo(g: Agrupamento): ((a: string, b: string) => number) | null {
  const porLista = (lista: readonly string[]) => (a: string, b: string) => {
    const ia = lista.indexOf(a);
    const ib = lista.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  };
  switch (g) {
    case "nivel":
      return porLista([...NIVEIS, "fechado", "desqualificado"]);
    case "temperatura":
      return porLista([...TEMPERATURAS, "fechado", "desqualificado"]);
    case "primeira_resposta":
      return porLista(FAIXAS_DA_PRIMEIRA_RESPOSTA);
    case "dia_da_semana":
    case "hora":
      return (a, b) => a.localeCompare(b);
    default:
      return null;
  }
}

/** Agrupa os leads e mede cada grupo (Explorar). */
export function agrupar(leads: LeadDoRetrato[], g: Agrupamento, posicaoDaEtapa?: Map<string, number>): GrupoDoExplorar[] {
  const grupos = new Map<string, LeadDoRetrato[]>();
  for (const l of leads) {
    const k = chaveDoGrupo(l, g);
    const lista = grupos.get(k);
    if (lista) lista.push(l);
    else grupos.set(k, [l]);
  }
  const out = [...grupos.entries()].map(([chave, ls]): GrupoDoExplorar => {
    const abertos = ls.filter((l) => l.status === "open");
    return {
      chave,
      ids: ls.map((l) => l.id),
      leads: ls.length,
      pct_resposta: pct(ls.filter(respondeu).length, ls.length),
      pct_qualificacao: pct(ls.filter((l) => l.qualificado_em !== null).length, ls.length),
      nota_media: pelaFicha(ls) ? null : media(abertos.map((l) => l.nota)),
      leads_ab: abertos.filter((l) => l.nivel === "A" || l.nivel === "B").length,
      em_jogo_cents: abertos.reduce((a, l) => a + (l.valor_cents ?? 0), 0),
    };
  });
  const ordem = g === "etapa" && posicaoDaEtapa
    ? (a: string, b: string) => (posicaoDaEtapa.get(a) ?? 1e15) - (posicaoDaEtapa.get(b) ?? 1e15)
    : ordemDoGrupo(g);
  out.sort((a, b) => {
    // O grupo "sem valor" vai por último, sempre.
    if (a.chave === "" && b.chave !== "") return 1;
    if (b.chave === "" && a.chave !== "") return -1;
    return ordem ? ordem(a.chave, b.chave) : b.leads - a.leads || a.chave.localeCompare(b.chave, "pt-BR");
  });
  return out;
}

/** A urgência de "Precisam de ação": menor = mais urgente. */
function urgencia(l: LeadDoRetrato): number {
  const esperando = l.situacoes.includes("esperando_fechamento");
  const parado = l.situacoes.includes("parado");
  if (esperando && parado) return 0;
  if (l.situacoes.includes("sem_resposta")) return 1;
  if (esperando) return 2;
  if (parado) return 3;
  return 4; // esfriou
}

/** Os painéis da tela (tipos, origens, top 10, ação e Explorar), do retrato. */
export function montarPaineis(c: Pick<ConteudoDoRetrato, "leads" | "resumo" | "por_etapa">): Paineis {
  const { leads, resumo } = c;
  const preco = new Map(resumo.tipos.map((t) => [t.nome, t.preco_cents]));

  const porInteresse = new Map<string, LeadDoRetrato[]>();
  for (const l of leads) {
    const k = l.interesse ?? "";
    const lista = porInteresse.get(k);
    if (lista) lista.push(l);
    else porInteresse.set(k, [l]);
  }
  const por_interesse = [...porInteresse.entries()]
    .map(([k, ls]): LinhaPorInteresse => {
      const abertos = ls.filter((l) => l.status === "open");
      const niveis = Object.fromEntries(NIVEIS.map((n) => [n, 0])) as Record<Nivel, number>;
      for (const l of abertos) if (l.nivel) niveis[l.nivel] += 1;
      return {
        interesse: k === "" ? null : k,
        leads: ls.length,
        abertos: abertos.length,
        niveis,
        desqualificados: ls.filter((l) => l.status === "lost").length,
        fechados: ls.filter((l) => l.status === "won").length,
        valor_medio_cents: k === "" ? null : (preco.get(k) ?? null),
        em_jogo_cents: abertos.reduce((a, l) => a + (l.valor_cents ?? 0), 0),
        previsao_cents: abertos.reduce((a, l) => a + valorEsperado(l), 0),
        parado_cents: abertos.filter((l) => l.parado_na_fila).reduce((a, l) => a + (l.valor_cents ?? 0), 0),
      };
    })
    .sort((a, b) => {
      if (a.interesse === null && b.interesse !== null) return 1;
      if (b.interesse === null && a.interesse !== null) return -1;
      return b.em_jogo_cents - a.em_jogo_cents || b.leads - a.leads || (a.interesse ?? "").localeCompare(b.interesse ?? "", "pt-BR");
    });

  const porOrigem = new Map<string, LeadDoRetrato[]>();
  for (const l of leads) {
    const lista = porOrigem.get(l.origem);
    if (lista) lista.push(l);
    else porOrigem.set(l.origem, [l]);
  }
  const por_origem = [...porOrigem.entries()]
    .map(([origem, ls]): LinhaPorOrigem => {
      const abertos = ls.filter((l) => l.status === "open");
      return {
        origem,
        leads: ls.length,
        responderam: ls.filter(respondeu).length,
        leads_ab: abertos.filter((l) => l.nivel === "A" || l.nivel === "B").length,
        nota_media: pelaFicha(ls) ? null : media(abertos.map((l) => l.nota)),
      };
    })
    .sort((a, b) => b.leads - a.leads || a.origem.localeCompare(b.origem));

  const abertos = leads.filter((l) => l.status === "open");
  const onde_esta_o_dinheiro = abertos
    .filter((l) => l.valor_cents !== null && valorEsperado(l) > 0)
    .sort((a, b) => valorEsperado(b) - valorEsperado(a) || (b.valor_cents ?? 0) - (a.valor_cents ?? 0) || a.id.localeCompare(b.id))
    .slice(0, TOP_DO_DINHEIRO)
    .map((l) => l.id);

  const precisam_de_acao = abertos
    .filter((l) => l.parado_na_fila || l.esfriou)
    .sort((a, b) => urgencia(a) - urgencia(b) || (b.horas_na_etapa ?? 0) - (a.horas_na_etapa ?? 0) || a.id.localeCompare(b.id))
    .slice(0, LIMITE_DE_PRECISAM_DE_ACAO)
    .map((l) => l.id);

  const posicao = new Map(c.por_etapa.map((e) => [e.etapa_id, e.posicao]));
  const explorar = Object.fromEntries(AGRUPAMENTOS.map((g) => [g, agrupar(leads, g, posicao)])) as Record<
    Agrupamento,
    GrupoDoExplorar[]
  >;

  return { por_interesse, por_origem, onde_esta_o_dinheiro, precisam_de_acao, explorar };
}

// ─── A comparação e o rótulo do horário ───────────────────────────────────

/** A diferença de um número contra o retrato anterior; nulo quando não dá para comparar. */
export function variacao(atual: number | null | undefined, anterior: number | null | undefined): number | null {
  if (atual === null || atual === undefined || anterior === null || anterior === undefined) return null;
  return atual - anterior;
}

/** Pontos percentuais: (a/b − c/d) × 100, arredondado. */
export function variacaoEmPontos(
  parte: number,
  todo: number,
  parteAntes: number | null | undefined,
  todoAntes: number | null | undefined,
): number | null {
  if (parteAntes === null || parteAntes === undefined || !todoAntes) return null;
  return pct(parte, todo) - pct(parteAntes, todoAntes);
}

export type QuandoFoiGerado =
  | { tipo: "hoje"; hora: string }
  | { tipo: "ontem"; hora: string }
  | { tipo: "velho"; data: string };

/**
 * O rótulo do topo: "Atualizado hoje às 06:00", "ontem às 06:00" ou, passadas
 * 30 horas, o aviso "dados de 03/11". Hoje e ontem são do relógio da organização.
 */
export function quandoFoiGerado(geradoEm: string, agora: Date, fuso: string): QuandoFoiGerado {
  const g = new Date(geradoEm);
  const p = partesNoFuso(g, fuso);
  const hora = `${doisDigitos(p.hora)}:${doisDigitos(p.minuto)}`;
  if (agora.getTime() - g.getTime() > HORAS_ATE_O_RETRATO_FICAR_VELHO * HORA) {
    return { tipo: "velho", data: `${doisDigitos(p.dia)}/${doisDigitos(p.mes)}` };
  }
  const diaG = `${p.ano}-${doisDigitos(p.mes)}-${doisDigitos(p.dia)}`;
  const hoje = diaNoFuso(agora, fuso);
  if (diaG === hoje) return { tipo: "hoje", hora };
  return { tipo: "ontem", hora };
}

/** "Sem nome · final 4821" para o card cujo título é só um telefone (regra do painel do Gestor). */
export function finalDoTelefone(titulo: string): string | null {
  const digitos = titulo.replace(/[^0-9]/g, "");
  if (/^[+0-9 ()-]+$/.test(titulo) && digitos.length >= 8) return digitos.slice(-4);
  return null;
}

/** Os parâmetros do funil para cada contagem do painel (seção 3). Sempre com o recorte do painel. */
export interface FiltroDoPainel {
  nivel?: Nivel;
  temp?: Temperatura;
  servico?: string;
  situacao?: Situacao;
  status?: "open" | "won" | "lost";
  motivo?: string;
  lead?: string;
}

export const RECORTE_DO_PAINEL = "painel";

export function linkDoFunil(pipelineId: string, f: FiltroDoPainel = {}): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.motivo) p.set("motivo", f.motivo);
  if (f.nivel) p.set("nivel", f.nivel);
  if (f.temp) p.set("temp", f.temp);
  if (f.servico) p.set("servico", f.servico);
  if (f.situacao) p.set("situacao", f.situacao);
  p.set("recorte", RECORTE_DO_PAINEL);
  if (f.lead) p.set("lead", f.lead);
  return `/app/pipelines/${pipelineId}?${p.toString()}`;
}

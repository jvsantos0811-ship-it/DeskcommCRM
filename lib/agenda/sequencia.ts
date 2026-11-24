/**
 * A SEQUÊNCIA DEPOIS DE MARCAR (PC-052 parte 3).
 *
 * Dois passos, em hora FIXA do relógio do escritório — os lembretes que já
 * existiam só sabem contar "X minutos antes":
 *
 *  1. **Aquecimento** — o vídeo e as imagens da organização, na noite do dia em
 *     que a reunião foi marcada (padrão 19h). Reunião no mesmo dia da marcação:
 *     logo depois de marcar.
 *  2. **Confirmação** — reunião antes do corte (padrão 12h): na véspera (padrão
 *     17h), recuando para o último dia com envio quando a véspera não tem (o
 *     domingo de quem não manda no domingo). Reunião no corte ou depois: no mesmo
 *     dia (padrão 8h30).
 *
 * Este arquivo é PURO: o schema único da configuração (`lerSequencia` nunca
 * lança) e a conta de QUANDO cada passo sai. Quem envia é o cron
 * `app/api/v1/cron/agenda-sequencia`.
 *
 * ─── A ocasião que nunca existiu não sai ─────────────────────────────────────
 *
 * A mesma régua do lembrete (#2223): a hora do passo que já tinha passado quando
 * a reunião foi MARCADA não é atraso de cron, é ocasião que não houve. A véspera
 * das 17h de uma reunião marcada às 18h para a manhã seguinte não sai — a
 * marcação, uma hora antes, já foi a confirmação.
 *
 * ─── Cada passo tem prazo de validade ────────────────────────────────────────
 *
 * O texto da véspera diz "amanhã": mandado na manhã do dia (a janela de envio
 * fechou às 20h e só abriu às 8h) ele mentiria. A véspera vale até a meia-noite
 * daquele dia; a do dia e o aquecimento, até 30 minutos antes da reunião (o
 * lembrete de "falta pouco" é do lembrete, não daqui).
 */
import { z } from "zod";

import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";

export const HORA_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const TETO_DO_TEXTO_DA_SEQUENCIA = 1_000;
/** Nenhum passo sai a menos disto do começo da reunião. */
export const MARGEM_ANTES_DA_REUNIAO_MS = 30 * 60_000;

export type PassoDaSequencia = "aquecimento" | "confirmacao_vespera" | "confirmacao_do_dia";

export interface ConfigDaSequencia {
  aquecimento: { ativo: boolean; hora: string; texto: string | null };
  confirmacao: {
    ativo: boolean;
    corte: string;
    horaVespera: string;
    horaDoDia: string;
    textoVespera: string | null;
    textoDoDia: string | null;
  };
}

/**
 * Os textos-base, no idioma da organização. São PONTO DE PARTIDA: o escritório
 * troca pelos dele na tela, e as quebras de linha do que ele escrever vão como
 * ele escreveu. Recebem o `t` para o literal ficar aqui, onde o dicionário o vê.
 */
export function textoPadraoDaVespera(t: (texto: string) => string): string {
  return t("Oi, {{primeiro_nome}}! Passando para lembrar: {{dia_relativo}}, às {{hora}}, a especialista vai te ligar.\n\nEstá confirmado?");
}
export function textoPadraoDoDia(t: (texto: string) => string): string {
  return t("Oi, {{primeiro_nome}}! É hoje: às {{hora}} a especialista vai te ligar.\n\nEstá confirmado?");
}

export const SEQUENCIA_PADRAO: ConfigDaSequencia = Object.freeze({
  aquecimento: { ativo: false, hora: "19:00", texto: null },
  confirmacao: {
    ativo: false,
    corte: "12:00",
    horaVespera: "17:00",
    horaDoDia: "08:30",
    textoVespera: null,
    textoDoDia: null,
  },
}) as ConfigDaSequencia;

/** Vazio ou só espaço = sem texto próprio. O resto vai EXATAMENTE como veio. */
function textoOuNulo(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  return v.trim().length === 0 ? null : v;
}

const hora = z.string().regex(HORA_HHMM);
const texto = z.string().max(TETO_DO_TEXTO_DA_SEQUENCIA).nullable().optional();

/** O que a tela manda. Tudo explícito: quem salva manda a configuração inteira. */
export const sequenciaEntrada = z
  .object({
    aquecimento: z.object({ ativo: z.boolean(), hora, texto }).strict(),
    confirmacao: z
      .object({
        ativo: z.boolean(),
        corte: hora,
        hora_vespera: hora,
        hora_do_dia: hora,
        texto_vespera: texto,
        texto_do_dia: texto,
      })
      .strict(),
  })
  .strict();

/** O jsonb que vai para `calendar_event_types.post_booking_sequence`. */
export function sequenciaParaGravar(e: z.output<typeof sequenciaEntrada>): Record<string, unknown> {
  return {
    aquecimento: { ativo: e.aquecimento.ativo, hora: e.aquecimento.hora, texto: textoOuNulo(e.aquecimento.texto) },
    confirmacao: {
      ativo: e.confirmacao.ativo,
      corte: e.confirmacao.corte,
      hora_vespera: e.confirmacao.hora_vespera,
      hora_do_dia: e.confirmacao.hora_do_dia,
      texto_vespera: textoOuNulo(e.confirmacao.texto_vespera),
      texto_do_dia: textoOuNulo(e.confirmacao.texto_do_dia),
    },
  };
}

function lerHora(v: unknown, padrao: string): string {
  return typeof v === "string" && HORA_HHMM.test(v) ? v : padrao;
}
function lerTexto(v: unknown): string | null {
  return typeof v === "string" && v.length <= TETO_DO_TEXTO_DA_SEQUENCIA ? textoOuNulo(v) : null;
}
function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Lê o que está gravado. NUNCA lança, e campo por campo: um horário ilegível
 * volta ao padrão sem apagar o resto. Um `ativo` ilegível é DESLIGADO — mandar
 * mensagem a cliente é irreversível, e na dúvida não manda.
 */
export function lerSequencia(raw: unknown): ConfigDaSequencia {
  const r = objeto(raw);
  const a = objeto(r.aquecimento);
  const c = objeto(r.confirmacao);
  const p = SEQUENCIA_PADRAO;
  return {
    aquecimento: {
      ativo: a.ativo === true,
      hora: lerHora(a.hora, p.aquecimento.hora),
      texto: lerTexto(a.texto),
    },
    confirmacao: {
      ativo: c.ativo === true,
      corte: lerHora(c.corte, p.confirmacao.corte),
      horaVespera: lerHora(c.hora_vespera, p.confirmacao.horaVespera),
      horaDoDia: lerHora(c.hora_do_dia, p.confirmacao.horaDoDia),
      textoVespera: lerTexto(c.texto_vespera),
      textoDoDia: lerTexto(c.texto_do_dia),
    },
  };
}

// ─── A conta de quando ─────────────────────────────────────────────────────

interface Dia {
  ano: number;
  mes: number;
  dia: number;
}

function minutosDe(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function diaDe(instante: Date, fuso: string): Dia {
  const p = partesNoFuso(instante, fuso);
  return { ano: p.ano, mes: p.mes, dia: p.dia };
}

function somarDias(d: Dia, n: number): Dia {
  const x = new Date(Date.UTC(d.ano, d.mes - 1, d.dia + n));
  return { ano: x.getUTCFullYear(), mes: x.getUTCMonth() + 1, dia: x.getUTCDate() };
}

/** Domingo = 0, calendário puro (o dia já é local). */
function diaDaSemana(d: Dia): number {
  return new Date(Date.UTC(d.ano, d.mes - 1, d.dia)).getUTCDay();
}

function mesmoDia(a: Dia, b: Dia): boolean {
  return a.ano === b.ano && a.mes === b.mes && a.dia === b.dia;
}

function naHora(d: Dia, hhmm: string, fuso: string): Date {
  const minutos = minutosDe(hhmm);
  return instanteDe({ ...d, hora: Math.floor(minutos / 60), minuto: minutos % 60 }, fuso);
}

export interface Ocasiao {
  passo: PassoDaSequencia;
  /** A partir de quando pode sair. */
  alvo: Date;
  /** Depois disto não sai mais (exclusivo). */
  validaAte: Date;
}

/**
 * O aquecimento: na hora fixa da noite do dia em que marcou; marcado depois
 * dessa hora, logo depois de marcar; reunião no mesmo dia, logo depois de marcar.
 * `null` = não há ocasião (a reunião começa antes de dar tempo).
 */
export function ocasiaoDoAquecimento(input: {
  marcadoEm: Date;
  comeca: Date;
  fuso: string;
  hora: string;
}): Ocasiao | null {
  const validaAte = new Date(input.comeca.getTime() - MARGEM_ANTES_DA_REUNIAO_MS);
  const diaMarcado = diaDe(input.marcadoEm, input.fuso);
  const alvo = mesmoDia(diaMarcado, diaDe(input.comeca, input.fuso))
    ? input.marcadoEm
    : new Date(Math.max(input.marcadoEm.getTime(), naHora(diaMarcado, input.hora, input.fuso).getTime()));
  if (alvo.getTime() >= validaAte.getTime()) return null;
  return { passo: "aquecimento", alvo, validaAte };
}

/**
 * A confirmação em hora fixa. `diaTemEnvio` responde, pelo dia da semana local
 * (domingo = 0), se o canal manda naquele dia — é ele que recua a véspera de
 * domingo para o sábado. `null` = não há ocasião: a hora do passo já tinha
 * passado quando a reunião foi marcada, ou a reunião começa antes dela.
 */
export function ocasiaoDaConfirmacao(input: {
  marcadoEm: Date;
  comeca: Date;
  fuso: string;
  corte: string;
  horaVespera: string;
  horaDoDia: string;
  diaTemEnvio: (diaDaSemana: number) => boolean;
}): Ocasiao | null {
  const p = partesNoFuso(input.comeca, input.fuso);
  const diaDaReuniao: Dia = { ano: p.ano, mes: p.mes, dia: p.dia };
  const margem = new Date(input.comeca.getTime() - MARGEM_ANTES_DA_REUNIAO_MS);
  let ocasiao: Ocasiao;
  if (p.hora * 60 + p.minuto < minutosDe(input.corte)) {
    let vespera = somarDias(diaDaReuniao, -1);
    let recuos = 0;
    while (!input.diaTemEnvio(diaDaSemana(vespera)) && recuos < 6) {
      vespera = somarDias(vespera, -1);
      recuos += 1;
    }
    if (!input.diaTemEnvio(diaDaSemana(vespera))) return null;
    const fimDoDia = instanteDe(somarDias(vespera, 1), input.fuso);
    ocasiao = {
      passo: "confirmacao_vespera",
      alvo: naHora(vespera, input.horaVespera, input.fuso),
      validaAte: new Date(Math.min(fimDoDia.getTime(), margem.getTime())),
    };
  } else {
    ocasiao = {
      passo: "confirmacao_do_dia",
      alvo: naHora(diaDaReuniao, input.horaDoDia, input.fuso),
      validaAte: margem,
    };
  }
  if (ocasiao.alvo.getTime() < input.marcadoEm.getTime()) return null;
  if (ocasiao.alvo.getTime() >= ocasiao.validaAte.getTime()) return null;
  return ocasiao;
}

/** A ocasião está aberta agora? */
export function ocasiaoAberta(o: Ocasiao, agora: Date): boolean {
  return agora.getTime() >= o.alvo.getTime() && agora.getTime() < o.validaAte.getTime();
}

// ─── O texto ───────────────────────────────────────────────────────────────

/**
 * As peças que o texto pode usar: `{{nome}}`, `{{primeiro_nome}}`, `{{dia}}`,
 * `{{hora}}`, `{{quando}}`, `{{dia_relativo}}` ("amanhã" ou o dia da semana,
 * quando a véspera recuou) e `{{especialista}}` (o primeiro nome de quem atende).
 * Chave desconhecida fica no texto, para quem digitou ver o erro.
 */
export function aplicarTextoDaSequencia(molde: string, pecas: Record<string, string>): string {
  return molde.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (literal, raw: string) => {
    const v = pecas[raw.toLowerCase()];
    return v === undefined ? literal : v;
  });
}

export function pecasDaSequencia(input: {
  nomeDoContato: string | null;
  especialista: string | null;
  comeca: Date;
  /** Quando a mensagem sai — `dia_relativo` é contado a partir dele. */
  envio: Date;
  fuso: string;
  etiquetaDeIdioma: string;
  palavras: { amanha: string; hoje: string; as: string };
}): Record<string, string> {
  const nome = input.nomeDoContato?.trim() ?? "";
  const dia = new Intl.DateTimeFormat(input.etiquetaDeIdioma, {
    timeZone: input.fuso,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(input.comeca);
  const hora = new Intl.DateTimeFormat(input.etiquetaDeIdioma, {
    timeZone: input.fuso,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(input.comeca);
  const dReuniao = diaDe(input.comeca, input.fuso);
  const dEnvio = diaDe(input.envio, input.fuso);
  const relativo = mesmoDia(dReuniao, dEnvio)
    ? input.palavras.hoje
    : mesmoDia(dReuniao, somarDias(dEnvio, 1))
      ? input.palavras.amanha
      : dia;
  return {
    nome,
    primeiro_nome: nome.split(/\s+/)[0] ?? "",
    dia,
    hora,
    quando: `${dia} ${input.palavras.as} ${hora}`,
    dia_relativo: relativo,
    especialista: input.especialista?.trim().split(/\s+/)[0] ?? "",
  };
}

// ─── O passo aberto agora ──────────────────────────────────────────────────

export interface LinhaDaSequencia {
  starts_at: string;
  created_at: string | null;
  starts_at_marked_at: string | null;
  warmup_sent_at: string | null;
  confirmation_sent_for: string | null;
}

function mesmoInstante(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * O passo que está aberto agora para este compromisso, se houver — o
 * aquecimento primeiro (um passo por rodada). O aquecimento conta da marcação
 * ORIGINAL (`created_at`: ele sai uma vez por compromisso); a confirmação conta
 * de quando ESTE horário foi marcado (`starts_at_marked_at`, a régua da
 * remarcação do lembrete), e sai uma vez por horário.
 */
export function passoAberto(input: {
  linha: LinhaDaSequencia;
  config: ConfigDaSequencia;
  fuso: string;
  agora: Date;
  diaTemEnvio: (diaDaSemana: number) => boolean;
}): Ocasiao | null {
  const { linha, config, fuso, agora } = input;
  const comeca = new Date(linha.starts_at);
  if (config.aquecimento.ativo && !linha.warmup_sent_at && linha.created_at) {
    const o = ocasiaoDoAquecimento({ marcadoEm: new Date(linha.created_at), comeca, fuso, hora: config.aquecimento.hora });
    if (o && ocasiaoAberta(o, agora)) return o;
  }
  if (config.confirmacao.ativo && !mesmoInstante(linha.confirmation_sent_for, linha.starts_at)) {
    const marcadoEm = linha.starts_at_marked_at ?? linha.created_at;
    if (!marcadoEm) return null;
    const o = ocasiaoDaConfirmacao({
      marcadoEm: new Date(marcadoEm),
      comeca,
      fuso,
      corte: config.confirmacao.corte,
      horaVespera: config.confirmacao.horaVespera,
      horaDoDia: config.confirmacao.horaDoDia,
      diaTemEnvio: input.diaTemEnvio,
    });
    if (o && ocasiaoAberta(o, agora)) return o;
  }
  return null;
}

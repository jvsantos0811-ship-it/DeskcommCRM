/**
 * DIAS ÚTEIS CONTADOS EM HORAS DE EXPEDIENTE (PM-025 §3).
 *
 * Os prazos do Leitor da conversa, do painel "Esperando a equipe" e do aviso
 * "Ninguém respondeu" não são de relógio corrido: contam só o tempo em que a
 * equipe trabalha. A régua, num lugar só, para os três baterem:
 *
 *   - o horário é o da equipe da organização (`settings.horario_da_equipe`, o
 *     mesmo que a trava de promessa de horário usa — fuso + janelas por dia);
 *     sem horário cadastrado vale seg–sex, 8h–18h no fuso da organização, e a
 *     tela diz isso (`avisoDeHorarioPadrao`);
 *   - feriado nacional não conta (`lib/lgpd/holidays-br.ts`, 20/11 incluso);
 *   - "1 dia útil" é a jornada MAIS LONGA da semana naquele horário (padrão 10 h);
 *     "2 dias úteis" é o dobro, "3 dias úteis" o triplo; "1 hora" é 1 hora de
 *     expediente.
 *
 * Tudo aqui é puro (sem banco, sem `Date.now()`): quem chama passa o "agora".
 * O fuso é convertido com `Intl`, que já sabe horário de verão.
 */
import { feriadosDoBrasilDoAno } from "@/lib/lgpd/holidays-br";
import { horarioDaEquipeDaOrg } from "@/lib/escalacao/horario-da-equipe";

export interface JanelaDeExpediente {
  /** 0 = domingo … 6 = sábado. */
  dow: number;
  /** "HH:MM", hora local. */
  start: string;
  end: string;
}

export interface Expediente {
  timezone: string;
  windows: JanelaDeExpediente[];
  /** false = a organização não cadastrou; vale o padrão seg–sex 8h–18h. */
  cadastrado: boolean;
}

const HORA_MS = 60 * 60 * 1000;
const FUSO_PADRAO = "America/Sao_Paulo";

/** O padrão da PM-025 quando a organização não cadastrou o horário da equipe. */
export const JANELAS_PADRAO: readonly JanelaDeExpediente[] = [1, 2, 3, 4, 5].map((dow) => ({
  dow,
  start: "08:00",
  end: "18:00",
}));

function fusoValido(fuso: string | null | undefined): string {
  if (!fuso) return FUSO_PADRAO;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: fuso });
    return fuso;
  } catch {
    return FUSO_PADRAO;
  }
}

/**
 * O expediente de uma organização. `fusoDaOrg` (organizations.timezone) só é
 * usado quando o horário não foi cadastrado — o cadastrado traz o próprio fuso.
 */
export function expedienteDaOrg(settings: unknown, fusoDaOrg?: string | null): Expediente {
  const cadastrado = horarioDaEquipeDaOrg(settings);
  if (cadastrado) {
    return { timezone: fusoValido(cadastrado.timezone), windows: cadastrado.windows, cadastrado: true };
  }
  return { timezone: fusoValido(fusoDaOrg), windows: [...JANELAS_PADRAO], cadastrado: false };
}

/** Texto da tela quando vale o padrão. `null` quando a organização cadastrou. */
export function avisoDeHorarioPadrao(e: Expediente, t: (s: string) => string): string | null {
  return e.cadastrado ? null : t("Horário da equipe não cadastrado: usando seg–sex, 8h–18h");
}

function minutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 1 dia útil = a jornada mais longa da semana (soma das janelas de um mesmo dia). */
export function jornadaMaisLongaMs(e: Pick<Expediente, "windows">): number {
  const porDia = new Map<number, number>();
  for (const w of e.windows) {
    const dur = Math.max(0, minutos(w.end) - minutos(w.start));
    porDia.set(w.dow, (porDia.get(w.dow) ?? 0) + dur);
  }
  const maior = Math.max(0, ...porDia.values());
  return maior * 60 * 1000;
}

// ─── fuso ────────────────────────────────────────────────────────────────────

const formatadores = new Map<string, Intl.DateTimeFormat>();
function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: fuso,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatadores.set(fuso, f);
  }
  return f;
}

function partesLocais(instanteMs: number, fuso: string) {
  const partes = formatador(fuso).formatToParts(new Date(instanteMs));
  const v = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? "0");
  return { ano: v("year"), mes: v("month"), dia: v("day"), hora: v("hour"), minuto: v("minute"), segundo: v("second") };
}

/** Diferença (ms) entre a hora local do fuso e o UTC naquele instante. */
function deslocamentoMs(instanteMs: number, fuso: string): number {
  const p = partesLocais(instanteMs, fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUtc - Math.floor(instanteMs / 1000) * 1000;
}

/** "AAAA-MM-DD" do instante no fuso. */
export function diaLocal(instanteMs: number, fuso: string): string {
  const p = partesLocais(instanteMs, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/** O instante (ms UTC) da hora local `hhmm` do dia `dia` no fuso. */
export function instanteLocal(dia: string, hhmm: string, fuso: string): number {
  const [a, m, d] = dia.split("-").map(Number);
  const parede = Date.UTC(a!, m! - 1, d!, Math.floor(minutos(hhmm) / 60), minutos(hhmm) % 60);
  const primeiro = parede - deslocamentoMs(parede, fuso);
  const segundo = parede - deslocamentoMs(primeiro, fuso);
  return segundo;
}

function somarUmDia(dia: string): string {
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(a!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

function diaDaSemana(dia: string): number {
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(a!, m! - 1, d!)).getUTCDay();
}

const feriadosPorAno = new Map<number, Set<string>>();
export function ehFeriadoNacional(dia: string): boolean {
  const ano = Number(dia.slice(0, 4));
  let s = feriadosPorAno.get(ano);
  if (!s) {
    s = new Set(feriadosDoBrasilDoAno(ano));
    feriadosPorAno.set(ano, s);
  }
  return s.has(dia);
}

/** Teto de dias varridos numa conta (um ano e pouco): prazo maior que isto já venceu. */
const TETO_DE_DIAS = 400;

// ─── a conta ─────────────────────────────────────────────────────────────────

/** Milissegundos de expediente entre dois instantes (só dentro das janelas, sem feriado). */
export function msDeExpedienteEntre(inicio: Date, fim: Date, e: Pick<Expediente, "timezone" | "windows">): number {
  const ini = inicio.getTime();
  const fi = fim.getTime();
  if (!(fi > ini) || e.windows.length === 0) return 0;
  const fuso = fusoValido(e.timezone);
  let dia = diaLocal(ini, fuso);
  const ultimo = diaLocal(fi, fuso);
  let total = 0;
  for (let i = 0; i <= TETO_DE_DIAS; i += 1) {
    if (!ehFeriadoNacional(dia)) {
      const dow = diaDaSemana(dia);
      for (const w of e.windows) {
        if (w.dow !== dow) continue;
        const a = instanteLocal(dia, w.start, fuso);
        const b = instanteLocal(dia, w.end, fuso);
        const sobra = Math.min(b, fi) - Math.max(a, ini);
        if (sobra > 0) total += sobra;
      }
    }
    if (dia === ultimo) break;
    dia = somarUmDia(dia);
  }
  return total;
}

/** Quantos dias úteis (frações inclusas) cabem entre os dois instantes. */
export function diasUteisEntre(inicio: Date, fim: Date, e: Pick<Expediente, "timezone" | "windows">): number {
  const jornada = jornadaMaisLongaMs(e);
  if (jornada === 0) return 0;
  return msDeExpedienteEntre(inicio, fim, e) / jornada;
}

/** Passaram MAIS de `n` dias úteis desde `desde`? (Exatamente `n` ainda não passou.) */
export function passouDeDiasUteis(
  desde: Date,
  agora: Date,
  n: number,
  e: Pick<Expediente, "timezone" | "windows">,
): boolean {
  const jornada = jornadaMaisLongaMs(e);
  if (jornada === 0) return false;
  return msDeExpedienteEntre(desde, agora, e) > n * jornada;
}

/** Já se completaram `horas` de expediente desde `desde`? ("ninguém respondeu em 1 hora") */
export function completouHorasDeExpediente(
  desde: Date,
  agora: Date,
  horas: number,
  e: Pick<Expediente, "timezone" | "windows">,
): boolean {
  return msDeExpedienteEntre(desde, agora, e) >= horas * HORA_MS;
}

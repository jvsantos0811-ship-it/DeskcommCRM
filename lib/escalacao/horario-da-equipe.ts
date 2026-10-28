/**
 * O HORÁRIO DA EQUIPE e a promessa de QUANDO a equipe assume (PC-002b, item 4).
 *
 * ## O defeito
 *
 * Na bateria da OE-005 (28/10/2026, dia útil, 10h, horário da equipe), a IA
 * passou o lead para a equipe e escreveu "a nossa equipe vai assumir a conversa
 * ainda hoje" — e a trava de promessa semântica barrou a frase como "promessa
 * fora do playbook" (J1, J2, J5). Na OE-004 já barrava "a partir das 8h". A
 * mensagem final saía sem dizer QUANDO alguém volta, que é justamente o que um
 * lead com prazo correndo precisa ouvir.
 *
 * Dizer quando a equipe do escritório assume não é promessa comercial — é
 * informação de atendimento — DESDE QUE bata com o horário em que a equipe
 * trabalha. "Ainda hoje" às 10h de quarta é verdade; "ainda hoje" às 21h, ou
 * num domingo, não é.
 *
 * ## A regra (determinística, sem modelo)
 *
 * 1. A organização cadastra o horário da equipe (`organizations.settings.
 *    horario_da_equipe`, mesmo formato da jornada de atendente: fuso + janelas
 *    por dia da semana). Sem horário cadastrado, nada muda: a trava age como antes.
 * 2. Só passa frase que é PROMESSA DE HORÁRIO DA EQUIPE: um sujeito da equipe
 *    (equipe, time, advogado, escritório, atendente, alguém…) com um verbo de
 *    retorno (assume, retorna, fala, chama, liga, entra em contato…) e uma
 *    referência de tempo reconhecida ("ainda hoje", "hoje", "amanhã", "a partir
 *    das 8h", "às 14h de segunda").
 * 3. Cada referência tem de bater com o horário: "hoje" pede janela hoje que
 *    ainda não acabou; "amanhã" pede janela amanhã; "às Xh"/"a partir das Xh"
 *    pede que Xh esteja dentro de uma janela daquele dia (ou do próximo dia útil,
 *    sem dia dito).
 * 4. Frase com palavra comercial (garantia, grátis, desconto, valor, R$, %,
 *    honorário) NUNCA passa por aqui — a régua é só de horário.
 */
import { z } from "zod";

import { localMoment } from "@/lib/routing/eligibility";
import { availabilityScheduleSchema, type AvailabilitySchedule } from "@/lib/schemas/routing";

export type HorarioDaEquipe = Pick<AvailabilitySchedule, "timezone" | "windows">;

/** Lê o horário da equipe do `settings` da organização. Sem janelas = não cadastrado. */
export function horarioDaEquipeDaOrg(settings: unknown): HorarioDaEquipe | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const bruto = (settings as Record<string, unknown>).horario_da_equipe;
  const r = availabilityScheduleSchema.safeParse(bruto ?? null);
  if (!r.success || r.data.windows.length === 0) return null;
  return { timezone: r.data.timezone, windows: r.data.windows };
}

/** O corpo do PATCH da tela. Janelas vazias = apagar (a trava volta a agir como antes). */
export const horarioDaEquipeEntradaSchema = z
  .object({ horario: availabilityScheduleSchema })
  .strict();

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SUJEITO =
  "(equipe|time|advogad[oa]s?|escritorio|atendente|especialista|responsavel|setor|doutor[a]?|dr\\.?|dra\\.?|alguem|uma pessoa|a gente|nos)";
const VERBO =
  "(assum\\w*|retorn\\w*|fala\\w*|chama\\w*|lig\\w*|entra\\w* em contato|contat\\w*|continu\\w*|atend\\w*|respond\\w*|da\\w* (um )?retorno|vai (te )?chamar|vai (te )?ligar|vai falar|vai responder)";
const COMERCIAL = /(garant|gratis|gratuit|desconto|r\$|%|reais|valor|preco|honorari|resultado|ganh)/;

const DIAS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

export type ReferenciaDeTempo =
  | { tipo: "hoje" }
  | { tipo: "amanha"; hora: string | null }
  | { tipo: "dia"; dow: number; hora: string | null }
  | { tipo: "hora"; hora: string };

function hhmm(h: string, m?: string): string {
  return `${h.padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}`;
}

/**
 * As referências de tempo de uma PROMESSA DE HORÁRIO DA EQUIPE — ou `null`
 * quando a frase não é isso (sem sujeito da equipe, sem verbo de retorno, sem
 * tempo reconhecido, ou com palavra comercial).
 */
export function referenciasDaPromessaDeHorario(texto: string): ReferenciaDeTempo[] | null {
  const t = normalizar(texto);
  if (COMERCIAL.test(t)) return null;
  if (!new RegExp(`\\b${SUJEITO}\\b`).test(t)) return null;
  if (!new RegExp(VERBO).test(t)) return null;

  const refs: ReferenciaDeTempo[] = [];
  const horaRx = /(?:a partir d[ao]s?|as|a partir de|depois d[ao]s?)\s*(\d{1,2})(?:h|:)(\d{2})?\s*(?:h(?:oras)?)?/g;
  const horas = [...t.matchAll(horaRx)].map((m) => hhmm(m[1]!, m[2]));
  const diaMatch = t.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?\b/);

  if (/\b(ainda hoje|hoje mesmo|hoje)\b/.test(t)) refs.push({ tipo: "hoje" });
  if (/\bamanha\b/.test(t)) refs.push({ tipo: "amanha", hora: horas[0] ?? null });
  else if (diaMatch) refs.push({ tipo: "dia", dow: DIAS[diaMatch[1]!]!, hora: horas[0] ?? null });
  else if (horas.length > 0 && !refs.some((r) => r.tipo === "hoje")) refs.push({ tipo: "hora", hora: horas[0]! });

  return refs.length > 0 ? refs : null;
}

/** A mensagem inteira tem palavra comercial? (garantia, grátis, desconto, valor, R$…) */
export function temPalavraComercial(texto: string): boolean {
  return COMERCIAL.test(normalizar(texto));
}

/** Janelas do dia da semana `dow`. */
function janelasDo(h: HorarioDaEquipe, dow: number) {
  return h.windows.filter((w) => w.dow === dow);
}

function horaDentro(h: HorarioDaEquipe, dow: number, hora: string): boolean {
  return janelasDo(h, dow).some((w) => hora >= w.start && hora < w.end);
}

/** A referência bate com o horário da equipe, a partir de `agora`? */
export function referenciaConfere(ref: ReferenciaDeTempo, h: HorarioDaEquipe, agora: Date): boolean {
  const { dow, hhmm: agoraHH } = localMoment(agora, h.timezone || "America/Sao_Paulo");
  if (ref.tipo === "hoje") {
    // Ainda há equipe HOJE: uma janela de hoje que não acabou.
    return janelasDo(h, dow).some((w) => agoraHH < w.end);
  }
  if (ref.tipo === "amanha") {
    const amanha = (dow + 1) % 7;
    return ref.hora ? horaDentro(h, amanha, ref.hora) : janelasDo(h, amanha).length > 0;
  }
  if (ref.tipo === "dia") {
    return ref.hora ? horaDentro(h, ref.dow, ref.hora) : janelasDo(h, ref.dow).length > 0;
  }
  // "a partir das 8h" sem dia: hoje (se ainda não passou) ou o próximo dia com equipe.
  if (agoraHH <= ref.hora && horaDentro(h, dow, ref.hora)) return true;
  for (let i = 1; i <= 7; i++) {
    const d = (dow + i) % 7;
    if (janelasDo(h, d).length > 0) return horaDentro(h, d, ref.hora);
  }
  return false;
}

/**
 * A frase é uma promessa de QUANDO a equipe assume que bate com o horário
 * cadastrado? `true` libera a frase na trava semântica de promessa.
 */
export function promessaDeHorarioConfere(
  texto: string | null | undefined,
  horario: HorarioDaEquipe | null | undefined,
  agora: Date,
): boolean {
  if (!texto || !horario || horario.windows.length === 0) return false;
  const refs = referenciasDaPromessaDeHorario(texto);
  if (!refs) return false;
  return refs.every((r) => referenciaConfere(r, horario, agora));
}

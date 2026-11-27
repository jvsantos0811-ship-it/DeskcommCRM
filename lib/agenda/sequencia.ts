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
 *  3. **Reforço** (PC-064) — a 2ª pergunta, só para quem NÃO confirmou depois da
 *     1ª. Reunião antes do corte: no dia da reunião, entre `hora_manha` e
 *     `ate_manha` (padrão 8h30–9h30). Reunião no corte ou depois: no dia, a
 *     partir de `hora_tarde` (padrão 11h). Nunca a menos de uma hora da 1ª, e
 *     uma vez por horário. "Confirmou" quem o cron decide (presença `confirmada`
 *     ou qualquer resposta do cliente depois da 1ª): aqui só a hora.
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

export type PassoDaSequencia = "aquecimento" | "confirmacao_vespera" | "confirmacao_do_dia" | "confirmacao_reforco";

/** O reforço nunca sai a menos disto da 1ª confirmação. */
export const INTERVALO_MINIMO_DO_REFORCO_MS = 60 * 60_000;

export interface ConfigDaSequencia {
  /**
   * `ligadoEm`: quando o aquecimento passou a valer (gravado pela rota). Marcação
   * ANTERIOR a ele não recebe vídeo — ligar a chave não pode disparar, de uma vez,
   * o aquecimento atrasado de tudo o que foi marcado nos dois dias antes.
   */
  aquecimento: { ativo: boolean; hora: string; texto: string | null; ligadoEm: string | null };
  confirmacao: {
    ativo: boolean;
    corte: string;
    horaVespera: string;
    horaDoDia: string;
    textoVespera: string | null;
    textoDoDia: string | null;
  };
  /** PC-064: a 2ª pergunta para quem não confirmou. Desligada de fábrica. */
  reforco: {
    ativo: boolean;
    horaManha: string;
    ateManha: string;
    horaTarde: string;
    texto: string | null;
  };
}

/**
 * Os textos-base, no idioma da organização. São PONTO DE PARTIDA: o escritório
 * troca pelos dele na tela, e as quebras de linha do que ele escrever vão como
 * ele escreveu. Recebem o `t` para o literal ficar aqui, onde o dicionário o vê.
 */
export function textoPadraoDaVespera(t: (texto: string) => string): string {
  return t("Oi, {{primeiro_nome}}! Passando para lembrar do seu horário: {{dia_relativo}}, às {{hora}}.\n\nEstá confirmado?");
}
export function textoPadraoDoDia(t: (texto: string) => string): string {
  return t("Oi, {{primeiro_nome}}! É hoje, às {{hora}}.\n\nEstá confirmado?");
}
export function textoPadraoDoReforco(t: (texto: string) => string): string {
  return t("Oi, {{primeiro_nome}}! Só confirmando o seu horário de hoje, às {{hora}}.\n\nPosso confirmar?");
}

export const SEQUENCIA_PADRAO: ConfigDaSequencia = Object.freeze({
  aquecimento: { ativo: false, hora: "19:00", texto: null, ligadoEm: null },
  confirmacao: {
    ativo: false,
    corte: "12:00",
    horaVespera: "17:00",
    horaDoDia: "08:30",
    textoVespera: null,
    textoDoDia: null,
  },
  reforco: { ativo: false, horaManha: "08:30", ateManha: "09:30", horaTarde: "11:00", texto: null },
}) as ConfigDaSequencia;

/** Vazio ou só espaço = sem texto próprio. O resto vai EXATAMENTE como veio. */
function textoOuNulo(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  return v.trim().length === 0 ? null : v;
}

const hora = z.string().regex(HORA_HHMM);
function horaEmMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
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
    /**
     * Opcional: uma tela antiga (aberta antes da atualização) salva sem ele, e
     * aí vale o que estava gravado (`sequenciaParaGravar` recebe o de antes).
     */
    reforco: z
      .object({
        ativo: z.boolean(),
        hora_manha: hora,
        ate_manha: hora,
        hora_tarde: hora,
        texto,
      })
      .strict()
      // Invertidos, a janela da manhã nunca abre e o reforço some sem aviso.
      .refine((r) => horaEmMinutos(r.ate_manha) > horaEmMinutos(r.hora_manha), { path: ["ate_manha"] })
      .optional(),
  })
  .strict();

/**
 * Quando o aquecimento passa a valer. Ligar agora (estava desligado, pela chave do
 * tipo ou pela do passo) = `agora`; continua ligado = o instante de antes;
 * desligado = nulo.
 */
export function aquecimentoLigadoEm(input: {
  ligadaAntes: boolean;
  antes: ConfigDaSequencia;
  ligadaAgora: boolean;
  aquecimentoAtivoAgora: boolean;
  agora: Date;
}): string | null {
  const vale = input.ligadaAgora && input.aquecimentoAtivoAgora;
  if (!vale) return null;
  const valiaAntes = input.ligadaAntes && input.antes.aquecimento.ativo;
  return valiaAntes && input.antes.aquecimento.ligadoEm ? input.antes.aquecimento.ligadoEm : input.agora.toISOString();
}

/** O jsonb que vai para `calendar_event_types.post_booking_sequence`. */
export function sequenciaParaGravar(
  e: z.output<typeof sequenciaEntrada>,
  ligadoEm: string | null = null,
  antes: ConfigDaSequencia = SEQUENCIA_PADRAO,
): Record<string, unknown> {
  const reforco = e.reforco
    ? {
        ativo: e.reforco.ativo,
        hora_manha: e.reforco.hora_manha,
        ate_manha: e.reforco.ate_manha,
        hora_tarde: e.reforco.hora_tarde,
        texto: textoOuNulo(e.reforco.texto),
      }
    : {
        ativo: antes.reforco.ativo,
        hora_manha: antes.reforco.horaManha,
        ate_manha: antes.reforco.ateManha,
        hora_tarde: antes.reforco.horaTarde,
        texto: antes.reforco.texto,
      };
  return {
    aquecimento: {
      ativo: e.aquecimento.ativo,
      hora: e.aquecimento.hora,
      texto: textoOuNulo(e.aquecimento.texto),
      ligado_em: ligadoEm,
    },
    confirmacao: {
      ativo: e.confirmacao.ativo,
      corte: e.confirmacao.corte,
      hora_vespera: e.confirmacao.hora_vespera,
      hora_do_dia: e.confirmacao.hora_do_dia,
      texto_vespera: textoOuNulo(e.confirmacao.texto_vespera),
      texto_do_dia: textoOuNulo(e.confirmacao.texto_do_dia),
    },
    reforco,
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
  const f = objeto(r.reforco);
  const p = SEQUENCIA_PADRAO;
  return {
    aquecimento: {
      ativo: a.ativo === true,
      hora: lerHora(a.hora, p.aquecimento.hora),
      texto: lerTexto(a.texto),
      ligadoEm: typeof a.ligado_em === "string" && !Number.isNaN(Date.parse(a.ligado_em)) ? a.ligado_em : null,
    },
    confirmacao: {
      ativo: c.ativo === true,
      corte: lerHora(c.corte, p.confirmacao.corte),
      horaVespera: lerHora(c.hora_vespera, p.confirmacao.horaVespera),
      horaDoDia: lerHora(c.hora_do_dia, p.confirmacao.horaDoDia),
      textoVespera: lerTexto(c.texto_vespera),
      textoDoDia: lerTexto(c.texto_do_dia),
    },
    reforco: {
      ativo: f.ativo === true,
      horaManha: lerHora(f.hora_manha, p.reforco.horaManha),
      ateManha: lerHora(f.ate_manha, p.reforco.ateManha),
      horaTarde: lerHora(f.hora_tarde, p.reforco.horaTarde),
      texto: lerTexto(f.texto),
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

/**
 * O reforço (PC-064), sempre no DIA da reunião. Antes do corte: de `horaManha`
 * até `ateManha` (e nunca depois de 30 minutos antes da reunião). No corte ou
 * depois: de `horaTarde` até 30 minutos antes. E nunca a menos de uma hora da
 * 1ª confirmação (`primeiraEm`): um horário configurado cedo demais empurra o
 * reforço, não o cola na 1ª. `null` = não há ocasião (a janela da manhã já
 * fechou antes de abrir, ou a reunião é cedo demais para caber).
 */
export function ocasiaoDoReforco(input: {
  comeca: Date;
  fuso: string;
  corte: string;
  horaManha: string;
  ateManha: string;
  horaTarde: string;
  primeiraEm: Date;
}): Ocasiao | null {
  const p = partesNoFuso(input.comeca, input.fuso);
  const diaDaReuniao: Dia = { ano: p.ano, mes: p.mes, dia: p.dia };
  const margem = new Date(input.comeca.getTime() - MARGEM_ANTES_DA_REUNIAO_MS);
  const deManha = p.hora * 60 + p.minuto < minutosDe(input.corte);
  const configurado = naHora(diaDaReuniao, deManha ? input.horaManha : input.horaTarde, input.fuso);
  const alvo = new Date(Math.max(configurado.getTime(), input.primeiraEm.getTime() + INTERVALO_MINIMO_DO_REFORCO_MS));
  const validaAte = deManha
    ? new Date(Math.min(naHora(diaDaReuniao, input.ateManha, input.fuso).getTime(), margem.getTime()))
    : margem;
  if (alvo.getTime() >= validaAte.getTime()) return null;
  return { passo: "confirmacao_reforco", alvo, validaAte };
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
  /** PC-064: quando a 1ª confirmação saiu (nulo nas que saíram antes da coluna). */
  confirmation_sent_at?: string | null;
  /** PC-064: o HORÁRIO para o qual o reforço saiu — uma vez por horário. */
  confirmation_retry_sent_for?: string | null;
  lead_presence?: string | null;
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
 * remarcação do lembrete), e sai uma vez por horário. O reforço (PC-064) só
 * depois da 1ª deste horário, uma vez por horário, e nunca para quem já está
 * com a presença confirmada (ou disse que não vai). A outra metade de
 * "confirmou" — o cliente respondeu depois da 1ª — o cron confere no banco.
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
  const marcadoAntesDeLigar =
    config.aquecimento.ligadoEm !== null &&
    linha.created_at !== null &&
    Date.parse(linha.created_at) < Date.parse(config.aquecimento.ligadoEm);
  if (config.aquecimento.ativo && !linha.warmup_sent_at && linha.created_at && !marcadoAntesDeLigar) {
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
  const primeiraDesteHorario = mesmoInstante(linha.confirmation_sent_for, linha.starts_at);
  const presencaResolvida = linha.lead_presence === "confirmada" || linha.lead_presence === "nao_vai";
  if (
    config.confirmacao.ativo &&
    config.reforco.ativo &&
    primeiraDesteHorario &&
    !mesmoInstante(linha.confirmation_retry_sent_for ?? null, linha.starts_at) &&
    !presencaResolvida
  ) {
    const primeiraEm = quandoSaiuAPrimeira(linha, config, fuso, input.diaTemEnvio);
    if (!primeiraEm) return null;
    const o = ocasiaoDoReforco({
      comeca,
      fuso,
      corte: config.confirmacao.corte,
      horaManha: config.reforco.horaManha,
      ateManha: config.reforco.ateManha,
      horaTarde: config.reforco.horaTarde,
      primeiraEm,
    });
    if (o && ocasiaoAberta(o, agora)) return o;
  }
  return null;
}

/**
 * Quando a 1ª confirmação deste horário saiu. O carimbo (`confirmation_sent_at`)
 * quando há; nas que saíram antes da coluna existir, a hora em que ela estava
 * marcada para sair (o envio é entre ela e o fim da validade, e a régua do
 * reforço só precisa de um piso). Sem nenhum dos dois: não se sabe, e o reforço
 * não sai — na dúvida, não manda.
 */
export function quandoSaiuAPrimeira(
  linha: LinhaDaSequencia,
  config: ConfigDaSequencia,
  fuso: string,
  diaTemEnvio: (diaDaSemana: number) => boolean,
): Date | null {
  if (linha.confirmation_sent_at && !Number.isNaN(Date.parse(linha.confirmation_sent_at))) {
    return new Date(linha.confirmation_sent_at);
  }
  const o = ocasiaoDaConfirmacao({
    marcadoEm: new Date(0),
    comeca: new Date(linha.starts_at),
    fuso,
    corte: config.confirmacao.corte,
    horaVespera: config.confirmacao.horaVespera,
    horaDoDia: config.confirmacao.horaDoDia,
    diaTemEnvio,
  });
  return o ? o.alvo : null;
}

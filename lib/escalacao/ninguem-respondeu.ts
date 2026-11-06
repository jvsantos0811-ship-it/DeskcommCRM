/**
 * "UM LEAD ESCREVEU E NINGUÉM RESPONDEU" — a regra do aviso (PM-027 §7).
 *
 * Dispara quando a última mensagem é do lead e nem a IA nem uma pessoa da
 * equipe (inclusive pelo celular do escritório) respondeu em 1 hora, contada
 * dentro do horário da equipe (`lib/dados/expediente.ts`).
 *
 * ─── Quem entra ─────────────────────────────────────────────────────────────
 *
 *   - lead com potencial ou lead que voltou (`lib/dados/alcance-do-leitor.ts`):
 *     conversa sem negócio no funil, ou com negócio só fora do alcance, não avisa;
 *   - fica fora: grupo, contato com opt-out (`is_blocked`) e o número interno de
 *     avisos da organização;
 *   - SEM RETROATIVO: só conta mensagem do lead que chegou depois que o aviso
 *     foi ligado na organização. Ligar o aviso não despeja na Central as
 *     conversas antigas paradas.
 *
 * ─── O que conta como "respondeu" ───────────────────────────────────────────
 *
 * Qualquer mensagem nossa depois da do lead — da IA, de alguém pelo CRM ou do
 * celular do escritório — MENOS a resposta automática do WhatsApp Business
 * (saudação ou ausência), que sai do celular como se fosse uma pessoa. Ela é
 * reconhecida por três sinais juntos: saiu do celular segundos depois da
 * mensagem do lead, é texto de verdade (não "ok") e o MESMO texto aparece em
 * várias conversas (`pareceRespostaAutomatica` aqui; a contagem é do banco).
 *
 * ─── Conversa encerrada não avisa ──────────────────────────────────────────
 *
 * 1ª camada pela forma (`lib/dados/fim-da-conversa.ts`): "Obg👍" logo depois da
 * nossa resposta encerra; "Bom dia" abrindo conversa pede resposta. 2ª camada,
 * só quando a forma não decide: a leitura curta das últimas 6 mensagens
 * (ponto `conferir_fim_da_conversa`). Na dúvida, avisa.
 *
 * Puro: sem banco, sem relógio. Quem chama passa "agora".
 */
import { z } from "zod";

import type { PosicaoNoAlcance } from "@/lib/dados/alcance-do-leitor";
import { completouHorasDeExpediente, type Expediente } from "@/lib/dados/expediente";
import { decidirPelaForma } from "@/lib/dados/fim-da-conversa";

export const CHAVE_DO_AVISO = "ninguem_respondeu" as const;
export const KIND_DO_AVISO = "ninguem_respondeu" as const;
/** Horas de expediente sem resposta até o aviso. */
export const HORAS_ATE_O_AVISO = 1;
/** Quantas mensagens a leitura curta lê. */
export const MENSAGENS_DA_LEITURA = 6;

// ─── a configuração (organizations.settings.ninguem_respondeu) ──────────────

export const configDoAvisoSchema = z
  .object({
    ligado: z.boolean().default(false),
    /** Quando foi ligado (ISO). Só mensagem do lead depois disto conta. */
    ligado_em: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type ConfigDoAviso = z.infer<typeof configDoAvisoSchema>;

export const CONFIG_DESLIGADA: ConfigDoAviso = { ligado: false, ligado_em: null };

/** Lê a configuração. Nunca lança; ligado sem data vale como desligado. */
export function configDoAviso(settings: unknown): ConfigDoAviso {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return CONFIG_DESLIGADA;
  const r = configDoAvisoSchema.safeParse((settings as Record<string, unknown>)[CHAVE_DO_AVISO] ?? {});
  if (!r.success || !r.data.ligado || r.data.ligado_em === null) return CONFIG_DESLIGADA;
  return r.data;
}

/**
 * A configuração que a tela grava. Religar mantém a data em que foi ligado da
 * primeira vez enquanto continuou ligado; desligar zera — religar depois volta
 * a contar dali (sem retroativo, de novo).
 */
export function proximaConfig(atual: ConfigDoAviso, ligar: boolean, agora: Date): ConfigDoAviso {
  if (!ligar) return CONFIG_DESLIGADA;
  if (atual.ligado && atual.ligado_em) return atual;
  return { ligado: true, ligado_em: agora.toISOString() };
}

// ─── as mensagens ───────────────────────────────────────────────────────────

export interface MensagemDaConversa {
  id: string;
  direction: "inbound" | "outbound";
  sent_via: string | null;
  type: string;
  body: string | null;
  /** Transcrição do áudio ou leitura da imagem, quando houver. */
  media_derived_text: string | null;
  created_at: string;
  /** Preenchido pela rodada: resposta automática do WhatsApp Business. */
  automatica?: boolean;
}

/** Saiu do celular até este tempo depois da mensagem do lead: candidata a automática. */
export const JANELA_DA_AUTOMATICA_MS = 60_000;
/** Texto curto ("ok", "bom dia") é gente, não automação. */
export const TAMANHO_MINIMO_DA_AUTOMATICA = 20;
/** O mesmo texto em pelo menos tantas conversas (30 dias) confirma a automação. */
export const CONVERSAS_PARA_CONFIRMAR_AUTOMATICA = 3;

/**
 * Esta mensagem nossa PODE ser a resposta automática do WhatsApp Business? A
 * confirmação (o mesmo texto em várias conversas) é da rodada, com o banco.
 */
export function pareceRespostaAutomatica(m: MensagemDaConversa, anterior: MensagemDaConversa | null): boolean {
  if (m.direction !== "outbound" || m.sent_via !== "external_device" || m.type !== "text") return false;
  if ((m.body ?? "").trim().length < TAMANHO_MINIMO_DA_AUTOMATICA) return false;
  if (!anterior || anterior.direction !== "inbound") return false;
  const dt = Date.parse(m.created_at) - Date.parse(anterior.created_at);
  return dt >= 0 && dt <= JANELA_DA_AUTOMATICA_MS;
}

// ─── a avaliação ────────────────────────────────────────────────────────────

export interface EntradaDaAvaliacao {
  /** Mensagens recentes da conversa, da mais antiga para a mais nova. */
  mensagens: MensagemDaConversa[];
  /** Melhor posição de um negócio do contato no alcance; `null` = sem negócio. */
  posicao: PosicaoNoAlcance | null;
  ehGrupo: boolean;
  contatoBloqueado: boolean;
  contatoInterno: boolean;
  ligadoEm: Date;
  agora: Date;
  expediente: Pick<Expediente, "timezone" | "windows">;
}

export type Avaliacao =
  | { tipo: "fora"; motivo: "grupo" | "bloqueado" | "interno" | "sem_negocio" | "fora_do_alcance" }
  | { tipo: "respondida" }
  | { tipo: "antes_de_ligar" }
  | { tipo: "no_prazo"; desde: Date }
  | { tipo: "encerrou"; ultima: MensagemDaConversa }
  | { tipo: "avisar"; desde: Date; ultima: MensagemDaConversa }
  | { tipo: "conferir"; desde: Date; ultima: MensagemDaConversa; trecho: MensagemDaConversa[] };

const ehNossaDeVerdade = (m: MensagemDaConversa) => m.direction === "outbound" && m.automatica !== true;

export function avaliarConversa(e: EntradaDaAvaliacao): Avaliacao {
  if (e.ehGrupo) return { tipo: "fora", motivo: "grupo" };
  if (e.contatoBloqueado) return { tipo: "fora", motivo: "bloqueado" };
  if (e.contatoInterno) return { tipo: "fora", motivo: "interno" };
  if (e.posicao === null) return { tipo: "fora", motivo: "sem_negocio" };
  if (e.posicao === "fora") return { tipo: "fora", motivo: "fora_do_alcance" };

  const msgs = e.mensagens;
  let iNossa = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (ehNossaDeVerdade(msgs[i]!)) {
      iNossa = i;
      break;
    }
  }
  const semResposta = msgs.slice(iNossa + 1).filter((m) => m.direction === "inbound");
  if (semResposta.length === 0) return { tipo: "respondida" };

  const ligadoEm = e.ligadoEm.getTime();
  const contam = semResposta.filter((m) => Date.parse(m.created_at) >= ligadoEm);
  if (contam.length === 0) return { tipo: "antes_de_ligar" };

  const desde = new Date(contam[0]!.created_at);
  const ultima = semResposta[semResposta.length - 1]!;
  if (!completouHorasDeExpediente(desde, e.agora, HORAS_ATE_O_AVISO, e.expediente)) {
    return { tipo: "no_prazo", desde };
  }

  const nossaAntes = iNossa >= 0 ? new Date(msgs[iNossa]!.created_at) : null;
  const forma = decidirPelaForma(
    { tipo: ultima.type, texto: ultima.body ?? ultima.media_derived_text, em: new Date(ultima.created_at) },
    nossaAntes,
  );
  if (forma === "encerrou") return { tipo: "encerrou", ultima };
  if (forma === "pede_resposta") return { tipo: "avisar", desde, ultima };
  return { tipo: "conferir", desde, ultima, trecho: msgs.slice(-MENSAGENS_DA_LEITURA) };
}

/** A melhor posição entre os negócios do contato: potencial > pode voltar > fora. */
export function melhorPosicao(posicoes: PosicaoNoAlcance[]): PosicaoNoAlcance | null {
  if (posicoes.length === 0) return null;
  if (posicoes.includes("com_potencial")) return "com_potencial";
  if (posicoes.includes("pode_voltar")) return "pode_voltar";
  return "fora";
}

// ─── o texto do aviso ───────────────────────────────────────────────────────

/** Título e corpo no idioma da organização. Sem nome do contato (LGPD). */
export function textoDoAviso(
  t: (s: string) => string,
  entrada: { desde: Date; etapa: string | null; fuso: string; idioma: string },
): { title: string; body: string } {
  const dia = new Intl.DateTimeFormat(entrada.idioma, {
    timeZone: entrada.fuso,
    day: "2-digit",
    month: "2-digit",
  }).format(entrada.desde);
  const hora = new Intl.DateTimeFormat(entrada.idioma, {
    timeZone: entrada.fuso,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(entrada.desde);
  const primeira = t("O lead escreveu em {dia} às {hora} e ninguém respondeu.")
    .replace("{dia}", dia)
    .replace("{hora}", hora);
  const etapa = entrada.etapa ? ` ${t("Etapa: {etapa}.").replace("{etapa}", entrada.etapa)}` : "";
  return { title: t("Um lead escreveu e ninguém respondeu"), body: `${primeira}${etapa}` };
}

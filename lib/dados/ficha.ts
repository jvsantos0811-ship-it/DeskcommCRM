/**
 * A FICHA DO LEAD — o que o Leitor da conversa (PM-027 §1 e §4; Regra v2 §2.2)
 * tira da conversa: FATOS, cada um com o trecho que prova. Nenhuma decisão de
 * situação, temperatura ou qualidade mora aqui — isso é da regra fixa
 * (`lib/dados/regra-da-ficha.ts`), código puro e igual para todo cliente.
 *
 * Este arquivo é o schema central da coluna `crm_lead_ficha.ficha` (jsonb): a
 * saída do modelo passa por `fichaDoLeitorSchema` antes de ser gravada, e quem
 * lê a coluna usa `lerFicha` — nunca o caminho do jsonb na mão.
 *
 * Campos que vêm do BANCO (última fala do lead, card duplicado, nunca
 * respondido, quem atendeu) não são pedidos ao modelo: são medidos na hora
 * (`FatosDoBanco`), porque mudam com o relógio e o modelo não os vê melhor do que
 * a tabela.
 */
import { z } from "zod";

export const CONTATOS = ["lead", "cliente", "interno", "engano", "ilegivel"] as const;
export const CONTOU_O_CASO = ["nao", "parcial", "sim"] as const;
export const REQUISITOS = ["atende", "a_confirmar", "nao_atende"] as const;
export const NEGOCIACOES = ["nenhuma", "proposta", "contrato_enviado", "assinado"] as const;
export const OBJECOES = ["nenhuma", "confianca", "preco", "pensar", "familia", "documento", "outra"] as const;
export const PROXIMO_PASSO_COM = ["lead", "escritorio"] as const;
export const MOTIVOS_DA_ESPERA = ["ia_disse_que_equipe_chama", "lead_pediu_pessoa", "equipe_prometeu_retorno"] as const;

/** O interesse que o modelo não conseguiu ligar a um tipo do catálogo. */
export const INTERESSE_A_CONFIRMAR = "a_confirmar";

const textoCurto = z.string().trim().max(400);

export const fichaDoLeitorSchema = z.object({
  contato: z.enum(CONTATOS),
  /** Nome exato de um tipo de lead do catálogo, ou `a_confirmar`, ou null quando nada indica. */
  interesse: z.string().trim().max(120).nullable(),
  /** Com `a_confirmar`: o que a conversa diz (ex.: "filha, acidente"). */
  interesse_texto: textoCurto.nullable(),
  contou_o_caso: z.enum(CONTOU_O_CASO),
  requisitos: z.enum(REQUISITOS),
  requisitos_faltando: z.array(z.string().trim().min(1).max(160)).max(12),
  requisito_em_risco: z.boolean(),
  negociacao: z.enum(NEGOCIACOES),
  objecao: z.enum(OBJECOES),
  fora_da_area: z.boolean(),
  sem_caso: z.boolean(),
  recusou: z.boolean(),
  /** Outro profissional, escritório, clínica ou fornecedor cuida do caso agora (PM-027 §4). */
  ja_atendido_por_outro: z.boolean(),
  /** Parece cliente, mas a assinatura não aparece confirmada na conversa. */
  confirmar_assinatura: z.boolean(),
  /** Algum áudio ou documento do contato não pôde ser entendido. */
  midia_nao_entendida: z.boolean(),
  aguardando: z
    .object({
      evento: z.string().trim().min(1).max(160),
      /** ISO-8601 quando a conversa diz a data; null quando não diz. */
      data: z.string().trim().max(40).nullable(),
    })
    .nullable(),
  proximo_passo_com: z.enum(PROXIMO_PASSO_COM),
  palavras_proprias: z.boolean(),
  esperando_a_equipe: z
    .object({
      motivo: z.enum(MOTIVOS_DA_ESPERA),
      /** ISO-8601 da mensagem que criou a espera. */
      desde: z.string().trim().min(10).max(40),
      prova: textoCurto,
    })
    .nullable(),
  /** Campo → trecho curto da conversa que prova o valor. */
  provas: z.record(z.string(), textoCurto),
});

export type FichaDoLeitor = z.infer<typeof fichaDoLeitorSchema>;

/** Quem falou na conversa — medido no banco (PM-027 §4, `atendido_por`). */
export interface AtendidoPor {
  /** Nomes dos agentes de IA que tiveram turno com este contato. */
  agentes: string[];
  /** Quantas pessoas da equipe responderam pelo CRM. */
  pessoas_pelo_crm: number;
  /** A equipe respondeu pelo celular do escritório (fora do CRM). */
  pelo_celular: boolean;
}

/** Gatilho da leitura (PM-027 §3). */
export const GATILHOS = ["chat_novo", "mensagem_do_lead", "mensagem_da_equipe", "lead_voltou"] as const;
export type Gatilho = (typeof GATILHOS)[number];

/**
 * Quem leu a ficha (migration 9033, PC-036): o Leitor do CRM (`leitor_do_crm`,
 * o padrão do banco), a tarefa diária do Claude pela porta Ficha
 * (`leitor_0530`) ou a correção do Gestor (`gestor_17h10`, PC-037). O CHECK do
 * banco fala este vocabulário (`vocabulario-banco-x-typescript`).
 */
export const ORIGENS_DA_FICHA = ["leitor_do_crm", "leitor_0530", "gestor_17h10"] as const;
export type OrigemDaFicha = (typeof ORIGENS_DA_FICHA)[number];

/** Uma linha de `crm_lead_ficha` como o código a usa. */
export interface FichaGravada {
  lead_id: string;
  ficha: FichaDoLeitor;
  atendido_por: AtendidoPor;
  modelo: string;
  versao_prompt: string;
  lida_em: string;
  gatilho: Gatilho;
  /** A mensagem mais recente que a leitura viu. A seleção seguinte compara com ela. */
  mensagens_ate: string | null;
}

/** Lê o jsonb gravado; uma ficha que não passa no schema é tratada como ausente. */
export function lerFicha(valor: unknown): FichaDoLeitor | null {
  const r = fichaDoLeitorSchema.safeParse(valor);
  return r.success ? r.data : null;
}

/** Os fatos do banco que a regra fixa usa ao lado da ficha. */
export interface FatosDoBanco {
  /** A última mensagem do lead (qualquer conversa do contato). */
  ultima_fala_do_lead: Date | null;
  /** Outro card aberto do mesmo contato, criado antes deste. */
  duplicado: boolean;
  /** O contato escreveu e nunca recebeu resposta de verdade (IA ou pessoa). */
  nunca_respondido: boolean;
  /** Há mídia do contato marcada como não entendida (PC-021). */
  midia_nao_entendida: boolean;
}

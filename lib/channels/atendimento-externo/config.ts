/**
 * O que o operador escolhe na tela para o canal em que a IA atende DENTRO de
 * outra plataforma de atendimento — hoje o ChatGuru (PC-047).
 *
 * Mora em `channel_sessions.chatguru_config` (jsonb, migration 9038) e este é o
 * schema ÚNICO dela: a rota grava pelo `parse`, quem lê passa por
 * `lerConfigDoAtendimentoExterno`, que nunca lança. Ninguém lê o caminho do
 * jsonb direto (anti-pattern 6 do CLAUDE.md, "jsonb lock-in").
 *
 * ─── As três escolhas ────────────────────────────────────────────────────────
 *
 *  1. `dialogo_transferencia` — o diálogo da plataforma que devolve o chat à
 *     equipe. É o que a passagem para a equipe executa lá, além de calar a IA
 *     aqui. Vazio = a passagem só acontece no CRM (e a equipe precisa olhar o
 *     aviso da Central).
 *  2. `campo_da_ia` — o campo personalizado que, na plataforma, mantém o chat
 *     ligado na IA (é ele que faz a plataforma mandar cada mensagem para cá).
 *     Na passagem, o CRM grava `valor_ao_passar` nele, e a plataforma para de
 *     entregar. Vazio = a plataforma continua entregando, e o CRM ignora porque
 *     a conversa está com a equipe.
 *  3. `acoes` — até quinze diálogos (PC-052) que a IA PODE executar durante o atendimento
 *     (etiquetar, mover de funil, mandar um modelo). A IA escolhe pela `chave`,
 *     nunca por um id livre: a lista é fechada pelo operador.
 */
import { z } from "zod";

/** Id de diálogo da plataforma: curto, sem espaço, sem nada que vire parâmetro extra. */
const ID_DE_DIALOGO = /^[A-Za-z0-9_-]{4,64}$/;
/** Nome de campo personalizado como a plataforma aceita em `field__<nome>`. */
const NOME_DE_CAMPO = /^[A-Za-z0-9_]{1,40}$/;

/**
 * Quantas ações do ChatGuru a IA pode executar. Era 5 (PC-047); o PC-052 subiu
 * para 15 porque cada ETIQUETA da plataforma é um diálogo, e um SDR etiqueta
 * origem, assunto e desfecho — com 5 não cabiam nem as origens.
 */
export const MAXIMO_DE_ACOES = 15;

const acaoSchema = z.object({
  nome: z.string().trim().min(2).max(60),
  dialogo_id: z.string().trim().regex(ID_DE_DIALOGO),
  quando_usar: z.string().trim().min(5).max(200),
});

/** O que a tela manda. A `chave` de cada ação é derivada aqui, nunca vem de fora. */
export const configDoAtendimentoExternoEntrada = z.object({
  dialogo_transferencia: z
    .string()
    .trim()
    .regex(ID_DE_DIALOGO)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  campo_da_ia: z
    .object({
      nome: z.string().trim().regex(NOME_DE_CAMPO),
      valor_ao_passar: z.string().max(100).default(""),
    })
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  acoes: z.array(acaoSchema).max(MAXIMO_DE_ACOES).default([]),
});

export interface AcaoDoAtendimento {
  /** Identificador estável para a IA (`a-z0-9_`), derivado do nome. */
  chave: string;
  nome: string;
  dialogoId: string;
  quandoUsar: string;
}

export interface ConfigDoAtendimentoExterno {
  dialogoTransferencia: string | null;
  campoDaIa: { nome: string; valorAoPassar: string } | null;
  acoes: AcaoDoAtendimento[];
}

export const CONFIG_VAZIA: ConfigDoAtendimentoExterno = Object.freeze({
  dialogoTransferencia: null,
  campoDaIa: null,
  acoes: [],
}) as ConfigDoAtendimentoExterno;

/** `nome` → `chave`: minúsculas, sem acento, só `a-z0-9_`, nunca vazia. */
function chaveDoNome(nome: string): string {
  const base = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base.length > 0 ? base : "acao";
}

/** Chaves únicas na ordem da tela: a segunda "Etiquetar" vira `etiquetar_2`. */
function comChavesUnicas(acoes: z.output<typeof acaoSchema>[]): AcaoDoAtendimento[] {
  const vistas = new Map<string, number>();
  return acoes.map((a) => {
    const base = chaveDoNome(a.nome);
    const n = (vistas.get(base) ?? 0) + 1;
    vistas.set(base, n);
    return {
      chave: n === 1 ? base : `${base}_${n}`,
      nome: a.nome,
      dialogoId: a.dialogo_id,
      quandoUsar: a.quando_usar,
    };
  });
}

/** O que vai para o banco, a partir do que a tela mandou (já validado). */
export function configParaGravar(
  entrada: z.output<typeof configDoAtendimentoExternoEntrada>,
): Record<string, unknown> {
  return {
    dialogo_transferencia: entrada.dialogo_transferencia,
    campo_da_ia: entrada.campo_da_ia,
    acoes: comChavesUnicas(entrada.acoes).map((a) => ({
      chave: a.chave,
      nome: a.nome,
      dialogo_id: a.dialogoId,
      quando_usar: a.quandoUsar,
    })),
  };
}

const gravadoSchema = z.object({
  dialogo_transferencia: z.string().regex(ID_DE_DIALOGO).nullable().optional(),
  campo_da_ia: z
    .object({ nome: z.string().regex(NOME_DE_CAMPO), valor_ao_passar: z.string().max(100).optional() })
    .nullable()
    .optional(),
  acoes: z
    .array(
      z.object({
        chave: z.string().regex(/^[a-z0-9_]{1,48}$/),
        nome: z.string().max(60),
        dialogo_id: z.string().regex(ID_DE_DIALOGO),
        quando_usar: z.string().max(200),
      }),
    )
    .max(MAXIMO_DE_ACOES)
    .optional(),
});

/**
 * Lê o que está gravado. NUNCA lança: configuração ilegível vira "nada
 * escolhido" — a IA perde as ações e a passagem fica só no CRM, que é o
 * comportamento de quem nunca configurou. Inventar uma ação a partir de lixo
 * seria pior que não ter nenhuma.
 */
export function lerConfigDoAtendimentoExterno(raw: unknown): ConfigDoAtendimentoExterno {
  const lido = gravadoSchema.safeParse(raw ?? {});
  if (!lido.success) return CONFIG_VAZIA;
  const c = lido.data;
  return {
    dialogoTransferencia: c.dialogo_transferencia ?? null,
    campoDaIa: c.campo_da_ia ? { nome: c.campo_da_ia.nome, valorAoPassar: c.campo_da_ia.valor_ao_passar ?? "" } : null,
    acoes: (c.acoes ?? []).map((a) => ({
      chave: a.chave,
      nome: a.nome,
      dialogoId: a.dialogo_id,
      quandoUsar: a.quando_usar,
    })),
  };
}

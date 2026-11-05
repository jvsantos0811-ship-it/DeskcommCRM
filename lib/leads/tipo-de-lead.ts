/**
 * TIPO DE LEAD — o que o cliente procura (v3, seção 1).
 *
 * Um tipo de lead é um item do catálogo (`catalog_products`) com
 * `tipo_de_lead = true`: Auxílio-acidente, BPC/LOAS, Salário-maternidade no
 * escritório; Implante, Clareamento, Consulta na clínica. O `preco_cents` dele é
 * o faturamento médio por caso fechado.
 *
 * O interesse do negócio mora em `crm_leads.custom_fields.servico`, gravado com
 * o NOME EXATO de um tipo de lead ativo. Quando ele muda e o valor do negócio
 * está vazio (ou foi a própria regra que o preencheu), o banco grava o valor do
 * tipo — gatilho `fn_lead_valor_pelo_tipo_de_lead`, migration 9018. Valor
 * digitado por pessoa nunca é sobrescrito.
 *
 * ⚠️ A régua do nome existe DUAS vezes, e as duas têm de dizer o mesmo: aqui
 * (a IA grava o nome exato) e em `public.fn_nome_do_tipo_de_lead` (o gatilho
 * acha o item). O invariante `tests/invariants/valor-por-tipo-de-lead.test.ts`
 * compara as duas com as mesmas frases.
 */

/** A chave de `custom_fields` que guarda o interesse do negócio. */
export const CHAVE_DO_INTERESSE = "servico";

/**
 * Quem preencheu `crm_leads.value_cents`. Vocabulário ABERTO no banco (sem
 * CHECK); nulo com valor quer dizer pessoa (valor anterior à migration 9018).
 */
export const ORIGENS_DO_VALOR = ["pessoa", "tipo_de_lead"] as const;
export type OrigemDoValor = (typeof ORIGENS_DO_VALOR)[number];
export const VALOR_PELO_TIPO_DE_LEAD: OrigemDoValor = "tipo_de_lead";

/** O tipo da atividade da linha do tempo que o gatilho grava. */
export const ATIVIDADE_DO_VALOR_PELO_TIPO = "valor_pelo_tipo_de_lead" as const;

/** Sem maiúscula, acento nem pontuação: "BPC/LOAS" = "bpc loas" = "Bpc Loas". */
export function normalizarNomeDoTipo(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface TipoDeLead {
  nome: string;
}

export type ResultadoDoInteresse =
  | { ok: true; nome: string }
  | { ok: false; mensagem: string };

/**
 * O interesse que a IA quer gravar casa com um tipo de lead ativo? Devolve o
 * NOME EXATO do catálogo (é ele que vai para `custom_fields.servico`), ou o
 * erro de ensino com os nomes válidos. Puro, para teste.
 */
export function resolverInteresse(valor: unknown, tipos: readonly TipoDeLead[]): ResultadoDoInteresse {
  const nomes = tipos.map((t) => t.nome);
  const lista = nomes.length > 0 ? nomes.join("; ") : "(nenhum cadastrado)";
  if (typeof valor !== "string" || normalizarNomeDoTipo(valor) === "") {
    return {
      ok: false,
      mensagem: `O interesse (servico) precisa ser o nome de um tipo de lead do escritório. Use um destes, escrito igual: ${lista}.`,
    };
  }
  const alvo = normalizarNomeDoTipo(valor);
  const achado = tipos.find((t) => normalizarNomeDoTipo(t.nome) === alvo);
  if (achado) return { ok: true, nome: achado.nome };
  return {
    ok: false,
    mensagem:
      `"${valor.trim()}" não é um tipo de lead deste escritório; o interesse (servico) não foi gravado. ` +
      `Use um destes, escrito igual: ${lista}. Se o cliente procura outra coisa, não grave o interesse.`,
  };
}

/** A linha do bloco do turno com os tipos de lead — vazia quando não há nenhum. */
export function linhaDosTiposDeLead(nomes: readonly string[]): string {
  if (nomes.length === 0) return "";
  return (
    `Tipos de lead do escritório (grave o interesse em custom_fields.servico com um destes nomes, escrito igual): ` +
    nomes.join("; ")
  );
}

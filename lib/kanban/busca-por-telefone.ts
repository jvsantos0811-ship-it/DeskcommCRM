import { phoneLookupVariants } from "@/lib/channels/phone-variants";

/**
 * A busca do funil acha o card pelo TELEFONE do contato (PC-024, item 3).
 *
 * ─── Por que existe ──────────────────────────────────────────────────────────
 *
 * A busca do quadro olhava só título e descrição. A equipe recebe o número
 * (no celular, numa ligação, num print) e não achava o card: o título nasce com
 * o nome do perfil do WhatsApp, que nem sempre é o que a pessoa conhece.
 *
 * ─── O que conta como "busca por número" ─────────────────────────────────────
 *
 * Só quando o termo é feito de dígitos e da pontuação de telefone (`+`, `(`,
 * `)`, espaço, hífen, ponto) e tem pelo menos 4 dígitos. "Maria 1234" continua
 * busca de texto — misturar os dois faria "Ana 31" achar todo mundo do DDD 31.
 *
 * ─── O nono dígito e o 55 ────────────────────────────────────────────────────
 *
 * O número completo (10 ou 11 dígitos, ou 12/13 com o 55) passa pela MESMA
 * régua que funde contatos (`phoneLookupVariants`): "31 99876-1234" e
 * "31 9876-1234" são a mesma pessoa só quando o local é faixa de celular — um
 * 9 grudado num fixo não vira a variante de outra pessoa. Com 4 a 9 dígitos é
 * busca PARCIAL pelos últimos dígitos ("1234", "9876-1234").
 *
 * Sem banco: o quadro já traz o telefone de cada card (`contact_phone`) e filtra
 * no navegador. Nenhuma consulta nova, nenhum índice — a tela não fica mais
 * lenta (havia chamado aberto de lentidão).
 */

const SO_PONTUACAO_DE_TELEFONE = /^[\d\s()+.\-]+$/;
const MINIMO_DE_DIGITOS = 4;

/** Os dígitos do termo, quando ele é uma busca por número; senão `null`. */
export function digitosDaBuscaPorTelefone(termo: string): string | null {
  const t = termo.trim();
  if (!t || !SO_PONTUACAO_DE_TELEFONE.test(t)) return null;
  const digitos = t.replace(/\D/g, "");
  return digitos.length >= MINIMO_DE_DIGITOS ? digitos : null;
}

function soDigitos(v: string): string {
  return v.replace(/\D/g, "");
}

/**
 * As formas que o termo pode ter no cadastro, em dígitos. Número completo vira
 * E.164 brasileiro (com o 55) e ganha a contraparte com/sem o nono; parcial
 * fica como veio.
 */
function formasDoTermo(digitos: string): string[] {
  let completo: string | null = null;
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith("55")) completo = digitos;
  else if (digitos.length === 10 || digitos.length === 11) completo = `55${digitos}`;
  if (!completo) return [digitos];
  return phoneLookupVariants(completo).map(soDigitos);
}

/** O telefone do contato casa com o termo da busca? */
export function telefoneCasaComBusca(telefone: string | null | undefined, termo: string): boolean {
  if (!telefone) return false;
  const digitos = digitosDaBuscaPorTelefone(termo);
  if (!digitos) return false;
  const doContato = phoneLookupVariants(telefone).map(soDigitos);
  if (doContato.length === 0) return false;
  const doTermo = formasDoTermo(digitos);
  return doContato.some((c) => doTermo.some((t) => c === t || c.endsWith(t)));
}

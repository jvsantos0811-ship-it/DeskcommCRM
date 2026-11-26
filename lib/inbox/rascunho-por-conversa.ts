/**
 * O RASCUNHO É DA CONVERSA, NÃO DO CAMPO (PC-057, 26/11/2026).
 *
 * O defeito: o campo de resposta da Inbox tinha chave fixa e guardava o texto no
 * próprio estado. Escrever na conversa A e clicar na conversa B deixava o texto de
 * A no campo de B — a um Enter de sair para o cliente errado. O pop-up do negócio
 * tinha o mesmo desenho.
 *
 * O conserto tem duas metades, e esta é a da MEMÓRIA:
 *  - quem monta o campo dá a ele uma chave por conversa (trocar de conversa
 *    desmonta o campo, levando junto o texto, o anexo escolhido e a citação);
 *  - o texto de cada conversa fica guardado aqui e volta quando ela é reaberta.
 *
 * Mora SÓ na memória da aba, de propósito. Rascunho é texto sobre o cliente, às
 * vezes com dado de saúde, e gravá-lo no `localStorage` o deixaria no computador
 * (muitas vezes compartilhado no escritório) depois de fechar o navegador.
 *
 * A chave é PESSOA + CONVERSA. Sair da conta NÃO recarrega a página (é um server
 * action com redirect, e o login volta pela mesma árvore), então quem entra
 * depois na mesma aba não pode encontrar o rascunho de quem saiu: a pessoa faz
 * parte da chave, e o `signOut` do `AuthProvider` ainda esvazia tudo. Trocar de
 * organização recarrega a página; o id da conversa é UUID e não se repete entre
 * organizações.
 *
 * Teto de conversas guardadas: quem abre cem conversas num dia não precisa de cem
 * rascunhos na memória; vai embora o mais antigo.
 */

export type ModoDoRascunho = "reply" | "note";

export interface RascunhoDaConversa {
  texto: string;
  modo: ModoDoRascunho;
}

export const TETO_DE_RASCUNHOS = 50;

const rascunhos = new Map<string, RascunhoDaConversa>();

function chave(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

/** O rascunho desta pessoa nesta conversa, ou `null`. */
export function lerRascunhoDaConversa(userId: string, conversationId: string): RascunhoDaConversa | null {
  return rascunhos.get(chave(userId, conversationId)) ?? null;
}

/**
 * Guarda o que está no campo. Texto vazio (ou só espaços) APAGA: é o que o campo
 * fica depois de um envio que deu certo, e um rascunho vazio guardado faria a
 * conversa reabrir no modo de nota sem motivo.
 */
export function guardarRascunhoDaConversa(
  userId: string,
  conversationId: string,
  texto: string,
  modo: ModoDoRascunho,
): void {
  const k = chave(userId, conversationId);
  if (texto.trim() === "") {
    rascunhos.delete(k);
    return;
  }
  // Reinsere para ir ao fim da ordem: o `Map` itera na ordem de inserção, e o
  // primeiro da fila é o mais antigo a sair quando passa do teto.
  rascunhos.delete(k);
  rascunhos.set(k, { texto, modo });
  while (rascunhos.size > TETO_DE_RASCUNHOS) {
    const maisAntigo = rascunhos.keys().next().value;
    if (maisAntigo === undefined) break;
    rascunhos.delete(maisAntigo);
  }
}

/** Esvazia tudo — na saída da conta (`AuthProvider.signOut`) e nos testes. */
export function esquecerTodosOsRascunhos(): void {
  rascunhos.clear();
}

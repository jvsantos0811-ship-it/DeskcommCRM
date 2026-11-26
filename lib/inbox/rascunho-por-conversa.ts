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
 * (muitas vezes compartilhado no escritório) depois de fechar o navegador. Trocar
 * de organização e sair recarregam a página, o que apaga tudo daqui. A chave é o
 * id da conversa (UUID), que não se repete entre organizações.
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

/** O rascunho guardado da conversa, ou `null`. */
export function lerRascunhoDaConversa(conversationId: string): RascunhoDaConversa | null {
  return rascunhos.get(conversationId) ?? null;
}

/**
 * Guarda o que está no campo. Texto vazio (ou só espaços) APAGA: é o que o campo
 * fica depois de um envio que deu certo, e um rascunho vazio guardado faria a
 * conversa reabrir no modo de nota sem motivo.
 */
export function guardarRascunhoDaConversa(conversationId: string, texto: string, modo: ModoDoRascunho): void {
  if (texto.trim() === "") {
    rascunhos.delete(conversationId);
    return;
  }
  // Reinsere para ir ao fim da ordem: o `Map` itera na ordem de inserção, e o
  // primeiro da fila é o mais antigo a sair quando passa do teto.
  rascunhos.delete(conversationId);
  rascunhos.set(conversationId, { texto, modo });
  while (rascunhos.size > TETO_DE_RASCUNHOS) {
    const maisAntigo = rascunhos.keys().next().value;
    if (maisAntigo === undefined) break;
    rascunhos.delete(maisAntigo);
  }
}

/** Só para teste: começa do zero. */
export function esquecerTodosOsRascunhos(): void {
  rascunhos.clear();
}

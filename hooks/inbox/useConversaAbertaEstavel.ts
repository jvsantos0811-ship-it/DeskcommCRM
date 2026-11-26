"use client";
import { useState } from "react";

/**
 * A CONVERSA ABERTA NÃO PISCA QUANDO SAI DA LISTA.
 *
 * O defeito (relato de cliente, 25/11/2026): "mando uma mensagem e, quando
 * atualiza, apaga o que eu estava escrevendo".
 *
 * A Inbox pega o objeto da conversa aberta da MESMA consulta da lista
 * (`inList`) e, quando ela não está lá, de uma busca própria por id
 * (`useConversation`). O envio muda a conversa — `awaiting_since`,
 * `bot_silenced_until`, `unread_count_for_assignee`, `last_message_at` — e a
 * recarga da lista que vem com o realtime pode deixá-la de fora: na Fila ela
 * desce na ordem da espera e cai para além da página carregada; na aba IA o
 * envio humano cala o automático e ela muda de aba; com "Só não lidas" ela
 * deixa de ser não lida. Nesse instante `inList` vira `null`, a busca por id
 * ainda está saindo (`single.data` vazio), e por um render a conversa aberta
 * era `null`. A tela trocava o painel pelo "Selecione uma conversa" e o
 * `Composer` DESMONTAVA — o texto mora no `useState` dele, então voltava
 * vazio quando a busca por id chegava, meio segundo depois.
 *
 * O conserto não toca no composer nem nas consultas: enquanto a MESMA conversa
 * continua escolhida e nenhuma leitura disse que ela não existe mais, vale o
 * último objeto visto dela. A leitura nova, quando chega, substitui.
 *
 * - Trocar de conversa: o id muda e o objeto antigo nunca é usado para a nova.
 * - A busca por id voltou 404 (a conversa saiu do alcance da pessoa): vale a
 *   resposta, e a tela mostra "não encontrada" como antes.
 *
 * Ajuste de estado durante o render (o padrão do React para "lembrar do
 * render anterior"): converge no render seguinte, porque a partir dele o
 * objeto guardado É o atual.
 */
export function useConversaAbertaEstavel<T extends { id: string }>(
  selectedId: string | null,
  daLeitura: T | null,
  naoEncontrada: boolean,
): T | null {
  const [ultimaVista, setUltimaVista] = useState<T | null>(null);
  if (daLeitura && daLeitura !== ultimaVista) setUltimaVista(daLeitura);
  if (daLeitura) return daLeitura;
  if (!selectedId || naoEncontrada) return null;
  return ultimaVista?.id === selectedId ? ultimaVista : null;
}

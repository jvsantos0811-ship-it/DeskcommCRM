"use client";
import { forwardRef, useCallback, useState, type ComponentProps } from "react";

import { Composer, type ComposerHandle } from "@/components/inbox/Composer";
import { useAuth } from "@/hooks/auth/AuthProvider";
import {
  guardarRascunhoDaConversa,
  lerRascunhoDaConversa,
  type RascunhoDaConversa,
} from "@/lib/inbox/rascunho-por-conversa";

type Props = Omit<ComponentProps<typeof Composer>, "initialDraft" | "initialMode" | "onDraftChange" | "ref"> & {
  /**
   * Texto sugerido por integração (`?rascunho=`, issue #1611) para ESTA conversa.
   * Quando vem, vence o rascunho guardado: o link foi aberto justamente para usá-lo.
   */
  textoSugerido?: string | null;
};

/**
 * O campo de resposta com o rascunho DA CONVERSA (PC-057).
 *
 * Quem monta este componente dá a ele `key` por conversa. Trocar de conversa
 * desmonta o campo inteiro — texto, anexo escolhido, citação, modo — e o
 * rascunho de cada uma fica em `lib/inbox/rascunho-por-conversa.ts`, de onde
 * volta quando a conversa é reaberta. Antes, a chave era fixa e o texto escrito
 * para um cliente aparecia no campo do próximo.
 *
 * A leitura do guardado mora no inicializador do `useState`, e não no corpo do
 * render: o valor só importa na montagem, e o render fica puro.
 */
export const ComposerDaConversa = forwardRef<ComposerHandle, Props>(function ComposerDaConversa(
  { textoSugerido = null, ...props },
  ref,
) {
  const { conversationId } = props;
  // A pessoa entra na chave: sair da conta não recarrega a página, e quem entra
  // depois na mesma aba não pode ver o rascunho de quem saiu.
  const userId = useAuth().user.id;
  const [inicial] = useState<RascunhoDaConversa | null>(() =>
    textoSugerido !== null ? { texto: textoSugerido, modo: "reply" } : lerRascunhoDaConversa(userId, conversationId),
  );
  // Com o texto SUGERIDO no campo, nada é guardado — e o guardado antes é
  // esquecido. O sugerido só volta pelo link, que o servidor relê e que traz a
  // faixa de origem e o consumo de uso único (#1611); guardá-lo aqui o faria
  // reaparecer sem a faixa, como se fosse texto da própria pessoa.
  const modoSugerido = textoSugerido !== null;
  const guardar = useCallback(
    (texto: string, modo: "reply" | "note") =>
      guardarRascunhoDaConversa(userId, conversationId, modoSugerido ? "" : texto, modo),
    [userId, conversationId, modoSugerido],
  );
  return (
    <Composer
      ref={ref}
      {...props}
      initialDraft={inicial?.texto ?? ""}
      initialMode={inicial?.modo ?? "reply"}
      onDraftChange={guardar}
    />
  );
});

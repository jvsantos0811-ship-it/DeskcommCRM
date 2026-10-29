"use client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Uma preferência de TELA guardada no navegador (`localStorage`), lida sem
 * quebrar a hidratação (PC-011: laterais recolhidas do card, faixa de
 * conformidade recolhida).
 *
 * Por que não `useState(() => localStorage…)`: o inicializador roda de novo na
 * hidratação com `window` de verdade, e o cliente diverge do HTML do servidor
 * (cerca `hidratacao-useState-nao-le-o-navegador`). Com `useSyncExternalStore`
 * o servidor e a primeira pintura do cliente veem `null`, e só depois do commit
 * o React troca para o valor guardado — o mesmo caminho de `lib/theme.tsx`.
 *
 * Sem armazenamento (aba privada, bloqueado), lê `null` e gravar não faz nada:
 * a preferência só não sobrevive ao recarregar.
 */
type Ouvinte = () => void;
const ouvintes = new Set<Ouvinte>();

function avisar(): void {
  for (const ouvinte of ouvintes) ouvinte();
}

function inscrever(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  // Outra aba mudou a mesma preferência: a tela acompanha.
  window.addEventListener("storage", ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
    window.removeEventListener("storage", ouvinte);
  };
}

export function lerPreferencia(chave: string): string | null {
  try {
    return window.localStorage.getItem(chave);
  } catch {
    return null;
  }
}

export function gravarPreferencia(chave: string, valor: string | null): void {
  try {
    if (valor === null) window.localStorage.removeItem(chave);
    else window.localStorage.setItem(chave, valor);
  } catch {
    // Sem armazenamento: só não lembra.
  }
  avisar();
}

/** O valor guardado em `chave` (ou `null`) e a função que o troca. */
export function usePreferenciaDoNavegador(
  chave: string,
): [string | null, (valor: string | null) => void] {
  const valor = useSyncExternalStore(
    inscrever,
    () => lerPreferencia(chave),
    () => null,
  );
  const gravar = useCallback((novo: string | null) => gravarPreferencia(chave, novo), [chave]);
  return [valor, gravar];
}

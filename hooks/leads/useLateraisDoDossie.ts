"use client";
import { useCallback } from "react";

import { usePreferenciaDoNavegador } from "@/hooks/ui/usePreferenciaDoNavegador";

/**
 * As colunas laterais do card do negócio, abertas ou recolhidas (PC-011).
 *
 * O estado é POR USUÁRIO e fica no navegador: quem recolhe as laterais para ler
 * a conversa encontra o card do mesmo jeito ao reabrir outro negócio e ao
 * recarregar a página. É uma preferência de tela, não um dado do negócio — por
 * isso não vai para o banco. Sem armazenamento (aba privada, bloqueado), as
 * duas nascem abertas e o clique vale até recarregar.
 */
export interface EstadoDasLaterais {
  dados: boolean;
  detalhes: boolean;
}

export function chaveDasLaterais(userId: string): string {
  return `dossie:laterais-recolhidas:${userId}`;
}

/** Lê o que foi guardado; qualquer coisa ilegível vale "as duas abertas". */
export function interpretarLaterais(bruto: string | null): EstadoDasLaterais {
  if (!bruto) return { dados: false, detalhes: false };
  try {
    const lido = JSON.parse(bruto) as Partial<EstadoDasLaterais>;
    return { dados: lido.dados === true, detalhes: lido.detalhes === true };
  } catch {
    return { dados: false, detalhes: false };
  }
}

export function useLateraisDoDossie(userId: string) {
  const [bruto, gravar] = usePreferenciaDoNavegador(chaveDasLaterais(userId));
  const estado = interpretarLaterais(bruto);

  const alternar = useCallback(
    (lado: keyof EstadoDasLaterais) => {
      const atual = interpretarLaterais(bruto);
      gravar(JSON.stringify({ ...atual, [lado]: !atual[lado] }));
    },
    [bruto, gravar],
  );

  return {
    dadosRecolhidos: estado.dados,
    detalhesRecolhidos: estado.detalhes,
    alternarDados: () => alternar("dados"),
    alternarDetalhes: () => alternar("detalhes"),
  };
}

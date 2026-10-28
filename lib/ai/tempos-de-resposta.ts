/**
 * Tempo de resposta da IA (PC-002, Fase 1, item 5) — as contas puras da
 * consulta: resumo e planilha. A rota é `app/api/v1/ai/tempos-de-resposta`; a
 * escrita é do worker (`lib/agent-engine/agent/tempo-do-turno.ts`).
 */

export interface TempoDeResposta {
  created_at: string;
  conversation_id: string;
  agent_id: string | null;
  ultima_msg_cliente_em: string | null;
  primeira_bolha_em: string | null;
  espera_ms: number | null;
  mensagens_respondidas: number;
  bolhas_retidas: number;
  ferramentas_falharam: number;
}

export interface ResumoDosTempos {
  turnos: number;
  /** Turnos em que a 1ª bolha saiu. */
  respondidos: number;
  mediana_ms: number | null;
  pior_ms: number | null;
  /** Turnos que responderam a mais de uma mensagem do cliente de uma vez. */
  juntaram_mensagens: number;
  bolhas_retidas: number;
  ferramentas_falharam: number;
}

export function resumirTempos(linhas: readonly TempoDeResposta[]): ResumoDosTempos {
  const esperas = linhas
    .map((l) => l.espera_ms)
    .filter((e): e is number => typeof e === "number")
    .sort((a, b) => a - b);
  const meio = Math.floor(esperas.length / 2);
  const mediana =
    esperas.length === 0
      ? null
      : esperas.length % 2 === 1
        ? esperas[meio]!
        : Math.round((esperas[meio - 1]! + esperas[meio]!) / 2);
  return {
    turnos: linhas.length,
    respondidos: linhas.filter((l) => l.primeira_bolha_em !== null).length,
    mediana_ms: mediana,
    pior_ms: esperas.length === 0 ? null : esperas[esperas.length - 1]!,
    juntaram_mensagens: linhas.filter((l) => l.mensagens_respondidas > 1).length,
    bolhas_retidas: linhas.reduce((s, l) => s + l.bolhas_retidas, 0),
    ferramentas_falharam: linhas.reduce((s, l) => s + l.ferramentas_falharam, 0),
  };
}

/** Célula CSV: aspas quando há separador, aspas ou quebra de linha. */
function celula(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A planilha, com `;` como separador (o Excel em português abre direto) e BOM
 * para os acentos do cabeçalho. A espera vai em SEGUNDOS, com uma casa: é a
 * unidade que quem lê a planilha usa.
 */
export function linhasParaCsv(linhas: readonly TempoDeResposta[], t: (texto: string) => string): string {
  const cabecalho = [
    t("Quando"),
    t("Conversa"),
    t("Agente"),
    t("Última mensagem do cliente"),
    t("1ª resposta"),
    t("Espera (s)"),
    t("Mensagens respondidas"),
    t("Bolhas retidas"),
    t("Ferramentas que falharam"),
  ];
  const corpo = linhas.map((l) =>
    [
      l.created_at,
      l.conversation_id,
      l.agent_id,
      l.ultima_msg_cliente_em,
      l.primeira_bolha_em,
      l.espera_ms === null ? null : (l.espera_ms / 1000).toFixed(1),
      l.mensagens_respondidas,
      l.bolhas_retidas,
      l.ferramentas_falharam,
    ]
      .map(celula)
      .join(";"),
  );
  return "﻿" + [cabecalho.map(celula).join(";"), ...corpo].join("\r\n") + "\r\n";
}

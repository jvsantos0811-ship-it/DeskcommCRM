/**
 * A CONVERSA TERMINOU? — 1ª camada do aviso "Ninguém respondeu" (PM-025 §7).
 *
 * O aviso dispara quando a última mensagem é do lead e ninguém (IA ou pessoa,
 * inclusive pelo celular) respondeu em 1 hora de expediente. Mas "obrigado",
 * "ok" ou um 👍 depois de uma resposta nossa não pedem resposta: a conversa
 * acabou. Esta camada decide SEM IA o que dá para decidir pela forma:
 *
 *   - mensagem inteira que é só despedida ou encerramento (obrigado, obg,
 *     brigado, valeu, ok, okay, blz, beleza, certo, combinado, tá bom, perfeito,
 *     tchau, até mais, até logo, falou, abraço…), emoji sozinho, reação ou
 *     figurinha, logo DEPOIS de uma resposta nossa → "encerrou";
 *   - "bom dia", "boa tarde", "boa noite" só encerram quando vêm LOGO depois
 *     da nossa resposta (até 1 h); fora disso a saudação ABRE conversa e
 *     nunca é encerramento → "pede_resposta";
 *   - o resto a forma não decide → "indeciso", e a 2ª camada
 *     (`conferir_fim_da_conversa`, uma leitura curta das últimas 6 mensagens)
 *     responde. Na dúvida, ela avisa.
 *
 * Puro: sem banco, sem relógio.
 */

export type DecisaoDaForma = "encerrou" | "pede_resposta" | "indeciso";

export interface UltimaDoLead {
  /** `messages.type`: text, audio, image, sticker, reaction… */
  tipo: string;
  /** Texto (ou transcrição) da mensagem. */
  texto: string | null;
  /** Quando chegou. */
  em: Date;
}

/** Até quanto depois da nossa resposta um encerramento conta como encerramento. */
export const JANELA_DO_ENCERRAMENTO_MS = 24 * 60 * 60 * 1000;
/** Saudação só encerra se vier logo depois da nossa resposta ("boa noite" de despedida). */
export const JANELA_DA_SAUDACAO_DE_DESPEDIDA_MS = 60 * 60 * 1000;

const ENCERRAMENTOS = [
  "muito obrigado",
  "muito obrigada",
  "obrigadao",
  "obrigado",
  "obrigada",
  "obrigad",
  "obgd",
  "obg",
  "brigado",
  "brigada",
  "valeu",
  "vlw",
  "okay",
  "okk",
  "ok",
  "blz",
  "beleza",
  "certo",
  "certinho",
  "combinado",
  "ta bom",
  "ta otimo",
  "perfeito",
  "tchau",
  "ate mais",
  "ate logo",
  "falou",
  "abracos",
  "abraco",
  "grato",
  "grata",
  "amem",
  "deus abencoe",
];

const SAUDACOES = ["bom dia", "boa tarde", "boa noite"];

const TIPOS_SEM_TEXTO_QUE_ENCERRAM = new Set(["sticker", "reaction"]);

/** Minúsculas, sem acento, sem emoji nem pontuação, espaços colapsados. */
export function normalizarFala(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tira, da esquerda para a direita, as expressões da lista; sobra o que não é. */
function sobraDepoisDe(frase: string, lista: readonly string[]): string {
  let resto = ` ${frase} `;
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const e of lista) {
      const alvo = ` ${e} `;
      if (resto.includes(alvo)) {
        resto = resto.replace(alvo, " ");
        mudou = true;
      }
    }
  }
  return resto.trim();
}

/**
 * Decide pela forma. `nossaUltimaAntes` é a última mensagem nossa (IA ou
 * pessoa — não a resposta automática do WhatsApp Business) antes desta; `null`
 * quando a conversa não tem resposta nossa.
 */
export function decidirPelaForma(ultima: UltimaDoLead, nossaUltimaAntes: Date | null): DecisaoDaForma {
  const desdeANossa = nossaUltimaAntes === null ? null : ultima.em.getTime() - nossaUltimaAntes.getTime();
  const logoDepois = (janela: number) => desdeANossa !== null && desdeANossa >= 0 && desdeANossa <= janela;

  if (TIPOS_SEM_TEXTO_QUE_ENCERRAM.has(ultima.tipo)) {
    return logoDepois(JANELA_DO_ENCERRAMENTO_MS) ? "encerrou" : "indeciso";
  }
  const texto = ultima.texto ?? "";
  // Só texto conta como "mensagem inteira": áudio, foto e documento vão para a 2ª camada.
  if (ultima.tipo !== "text") return "indeciso";

  const fala = normalizarFala(texto);
  if (fala === "") {
    // Emoji sozinho (ou só pontuação).
    return texto.trim() !== "" && logoDepois(JANELA_DO_ENCERRAMENTO_MS) ? "encerrou" : "indeciso";
  }

  const semSaudacao = sobraDepoisDe(fala, SAUDACOES);
  const temSaudacao = semSaudacao !== fala;
  const semNada = sobraDepoisDe(semSaudacao, ENCERRAMENTOS);
  const temEncerramento = semNada !== semSaudacao;

  if (semNada !== "") return "indeciso";
  if (temEncerramento) {
    // "ok obrigado", "boa noite, obrigado": encerramento com ou sem saudação.
    return logoDepois(JANELA_DO_ENCERRAMENTO_MS) ? "encerrou" : "indeciso";
  }
  if (temSaudacao) {
    // Saudação sozinha: despedida só logo depois da nossa resposta; senão ABRE conversa.
    return logoDepois(JANELA_DA_SAUDACAO_DE_DESPEDIDA_MS) ? "encerrou" : "pede_resposta";
  }
  return "indeciso";
}

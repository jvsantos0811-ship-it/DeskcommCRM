/**
 * PC-035 B2 — envios EM CURSO num turno.
 *
 * O modelo chama `send_message` e `request_human_handoff` na MESMA passada e o
 * SDK executa as ferramentas da passada em paralelo. A passagem decide se manda
 * o aviso padrão ao lead lendo quantas mensagens já saíram no turno (`seq`); lida
 * antes de o envio terminar, ela via zero e mandava o aviso por cima da fala do
 * modelo, ou em dobro. A passagem espera os envios em curso antes de decidir.
 *
 * Função pura, sem banco e sem modelo.
 */
export interface EnviosEmCurso {
  /** Registra a promessa de um envio enquanto ela corre e a devolve intacta. */
  acompanhar<T>(envio: Promise<T>): Promise<T>;
  /** Espera todos os envios em curso terminarem (resolvidos ou não). Nunca lança. */
  esperar(): Promise<void>;
  /** Quantos envios estão correndo agora. */
  readonly emCurso: number;
}

export function criarEnviosEmCurso(): EnviosEmCurso {
  const correndo = new Set<Promise<unknown>>();
  return {
    acompanhar<T>(envio: Promise<T>): Promise<T> {
      correndo.add(envio);
      const tirar = (): void => {
        correndo.delete(envio);
      };
      envio.then(tirar, tirar);
      return envio;
    },
    async esperar(): Promise<void> {
      if (correndo.size === 0) return;
      await Promise.allSettled([...correndo]);
    },
    get emCurso(): number {
      return correndo.size;
    },
  };
}

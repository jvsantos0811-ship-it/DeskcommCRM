/**
 * AS TRÊS PORTAS DA AGÊNCIA — o que cada chave é, num lugar só.
 *
 * Uma chave comum (`api_tokens`) alcança UMA organização. A chave da agência
 * alcança todas as organizações da instalação, por uma rota própria, e só faz o
 * que a porta dela permite:
 *
 *   - Leitura (`/api/mcp/agencia`): lê tudo, inclusive conversas; não altera nada.
 *   - Admin   (`/api/mcp/agencia/admin`): altera a configuração; não lê conversa
 *     nem dado de contato e nunca fala com o cliente final.
 *   - Ficha   (`/api/mcp/agencia/ficha`, PC-036): o Leitor da conversa pelo
 *     Claude — lê a conversa de quem o Leitor leria e grava SÓ a ficha do lead,
 *     e só em organização com a escolha `claude`. Não move card, não muda etapa,
 *     não mexe em marcador nem fala com ninguém.
 *
 * O banco (migration 9014, `fn_api_tokens_guarda_da_agencia`) garante a forma
 * da chave: um escopo só, nome fixo, IPs obrigatórios, criada pelo dono da
 * instalação. Os valores aqui TÊM de bater com os de lá.
 */

export type PortaDaAgencia = "leitura" | "admin" | "ficha";

export interface DefinicaoDaPorta {
  porta: PortaDaAgencia;
  /** O único escopo que a chave carrega em `api_tokens.scopes`. */
  escopo: "agencia:leitura" | "agencia:admin" | "agencia:ficha";
  /** Nome fixo da chave (exigido pelo banco). */
  nome: "gestor-leitura" | "operador-admin" | "gestor-ficha";
  /** Caminho da rota MCP desta porta. */
  caminho: string;
}

export const PORTAS_DA_AGENCIA: Record<PortaDaAgencia, DefinicaoDaPorta> = {
  leitura: {
    porta: "leitura",
    escopo: "agencia:leitura",
    nome: "gestor-leitura",
    caminho: "/api/mcp/agencia",
  },
  admin: {
    porta: "admin",
    escopo: "agencia:admin",
    nome: "operador-admin",
    caminho: "/api/mcp/agencia/admin",
  },
  ficha: {
    porta: "ficha",
    escopo: "agencia:ficha",
    nome: "gestor-ficha",
    caminho: "/api/mcp/agencia/ficha",
  },
};

export const ESCOPOS_DA_AGENCIA = ["agencia:leitura", "agencia:admin", "agencia:ficha"] as const;

export function ehEscopoDaAgencia(escopo: string): boolean {
  return escopo.startsWith("agencia:");
}

/**
 * Faixa de SAÍDA da Anthropic: de onde partem as chamadas dos conectores MCP do
 * Claude. Publicada em https://platform.claude.com/docs/en/api/ip-addresses
 * (conferida em 30/10/2026; a Anthropic avisa antes de mudar). É o padrão da
 * lista de IPs de uma chave nova — o dono pode editar na criação.
 */
export const IPS_DE_SAIDA_DA_ANTHROPIC: readonly string[] = ["160.79.104.0/21"];

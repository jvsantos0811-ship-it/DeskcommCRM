/**
 * A CAMADA DE ASSINATURA ELETRÔNICA (PC-030, item 1) — a interface única.
 *
 * Cada serviço (ZapSign hoje; Clicksign, D4Sign e Autentique um por vez, cada
 * um só depois de passar nos critérios com a conta de teste dele) é um
 * adaptador desta interface. Quem usa — o envio do contrato, o aviso do
 * serviço, a tela de Configurações — fala só com ela.
 *
 * Três regras valem para todo adaptador:
 *
 *  1. **O aviso do serviço nunca é a verdade.** `lerAviso` só diz QUAL documento
 *     mudou; a situação é sempre relida na API do serviço (`consultar`), com a
 *     credencial da organização. Um corpo forjado com "assinado" não fecha
 *     negócio nenhum.
 *  2. **A credencial nunca sai daqui.** O adaptador recebe a chave já aberta,
 *     usa no cabeçalho e não a devolve em erro, log nem resposta.
 *  3. **Erro tem nome.** `ErroDoServico.codigo` diz o que a tela e a IA fazem
 *     com ele: credencial errada (a equipe corrige), serviço fora (tentar
 *     depois, caso "Contrato não gerado"), dado recusado (o que o serviço não
 *     aceitou), documento que não existe.
 */
import type { ProvedorEletronicoId } from "@/lib/contratos/vocabulario";

export type AmbienteDoServico = "teste" | "producao";

export interface CredencialDoServico {
  readonly chave: string;
  readonly ambiente: AmbienteDoServico;
}

export interface Signatario {
  readonly nome: string;
  /** Só dígitos, com o 55 do Brasil na frente. */
  readonly telefone: string;
  /** 11 dígitos, já conferidos; `null` quando o modelo não pede. */
  readonly cpf: string | null;
  readonly email: string | null;
}

export interface PedidoDeAssinatura {
  readonly pdf: Buffer;
  /** Como o documento aparece para o cliente no serviço. */
  readonly nomeDoDocumento: string;
  readonly signatario: Signatario;
  /** AAAA-MM-DD — depois disso o pedido expira. */
  readonly prazo: string;
  /** O id do contrato no CRM, gravado no serviço para achar o caminho de volta. */
  readonly referencia: string;
}

export interface PedidoCriado {
  /** O id do documento NO SERVIÇO — é por ele que o aviso acha o contrato. */
  readonly documentoId: string;
  /** O link que o cliente abre para assinar. */
  readonly linkAssinatura: string;
}

/** A situação do pedido, na língua do CRM. */
export const ESTADOS_NO_SERVICO = ["enviado", "visualizado", "assinado", "recusado", "expirado", "cancelado"] as const;
export type EstadoNoServico = (typeof ESTADOS_NO_SERVICO)[number];

export interface SituacaoNoServico {
  readonly estado: EstadoNoServico;
  /** ISO, quando o cliente abriu o link pela primeira vez (se o serviço diz). */
  readonly visualizadoEm: string | null;
  /** ISO, quando o cliente assinou. */
  readonly assinadoEm: string | null;
  /** O motivo que o cliente escreveu ao recusar, quando o serviço manda. */
  readonly motivoRecusa: string | null;
  /** Endereço TEMPORÁRIO do PDF assinado (o serviço o renova a cada consulta). */
  readonly arquivoAssinadoUrl: string | null;
}

/** O que um aviso do serviço diz: só o documento e o nome do evento. */
export interface AvisoDoServico {
  readonly documentoId: string;
  readonly evento: string;
}

export type CodigoDoErroDoServico =
  | "credencial_invalida"
  | "servico_fora"
  | "dado_recusado"
  | "nao_encontrado"
  | "resposta_inesperada";

export class ErroDoServico extends Error {
  constructor(
    public readonly codigo: CodigoDoErroDoServico,
    mensagem: string,
    /** Status HTTP do serviço, quando houve. Nunca o corpo inteiro (pode ecoar dado pessoal). */
    public readonly status: number | null = null,
  ) {
    super(mensagem);
    this.name = "ErroDoServico";
  }
}

export interface ServicoDeAssinatura {
  readonly id: ProvedorEletronicoId;
  /** Confere a credencial com uma leitura barata. Lança `ErroDoServico`. */
  testarConexao(): Promise<void>;
  criarPedido(pedido: PedidoDeAssinatura): Promise<PedidoCriado>;
  consultar(documentoId: string): Promise<SituacaoNoServico>;
  cancelar(documentoId: string): Promise<void>;
  /** Baixa o PDF assinado do endereço temporário que `consultar` devolveu. */
  baixarAssinado(url: string): Promise<Buffer>;
  /**
   * Cadastra no serviço o endereço do aviso, com o segredo num cabeçalho.
   * Devolve o id do aviso no serviço (para remover o antigo na troca).
   */
  registrarAviso(aviso: { url: string; cabecalho: string; segredo: string }): Promise<{ avisoId: string | null }>;
  removerAviso(avisoId: string): Promise<void>;
}

/** O `fetch` que o adaptador usa — injetável para os testes. */
export type BuscaHttp = (url: string, init?: RequestInit) => Promise<Response>;

/** Tamanho máximo do PDF assinado que baixamos (o mesmo do bucket de contratos). */
export const TETO_DO_PDF_ASSINADO = 20 * 1024 * 1024;

/**
 * O ENCAIXE DO SERVIÇO DE ASSINATURA (fork, migration 9008).
 *
 * Decisão do dono (27/10/2026): "deixar preparado para ter o serviço de
 * assinatura, mas por enquanto um humano envia o contrato". Este arquivo é o
 * "preparado": a rota de envio NÃO sabe como a assinatura é colhida — ela pede
 * ao provedor do contrato que prepare o documento e manda pelo WhatsApp o que
 * ele devolver.
 *
 *   manual (hoje)   → não prepara nada: o PDF vai como está, sem link, e o
 *                     desfecho é marcado por uma pessoa na tela;
 *   eletrônico (um dia, ZapSign/Clicksign/…) → sobe o PDF no serviço, devolve
 *                     o id do documento e o link de assinatura (que a mensagem
 *                     leva), e o desfecho chega pelo webhook do serviço.
 *
 * Desde o PC-030 os serviços eletrônicos moram em `lib/contratos/assinatura/`
 * (interface única, um adaptador por serviço, a conta cifrada por
 * organização). Aqui fica só o encaixe que a rota de envio usa: o `manual`
 * não prepara nada; um serviço eletrônico cria o pedido de assinatura com o
 * signatário e devolve o id do documento e o link. O aviso do serviço entra
 * pela rota que já existia (`/api/v1/webhooks/assinatura/:token`) e relê a
 * situação na API do serviço — nunca confia no corpo.
 *
 * O compilador amarra o registro ao vocabulário: um id novo sem adaptador não
 * compila.
 */
import type { ServicoDeAssinatura, Signatario } from "@/lib/contratos/assinatura/servico";
import { ErroDoServico } from "@/lib/contratos/assinatura/servico";
import type { ProvedorDeAssinaturaId } from "@/lib/contratos/vocabulario";

export interface EntradaDoPreparo {
  readonly organizationId: string;
  readonly contratoId: string;
  /** O PDF que o cliente vai assinar. */
  readonly pdf: Buffer;
  /** Como o arquivo se chama para o cliente. */
  readonly nomeDoArquivo: string;
  /** Só para serviço eletrônico: quem assina. */
  readonly signatario?: Signatario;
  /** Só para serviço eletrônico: AAAA-MM-DD, quando o pedido expira. */
  readonly prazo?: string;
  /** Só para serviço eletrônico: o serviço já com a credencial da organização. */
  readonly servico?: ServicoDeAssinatura;
}

export interface PreparoDaAssinatura {
  /** O id do documento NO SERVIÇO, para o webhook achar o contrato. `null` no manual. */
  readonly documentoId: string | null;
  /** O link de assinatura que a mensagem leva. `null` no manual. */
  readonly linkAssinatura: string | null;
}

export interface ProvedorDeAssinatura {
  readonly id: ProvedorDeAssinaturaId;
  /**
   * `true`: o desfecho (assinado/recusado) é marcado por uma pessoa na tela.
   * `false`: chega sozinho, pelo webhook do serviço — e a tela deixa de
   * oferecer "Marcar como assinado".
   */
  readonly desfechoPorPessoa: boolean;
  preparar(entrada: EntradaDoPreparo): Promise<PreparoDaAssinatura>;
}

const MANUAL: ProvedorDeAssinatura = {
  id: "manual",
  desfechoPorPessoa: true,
  async preparar() {
    return { documentoId: null, linkAssinatura: null };
  },
};

/** Um serviço eletrônico: cria o pedido no serviço com o signatário. */
function eletronico(id: Exclude<ProvedorDeAssinaturaId, "manual">): ProvedorDeAssinatura {
  return {
    id,
    desfechoPorPessoa: false,
    async preparar(e) {
      if (!e.servico || e.servico.id !== id) {
        throw new ErroDoServico("credencial_invalida", "O serviço de assinatura não está configurado nesta organização.");
      }
      if (!e.signatario || !e.prazo) {
        throw new ErroDoServico("dado_recusado", "Falta o signatário ou o prazo do pedido de assinatura.");
      }
      const r = await e.servico.criarPedido({
        pdf: e.pdf,
        nomeDoDocumento: e.nomeDoArquivo.replace(/\.pdf$/i, ""),
        signatario: e.signatario,
        prazo: e.prazo,
        referencia: e.contratoId,
      });
      return { documentoId: r.documentoId, linkAssinatura: r.linkAssinatura };
    },
  };
}

export function provedorDeAssinatura(id: ProvedorDeAssinaturaId): ProvedorDeAssinatura {
  switch (id) {
    case "manual":
      return MANUAL;
    case "zapsign":
      return eletronico("zapsign");
  }
}

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
 * Para ligar um serviço: o id entra em `PROVEDORES_DE_ASSINATURA`
 * (`vocabulario.ts`) e no CHECK de `crm_contracts.provedor_assinatura`
 * (migration nova + apêndice do baseline), o adaptador entra no `switch` de
 * `provedorDeAssinatura`, a chave por organização vai para uma tabela de
 * credenciais cifradas (o molde é `ai_provider_credentials`), e o webhook do
 * serviço ganha rota própria — que relê o estado na API do serviço, nunca
 * confia no corpo (o molde é `lib/cobranca/provedores/contrato.ts`).
 *
 * O compilador amarra o registro ao vocabulário: um id novo sem adaptador não
 * compila.
 */
import type { ProvedorDeAssinaturaId } from "@/lib/contratos/vocabulario";

export interface EntradaDoPreparo {
  readonly organizationId: string;
  readonly contratoId: string;
  /** O PDF que o cliente vai assinar. */
  readonly pdf: Buffer;
  /** Como o arquivo se chama para o cliente. */
  readonly nomeDoArquivo: string;
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

export function provedorDeAssinatura(id: ProvedorDeAssinaturaId): ProvedorDeAssinatura {
  switch (id) {
    case "manual":
      return MANUAL;
  }
}

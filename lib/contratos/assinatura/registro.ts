/**
 * O REGISTRO DOS SERVIÇOS DE ASSINATURA (PC-030).
 *
 * O compilador amarra este registro ao vocabulário: um id novo em
 * `PROVEDORES_ELETRONICOS` sem adaptador aqui não compila (o `switch` é
 * exaustivo). Um serviço entra só depois de passar nos critérios de aceite
 * com a conta de teste dele.
 */
import type { ProvedorEletronicoId } from "@/lib/contratos/vocabulario";

import type { AvisoDoServico, BuscaHttp, CredencialDoServico, ServicoDeAssinatura } from "./servico";
import { criarServicoZapsign, lerAvisoDaZapsign } from "./zapsign";

export function servicoDeAssinatura(
  id: ProvedorEletronicoId,
  cred: CredencialDoServico,
  busca?: BuscaHttp,
): ServicoDeAssinatura {
  switch (id) {
    case "zapsign":
      return criarServicoZapsign(cred, busca);
  }
}

/** Lê o aviso do serviço: só QUAL documento mudou. A situação vem de `consultar`. */
export function lerAvisoDoServico(id: ProvedorEletronicoId, corpo: unknown): AvisoDoServico | null {
  switch (id) {
    case "zapsign":
      return lerAvisoDaZapsign(corpo);
  }
}

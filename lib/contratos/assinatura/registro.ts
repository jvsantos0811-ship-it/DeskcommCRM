/**
 * O REGISTRO DOS SERVIÇOS DE ASSINATURA (PC-030).
 *
 * O compilador amarra este registro ao vocabulário: um id novo em
 * `PROVEDORES_ELETRONICOS` sem adaptador aqui não compila (o `switch` é
 * exaustivo). Um serviço entra só depois de passar nos critérios de aceite
 * com a conta de teste dele.
 */
import type { ProvedorEletronicoId } from "@/lib/contratos/vocabulario";

import {
  assinaturaDoAvisoConfere,
  CABECALHO_DO_AVISO_DA_AUTENTIQUE,
  criarServicoAutentique,
  lerAvisoDaAutentique,
} from "./autentique";
import type { AvisoDoServico, BuscaHttp, CadastroDoAviso, CredencialDoServico, ServicoDeAssinatura } from "./servico";
import { criarServicoZapsign, lerAvisoDaZapsign } from "./zapsign";

export function servicoDeAssinatura(
  id: ProvedorEletronicoId,
  cred: CredencialDoServico,
  busca?: BuscaHttp,
): ServicoDeAssinatura {
  switch (id) {
    case "zapsign":
      return criarServicoZapsign(cred, busca);
    case "autentique":
      return criarServicoAutentique(cred, busca);
  }
}

/** Como o aviso de cada serviço é cadastrado — sem precisar abrir a chave. */
export function cadastroDoAviso(id: ProvedorEletronicoId): CadastroDoAviso {
  switch (id) {
    case "zapsign":
      return "pela_api";
    case "autentique":
      return "no_painel";
  }
}

/** Lê o aviso do serviço: só QUAL documento mudou. A situação vem de `consultar`. */
export function lerAvisoDoServico(id: ProvedorEletronicoId, corpo: unknown): AvisoDoServico | null {
  switch (id) {
    case "zapsign":
      return lerAvisoDaZapsign(corpo);
    case "autentique":
      return lerAvisoDaAutentique(corpo);
  }
}

/**
 * A prova de origem do aviso cadastrado NO PAINEL do serviço (`no_painel`): a
 * assinatura que o próprio serviço calcula sobre o corpo bruto. Para os
 * serviços `pela_api` a prova é o segredo nosso no cabeçalho, conferido na rota.
 */
export function avisoDoPainelConfere(
  id: ProvedorEletronicoId,
  a: { corpoBruto: string; cabecalhos: Headers; segredos: ReadonlyArray<string | null> },
): boolean {
  switch (id) {
    case "zapsign":
      return false;
    case "autentique":
      return assinaturaDoAvisoConfere(a.corpoBruto, a.cabecalhos.get(CABECALHO_DO_AVISO_DA_AUTENTIQUE), a.segredos);
  }
}

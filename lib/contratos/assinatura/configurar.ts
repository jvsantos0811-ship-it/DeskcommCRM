/**
 * SALVAR A CONTA DE ASSINATURA ELETRÔNICA (PC-030) — o que a tela de
 * Configurações › Integrações › Assinatura eletrônica faz ao clicar "Salvar".
 *
 * A ordem importa, e cada passo só acontece se o anterior deu certo:
 *
 *  1. a chave (nova, ou a guardada) é TESTADA no serviço — chave errada para
 *     aqui, com a frase que a tela mostra, e nada é gravado;
 *  2. o endereço do aviso é (re)cadastrado no serviço com um segredo NOVO no
 *     cabeçalho: o banco só guarda o hash (na própria conta), então não há
 *     como recadastrar com o segredo antigo. O aviso anterior é tirado do
 *     serviço (melhor esforço);
 *  3. só então a conta é gravada, com a chave cifrada, o caminho e o hash.
 *
 * O endereço do aviso é a mesma porta de sempre (`/api/v1/webhooks/assinatura/:token`,
 * PC-003), mas com caminho e segredo PRÓPRIOS do serviço (colunas `aviso_*` da
 * conta): a porta genérica (`assinatura_webhook_chaves`) segue intocada, então
 * salvar a conta não corta uma integração que o escritório já usa, e trocar a
 * porta genérica não corta o aviso do serviço. O caminho é mantido entre
 * salvamentos; só o segredo troca.
 * Sem endereço público com https (instalação de teste em localhost), o aviso
 * não é cadastrado e a tela diz isso: o acompanhamento passa a depender de
 * consultar a situação.
 *
 * PC-046 — serviço com o aviso cadastrado NO PAINEL dele (Autentique,
 * `cadastroDoAviso = "no_painel"`): o passo 2 não chama o serviço. O caminho
 * do aviso é criado e mostrado na tela, o gerente cola no painel do serviço, e
 * o segredo que o serviço gera para aquele endpoint volta para cá
 * (`segredo_do_aviso`), cifrado como a chave — é com ele que o HMAC do aviso é
 * conferido. Trocar de serviço apaga o segredo do serviço anterior.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { HEADER_SEGREDO_DA_ASSINATURA, hashDoSegredo } from "@/lib/leads/assinatura-webhook";
import { ehProvedorEletronico, type ProvedorEletronicoId } from "@/lib/contratos/vocabulario";
import { logger } from "@/lib/logger";

import {
  abrirChave,
  colunasDaChave,
  colunasDoSegredoDoAviso,
  contaParaATela,
  enderecoDoAviso,
  lerLinhaDaConta,
  type ContaNaTela,
} from "./conta";
import { cadastroDoAviso, servicoDeAssinatura } from "./registro";
import { ErroDoServico, type AmbienteDoServico, type BuscaHttp } from "./servico";

export interface EntradaDaConta {
  provedor: ProvedorEletronicoId;
  ambiente: AmbienteDoServico;
  /** Nova chave da API. Ausente = mantém a guardada. */
  chave?: string;
  aprovacao_da_equipe: boolean;
  prazo_para_assinar_dias: number;
  ativo: boolean;
  /**
   * PC-046: o segredo do endpoint que o serviço gerou no painel dele (só para
   * `no_painel`). Ausente = mantém o guardado (do mesmo serviço).
   */
  segredo_do_aviso?: string;
}

/**
 * O que aconteceu com o aviso ao salvar:
 *  - `cadastrado`: pela API (ZapSign), ou no painel com o segredo já colado;
 *  - `falta_colar_no_painel`: o endereço está pronto na tela, falta o gerente
 *    criar o endpoint no painel do serviço e colar o segredo aqui;
 *  - `sem_endereco_publico`: instalação sem https público;
 *  - `falhou`: o serviço não aceitou o cadastro pela API.
 */
export type AvisoAoSalvar = "cadastrado" | "falta_colar_no_painel" | "sem_endereco_publico" | "falhou";

export type ResultadoDaConta =
  | { ok: true; conta: ContaNaTela; aviso: AvisoAoSalvar; trocouChave: boolean }
  | { ok: false; codigo: "sem_chave" | "credencial_invalida" | "servico_fora" | "erro"; mensagem: string };

/** Reexportado de `./conta` (onde a tela também o usa). */
export { enderecoDoAviso };

export async function salvarContaDeAssinatura(
  admin: SupabaseClient,
  a: { orgId: string; userId: string; entrada: EntradaDaConta; baseUrl: string; busca?: BuscaHttp },
): Promise<ResultadoDaConta> {
  const e = a.entrada;
  const atual = await lerLinhaDaConta(admin, a.orgId);
  const trocouChave = Boolean(e.chave);
  const chave = e.chave ?? (atual && atual.provedor === e.provedor ? abrirChave(atual) : null);
  if (!chave) {
    return { ok: false, codigo: "sem_chave", mensagem: "Cole a chave da API do serviço de assinatura." };
  }

  const servico = servicoDeAssinatura(e.provedor, { chave, ambiente: e.ambiente }, a.busca);
  try {
    await servico.testarConexao();
  } catch (err) {
    if (err instanceof ErroDoServico && err.codigo === "credencial_invalida") {
      return {
        ok: false,
        codigo: "credencial_invalida",
        mensagem:
          e.ambiente === "teste"
            ? "O serviço recusou a chave. Confira se ela é do ambiente de TESTE (sandbox)."
            : "O serviço recusou a chave. Confira se ela é do ambiente de PRODUÇÃO.",
      };
    }
    return {
      ok: false,
      codigo: "servico_fora",
      mensagem: "Não consegui falar com o serviço de assinatura agora. Tente de novo em alguns minutos.",
    };
  }

  // ── o endereço do aviso ──────────────────────────────────────────────────
  const mesmoServico = Boolean(atual && atual.provedor === e.provedor);
  let aviso: AvisoAoSalvar = "sem_endereco_publico";
  let avisoId: string | null = mesmoServico ? (atual?.aviso_id_no_servico ?? null) : null;
  let avisoEm: string | null = mesmoServico ? (atual?.aviso_registrado_em ?? null) : null;
  // O caminho do aviso deste serviço: o mesmo entre salvamentos (o serviço já o
  // conhece), novo só na primeira vez.
  const token = atual?.aviso_path_token ?? randomBytes(24).toString("base64url");
  let segredoSha256: string | null = mesmoServico ? (atual?.aviso_segredo_sha256 ?? null) : null;
  // O segredo do aviso cadastrado no painel (PC-046): o novo colado, ou o
  // guardado se o serviço é o mesmo. Trocar de serviço o descarta.
  let colunasDoSegredo: Record<string, string | null> = mesmoServico
    ? {}
    : { aviso_hmac_encrypted: null, aviso_hmac_iv: null, aviso_hmac_tag: null };
  const temSegredoGuardado = mesmoServico && Boolean(atual?.aviso_hmac_encrypted);

  // Trocou de serviço: o aviso cadastrado pela API no serviço ANTERIOR sai de lá
  // (melhor esforço, com a chave antiga), para ele não ficar mandando aviso.
  if (atual && !mesmoServico && atual.aviso_id_no_servico && ehProvedorEletronico(atual.provedor)) {
    const chaveAntiga = abrirChave(atual);
    if (chaveAntiga && cadastroDoAviso(atual.provedor) === "pela_api") {
      await servicoDeAssinatura(atual.provedor, {
        chave: chaveAntiga,
        ambiente: atual.ambiente === "teste" ? "teste" : "producao",
      }, a.busca)
        .removerAviso(atual.aviso_id_no_servico)
        .catch((err: unknown) =>
          logger.warn("[assinatura] aviso do serviço anterior não removido", {
            organization_id: a.orgId,
            detalhe: err instanceof Error ? err.message.slice(0, 120) : "erro",
          }),
        );
    }
  }

  if (e.ativo && servico.cadastroDoAviso === "no_painel") {
    // Nada a pedir ao serviço: o endereço vai para a tela, e o aviso prova a
    // origem pelo HMAC do serviço (não por um segredo nosso no cabeçalho).
    avisoId = null;
    segredoSha256 = null;
    if (enderecoDoAviso(a.baseUrl, token)) {
      if (e.segredo_do_aviso) {
        colunasDoSegredo = colunasDoSegredoDoAviso(e.segredo_do_aviso);
        avisoEm = new Date().toISOString();
        aviso = "cadastrado";
      } else if (temSegredoGuardado) {
        aviso = "cadastrado";
      } else {
        avisoEm = null;
        aviso = "falta_colar_no_painel";
      }
    }
  } else if (e.ativo) {
    const url = enderecoDoAviso(a.baseUrl, token);
    if (url) {
      const segredo = randomBytes(32).toString("base64url");
      try {
        const novo = await servico.registrarAviso({ url, cabecalho: HEADER_SEGREDO_DA_ASSINATURA, segredo });
        if (avisoId && avisoId !== novo.avisoId) {
          await servico.removerAviso(avisoId).catch((err: unknown) =>
            logger.warn("[assinatura] aviso antigo não removido", {
              organization_id: a.orgId,
              detalhe: err instanceof Error ? err.message.slice(0, 120) : "erro",
            }),
          );
        }
        avisoId = novo.avisoId;
        avisoEm = new Date().toISOString();
        segredoSha256 = hashDoSegredo(segredo);
        aviso = "cadastrado";
      } catch (err) {
        logger.warn("[assinatura] aviso não cadastrado no serviço", {
          organization_id: a.orgId,
          detalhe: err instanceof Error ? err.message.slice(0, 120) : "erro",
        });
        aviso = "falhou";
      }
    }
  }

  const linha = {
    organization_id: a.orgId,
    provedor: e.provedor,
    ambiente: e.ambiente,
    ...(trocouChave || !atual ? colunasDaChave(chave) : {}),
    aprovacao_da_equipe: e.aprovacao_da_equipe,
    prazo_para_assinar_dias: e.prazo_para_assinar_dias,
    aviso_id_no_servico: avisoId,
    aviso_registrado_em: avisoEm,
    aviso_path_token: token,
    aviso_segredo_sha256: segredoSha256,
    ...colunasDoSegredo,
    ativo: e.ativo,
    atualizado_por_user_id: a.userId,
  };
  const { error } = await admin.from("assinatura_eletronica_contas").upsert(linha, { onConflict: "organization_id" });
  if (error) return { ok: false, codigo: "erro", mensagem: "Não consegui salvar. Tente de novo." };

  const gravada = await lerLinhaDaConta(admin, a.orgId);
  const conta = gravada ? contaParaATela(gravada, a.baseUrl) : null;
  if (!conta) return { ok: false, codigo: "erro", mensagem: "Não consegui salvar. Tente de novo." };
  return { ok: true, conta, aviso, trocouChave };
}

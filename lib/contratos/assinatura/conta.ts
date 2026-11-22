/**
 * A CONTA DE ASSINATURA ELETRÔNICA DA ORGANIZAÇÃO (PC-030, migration 9027).
 *
 * Mora em `assinatura_eletronica_contas`, tabela só do servidor. A chave da API
 * do serviço é cifrada com a chave da instalação (`encryptKey`, AES-GCM — o
 * mesmo caminho das chaves de IA) e só é aberta no escopo de uma chamada ao
 * serviço. O que sai daqui para a tela é o resumo (`ContaNaTela`): serviço,
 * ambiente, os 4 últimos caracteres da chave e as escolhas — nunca a chave.
 *
 * Todo acesso filtra `organization_id`, que o chamador resolveu de fonte
 * confiável (sessão, token do caminho do aviso).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { ehProvedorEletronico, type ProvedorEletronicoId } from "@/lib/contratos/vocabulario";

import { cadastroDoAviso, servicoDeAssinatura } from "./registro";
import type { AmbienteDoServico, BuscaHttp, CadastroDoAviso, ServicoDeAssinatura } from "./servico";

export interface LinhaDaConta {
  organization_id: string;
  provedor: string;
  ambiente: string;
  chave_encrypted: string | null;
  chave_iv: string | null;
  chave_tag: string | null;
  chave_last4: string | null;
  aprovacao_da_equipe: boolean;
  prazo_para_assinar_dias: number;
  aviso_id_no_servico: string | null;
  aviso_registrado_em: string | null;
  /** O caminho do aviso DESTE serviço (`/api/v1/webhooks/assinatura/:token`). */
  aviso_path_token: string | null;
  /** Hash SHA-256 do segredo que o serviço manda no cabeçalho do aviso. */
  aviso_segredo_sha256: string | null;
  /**
   * PC-046: o segredo do endpoint que o SERVIÇO gera quando o aviso é
   * cadastrado no painel dele (Autentique), cifrado como a chave. É com ele que
   * o HMAC do aviso é conferido — por isso cifrado, e não hash.
   */
  aviso_hmac_encrypted: string | null;
  aviso_hmac_iv: string | null;
  aviso_hmac_tag: string | null;
  ativo: boolean;
  updated_at: string;
}

export interface ContaNaTela {
  provedor: ProvedorEletronicoId;
  ambiente: AmbienteDoServico;
  tem_chave: boolean;
  chave_final: string | null;
  aprovacao_da_equipe: boolean;
  prazo_para_assinar_dias: number;
  aviso_registrado_em: string | null;
  /** PC-046: `no_painel` = o gerente cola o endereço do aviso no painel do serviço. */
  cadastro_do_aviso: CadastroDoAviso;
  /** O endereço para colar no painel do serviço; só para `no_painel` e com https público. */
  endereco_do_aviso: string | null;
  /** Se o segredo do aviso, gerado pelo serviço, já foi colado aqui (`no_painel`). */
  tem_segredo_do_aviso: boolean;
  ativo: boolean;
  atualizado_em: string;
}

const COLUNAS =
  "organization_id, provedor, ambiente, chave_encrypted, chave_iv, chave_tag, chave_last4, aprovacao_da_equipe, prazo_para_assinar_dias, aviso_id_no_servico, aviso_registrado_em, aviso_path_token, aviso_segredo_sha256, aviso_hmac_encrypted, aviso_hmac_iv, aviso_hmac_tag, ativo, updated_at";

/**
 * O endereço do aviso deste serviço, só num endereço público com https (o
 * serviço não alcança localhost nem rede interna). `null` = sem como avisar.
 */
export function enderecoDoAviso(baseUrl: string, token: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname === "localhost" || u.hostname.endsWith(".local") || /^127\.|^10\.|^192\.168\./.test(u.hostname)) {
    return null;
  }
  return `${u.origin}/api/v1/webhooks/assinatura/${token}`;
}

/** A conta dona de um caminho de aviso (o token do caminho, nunca o corpo). */
export async function contaDoCaminhoDoAviso(
  admin: SupabaseClient,
  token: string,
): Promise<LinhaDaConta | null> {
  const { data, error } = await admin
    .from("assinatura_eletronica_contas")
    .select(COLUNAS)
    .eq("aviso_path_token", token)
    .maybeSingle();
  if (error) throw new Error(`conta de assinatura: ${error.message}`);
  return (data as LinhaDaConta | null) ?? null;
}

export async function lerLinhaDaConta(admin: SupabaseClient, orgId: string): Promise<LinhaDaConta | null> {
  const { data, error } = await admin
    .from("assinatura_eletronica_contas")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`conta de assinatura: ${error.message}`);
  return (data as LinhaDaConta | null) ?? null;
}

export function contaParaATela(l: LinhaDaConta, baseUrl?: string): ContaNaTela | null {
  if (!ehProvedorEletronico(l.provedor)) return null;
  const cadastro = cadastroDoAviso(l.provedor);
  return {
    provedor: l.provedor,
    ambiente: l.ambiente === "teste" ? "teste" : "producao",
    tem_chave: Boolean(l.chave_encrypted),
    chave_final: l.chave_last4,
    aprovacao_da_equipe: l.aprovacao_da_equipe,
    prazo_para_assinar_dias: l.prazo_para_assinar_dias,
    aviso_registrado_em: l.aviso_registrado_em,
    cadastro_do_aviso: cadastro,
    // O endereço leva o token do caminho: vai só para quem já gerencia a conta
    // (gerente ou dono), e só para o serviço que precisa dele colado no painel.
    endereco_do_aviso:
      cadastro === "no_painel" && baseUrl && l.aviso_path_token ? enderecoDoAviso(baseUrl, l.aviso_path_token) : null,
    tem_segredo_do_aviso: Boolean(l.aviso_hmac_encrypted),
    ativo: l.ativo,
    atualizado_em: l.updated_at,
  };
}

/** Plaintext → colunas cifradas. A chave nunca é gravada em claro. */
export function colunasDaChave(chave: string): Pick<
  LinhaDaConta,
  "chave_encrypted" | "chave_iv" | "chave_tag" | "chave_last4"
> {
  const c = encryptKey(chave);
  return {
    chave_encrypted: bufToBytea(c.ciphertext),
    chave_iv: bufToBytea(c.iv),
    chave_tag: bufToBytea(c.tag),
    chave_last4: c.last4,
  };
}

/** O segredo do aviso (PC-046) → colunas cifradas, no mesmo molde da chave. */
export function colunasDoSegredoDoAviso(segredo: string): Pick<
  LinhaDaConta,
  "aviso_hmac_encrypted" | "aviso_hmac_iv" | "aviso_hmac_tag"
> {
  const c = encryptKey(segredo);
  return {
    aviso_hmac_encrypted: bufToBytea(c.ciphertext),
    aviso_hmac_iv: bufToBytea(c.iv),
    aviso_hmac_tag: bufToBytea(c.tag),
  };
}

/** O segredo do aviso aberto, ou `null`. */
export function abrirSegredoDoAviso(
  l: Pick<LinhaDaConta, "aviso_hmac_encrypted" | "aviso_hmac_iv" | "aviso_hmac_tag">,
): string | null {
  return abrirChave({ chave_encrypted: l.aviso_hmac_encrypted, chave_iv: l.aviso_hmac_iv, chave_tag: l.aviso_hmac_tag });
}

/** Colunas → plaintext; `null` quando não há chave ou a cifra não abre. */
export function abrirChave(l: Pick<LinhaDaConta, "chave_encrypted" | "chave_iv" | "chave_tag">): string | null {
  if (!l.chave_encrypted || !l.chave_iv || !l.chave_tag) return null;
  try {
    return decryptKey({
      ciphertext: byteaToBuffer(l.chave_encrypted),
      iv: byteaToBuffer(l.chave_iv),
      tag: byteaToBuffer(l.chave_tag),
    });
  } catch {
    return null;
  }
}

export interface ServicoDaOrganizacao {
  readonly servico: ServicoDeAssinatura;
  readonly conta: LinhaDaConta & { provedor: ProvedorEletronicoId };
}

/**
 * O serviço de assinatura pronto para usar, ou `null` com o motivo:
 * sem conta, desligada, sem chave ou chave que não abre (instalação trocou a
 * chave de cifra). Nunca lança por falta de configuração.
 */
export async function servicoDaOrganizacao(
  admin: SupabaseClient,
  orgId: string,
  busca?: BuscaHttp,
): Promise<{ ok: true; valor: ServicoDaOrganizacao } | { ok: false; motivo: "sem_conta" | "desligada" | "sem_chave" }> {
  const l = await lerLinhaDaConta(admin, orgId);
  if (!l || !ehProvedorEletronico(l.provedor)) return { ok: false, motivo: "sem_conta" };
  if (!l.ativo) return { ok: false, motivo: "desligada" };
  const chave = abrirChave(l);
  if (!chave) return { ok: false, motivo: "sem_chave" };
  const ambiente: AmbienteDoServico = l.ambiente === "teste" ? "teste" : "producao";
  return {
    ok: true,
    valor: {
      servico: servicoDeAssinatura(l.provedor, { chave, ambiente }, busca),
      conta: { ...l, provedor: l.provedor },
    },
  };
}

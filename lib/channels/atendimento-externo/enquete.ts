/**
 * ENQUETE DO GRUPO (PC-050): quem votou vira conversa com a IA.
 *
 * O escritório faz enquete num grupo que fica no número de QR da plataforma de
 * atendimento (ChatGuru). Quem vota quer contato. Um diálogo da plataforma,
 * disparado pelo voto, manda ao votante o modelo aprovado da Meta pelo número
 * OFICIAL e faz o "POST PARA URL" para a entrada deste canal com um campo que
 * diz a enquete e a opção. O voto de enquete do WhatsApp chega cifrado no WAHA
 * (NOWEB quase não entrega voto de grupo): por isso o caminho é a plataforma.
 *
 * O que este módulo faz, e o que não faz:
 *   - lê o campo escolhido na tela (`enquetes_config.campo_do_voto`), que pode
 *     ser um campo do POST (`bot_context`) ou um campo personalizado
 *     (`campos_personalizados.ia_origem`);
 *   - reconhece `enquete:<código>:<opção>` (o contrato recomendado),
 *     `<código>:<opção>` e, com UMA enquete ativa, só `<opção>`;
 *   - grava o voto (um por contato e enquete; o mesmo de novo não muda nada;
 *     trocado atualiza) — SEM criar mensagem, SEM rodar a IA e SEM mandar nada:
 *     a 1ª mensagem ao votante é o modelo da Meta que a plataforma já mandou;
 *   - guarda os NOMES dos campos do último POST para a tela oferecer a escolha.
 *     Nunca os valores, e nada do grupo.
 * Chave desligada (padrão) = o canal se comporta como antes do PC-050.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";

import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { canonicalPhoneBR } from "../phone-variants";

export const CODIGO_DA_ENQUETE = /^[a-z0-9_-]{1,40}$/;
/** Nome de campo do POST, ou `campos_personalizados.<nome>`. Só nome. */
export const CAMPO_DO_VOTO = /^[A-Za-z0-9_$-]{1,60}(\.[A-Za-z0-9_$ -]{1,60})?$/;
/** Voto vale como contexto da conversa por este tempo. */
export const VOTO_VALE_DIAS = 14;

export const opcaoDaEnqueteSchema = z.strictObject({
  valor: z.string().trim().min(1).max(100),
  significado: z.string().trim().max(300).default(""),
  chamar: z.boolean().default(true),
});

export const enqueteSchema = z.strictObject({
  codigo: z.string().trim().regex(CODIGO_DA_ENQUETE, "Código: letras minúsculas, números, _ ou -, até 40."),
  pergunta: z.string().trim().min(1).max(300),
  opcoes: z.array(opcaoDaEnqueteSchema).min(1).max(12),
  ativa: z.boolean().default(true),
});

export type OpcaoDaEnquete = z.infer<typeof opcaoDaEnqueteSchema>;
export interface EnqueteCadastrada {
  id: string;
  codigo: string;
  pergunta: string;
  opcoes: OpcaoDaEnquete[];
  ativa: boolean;
}

/** Os NOMES dos campos de um POST: os de cima e os de `campos_personalizados`. */
export function nomesDosCampos(corpo: Record<string, unknown>): string[] {
  const nomes = new Set<string>();
  for (const k of Object.keys(corpo)) {
    if (CAMPO_DO_VOTO.test(k)) nomes.add(k);
  }
  const pers = camposPersonalizados(corpo);
  for (const k of Object.keys(pers)) {
    const nome = `campos_personalizados.${k}`;
    if (CAMPO_DO_VOTO.test(nome)) nomes.add(nome);
  }
  return [...nomes].sort().slice(0, 80);
}

/** `campos_personalizados` pode vir como objeto ou como JSON em texto. */
function camposPersonalizados(corpo: Record<string, unknown>): Record<string, unknown> {
  const bruto = corpo.campos_personalizados;
  if (bruto && typeof bruto === "object" && !Array.isArray(bruto)) return bruto as Record<string, unknown>;
  if (typeof bruto === "string" && bruto.trim().startsWith("{")) {
    try {
      const p = JSON.parse(bruto) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {
      // segue sem campos personalizados
    }
  }
  return {};
}

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** O valor do campo escolhido na tela, ou `null`. */
export function valorDoCampo(corpo: Record<string, unknown>, campo: string): string | null {
  const ponto = campo.indexOf(".");
  if (ponto < 0) return texto(corpo[campo]);
  const [raiz, nome] = [campo.slice(0, ponto), campo.slice(ponto + 1)];
  if (raiz !== "campos_personalizados") return null;
  return texto(camposPersonalizados(corpo)[nome]);
}

const sem = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

/**
 * Que enquete e que opção o valor diz. Pura. Só enquetes ATIVAS. Ordem:
 * `enquete:<código>:<opção>`, `<código>:<opção>`, e só `<opção>` quando há UMA
 * enquete ativa (sem ambiguidade). Opção comparada sem acento e sem caixa.
 */
export function interpretarVoto(
  valor: string,
  enquetes: readonly EnqueteCadastrada[],
): { enquete: EnqueteCadastrada; opcao: OpcaoDaEnquete } | null {
  const ativas = enquetes.filter((e) => e.ativa);
  if (ativas.length === 0) return null;
  const v = valor.trim().slice(0, 300);
  const achar = (e: EnqueteCadastrada, opcao: string) => {
    const o = e.opcoes.find((x) => sem(x.valor) === sem(opcao));
    return o ? { enquete: e, opcao: o } : null;
  };
  const partes = v.split(":");
  if (partes.length >= 3 && sem(partes[0]!) === "enquete") {
    const e = ativas.find((x) => x.codigo === sem(partes[1]!));
    return e ? achar(e, partes.slice(2).join(":")) : null;
  }
  if (partes.length >= 2) {
    const e = ativas.find((x) => x.codigo === sem(partes[0]!));
    if (e) return achar(e, partes.slice(1).join(":"));
  }
  return ativas.length === 1 ? achar(ativas[0]!, v) : null;
}

export interface ConfigDaEnquete {
  ligada: boolean;
  campoDoVoto: string | null;
  camposVistos: string[];
}

export async function lerConfigDaEnquete(admin: SupabaseClient, orgId: string): Promise<ConfigDaEnquete | null> {
  const { data, error } = await admin
    .from("enquetes_config")
    .select("ligada, campo_do_voto, campos_vistos")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`enquete: configuração ilegível (${error.code ?? "sem_codigo"})`);
  const d = data as { ligada: boolean; campo_do_voto: string | null; campos_vistos: string[] | null } | null;
  return d ? { ligada: d.ligada, campoDoVoto: d.campo_do_voto, camposVistos: d.campos_vistos ?? [] } : null;
}

export async function lerEnquetes(admin: SupabaseClient, orgId: string): Promise<EnqueteCadastrada[]> {
  const { data, error } = await admin
    .from("enquetes_do_grupo")
    .select("id, codigo, pergunta, opcoes, ativa")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`enquete: enquetes ilegíveis (${error.code ?? "sem_codigo"})`);
  return ((data ?? []) as Array<EnqueteCadastrada & { opcoes: unknown }>).map((e) => ({
    ...e,
    opcoes: z.array(opcaoDaEnqueteSchema).catch([]).parse(e.opcoes),
  }));
}

export type DesfechoDaEnquete =
  | { status: "sem_enquete" }
  | { status: "registrado"; enqueteId: string; contactId: string; opcao: string; mudou: boolean }
  | { status: "nao_reconhecido" };

/**
 * Chamado pela entrada do canal ANTES da leitura da mensagem. Nunca lança: a
 * enquete falhando não pode derrubar a entrada da mensagem (o pior caso é a
 * conversa seguir sem o contexto do voto).
 */
export async function tratarEnqueteDoPost(
  admin: SupabaseClient,
  p: { orgId: string; corpo: Record<string, unknown> | null; agora?: () => Date },
): Promise<DesfechoDaEnquete> {
  if (!p.corpo) return { status: "sem_enquete" };
  try {
    const config = await lerConfigDaEnquete(admin, p.orgId);
    await anotarCamposVistos(admin, p.orgId, config, p.corpo, p.agora ?? (() => new Date()));
    if (!config?.ligada || !config.campoDoVoto) return { status: "sem_enquete" };
    const valor = valorDoCampo(p.corpo, config.campoDoVoto);
    if (!valor) return { status: "sem_enquete" };
    const enquetes = await lerEnquetes(admin, p.orgId);
    const voto = interpretarVoto(valor, enquetes);
    if (!voto) return { status: "nao_reconhecido" };

    // Grupo nunca vira contato: só o chat do votante (o mesmo critério da entrada).
    const celularBruto = texto(p.corpo.celular);
    if (!celularBruto || celularBruto.includes("@")) return { status: "nao_reconhecido" };
    const celular = celularBruto.replace(/\D/g, "");
    if (celular.length < 10 || celular.length > 15) return { status: "nao_reconhecido" };

    const telefone = `+${celular}`;
    const existente = await encontrarContatoPorTelefone(admin, p.orgId, telefone);
    const phone = existente?.phone_number ? canonicalPhoneBR(existente.phone_number) : canonicalPhoneBR(telefone);
    const { data: contactId, error: erroContato } = await admin.rpc(
      "fn_upsert_wa_contact" as never,
      { p_org: p.orgId, p_kind: "phone", p_phone: phone, p_lid: null, p_chat_id: celular, p_notify: texto(p.corpo.nome) } as never,
    );
    if (erroContato || !contactId) {
      logger.warn("[enquete] contato do votante não gravado", { organization_id: p.orgId, codigo: erroContato?.code ?? null });
      return { status: "nao_reconhecido" };
    }

    const { data: atual } = await admin
      .from("enquetes_votos")
      .select("id, opcao")
      .eq("organization_id", p.orgId)
      .eq("enquete_id", voto.enquete.id)
      .eq("contact_id", contactId as string)
      .maybeSingle();
    const anterior = atual as { id: string; opcao: string } | null;
    if (anterior && anterior.opcao === voto.opcao.valor) {
      return { status: "registrado", enqueteId: voto.enquete.id, contactId: contactId as string, opcao: voto.opcao.valor, mudou: false };
    }
    const { error: erroVoto } = await admin.from("enquetes_votos").upsert(
      {
        organization_id: p.orgId,
        enquete_id: voto.enquete.id,
        contact_id: contactId as string,
        opcao: voto.opcao.valor,
        chamar: voto.opcao.chamar,
      },
      { onConflict: "organization_id,enquete_id,contact_id" },
    );
    if (erroVoto) {
      logger.warn("[enquete] voto não gravado", { organization_id: p.orgId, codigo: erroVoto.code ?? null });
      return { status: "nao_reconhecido" };
    }
    return { status: "registrado", enqueteId: voto.enquete.id, contactId: contactId as string, opcao: voto.opcao.valor, mudou: true };
  } catch (e) {
    logger.warn("[enquete] voto não lido — a entrada segue sem ele", {
      organization_id: p.orgId,
      motivo: (e instanceof Error ? e.message : String(e)).slice(0, 160),
    });
    return { status: "sem_enquete" };
  }
}

/** Guarda os nomes do último POST só quando mudaram (uma escrita rara, nunca por mensagem). */
async function anotarCamposVistos(
  admin: SupabaseClient,
  orgId: string,
  config: ConfigDaEnquete | null,
  corpo: Record<string, unknown>,
  agora: () => Date,
): Promise<void> {
  const nomes = nomesDosCampos(corpo);
  if (nomes.length === 0) return;
  const iguais = config !== null && config.camposVistos.length === nomes.length && config.camposVistos.every((n, i) => n === nomes[i]);
  if (iguais) return;
  const { error } = await admin
    .from("enquetes_config")
    .upsert({ organization_id: orgId, campos_vistos: nomes, campos_vistos_em: agora().toISOString() }, { onConflict: "organization_id" });
  if (error) logger.warn("[enquete] nomes dos campos não anotados", { organization_id: orgId, codigo: error.code ?? null });
}

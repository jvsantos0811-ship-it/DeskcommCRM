/**
 * OS MODELOS DE CONTRATO NO SERVIDOR (PC-030, item 2).
 *
 * Regras que valem para toda escrita (e moram aqui, não na tela):
 *  - mudar o TEXTO ou os campos obrigatórios sobe a versão e TIRA a aprovação:
 *    o advogado aprovou um texto, não o modelo para sempre;
 *  - aprovar grava o nome de quem aprovou e a data ("aprovado pelo advogado
 *    em"), na versão atual;
 *  - sem aprovação, nem a IA nem a tela geram contrato pelo modelo
 *    (`gerarContratoDoModelo`).
 *
 * Todo acesso filtra `organization_id` (vindo da sessão).
 */
import { z } from "zod";

import type { SupabaseClient } from "@supabase/supabase-js";

import { COLUNAS_DO_MODELO, type LinhaDoModelo } from "./gerar-do-modelo";

const chaveDeCampo = z.string().regex(/^[a-z][a-z0-9_]*$/i).max(40);

export const modeloNovoSchema = z
  .object({
    nome: z.string().trim().min(1).max(120),
    interesse: z.string().trim().max(120).nullable().optional(),
    corpo: z.string().min(20).max(60000),
    campos_obrigatorios: z.array(chaveDeCampo).max(40).default([]),
  })
  .strict();

export const modeloPatchSchema = z
  .object({
    nome: z.string().trim().min(1).max(120).optional(),
    interesse: z.string().trim().max(120).nullable().optional(),
    corpo: z.string().min(20).max(60000).optional(),
    campos_obrigatorios: z.array(chaveDeCampo).max(40).optional(),
    ativo: z.boolean().optional(),
  })
  .strict();

export const aprovacaoSchema = z
  .object({
    aprovado_por_nome: z.string().trim().min(3).max(120),
  })
  .strict();

export interface ModeloNaTela extends LinhaDoModelo {
  updated_at: string;
}

const COLUNAS = `${COLUNAS_DO_MODELO}, updated_at`;

export async function listarModelos(admin: SupabaseClient, orgId: string): Promise<ModeloNaTela[]> {
  const { data, error } = await admin
    .from("contrato_modelos")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .order("ativo", { ascending: false })
    .order("nome", { ascending: true });
  if (error) throw new Error(`modelos: ${error.message}`);
  return (data ?? []) as ModeloNaTela[];
}

export async function criarModelo(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  e: z.infer<typeof modeloNovoSchema>,
): Promise<ModeloNaTela> {
  const { data, error } = await admin
    .from("contrato_modelos")
    .insert({
      organization_id: orgId,
      nome: e.nome,
      interesse: e.interesse?.trim() || null,
      corpo: e.corpo,
      campos_obrigatorios: e.campos_obrigatorios,
      criado_por_user_id: userId,
    })
    .select(COLUNAS)
    .single();
  if (error || !data) throw new Error(`modelo: ${error?.message ?? "sem linha"}`);
  return data as ModeloNaTela;
}

/** O que mudar o modelo faz com a versão e a aprovação. Pura. */
export function patchDoModelo(
  atual: Pick<LinhaDoModelo, "corpo" | "campos_obrigatorios" | "versao">,
  e: z.infer<typeof modeloPatchSchema>,
): { patch: Record<string, unknown>; mudouOTexto: boolean } {
  const mudouOTexto =
    (e.corpo !== undefined && e.corpo !== atual.corpo) ||
    (e.campos_obrigatorios !== undefined &&
      JSON.stringify([...e.campos_obrigatorios].sort()) !== JSON.stringify([...atual.campos_obrigatorios].sort()));
  const patch: Record<string, unknown> = {};
  if (e.nome !== undefined) patch.nome = e.nome;
  if (e.interesse !== undefined) patch.interesse = e.interesse?.trim() || null;
  if (e.ativo !== undefined) patch.ativo = e.ativo;
  if (e.corpo !== undefined) patch.corpo = e.corpo;
  if (e.campos_obrigatorios !== undefined) patch.campos_obrigatorios = e.campos_obrigatorios;
  if (mudouOTexto) {
    patch.versao = atual.versao + 1;
    patch.aprovado_em = null;
    patch.aprovado_por_nome = null;
    patch.aprovado_por_user_id = null;
  }
  return { patch, mudouOTexto };
}

export async function carregarModelo(admin: SupabaseClient, orgId: string, id: string): Promise<ModeloNaTela | null> {
  const { data } = await admin.from("contrato_modelos").select(COLUNAS).eq("organization_id", orgId).eq("id", id).maybeSingle();
  return (data as ModeloNaTela | null) ?? null;
}

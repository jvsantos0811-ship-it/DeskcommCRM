/**
 * Criar, listar, revogar e trocar as chaves da agência.
 *
 * Quem chama (as rotas de `/api/v1/admin/chaves-da-agencia`) já conferiu que é
 * o dono da instalação com escrita (`requirePlatformAdminEscrita`). O banco
 * confere de novo no INSERT (migration 9014).
 *
 * O texto da chave só existe na volta da criação/troca: guardamos o SHA256.
 */
import { createHash, randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { PORTAS_DA_AGENCIA, type PortaDaAgencia } from "./portas";

export const COLUNAS_DA_CHAVE =
  "id, organization_id, name, prefix, scopes, ips_permitidos, last_used_at, created_at, revoked_at";

export interface ChaveDaAgenciaNaTela {
  id: string;
  organization_id: string;
  porta: PortaDaAgencia;
  name: string;
  prefix: string;
  ips_permitidos: string[];
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

function portaDoEscopo(scopes: unknown): PortaDaAgencia | null {
  if (!Array.isArray(scopes)) return null;
  if (scopes.includes(PORTAS_DA_AGENCIA.leitura.escopo)) return "leitura";
  if (scopes.includes(PORTAS_DA_AGENCIA.admin.escopo)) return "admin";
  return null;
}

export function paraTela(linha: Record<string, unknown>): ChaveDaAgenciaNaTela | null {
  const porta = portaDoEscopo(linha.scopes);
  if (!porta) return null;
  return {
    id: linha.id as string,
    organization_id: linha.organization_id as string,
    porta,
    name: linha.name as string,
    prefix: linha.prefix as string,
    ips_permitidos: Array.isArray(linha.ips_permitidos) ? (linha.ips_permitidos as string[]) : [],
    last_used_at: (linha.last_used_at as string | null) ?? null,
    created_at: linha.created_at as string,
    revoked_at: (linha.revoked_at as string | null) ?? null,
  };
}

export async function listarChavesDaAgencia(db: SupabaseClient): Promise<ChaveDaAgenciaNaTela[]> {
  const { data, error } = await db
    .from("api_tokens")
    .select(COLUNAS_DA_CHAVE)
    .or(`scopes.cs.["${PORTAS_DA_AGENCIA.leitura.escopo}"],scopes.cs.["${PORTAS_DA_AGENCIA.admin.escopo}"]`)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((l) => paraTela(l as Record<string, unknown>)).filter((c): c is ChaveDaAgenciaNaTela => c !== null);
}

export interface NovaChave {
  chave: ChaveDaAgenciaNaTela;
  /** Mostrado UMA vez. */
  texto: string;
}

export class ChaveDaAgenciaErro extends Error {
  constructor(
    public readonly codigo: "ja_existe" | "banco",
    message: string,
  ) {
    super(message);
    this.name = "ChaveDaAgenciaErro";
  }
}

export async function criarChaveDaAgencia(
  db: SupabaseClient,
  opcoes: { porta: PortaDaAgencia; organizationId: string; criadaPor: string; ips: string[] },
): Promise<NovaChave> {
  const definicao = PORTAS_DA_AGENCIA[opcoes.porta];
  const prefix = `dsk_${randomBytes(4).toString("hex")}`;
  const texto = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(texto).digest();

  const { data, error } = await db
    .from("api_tokens")
    .insert({
      organization_id: opcoes.organizationId,
      created_by: opcoes.criadaPor,
      name: definicao.nome,
      prefix,
      token_hash: `\\x${hash.toString("hex")}`,
      scopes: [definicao.escopo],
      ips_permitidos: opcoes.ips,
      expires_at: null,
    })
    .select(COLUNAS_DA_CHAVE)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new ChaveDaAgenciaErro("ja_existe", "A live key already exists for this port. Revoke or rotate it first.");
    }
    throw new ChaveDaAgenciaErro("banco", error.message);
  }
  const chave = paraTela(data as Record<string, unknown>);
  if (!chave) throw new ChaveDaAgenciaErro("banco", "Key created without the port scope.");
  return { chave, texto };
}

/**
 * Lê UMA chave da agência pelo id. A chave da agência não é de uma organização
 * só (alcança todas), então a busca é pelo id — e só devolve se for mesmo uma
 * chave da agência: token comum de escritório nunca sai daqui.
 */
export async function lerChaveDaAgencia(db: SupabaseClient, id: string): Promise<ChaveDaAgenciaNaTela | null> {
  const { data, error } = await db.from("api_tokens").select(COLUNAS_DA_CHAVE).eq("id", id).maybeSingle();
  if (error) throw new ChaveDaAgenciaErro("banco", error.message);
  return data ? paraTela(data as Record<string, unknown>) : null;
}

/**
 * Revoga. Idempotente: revogar a revogada devolve a mesma linha com
 * `jaEstavaRevogada` — quem chama audita só a primeira vez.
 */
export async function revogarChaveDaAgencia(
  db: SupabaseClient,
  id: string,
  revogadaPor: string,
): Promise<{ chave: ChaveDaAgenciaNaTela; jaEstavaRevogada: boolean } | null> {
  const chave = await lerChaveDaAgencia(db, id);
  if (!chave) return null;
  if (chave.revoked_at) return { chave, jaEstavaRevogada: true };

  const { data, error } = await db
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString(), revoked_by: revogadaPor })
    .eq("organization_id", chave.organization_id)
    .eq("id", id)
    .select(COLUNAS_DA_CHAVE)
    .single();
  if (error) throw new ChaveDaAgenciaErro("banco", error.message);
  const revogada = paraTela(data as Record<string, unknown>);
  if (!revogada) throw new ChaveDaAgenciaErro("banco", "Revoked row lost the port scope.");
  return { chave: revogada, jaEstavaRevogada: false };
}

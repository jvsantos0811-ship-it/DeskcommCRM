/**
 * AS RODADAS DO LEITOR — quando ele lê e como o retrato espera (PM-027 §3).
 *
 *  - A diária começa às 06:00 no fuso da organização (a mesma hora do retrato,
 *    `HORA_DO_RETRATO`). O cron `leitor-da-conversa` passa a cada 10 minutos:
 *    abre a diária do dia quando a hora chega e faz uma passada em toda rodada
 *    aberta, dentro do orçamento de tempo. O que não couber fica para a passada
 *    seguinte — a seleção é por "mudou desde a ficha", nada é lido duas vezes.
 *  - Quando a diária termina, o retrato do dia é gerado NA MESMA CADEIA (o
 *    retrato vem depois do Leitor). O cron do retrato, que passa de hora em
 *    hora, pula a organização enquanto a diária dela está aberta — até 3 horas;
 *    depois disso gera assim mesmo (um Leitor travado não pode deixar o painel
 *    sem número).
 *  - "Atualizar agora" abre uma rodada manual, faz uma passada curta e só
 *    depois refaz o retrato. Se não couber tudo, o cron continua a rodada.
 *
 * Organização sem o Leitor ligado (ou sem modelo aprovado) não tem rodada: o
 * retrato segue como sempre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { gerarRetratoDaOrg } from "@/lib/dados/gerar-retrato";
import { diaNoFuso, HORA_DO_RETRATO } from "@/lib/dados/retrato";
import { logger } from "@/lib/logger";
import { ehOperante, STATUS_OPERANTE } from "@/lib/organizacao/operante";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

import { configDoLeitor, leitorPodeRodar } from "./config";
import type { Leitor } from "./ler-lead";
import { passadaDoLeitor, type OrgDoLeitor, type ResultadoDaPassada } from "./rodada";

/** O cron tem 120 s no agendador; a passada não começa leitura nova depois disto. */
export const ORCAMENTO_DO_CRON_MS = 90_000;
/** "Atualizar agora" espera no máximo isto pelo Leitor antes de refazer o retrato. */
export const ORCAMENTO_MANUAL_MS = 40_000;
/** Depois disto o retrato não espera mais a diária do Leitor. */
export const HORAS_QUE_O_RETRATO_ESPERA = 3;

const HORA_MS = 3_600_000;

function horaNoFuso(agora: Date, fuso: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: fuso, hour: "2-digit", hourCycle: "h23" }).format(agora));
}

interface RodadaAberta {
  id: string;
  origem: "diaria" | "manual";
  dia: string;
  lidos: number;
  falhas: number;
  iniciada_em: string;
}

function terminou(p: ResultadoDaPassada): boolean {
  return p.parou !== null || p.restantes === 0;
}

async function registrarPassada(
  admin: SupabaseClient,
  orgId: string,
  rodada: Pick<RodadaAberta, "id" | "lidos" | "falhas">,
  p: ResultadoDaPassada,
  fechar: boolean,
): Promise<void> {
  const { error } = await admin
    .from("leitor_rodadas")
    .update({
      lidos: rodada.lidos + p.lidos,
      falhas: rodada.falhas + p.falhas,
      ultimo_erro: p.ultimoErro,
      ...(fechar ? { terminada_em: new Date().toISOString() } : {}),
    })
    .eq("organization_id", orgId)
    .eq("id", rodada.id);
  if (error) throw new Error(`rodada: ${error.message}`);
}

async function auditarPassada(orgId: string, origem: string, dia: string, p: ResultadoDaPassada, fechou: boolean, requestId?: string) {
  if (p.lidos === 0 && !fechou) return; // passada sem efeito não audita
  await audit({
    organizationId: orgId,
    action: "leitor.rodada",
    resourceType: "leitor_rodadas",
    metadata: {
      origem,
      dia,
      lidos: p.lidos,
      falhas: p.falhas,
      restantes: p.restantes,
      avisos: p.avisos,
      parou: p.parou,
      terminou: fechou,
    },
    ...(requestId ? { requestId } : {}),
  });
}

// ─── o cron ────────────────────────────────────────────────────────────────

export interface ResultadoDoCron {
  organizacoes: number;
  lidos: number;
  falhas: number;
  avisos: number;
  terminadas: number;
  retratos: number;
}

export async function cronDoLeitor(
  admin: SupabaseClient,
  deps: { agora: Date; ler: Leitor; orcamentoMs?: number; requestId?: string },
): Promise<ResultadoDoCron> {
  const r: ResultadoDoCron = { organizacoes: 0, lidos: 0, falhas: 0, avisos: 0, terminadas: 0, retratos: 0 };
  const limite = Date.now() + (deps.orcamentoMs ?? ORCAMENTO_DO_CRON_MS);
  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, settings, timezone, display_name, locale, status")
    .eq("status", STATUS_OPERANTE)
    .eq("settings->leitor->>ligado", "true");
  if (error) throw new Error(`organizacoes: ${error.message}`);

  for (const org of (orgs ?? []) as Array<OrgDoLeitor & { status: string }>) {
    if (Date.now() >= limite) break;
    if (!ehOperante(org.status) || !leitorPodeRodar(configDoLeitor(org.settings)).pode) continue;
    r.organizacoes += 1;
    try {
      const fuso = fusoUtilizavel(org.timezone);
      const dia = diaNoFuso(deps.agora, fuso);
      if (horaNoFuso(deps.agora, fuso) >= HORA_DO_RETRATO) {
        const { error: eIns } = await admin.from("leitor_rodadas").insert({ organization_id: org.id, dia, origem: "diaria" });
        if (eIns && eIns.code !== "23505") throw new Error(`abrir a diária: ${eIns.message}`);
      }
      const { data: abertasData, error: eAb } = await admin
        .from("leitor_rodadas")
        .select("id, origem, dia, lidos, falhas, iniciada_em")
        .eq("organization_id", org.id)
        .is("terminada_em", null)
        .order("iniciada_em", { ascending: false });
      if (eAb) throw new Error(`rodadas abertas: ${eAb.message}`);
      const abertas = (abertasData ?? []) as RodadaAberta[];
      if (abertas.length === 0) continue;

      const p = await passadaDoLeitor(admin, org, { agora: deps.agora, ler: deps.ler, ateMs: limite });
      r.lidos += p.lidos;
      r.falhas += p.falhas;
      r.avisos += p.avisos;
      const fechar = terminou(p);
      // A passada é uma só para todas as rodadas abertas; a contagem vai para a mais nova.
      for (const [i, rodada] of abertas.entries()) {
        await registrarPassada(admin, org.id, rodada, i === 0 ? p : { ...p, lidos: 0, falhas: 0 }, fechar);
      }
      await auditarPassada(org.id, abertas[0]!.origem, abertas[0]!.dia, p, fechar, deps.requestId);
      if (!fechar) continue;
      r.terminadas += abertas.length;

      if (abertas.some((a) => a.origem === "diaria" && a.dia === dia)) {
        const g = await gerarRetratoDaOrg(admin, org.id, "cron", { soSeFaltar: true, agora: deps.agora });
        if (g.gravado) {
          r.retratos += 1;
          await audit({
            organizationId: org.id,
            action: "dados.retrato_gerado",
            resourceType: "crm_dados_retrato",
            metadata: { origem: "cron", dia: g.dia, leads: g.leads, apagados: g.apagados, depois_do_leitor: true },
            ...(deps.requestId ? { requestId: deps.requestId } : {}),
          });
        }
      }
    } catch (err) {
      r.falhas += 1;
      logger.error("[leitor] a rodada de uma organização falhou; sigo para as outras", {
        organization_id: org.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return r;
}

// ─── "Atualizar agora" ─────────────────────────────────────────────────────

/** Uma rodada manual curta antes do retrato. `null` = o Leitor não está ligado aqui. Nunca lança. */
export async function rodadaManualDoLeitor(
  admin: SupabaseClient,
  orgId: string,
  deps: { agora: Date; ler: Leitor; orcamentoMs?: number; requestId?: string },
): Promise<ResultadoDaPassada | null> {
  try {
    const { data: org, error } = await admin
      .from("organizations")
      .select("id, settings, timezone, display_name, locale")
      .eq("id", orgId)
      .maybeSingle();
    if (error || !org) return null;
    if (!leitorPodeRodar(configDoLeitor((org as OrgDoLeitor).settings)).pode) return null;
    const dia = diaNoFuso(deps.agora, fusoUtilizavel((org as OrgDoLeitor).timezone));
    const { data: nova, error: eIns } = await admin
      .from("leitor_rodadas")
      .insert({ organization_id: orgId, dia, origem: "manual" })
      .select("id")
      .maybeSingle();
    if (eIns || !nova) throw new Error(`abrir a rodada: ${eIns?.message ?? "sem linha"}`);
    const p = await passadaDoLeitor(admin, org as OrgDoLeitor, {
      agora: deps.agora,
      ler: deps.ler,
      ateMs: Date.now() + (deps.orcamentoMs ?? ORCAMENTO_MANUAL_MS),
    });
    const fechar = terminou(p);
    await registrarPassada(admin, orgId, { id: (nova as { id: string }).id, lidos: 0, falhas: 0 }, p, fechar);
    await auditarPassada(orgId, "manual", dia, p, fechar, deps.requestId);
    return p;
  } catch (err) {
    logger.error("[leitor] a rodada do Atualizar agora falhou; o retrato segue", {
      organization_id: orgId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── o retrato espera o Leitor ─────────────────────────────────────────────

/**
 * O retrato das 06:00 desta organização deve esperar o Leitor? Só quando o
 * Leitor está ligado e a diária de hoje ainda não terminou (ou ainda nem abriu)
 * há menos de `HORAS_QUE_O_RETRATO_ESPERA` horas.
 */
export async function retratoEsperaOLeitor(
  admin: SupabaseClient,
  org: Pick<OrgDoLeitor, "id" | "settings" | "timezone">,
  agora: Date,
): Promise<boolean> {
  if (!leitorPodeRodar(configDoLeitor(org.settings)).pode) return false;
  const fuso = fusoUtilizavel(org.timezone);
  const dia = diaNoFuso(agora, fuso);
  const { data, error } = await admin
    .from("leitor_rodadas")
    .select("iniciada_em, terminada_em")
    .eq("organization_id", org.id)
    .eq("origem", "diaria")
    .eq("dia", dia)
    .maybeSingle();
  if (error) return false;
  const rodada = data as { iniciada_em: string; terminada_em: string | null } | null;
  if (!rodada) return horaNoFuso(agora, fuso) < HORA_DO_RETRATO + HORAS_QUE_O_RETRATO_ESPERA;
  if (rodada.terminada_em) return false;
  return agora.getTime() - Date.parse(rodada.iniciada_em) < HORAS_QUE_O_RETRATO_ESPERA * HORA_MS;
}

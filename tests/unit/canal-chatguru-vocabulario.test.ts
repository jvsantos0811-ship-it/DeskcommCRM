import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getAdapter } from "@/lib/channels";
import {
  CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO,
  capabilitiesOf,
  transportaMensagem,
} from "@/lib/channels/capabilities";
import { rotuloDoTipoDeCanal } from "@/lib/channels/conversa-nova";
import { channelBrand } from "@/lib/channels/presentation";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";
import { nomeiaProvider } from "../../scripts/lint-channels.pattern";

/**
 * O canal ChatGuru (PC-047) — a IA atendendo dentro da plataforma de
 * atendimento do escritório. Fixa o perfil, o `sessionRef`, o adapter, a
 * catraca de nome e o par migration × baseline — os artefatos que andam juntos.
 */
const PROVIDER = "chatguru" as const;
const MIGRATION = "supabase/migrations/20261122130000_9038_canal_chatguru.sql";

describe("canal chatguru — vocabulário e seam", () => {
  it("a constante neutra aponta para o provider, e ele é canal de MENSAGEM que aparece como WhatsApp", () => {
    expect(CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO).toBe(PROVIDER);
    expect(transportaMensagem(PROVIDER)).toBe(true);
    expect(channelBrand({ provider: PROVIDER })).toBe("whatsapp");
    expect(rotuloDoTipoDeCanal(PROVIDER)).toBe("ChatGuru");
  });

  it("perfil: janela da Meta respeitada, sem anti-ban próprio, sem catálogo de modelos no CRM", () => {
    const caps = capabilitiesOf(PROVIDER);
    expect(caps.freeformOutsideWindow).toBe(false);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(caps.banRisk).toBe(false);
    expect(caps.groups).toBe("none");
    expect(fonteDeTemplates(PROVIDER)).toBeNull();
  });

  it("o sessionRef é o phone_id da plataforma, e a coluna entra no select", () => {
    expect(resolveSessionRef({ provider: PROVIDER, chatguru_phone_id: "fone-1" })).toBe("fone-1");
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("chatguru_phone_id");
  });

  it("o adapter existe, sabe passar para a equipe e oferecer ações, e os códigos carregam o nome", () => {
    const adapter = getAdapter(PROVIDER);
    expect(adapter.provider).toBe(PROVIDER);
    expect(typeof adapter.aoPassarParaAEquipe).toBe("function");
    expect(typeof adapter.acoesDoAtendimento).toBe("function");
    expect(typeof adapter.fetchInboundMedia).toBe("function");
    expect(adapter.codes.notConfigured).toBe("chatguru_not_configured");
    expect(adapter.codes.sendFailed).toContain(PROVIDER);
  });

  it("a catraca de canal reconhece o nome nas duas grafias", () => {
    expect(nomeiaProvider("import x from '@/lib/channels/chatguru'")).toBe(true);
    expect(nomeiaProvider("const ChatGuruClient = 1")).toBe(true);
    // O nome neutro da pasta, que a rota e a tela importam, não é o provider.
    expect(nomeiaProvider("@/lib/channels/atendimento-externo/sessao")).toBe(false);
  });

  it("migration e baseline conhecem o provider, os ramos dos CHECKs, o arquivo do webhook e o índice", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    expect(migration.split("\n")[0]).toMatch(/^-- manifest: /);
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,800}'chatguru'::text/);
    expect(baseline).toMatch(/provider = 'chatguru'\s+and chatguru_phone_id\s+is not null/);
    expect(baseline).toMatch(/webhook_events_log_provider_check check \(provider in \([\s\S]*?'chatguru'/);
    expect(baseline).toContain("channel_sessions_chatguru_phone_id_ativo_unique");
    // Colunas ANTES do CHECK que as referencia — senão o install quebra.
    expect(baseline.indexOf("add column if not exists chatguru_phone_id")).toBeLessThan(
      baseline.indexOf("(provider = 'chatguru'"),
    );
    // UM bloco por constraint: o apêndice desta migration não reconstrói os CHECKs.
    // Só o bloco DESTA migration: ele termina onde começa o próximo bloco do
    // apêndice (o da 9039, rodízio, tem a própria constraint — PC-052).
    const inicio = baseline.indexOf("-- ---- canal ChatGuru (migration 9038) ----");
    const proximo = baseline.indexOf("\n-- ---- ", inicio + 1);
    const apendice = baseline.slice(inicio, proximo === -1 ? undefined : proximo);
    expect(apendice).not.toMatch(/add\s+constraint/i);
  });
});

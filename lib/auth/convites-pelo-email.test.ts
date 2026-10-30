import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  convitesPendentesPeloEmail,
  emailComprovado,
  payloadDoConvitePendente,
  temConvitePendente,
  type ConvitePendente,
} from "./convites-pelo-email";

/** Dublê que grava os filtros pedidos e devolve as linhas dadas. */
function dubleDoBanco(linhas: unknown[] | null, erro: { message: string } | null = null) {
  const filtros: Array<[string, string, unknown]> = [];
  const consulta = {
    select: () => consulta,
    eq: (c: string, v: unknown) => (filtros.push(["eq", c, v]), consulta),
    is: (c: string, v: unknown) => (filtros.push(["is", c, v]), consulta),
    gt: (c: string, v: unknown) => (filtros.push(["gt", c, v]), consulta),
    order: () => Promise.resolve({ data: linhas, error: erro }),
  };
  const admin = { from: (tabela: string) => (filtros.push(["from", tabela, null]), consulta) };
  return { admin: admin as unknown as SupabaseClient, filtros };
}

const linha = (extra: Record<string, unknown> = {}) => ({
  id: "inv-1",
  organization_id: "org-1",
  role: "agent",
  interface_settings: null,
  invited_by: "u-dono",
  inviter_name: "João",
  last_sent_at: "2026-10-30T10:00:00.000Z",
  expires_at: "2026-10-31T10:00:00.000Z",
  organizations: { display_name: "Bórbora Advogados", status: "active" },
  ...extra,
});

describe("emailComprovado", () => {
  it("só devolve e-mail que o provedor comprovou", () => {
    expect(emailComprovado({ email: "Ana@X.com", email_confirmed_at: null })).toBeNull();
    expect(emailComprovado({ email: "Ana@X.com" })).toBeNull();
    expect(emailComprovado(null)).toBeNull();
    expect(emailComprovado({ email: " Ana@X.com ", email_confirmed_at: "2026-10-30T00:00:00Z" })).toBe("ana@x.com");
  });
});

describe("convitesPendentesPeloEmail", () => {
  it("procura só convite vivo, pelo e-mail exato (eq, nunca ilike) e dentro do prazo", async () => {
    const { admin, filtros } = dubleDoBanco([linha()]);
    const agora = new Date("2026-10-30T12:00:00.000Z");
    const achados = await convitesPendentesPeloEmail(admin, " Ana_Silva@X.com ", agora);

    expect(filtros).toContainEqual(["from", "team_invites", null]);
    expect(filtros).toContainEqual(["eq", "email", "ana_silva@x.com"]);
    expect(filtros).toContainEqual(["is", "accepted_at", null]);
    expect(filtros).toContainEqual(["is", "revoked_at", null]);
    expect(filtros).toContainEqual(["gt", "expires_at", agora.toISOString()]);
    expect(achados).toHaveLength(1);
    expect(achados[0]!.nome_da_organizacao).toBe("Bórbora Advogados");
  });

  it("empresa suspensa ou anonimizada não recebe gente nova", async () => {
    const { admin } = dubleDoBanco([
      linha({ id: "a", organizations: { display_name: "Suspensa", status: "suspended" } }),
      linha({ id: "b", organizations: { display_name: "Apagada", status: "redacted" } }),
      linha({ id: "c" }),
    ]);
    expect((await convitesPendentesPeloEmail(admin, "ana@x.com")).map((c) => c.id)).toEqual(["c"]);
  });

  it("falha de leitura LANÇA — nunca vira 'não há convite' em silêncio", async () => {
    const { admin } = dubleDoBanco(null, { message: "timeout" });
    await expect(convitesPendentesPeloEmail(admin, "ana@x.com")).rejects.toThrow(/timeout/);
  });
});

describe("temConvitePendente", () => {
  it("sem e-mail comprovado nem pergunta ao banco", async () => {
    const { admin, filtros } = dubleDoBanco([linha()]);
    expect(await temConvitePendente(admin, { email: "ana@x.com", email_confirmed_at: null })).toBe(false);
    expect(filtros).toEqual([]);
  });

  it("com e-mail comprovado e convite vivo, responde sim", async () => {
    const { admin } = dubleDoBanco([linha()]);
    expect(await temConvitePendente(admin, { email: "ana@x.com", email_confirmed_at: "2026-10-30T00:00:00Z" })).toBe(true);
  });

  it("leitura que cai mantém o caminho de hoje (responde não)", async () => {
    const { admin } = dubleDoBanco(null, { message: "fora" });
    expect(await temConvitePendente(admin, { email: "ana@x.com", email_confirmed_at: "2026-10-30T00:00:00Z" })).toBe(false);
  });
});

describe("payloadDoConvitePendente", () => {
  it("organização, papel e convidador saem da LINHA; a emissão é o último envio", () => {
    const convite: ConvitePendente = {
      id: "inv-1",
      organization_id: "org-1",
      nome_da_organizacao: "Bórbora Advogados",
      role: "manager",
      interface_settings: null,
      invited_by: "u-dono",
      inviter_name: null,
      last_sent_at: "2026-10-30T10:00:00.000Z",
      expires_at: "2026-10-31T10:00:00.000Z",
    };
    const p = payloadDoConvitePendente(convite, "ana@x.com");
    expect(p).toEqual({
      invite_id: "inv-1",
      email: "ana@x.com",
      organization_id: "org-1",
      role: "manager",
      exp: Date.parse("2026-10-31T10:00:00.000Z") / 1000,
      iat: Date.parse("2026-10-30T10:00:00.000Z") / 1000,
      invited_by: "u-dono",
    });
  });
});

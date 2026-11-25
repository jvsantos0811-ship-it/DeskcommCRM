/**
 * DOIS NÚMEROS DA PLATAFORMA DE ATENDIMENTO NA MESMA ORGANIZAÇÃO (PC-053, 25/11/2026).
 *
 * ─── O defeito que motivou ─────────────────────────────────────────────────
 *
 * A conexão era UMA por organização: a rota lia "a conexão" e o POST gravava
 * nela. Colar o ID do segundo número TROCAVA o primeiro — o número que atendia
 * parava de responder. A Samantha tem o número oficial e o número por QR, e a
 * IA atende nos dois.
 *
 * ─── O que estes casos provam ──────────────────────────────────────────────
 *
 *  1. Com UM número, tudo é como antes (mesma linha, mesmo endereço).
 *  2. "Adicionar" cria uma linha nova e não toca a que existe.
 *  3. "Usar a mesma chave" só copia a chave cifrada de uma conexão EM USO, DESTA
 *     organização e da MESMA conta — e a chave nunca volta no GET.
 *  4. O teto de dois vale, e nada cruza organização.
 *  5. Com dois números, configurar sem dizer qual é recusado.
 *
 * Handler REAL sobre um dublê do banco que aplica os filtros e guarda o estado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linhas: [] as Array<Record<string, unknown>>,
  proximoId: 0,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async (_admin: unknown, valor: string) => `cifrado(${valor.slice(0, 4)})`),
  decryptWebhookSecret: vi.fn(async () => "segredo-em-claro"),
}));
vi.mock("@/lib/webhooks/url-publica", () => ({
  basePublicaDaInstalacao: () => "https://crm.test",
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dubleDoBanco() }));

import { GET, PATCH, POST } from "@/app/api/v1/channels/atendimento-externo/route";
import { CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO } from "@/lib/channels/capabilities";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const OFICIAL = "22222222-2222-4222-8222-222222222222";
const QR = "44444444-4444-4444-8444-444444444444";
const DE_OUTRA_ORG = "66666666-6666-4666-8666-666666666666";

/** Só o que estas rotas pedem ao banco: filtro por igualdade, ordem, update, insert. */
function dubleDoBanco() {
  return {
    from() {
      const filtros: Array<[string, unknown]> = [];
      let op: "select" | "update" | "insert" = "select";
      let corpo: Record<string, unknown> = {};
      let unica = false;
      const casam = () => h.linhas.filter((l) => filtros.every(([c, v]) => (l[c] ?? null) === v));
      const executar = () => {
        if (op === "insert") {
          h.proximoId += 1;
          const nova = {
            id: `55555555-5555-4555-8555-${String(h.proximoId).padStart(12, "0")}`,
            archived_at: null,
            created_at: `2026-11-25T10:00:0${h.proximoId}.000Z`,
            webhook_path_token: `tok-novo-${h.proximoId}`,
            ...corpo,
          };
          h.linhas.push(nova);
          return { data: unica ? { id: nova.id } : [nova], error: null };
        }
        const achadas = casam();
        if (op === "update") {
          for (const l of achadas) Object.assign(l, corpo);
          return { data: null, error: null };
        }
        return { data: unica ? (achadas[0] ?? null) : achadas, error: null };
      };
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
        is: (c: string, v: unknown) => (filtros.push([c, v]), q),
        order: () => q,
        limit: () => q,
        maybeSingle: () => ((unica = true), q),
        single: () => ((unica = true), q),
        update: (p: Record<string, unknown>) => ((op = "update"), (corpo = p), q),
        insert: (p: Record<string, unknown>) => ((op = "insert"), (corpo = p), q),
        then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve(executar()).then(ok, erro),
      };
      return q;
    },
  };
}

function conexao(id: string, phoneId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    organization_id: ORG,
    provider: CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO,
    chatguru_servidor: "s22",
    chatguru_account_id: "conta-escritorio",
    chatguru_phone_id: phoneId,
    chatguru_api_key_encrypted: `chave-cifrada-de-${phoneId}`,
    chatguru_config: {},
    display_name: `Número ${phoneId}`,
    status: "WORKING",
    webhook_path_token: `tok-${phoneId}`,
    webhook_secret_encrypted: `segredo-de-${phoneId}`,
    archived_at: null,
    created_at: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

const conectar = (body: Record<string, unknown>) =>
  POST(
    new NextRequest("https://crm.test/api/v1/channels/atendimento-externo", {
      method: "POST",
      body: JSON.stringify({ servidor: "s22", account_id: "conta-escritorio", ...body }),
    }),
  );

const configurar = (body: Record<string, unknown>) =>
  PATCH(
    new NextRequest("https://crm.test/api/v1/channels/atendimento-externo", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  );

const lerEstado = async () =>
  (await (await GET(new NextRequest("https://crm.test/api/v1/channels/atendimento-externo"))).json()) as {
    data: Record<string, unknown> & { conexoes: Array<Record<string, unknown>> };
  };

const daOrg = () =>
  h.linhas.filter((l) => l.organization_id === ORG && l.provider === CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO);

const CHAVE = "CHAVEDAAPI1234567890";

beforeEach(() => {
  h.linhas = [];
  h.proximoId = 0;
});

describe("com UM número, nada muda", () => {
  it("colar a credencial de novo, sem dizer qual número, atualiza a MESMA linha e mantém o endereço", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"));
    const r = await conectar({ phone_id: "fone-oficial", api_key: CHAVE });
    expect(r.status).toBe(200);
    expect(daOrg()).toHaveLength(1);
    expect(daOrg()[0]).toMatchObject({
      id: OFICIAL,
      webhook_path_token: "tok-fone-oficial",
      webhook_secret_encrypted: "segredo-de-fone-oficial",
    });
  });

  it("sem número nenhum, conectar cria a primeira linha", async () => {
    const r = await conectar({ phone_id: "fone-oficial", api_key: CHAVE });
    expect(r.status).toBe(200);
    expect(daOrg()).toHaveLength(1);
  });

  it("configurar sem dizer qual número grava na única conexão", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"));
    const r = await configurar({ config: { dialogo_transferencia: "dialogo-transf", acoes: [] } });
    expect(r.status).toBe(200);
    expect(daOrg()[0]?.chatguru_config).toMatchObject({ dialogo_transferencia: "dialogo-transf" });
  });
});

describe("o segundo número", () => {
  it("'Adicionar' com a mesma chave cria a linha nova, copia a chave CIFRADA e não toca o primeiro", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"));
    const antes = { ...daOrg()[0] };
    const r = await conectar({ phone_id: "fone-qr", novo: true, usar_chave_de: OFICIAL, apelido: "Número do QR" });
    expect(r.status).toBe(200);
    expect(daOrg()).toHaveLength(2);
    expect(daOrg()[0]).toEqual(antes);
    const nova = daOrg()[1];
    expect(nova).toMatchObject({
      chatguru_phone_id: "fone-qr",
      chatguru_api_key_encrypted: "chave-cifrada-de-fone-oficial",
      display_name: "Número do QR",
    });
    // Endereço próprio: segredo novo, nunca o do primeiro número.
    expect(nova?.webhook_secret_encrypted).not.toBe("segredo-de-fone-oficial");
  });

  it("'Adicionar' com o número que já atende é recusado em vez de gravar por cima", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"));
    const r = await conectar({ phone_id: "fone-oficial", novo: true, api_key: CHAVE });
    expect(r.status).toBe(409);
    expect(daOrg()).toHaveLength(1);
  });

  it("'Adicionar' junto com uma conexão pedida é contraditório: recusa", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"));
    const r = await conectar({ phone_id: "fone-qr", novo: true, channel_session_id: OFICIAL, api_key: CHAVE });
    expect(r.status).toBe(422);
    expect(daOrg()[0]?.chatguru_phone_id).toBe("fone-oficial");
  });

  it("o teto de dois vale", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"), conexao(QR, "fone-qr", { created_at: "2026-11-02T00:00:00.000Z" }));
    const r = await conectar({ phone_id: "fone-3", novo: true, api_key: CHAVE });
    expect(r.status).toBe(409);
    expect(daOrg()).toHaveLength(2);
  });

  it("com dois números, trocar a credencial sem dizer qual é recusado", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"), conexao(QR, "fone-qr", { created_at: "2026-11-02T00:00:00.000Z" }));
    const r = await conectar({ phone_id: "fone-3", api_key: CHAVE });
    expect(r.status).toBe(422);
  });

  it("com dois números, a credencial pedida grava só naquela conexão", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"), conexao(QR, "fone-qr", { created_at: "2026-11-02T00:00:00.000Z" }));
    const r = await conectar({ phone_id: "fone-qr", channel_session_id: QR, api_key: CHAVE });
    expect(r.status).toBe(200);
    const [oficial, qr] = daOrg();
    expect(oficial?.chatguru_api_key_encrypted).toBe("chave-cifrada-de-fone-oficial");
    expect(qr?.chatguru_api_key_encrypted).toBe("cifrado(CHAV)");
  });
});

describe("'usar a mesma chave' só copia do que é desta organização, em uso e da mesma conta", () => {
  it("de uma conexão de OUTRA organização: recusa, e a chave não é copiada", async () => {
    h.linhas.push(
      conexao(OFICIAL, "fone-oficial"),
      conexao(DE_OUTRA_ORG, "fone-alheio", { organization_id: OUTRA_ORG, chatguru_api_key_encrypted: "chave-alheia" }),
    );
    const r = await conectar({ phone_id: "fone-qr", novo: true, usar_chave_de: DE_OUTRA_ORG });
    expect(r.status).toBe(422);
    expect(h.linhas.some((l) => l.chatguru_api_key_encrypted === "chave-alheia" && l.organization_id === ORG)).toBe(false);
    expect(daOrg()).toHaveLength(1);
  });

  it("de uma conexão desconectada: recusa", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial", { archived_at: "2026-11-20T00:00:00.000Z" }));
    const r = await conectar({ phone_id: "fone-qr", novo: true, usar_chave_de: OFICIAL });
    expect(r.status).toBe(422);
  });

  it("com servidor ou conta diferentes do número de origem: recusa", async () => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"));
    expect((await conectar({ servidor: "s7", phone_id: "fone-qr", novo: true, usar_chave_de: OFICIAL })).status).toBe(422);
    expect(
      (await conectar({ account_id: "outra-conta", phone_id: "fone-qr", novo: true, usar_chave_de: OFICIAL })).status,
    ).toBe(422);
    expect(daOrg()).toHaveLength(1);
  });

  it("sem chave e sem origem: recusa", async () => {
    const r = await conectar({ phone_id: "fone-oficial" });
    expect(r.status).toBe(422);
  });
});

describe("configuração e leitura com dois números", () => {
  beforeEach(() => {
    h.linhas.push(conexao(OFICIAL, "fone-oficial"), conexao(QR, "fone-qr", { created_at: "2026-11-02T00:00:00.000Z" }));
  });

  it("configurar sem dizer qual número é recusado", async () => {
    expect((await configurar({ config: { dialogo_transferencia: "dialogo-x", acoes: [] } })).status).toBe(422);
    expect((await configurar({ trocar_segredo: true })).status).toBe(422);
  });

  it("configurar o número 2 não toca o número 1", async () => {
    const r = await configurar({ channel_session_id: QR, config: { dialogo_transferencia: "dialogo-qr", acoes: [] } });
    expect(r.status).toBe(200);
    expect(daOrg()[0]?.chatguru_config).toEqual({});
    expect(daOrg()[1]?.chatguru_config).toMatchObject({ dialogo_transferencia: "dialogo-qr" });
  });

  it("conexão de outra organização não é alcançada pelo id", async () => {
    h.linhas.push(conexao(DE_OUTRA_ORG, "fone-alheio", { organization_id: OUTRA_ORG }));
    expect(
      (await configurar({ channel_session_id: DE_OUTRA_ORG, config: { dialogo_transferencia: "dialogo-x", acoes: [] } }))
        .status,
    ).toBe(404);
    expect((await conectar({ phone_id: "fone-alheio", channel_session_id: DE_OUTRA_ORG, api_key: CHAVE })).status).toBe(404);
    expect(h.linhas.find((l) => l.id === DE_OUTRA_ORG)?.chatguru_config).toEqual({});
  });

  it("o GET lista os dois, a principal em cima, e nunca devolve a chave", async () => {
    const { data } = await lerEstado();
    expect(data.conexoes.map((c) => c.channel_session_id)).toEqual([OFICIAL, QR]);
    expect(data.channel_session_id).toBe(OFICIAL);
    expect(data.pode_adicionar).toBe(false);
    expect(data.conexoes[1]?.endereco_de_entrada).toBe(
      "https://crm.test/api/v1/webhooks/channel/tok-fone-qr/segredo-em-claro",
    );
    expect(JSON.stringify(data)).not.toContain("chave-cifrada");
  });
});

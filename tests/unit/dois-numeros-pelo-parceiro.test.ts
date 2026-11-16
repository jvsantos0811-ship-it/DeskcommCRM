/**
 * DOIS NÚMEROS PELO PROVEDOR PARCEIRO NA MESMA ORGANIZAÇÃO (16/11/2026).
 *
 * ─── O defeito que motivou ─────────────────────────────────────────────────
 *
 * A conexão era UMA por organização: `findPartnerSession` lia com
 * `maybeSingle()`, e o POST atualizava a linha que achasse. Colar a conta de um
 * segundo número no formulário TROCAVA o primeiro — o número em uso parava de
 * enviar e receber na hora. E uma segunda linha criada por fora fazia o
 * `maybeSingle()` devolver nada: a tela dizia "não conectado" para um número
 * que estava recebendo.
 *
 * ─── O que estes casos provam ──────────────────────────────────────────────
 *
 *  1. Com UM número, tudo é como antes (a regra de escolha devolve a mesma linha).
 *  2. "Adicionar" cria uma linha nova e não toca a que existe.
 *  3. A conta já gravada nunca muda de número por engano.
 *  4. O teto de dois números vale, e a leitura nunca cruza organização.
 *
 * Handler REAL sobre um dublê do banco que aplica os filtros e guarda o estado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linhas: [] as Array<Record<string, unknown>>,
  validar: vi.fn(),
  proximoId: 0,
  /** Erro que a próxima escrita devolve (simula os índices únicos do banco). */
  erroNaEscrita: null as null | { code: string; message: string },
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
  encryptWebhookSecret: vi.fn(async () => "cifrado"),
  decryptWebhookSecret: vi.fn(async () => null),
}));
vi.mock("@/lib/webhooks/url-publica", () => ({
  basePublicaDaInstalacao: () => "https://crm.test",
}));
vi.mock("@/lib/channels/connect", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  validatePartnerCredentials: h.validar,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dubleDoBanco() }));

import { GET, POST } from "@/app/api/v1/channels/partner/route";
import {
  MAX_PARTNER_NUMBERS,
  PARTNER_CHANNEL_PROVIDER,
  escolherAlvoDaCredencial,
  escolherPrincipal,
  findPartnerSessionById,
  type PartnerSession,
} from "@/lib/channels/connect";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const NUMERO_1 = "22222222-2222-4222-8222-222222222222";
const NUMERO_2 = "44444444-4444-4444-8444-444444444444";

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
        if (op !== "select" && h.erroNaEscrita) {
          const erro = h.erroNaEscrita;
          h.erroNaEscrita = null;
          return { data: null, error: erro };
        }
        if (op === "insert") {
          h.proximoId += 1;
          const nova = {
            id: `55555555-5555-4555-8555-${String(h.proximoId).padStart(12, "0")}`,
            archived_at: null,
            created_at: `2026-11-16T10:00:0${h.proximoId}.000Z`,
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

function numero(id: string, conta: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    organization_id: ORG,
    provider: PARTNER_CHANNEL_PROVIDER,
    zernio_account_id: conta,
    zernio_token_encrypted: "cifrado-antigo",
    phone_number: `+55119${conta.slice(-4)}`,
    display_name: `Número ${conta}`,
    status: "WORKING",
    webhook_path_token: `tok-${conta}`,
    archived_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

const conectar = (body: Record<string, unknown>) =>
  POST(
    new NextRequest("https://crm.test/api/v1/channels/partner", {
      method: "POST",
      body: JSON.stringify({ api_key: "sk_live_123456", ...body }),
    }),
  );

const daOrg = () => h.linhas.filter((l) => l.organization_id === ORG && l.provider === PARTNER_CHANNEL_PROVIDER);

beforeEach(() => {
  h.linhas = [];
  h.proximoId = 0;
  h.erroNaEscrita = null;
  h.validar.mockReset();
  h.validar.mockResolvedValue({ ok: true, phoneNumber: "5511900000000", displayName: "Do provedor", qualityRating: null });
});

describe("com UM número, nada muda", () => {
  it("Reconectar com outra conta, sem pedir número novo, atualiza a MESMA linha (o comportamento de antes)", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"));
    const r = await conectar({ account_id: "acc_b" });
    expect(r.status).toBe(200);
    expect(daOrg()).toHaveLength(1);
    expect(daOrg()[0]).toMatchObject({ id: NUMERO_1, zernio_account_id: "acc_b", webhook_path_token: "tok-acc_a" });
  });

  it("sem número nenhum, conectar cria a primeira linha", async () => {
    const r = await conectar({ account_id: "acc_a" });
    expect(r.status).toBe(200);
    expect(daOrg()).toHaveLength(1);
  });

  it("o GET de um número traz os campos de sempre e a lista com ele", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"));
    const r = await GET(new NextRequest("https://crm.test/api/v1/channels/partner"));
    const { data } = (await r.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ connected: true, channel_session_id: NUMERO_1, account_id: "acc_a", can_add: true });
    expect(data.numbers).toHaveLength(1);
    // A chave nunca volta, nem na lista.
    expect(JSON.stringify(data)).not.toContain("cifrado");
  });
});

describe("adicionar o segundo número", () => {
  it("cria uma linha NOVA e deixa a primeira exatamente como estava", async () => {
    const primeira = numero(NUMERO_1, "acc_a");
    h.linhas.push(primeira);
    const antes = { ...primeira };

    const r = await conectar({ account_id: "acc_b", novo: true });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { webhook_url: string; webhook_secret: string } };

    expect(daOrg()).toHaveLength(2);
    expect(h.linhas.find((l) => l.id === NUMERO_1)).toEqual(antes);
    const nova = daOrg().find((l) => l.id !== NUMERO_1)!;
    expect(nova).toMatchObject({ zernio_account_id: "acc_b", status: "WORKING", archived_at: null });
    // Webhook próprio: o token e o segredo NÃO são os do primeiro número.
    expect(nova.webhook_path_token).not.toBe("tok-acc_a");
    expect(corpo.data.webhook_url).toContain(String(nova.webhook_path_token));
    expect(corpo.data.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    // Nasce com a IA fechada, como todo canal novo.
    expect(nova.metadata).toMatchObject({ ai_gate: "allowlist" });
  });

  it("o GET com dois números lista os dois, o mais antigo como principal, e não deixa adicionar um terceiro", async () => {
    h.linhas.push(numero(NUMERO_2, "acc_b", { created_at: "2026-11-16T00:00:00.000Z" }));
    h.linhas.push(numero(NUMERO_1, "acc_a"));
    const r = await GET(new NextRequest("https://crm.test/api/v1/channels/partner"));
    const { data } = (await r.json()) as { data: { channel_session_id: string; numbers: Array<{ channel_session_id: string }>; can_add: boolean } };
    expect(data.channel_session_id).toBe(NUMERO_1);
    expect(data.numbers.map((n) => n.channel_session_id)).toEqual([NUMERO_1, NUMERO_2]);
    expect(data.can_add).toBe(false);
  });

  it(`o teto é ${MAX_PARTNER_NUMBERS}: pedir um terceiro é 409 e não grava nada`, async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"), numero(NUMERO_2, "acc_b"));
    const r = await conectar({ account_id: "acc_c", novo: true });
    expect(r.status).toBe(409);
    expect(daOrg()).toHaveLength(2);
    expect(daOrg().map((l) => l.zernio_account_id).sort()).toEqual(["acc_a", "acc_b"]);
  });

  it("número excluído não conta no teto", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"), numero(NUMERO_2, "acc_b", { archived_at: "2026-11-01T00:00:00.000Z" }));
    const r = await conectar({ account_id: "acc_c", novo: true });
    expect(r.status).toBe(200);
  });

  it("'adicionar' com a conta de um número EM USO é recusado e não troca o segredo dele (não o cala)", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"));
    const antes = { ...h.linhas[0] };
    const r = await conectar({ account_id: "acc_a", novo: true });
    expect(r.status).toBe(409);
    expect(daOrg()).toHaveLength(1);
    // Nada foi gravado: nem chave, nem segredo do webhook.
    expect(h.linhas[0]).toEqual(antes);
    expect(h.linhas[0]).not.toHaveProperty("webhook_secret_encrypted");
  });

  it("'adicionar' com a conta de um número EXCLUÍDO desta organização o traz de volta, sem duplicar", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"), numero(NUMERO_2, "acc_b", { archived_at: "2026-11-01T00:00:00.000Z" }));
    const r = await conectar({ account_id: "acc_b", novo: true });
    expect(r.status).toBe(200);
    expect(daOrg()).toHaveLength(2);
    expect(h.linhas.find((l) => l.id === NUMERO_2)?.archived_at).toBeNull();
    const corpo = (await r.json()) as { data: { channel_session_id: string } };
    expect(corpo.data.channel_session_id).toBe(NUMERO_2);
  });

  it("trazer de volta um número excluído também ocupa vaga: com dois em uso é 409, por qualquer caminho", async () => {
    const terceiro = "66666666-6666-4666-8666-666666666666";
    h.linhas.push(
      numero(NUMERO_1, "acc_a"),
      numero(NUMERO_2, "acc_b"),
      numero(terceiro, "acc_c", { archived_at: "2026-11-01T00:00:00.000Z" }),
    );
    for (const corpo of [
      { account_id: "acc_c" },
      { account_id: "acc_c", novo: true },
      { account_id: "acc_c", channel_session_id: terceiro },
    ]) {
      expect((await conectar(corpo)).status, JSON.stringify(corpo)).toBe(409);
    }
    expect(h.linhas.find((l) => l.id === terceiro)?.archived_at).not.toBeNull();
  });

  it("o POST devolve DE QUAL número é o segredo novo", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"));
    const r = await conectar({ account_id: "acc_b", novo: true });
    const corpo = (await r.json()) as { data: { channel_session_id: string } };
    const nova = daOrg().find((l) => l.id !== NUMERO_1)!;
    expect(corpo.data.channel_session_id).toBe(nova.id);
  });
});

describe("a conta nunca troca de número por engano", () => {
  it("Reconectar o número 1 colando a conta do número 2 é recusado, e nenhum dos dois muda", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"), numero(NUMERO_2, "acc_b"));
    const r = await conectar({ account_id: "acc_b", channel_session_id: NUMERO_1 });
    expect(r.status).toBe(409);
    expect(h.linhas.find((l) => l.id === NUMERO_1)?.zernio_account_id).toBe("acc_a");
    expect(h.linhas.find((l) => l.id === NUMERO_2)?.zernio_account_id).toBe("acc_b");
  });

  it("colar a conta do número 2 no formulário sem dizer qual reconecta o número 2, não o 1", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"), numero(NUMERO_2, "acc_b"));
    const r = await conectar({ account_id: "acc_b" });
    expect(r.status).toBe(200);
    expect(h.linhas.find((l) => l.id === NUMERO_1)?.zernio_account_id).toBe("acc_a");
    expect(h.linhas.find((l) => l.id === NUMERO_2)?.zernio_token_encrypted).toBe("cifrado");
  });

  it("com dois números, um pedido que não diz qual (aba antiga, chamada pela API) é 409 e não troca nenhum", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"), numero(NUMERO_2, "acc_b"));
    const r = await conectar({ account_id: "acc_novinha" });
    expect(r.status).toBe(409);
    expect(daOrg().map((l) => l.zernio_account_id).sort()).toEqual(["acc_a", "acc_b"]);
    expect(daOrg().every((l) => l.zernio_token_encrypted === "cifrado-antigo")).toBe(true);
  });

  it("Reconectar um número de OUTRA organização pelo id é 404 e não grava", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"), { ...numero(NUMERO_2, "acc_x"), organization_id: OUTRA_ORG });
    const r = await conectar({ account_id: "acc_x", channel_session_id: NUMERO_2 });
    expect(r.status).toBe(404);
    expect(h.linhas.find((l) => l.id === NUMERO_2)?.zernio_token_encrypted).toBe("cifrado-antigo");
  });

  it("a busca por id só alcança a organização de quem pede", async () => {
    h.linhas.push({ ...numero(NUMERO_2, "acc_x"), organization_id: OUTRA_ORG });
    expect(await findPartnerSessionById(createAdminClient(), ORG, NUMERO_2)).toBeNull();
    expect(await findPartnerSessionById(createAdminClient(), OUTRA_ORG, NUMERO_2)).not.toBeNull();
  });
});

describe("recusas do banco viram frase, não 500", () => {
  it("conta ativa em OUTRA organização (índice único da 0165) é 409", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"));
    h.erroNaEscrita = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "channel_sessions_zernio_account_id_ativo_unique"',
    };
    const r = await conectar({ account_id: "acc_de_outra_org", novo: true });
    expect(r.status).toBe(409);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toMatch(/outra organização/);
  });

  it("telefone já ativo nesta organização por outra conexão (índice da 0107) é 409", async () => {
    h.linhas.push(numero(NUMERO_1, "acc_a"));
    h.erroNaEscrita = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "channel_sessions_phone_per_org_unique"',
    };
    const r = await conectar({ account_id: "acc_b", novo: true });
    expect(r.status).toBe(409);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toMatch(/telefone já está conectado/);
  });
});

describe("a regra de escolha, sem banco", () => {
  const s = (id: string, conta: string, extra: Partial<PartnerSession> = {}): PartnerSession => ({
    id,
    accountId: conta,
    phoneNumber: null,
    displayName: null,
    status: "WORKING",
    webhookPathToken: `tok-${id}`,
    hasApiKey: true,
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  });

  it("principal: a ativa mais antiga; sem ativa, a excluída mais recente; sem nada, nenhuma", () => {
    expect(escolherPrincipal([s("a", "1"), s("b", "2")])?.id).toBe("a");
    expect(escolherPrincipal([s("a", "1", { archivedAt: "x" }), s("b", "2")])?.id).toBe("b");
    expect(escolherPrincipal([s("a", "1", { archivedAt: "x" }), s("b", "2", { archivedAt: "y" })])?.id).toBe("b");
    expect(escolherPrincipal([])).toBeNull();
  });

  it("com uma linha só, toda forma de pedido sem id nem 'novo' cai nela — ativa ou excluída", () => {
    for (const unica of [s("a", "1"), s("a", "1", { archivedAt: "x" })]) {
      expect(escolherAlvoDaCredencial([unica], { accountId: "1" })).toEqual({ tipo: "existente", sessao: unica });
      expect(escolherAlvoDaCredencial([unica], { accountId: "outra" })).toEqual({ tipo: "existente", sessao: unica });
    }
    expect(escolherAlvoDaCredencial([], { accountId: "1" })).toEqual({ tipo: "nova" });
  });
});

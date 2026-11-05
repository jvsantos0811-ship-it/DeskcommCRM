/**
 * A PORTA QUE O CONVITE USA QUANDO O GOTRUE ESTÁ FECHADO (#1653).
 *
 * `disable_signup` é a única trava do GoTrue que fecha `POST /auth/v1/signup`
 * para quem tem a anon key — e ela fecha TAMBÉM o convite, porque o convite
 * cria a conta por ali. Este arquivo guarda as duas metades do conserto:
 *
 *   1. `lerConfigPublicaDoGoTrue` — a pergunta pública que decide qual caminho
 *      a server action usa. `null` (rede fora, resposta estranha) não pode virar
 *      nem "aberto" nem "fechado": os dois erros têm vítima diferente.
 *   2. `criarContaDeConvite` — a conta nasce pela admin API (que o
 *      `disable_signup` não alcança) JÁ CONFIRMADA: desde 05/11/2026 o link do
 *      convite é a prova de caixa postal e não existe segundo e-mail (o porquê
 *      está no cabeçalho do módulo). A senha recusada pelo provedor volta como
 *      `senha_fraca`, com o motivo — foi o que travou convidados reais.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";

const admin = vi.hoisted(() => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ auth: { admin: { createUser: admin.createUser, deleteUser: admin.deleteUser } } })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const convite = async () => await import("./convite-no-gotrue");

function responderSettings(corpo: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => corpo }) as Response),
  );
}

const entrada = {
  email: "convidada@exemplo.test",
  password: "SenhaForte!2026",
  inviteToken: "token-assinado-do-convite",
  fullName: "Convidada da Silva",
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lerConfigPublicaDoGoTrue", () => {
  it("URL do Supabase com barra final não vira `//auth` (404 no gateway)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://sb.exemplo.test/", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" },
    }));
    try {
      responderSettings({ disable_signup: true });
      const { lerConfigPublicaDoGoTrue } = await convite();
      await lerConfigPublicaDoGoTrue();
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://sb.exemplo.test/auth/v1/settings");
    } finally {
      vi.doUnmock("@/lib/env");
      vi.resetModules();
    }
  });

  it("lê `disable_signup` do endpoint público", async () => {
    responderSettings({ disable_signup: true, mailer_autoconfirm: false });
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toEqual({ disable_signup: true });
  });

  it("cadastro aberto é `false`, não ausência de resposta", async () => {
    responderSettings({ disable_signup: false });
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toEqual({ disable_signup: false });
  });

  it("rede fora → `null` (nunca lança: isto roda no meio do cadastro)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toBeNull();
  });

  it("resposta sem o campo → `null`: não sei não vira 'aberto'", async () => {
    responderSettings({ external: {} });
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toBeNull();
  });

  it("HTTP 500 do GoTrue → `null`", async () => {
    responderSettings({ disable_signup: true }, false);
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toBeNull();
  });
});

describe("criarContaDeConvite", () => {
  it("⭐ cria pela admin API, JÁ CONFIRMADA, com o convite no user_metadata — e não manda e-mail", async () => {
    admin.createUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });

    const r = await (await convite()).criarContaDeConvite(entrada);

    expect(r).toEqual({ ok: true, userId: "u-1" });
    // `email_confirm: true`: o link do convite, assinado e enviado ao endereço
    // convidado, já provou a caixa postal (decisão de 05/11/2026). O segundo
    // e-mail custava convidados reais e não provava nada a mais.
    expect(admin.createUser).toHaveBeenCalledWith({
      email: entrada.email,
      password: entrada.password,
      email_confirm: true,
      user_metadata: { invite_token: entrada.inviteToken, full_name: entrada.fullName },
    });
    // Nenhum client anônimo é aberto: não existe `/resend` neste caminho.
    expect(createClient).not.toHaveBeenCalled();
  });

  it("conta já existe → `conta_ja_existe` (não é falha de infra)", async () => {
    admin.createUser.mockResolvedValue({
      data: null,
      error: { message: "A user with this email address has already been registered", code: "email_exists", status: 422 },
    });

    const r = await (await convite()).criarContaDeConvite(entrada);

    expect(r).toEqual({ ok: false, motivo: "conta_ja_existe" });
  });

  it("⭐ senha vazada (o 422 medido em produção) → `senha_fraca` com o motivo, não `criacao_recusada`", async () => {
    const mensagem = "Password is known to be weak and easy to guess, please choose a different one.";
    admin.createUser.mockResolvedValue({ data: null, error: { message: mensagem, status: 422 } });

    const r = await (await convite()).criarContaDeConvite(entrada);

    expect(r).toEqual({ ok: false, motivo: "senha_fraca", motivosDaSenha: ["vazada"], detalhe: mensagem });
    // Nada a desfazer: a conta não nasceu.
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it("CONTROLE — falha que não é de senha nem de conta existente segue `criacao_recusada`", async () => {
    admin.createUser.mockResolvedValue({ data: null, error: { message: "Database error saving new user", status: 500 } });

    const r = await (await convite()).criarContaDeConvite(entrada);

    expect(r).toEqual({ ok: false, motivo: "criacao_recusada", detalhe: "Database error saving new user" });
  });

  it("429 do GoTrue vira `rate_limited`, igual ao caminho de sempre", async () => {
    admin.createUser.mockResolvedValue({
      data: null,
      error: { message: "rate limit exceeded", status: 429 },
    });

    const r = await (await convite()).criarContaDeConvite(entrada);

    expect(r).toEqual({ ok: false, motivo: "rate_limited" });
  });
});

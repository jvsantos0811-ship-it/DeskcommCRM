/**
 * O PRIMEIRO ACESSO PELO CONVITE É UM FORMULÁRIO SÓ — E A SENHA RECUSADA DIZ POR QUÊ.
 *
 * ─── O defeito, medido em produção (05/11/2026) ─────────────────────────────
 *
 * Três convidados de um escritório (Souza Rodrigues Advogados) não conseguiram
 * entrar. Um deles abriu o convite, escolheu uma senha, e o provedor de auth a
 * recusou por estar em lista de senhas vazadas (`422 Password is known to be
 * weak and easy to guess`). A tela disse "Não foi possível criar a conta. Tente
 * novamente." — e tentar de novo com a mesma senha nunca funciona. Mesmo com a
 * senha aceita, ainda viria um SEGUNDO e-mail, de confirmação, antes de entrar.
 *
 * ─── O que este arquivo guarda ──────────────────────────────────────────────
 *
 * A metade da TELA (a da action está em `app/actions/auth/signUp.test.ts`):
 *
 *   - convite aceito na mesma ação → a tela vai DIRETO para o CRM;
 *   - nenhum caminho do convite manda "abrir o e-mail e clicar no link";
 *   - a senha recusada aparece com o MOTIVO e o que fazer, nunca "tente de novo".
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignupForm } from "@/components/auth/SignupForm";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const signUp = vi.fn();
vi.mock("@/app/actions/auth/signUp", () => ({ signUp: (...a: unknown[]) => signUp(...a) }));

const CONVITE = { token: "tok-convite", email: "convidada@escritorio.test" };

async function criarSenhaPeloConvite() {
  const user = userEvent.setup();
  render(<SignupForm convite={CONVITE} />);
  await user.type(screen.getByLabelText(/Seu nome/i), "Convidada da Silva");
  await user.type(screen.getByLabelText(/^Senha$/i), "SenhaForte!2026");
  await user.type(screen.getByLabelText(/Confirmar senha/i), "SenhaForte!2026");
  await user.click(screen.getByRole("button", { name: /criar senha e entrar/i }));
}

describe("primeiro acesso pelo convite", () => {
  beforeEach(() => {
    replace.mockClear();
    signUp.mockReset();
  });

  it("⭐ conta criada e convite aceito: vai direto para o CRM, sem e-mail para esperar", async () => {
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true, convite_aceito: true });
    await criarSenhaPeloConvite();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app"));
    expect(screen.queryByText(/Enviamos um link de confirmação/i)).toBeNull();
    // A action recebeu o token: é ele que amarra a conta nova a ESTE convite.
    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({ email: CONVITE.email, full_name: "Convidada da Silva" }),
      CONVITE.token,
    );
  });

  it("conta criada mas o aceite não fechou: a tela do convite explica (revogado, limite do plano)", async () => {
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true, convite_aceito: false });
    await criarSenhaPeloConvite();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/team/accept-invite/${CONVITE.token}`));
  });

  it("conta criada sem sessão: o login, com o convite pendurado — nunca 'confirme seu e-mail'", async () => {
    // Neste caminho NÃO sai e-mail nenhum. Mandar esperar um seria o beco que
    // `cadastro-sem-confirmacao-nao-manda-esperar-email` já fechou uma vez.
    signUp.mockResolvedValue({ ok: true, sessao_ativa: false, entrar_pelo_login: true });
    await criarSenhaPeloConvite();

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent(`/team/accept-invite/${CONVITE.token}`)}`,
      ),
    );
    expect(screen.queryByText(/Enviamos um link de confirmação/i)).toBeNull();
  });

  it("⭐ senha vazada: diz o motivo e o que fazer, em vez de 'tente novamente'", async () => {
    signUp.mockResolvedValue({ ok: false, error: "senha_fraca", details: { motivos: ["vazada"] } });
    await criarSenhaPeloConvite();

    await waitFor(() => expect(screen.getByText(/apareceu em vazamentos/i)).toBeTruthy());
    expect(screen.queryByText(/Tente novamente/i)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("senha curta: diz o tamanho mínimo", async () => {
    signUp.mockResolvedValue({ ok: false, error: "senha_fraca", details: { motivos: ["curta"] } });
    await criarSenhaPeloConvite();

    await waitFor(() => expect(screen.getByText(/pelo menos 8 caracteres/i)).toBeTruthy());
  });

  it("senha recusada sem motivo declarado: ainda assim não manda 'tentar de novo'", async () => {
    signUp.mockResolvedValue({ ok: false, error: "senha_fraca", details: { motivos: [] } });
    await criarSenhaPeloConvite();

    await waitFor(() => expect(screen.getByText(/não foi aceita por ser fraca/i)).toBeTruthy());
    expect(screen.queryByText(/Tente novamente/i)).toBeNull();
  });

  it("a dica de senha aparece ANTES de a pessoa errar", () => {
    render(<SignupForm convite={CONVITE} />);
    expect(screen.getByText(/Senhas comuns ou que já vazaram na internet são recusadas/i)).toBeTruthy();
  });
});

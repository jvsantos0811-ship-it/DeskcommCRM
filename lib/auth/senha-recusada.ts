/**
 * A SENHA QUE O PROVEDOR DE AUTH RECUSOU — e por quê, em palavras de gente.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 * Em 05/11/2026 uma pessoa convidada abriu o link do convite, escolheu uma
 * senha e recebeu "Não foi possível criar a conta. Tente novamente." O log do
 * provedor dizia outra coisa: `422 Password is known to be weak and easy to
 * guess, please choose a different one.` — a proteção contra senha vazada
 * (HaveIBeenPwned) estava ligada, e a senha estava na lista.
 *
 * "Tente novamente" com a MESMA senha nunca funciona. A pessoa tentou, depois
 * foi em "Esqueci minha senha" duas vezes (que não faz nada para quem ainda não
 * tem conta) e desistiu. A tela sabia o motivo e não o disse.
 *
 * ─── O que este módulo faz ──────────────────────────────────────────────────
 *
 * Lê o erro do GoTrue — pelo `code` (`weak_password`), pelos `reasons` que o
 * supabase-js expõe em `AuthWeakPasswordError` (`pwned`, `length`,
 * `characters`) ou, em versões mais velhas, pela mensagem — e devolve os
 * motivos num vocabulário nosso. `null` = não é recusa de senha.
 *
 * Função pura e sem dependência: a action do cadastro e a da conta do convidado
 * leem o MESMO erro do mesmo provedor, e uma régua só evita que um caminho diga
 * "senha fraca" e o outro "tente novamente".
 */

/** `vazada`: apareceu em vazamento ou é fácil de adivinhar. `curta`/`simples`: régua de tamanho e de caracteres. */
export type MotivoDaSenhaRecusada = "vazada" | "curta" | "simples";

interface ErroDoProvedor {
  code?: unknown;
  message?: unknown;
  reasons?: unknown;
}

const POR_RAZAO: Record<string, MotivoDaSenhaRecusada> = {
  pwned: "vazada",
  length: "curta",
  characters: "simples",
};

/**
 * Os motivos da recusa, ou `null` quando o erro não é de senha. Lista vazia é
 * possível — o provedor disse `weak_password` sem dizer por quê — e a tela tem
 * uma frase para isso também.
 */
export function motivosDaSenhaRecusada(
  erro: ErroDoProvedor | null | undefined,
): MotivoDaSenhaRecusada[] | null {
  if (!erro) return null;
  const mensagem = typeof erro.message === "string" ? erro.message : "";
  const porCodigo = erro.code === "weak_password";
  const porMensagem =
    /weak|easy to guess|pwned|known to be|should be at least|should contain/i.test(mensagem);
  if (!porCodigo && !porMensagem) return null;

  const motivos = new Set<MotivoDaSenhaRecusada>();
  if (Array.isArray(erro.reasons)) {
    for (const r of erro.reasons) {
      const m = typeof r === "string" ? POR_RAZAO[r] : undefined;
      if (m) motivos.add(m);
    }
  }
  if (motivos.size === 0) {
    if (/known to be|easy to guess|pwned|leak/i.test(mensagem)) motivos.add("vazada");
    if (/at least \d+ characters/i.test(mensagem)) motivos.add("curta");
    if (/should contain/i.test(mensagem)) motivos.add("simples");
  }
  return [...motivos];
}

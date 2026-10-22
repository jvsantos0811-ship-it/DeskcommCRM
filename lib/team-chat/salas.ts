/**
 * Chat interno da equipe — as regras das SALAS, sem I/O (migration 9002).
 *
 * Duas formas de sala, e o mesmo texto vive no banco (CHECK), na RLS e aqui:
 * - `geral`: a equipe inteira da organização;
 * - `dm:<menor>:<maior>`: duas pessoas, com os ids em ORDEM — assim a conversa
 *   de A com B e a de B com A são a mesma sala, e não duas.
 */

export const SALA_GERAL = "geral";
export const TEXTO_MAXIMO = 4000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function salaDireta(a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `dm:${x}:${y}`;
}

/** Os dois participantes de uma sala direta, ou `null` se não for uma. */
export function participantesDaSala(sala: string): [string, string] | null {
  const [prefixo, a, b, ...resto] = sala.split(":");
  if (prefixo !== "dm" || !a || !b || resto.length > 0) return null;
  if (!UUID.test(a) || !UUID.test(b) || a === b) return null;
  if (salaDireta(a, b) !== sala) return null; // fora de ordem = sala que não existe
  return [a, b];
}

export function salaValida(sala: string): boolean {
  return sala === SALA_GERAL || participantesDaSala(sala) !== null;
}

/** A pessoa pode ler e escrever nesta sala? (o MESMO critério da RLS) */
export function podeEntrar(sala: string, userId: string): boolean {
  if (sala === SALA_GERAL) return true;
  const p = participantesDaSala(sala);
  return !!p && (p[0] === userId.toLowerCase() || p[1] === userId.toLowerCase());
}

/** Com quem é a conversa direta, do ponto de vista de `userId`. */
export function outroParticipante(sala: string, userId: string): string | null {
  const p = participantesDaSala(sala);
  if (!p) return null;
  const eu = userId.toLowerCase();
  if (p[0] === eu) return p[1];
  if (p[1] === eu) return p[0];
  return null;
}

export interface MensagemDaEquipe {
  id: string;
  organization_id: string;
  room: string;
  sender_user_id: string | null;
  sender_name: string | null;
  body: string;
  created_at: string;
}

export const COLUNAS_DA_MENSAGEM = "id, organization_id, room, sender_user_id, sender_name, body, created_at";

export interface SalaResumo {
  room: string;
  /** Para a sala direta: a outra pessoa. `null` na geral. */
  user_id: string | null;
  nome: string;
  nao_lidas: number;
  ultima: { body: string; created_at: string; sender_name: string | null } | null;
}

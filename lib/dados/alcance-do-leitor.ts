/**
 * QUEM É "LEAD COM POTENCIAL" — o alcance do Leitor da conversa, do painel
 * "Esperando a equipe" e do aviso "Ninguém respondeu" (PM-025 §2).
 *
 * Configurável por organização (`organizations.settings.leitor`), e NUNCA por
 * nome de funil, de etapa ou de cliente: vale para escritório, clínica e
 * consultório. A regra, num lugar só, para os três baterem:
 *
 *   lead com potencial = está num funil lido
 *                      + numa etapa sem `is_won`, sem `is_lost` e não arquivada
 *                      + sem nenhum marcador da lista que desqualifica.
 *
 * Funis lidos: os que a organização escolheu; sem escolha, todos os não
 * arquivados MENOS o marcado `is_client_pipeline`. Essa marca é LIDA aqui só
 * para montar o padrão — o alcance não lhe dá um segundo sentido (anti-padrão 2):
 * quem escolhe os funis à mão escolhe inclusive o de clientes, se quiser.
 *
 * "Pode voltar" (PM-025 §3, exceção 1): o lead de um funil lido que está fora
 * por etapa de PERDA ou por marcador que desqualifica. Se ele manda mensagem
 * nova, volta a ser lido e entra no aviso — a etapa não muda, a equipe decide.
 * Ganho, etapa arquivada e funil não lido não "voltam".
 */
import { z } from "zod";

export const CHAVE_DO_ALCANCE = "leitor" as const;

const marcador = z.string().trim().min(1).max(80);

export const alcanceDoLeitorSchema = z
  .object({
    /** `null` = padrão (todos os não arquivados, menos o funil de clientes). */
    funis: z.array(z.string().uuid()).max(50).nullable().default(null),
    marcadores_que_desqualificam: z.array(marcador).max(50).default([]),
  })
  .strict();
export type AlcanceDoLeitor = z.infer<typeof alcanceDoLeitorSchema>;

export const ALCANCE_PADRAO: AlcanceDoLeitor = { funis: null, marcadores_que_desqualificam: [] };

/** Lê o alcance do `settings` da organização. Nunca lança: inválido vira o padrão. */
export function alcanceDaOrg(settings: unknown): AlcanceDoLeitor {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return ALCANCE_PADRAO;
  const bruto = (settings as Record<string, unknown>)[CHAVE_DO_ALCANCE];
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return ALCANCE_PADRAO;
  const so = {
    funis: (bruto as Record<string, unknown>).funis ?? null,
    marcadores_que_desqualificam: (bruto as Record<string, unknown>).marcadores_que_desqualificam ?? [],
  };
  const r = alcanceDoLeitorSchema.safeParse(so);
  return r.success ? r.data : ALCANCE_PADRAO;
}

export interface FunilDaOrg {
  id: string;
  is_archived: boolean;
  is_client_pipeline: boolean;
}

/** Os funis que o Leitor lê nesta organização. */
export function funisLidos(alcance: AlcanceDoLeitor, funis: FunilDaOrg[]): Set<string> {
  const vivos = funis.filter((f) => !f.is_archived);
  if (alcance.funis === null) {
    return new Set(vivos.filter((f) => !f.is_client_pipeline).map((f) => f.id));
  }
  const escolhidos = new Set(alcance.funis);
  return new Set(vivos.filter((f) => escolhidos.has(f.id)).map((f) => f.id));
}

/** Marcador comparado sem maiúscula, acento nem espaço nas pontas. */
export function normalizarMarcador(m: string): string {
  return m
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

export interface LeadNoAlcance {
  pipeline_id: string;
  tags: string[] | null;
  etapa: { is_won: boolean; is_lost: boolean; is_archived: boolean };
}

export type PosicaoNoAlcance =
  /** Lead com potencial: lido, entra nos painéis e no aviso. */
  | "com_potencial"
  /** Fora por perda ou por marcador; se escrever de novo, volta (`lead_voltou`). */
  | "pode_voltar"
  /** Fora de vez: funil não lido, ganho ou etapa arquivada. */
  | "fora";

export function posicaoNoAlcance(
  lead: LeadNoAlcance,
  lidos: Set<string>,
  alcance: AlcanceDoLeitor,
): PosicaoNoAlcance {
  if (!lidos.has(lead.pipeline_id)) return "fora";
  if (lead.etapa.is_archived || lead.etapa.is_won) return "fora";
  if (lead.etapa.is_lost) return "pode_voltar";
  const desqualifica = new Set(alcance.marcadores_que_desqualificam.map(normalizarMarcador));
  if (desqualifica.size > 0 && (lead.tags ?? []).some((t) => desqualifica.has(normalizarMarcador(t)))) {
    return "pode_voltar";
  }
  return "com_potencial";
}

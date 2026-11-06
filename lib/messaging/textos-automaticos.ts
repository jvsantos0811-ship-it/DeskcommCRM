/**
 * MENSAGEM AUTOMÁTICA DO CELULAR — PM-027 §6, a mesma regra para o painel
 * "Esperando a equipe" e para o aviso "Ninguém respondeu".
 *
 * A saudação ou ausência do WhatsApp Business e o robô da plataforma antiga
 * (histórico importado) saem do CELULAR do escritório e chegam como
 * `external_device` — iguais à fala de uma pessoa. Não são pessoa, e não
 * contam como resposta.
 *
 * A decisão é do TEXTO, não da mensagem: um texto é automático quando saiu
 * igual em 3 ou mais conversas da organização e, em 80% ou mais das vezes, até
 * 60 s depois da mensagem do lead (janela de 90 dias). Aí TODA mensagem com
 * aquele texto é automática, mesmo a que saiu atrasada — decidir mensagem a
 * mensagem deixava a saudação atrasada (61 s a 502 s, na Bórbora) contar como
 * pessoa e tirar o lead do painel. O erro que esconde lead é não reconhecer a
 * automática. "[Unsupported message]" (o conteúdo que a importação não trouxe)
 * nunca conta como pessoa.
 *
 * A contagem é do banco (`fn_textos_automaticos_do_celular`, migration 9024);
 * a proporção e a normalização do texto moram aqui, e a do banco é a mesma
 * (espaços juntos, sem espaço nas pontas, minúsculas).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const CONVERSAS_PARA_SER_AUTOMATICA = 3;
export const PROPORCAO_NO_PRAZO = 0.8;
export const SEGUNDOS_DA_AUTOMATICA = 60;
export const DIAS_DA_JANELA_DAS_AUTOMATICAS = 90;
/** O conteúdo que a importação da plataforma antiga não trouxe. Nunca é pessoa. */
export const TEXTO_NAO_IMPORTADO = "[unsupported message]";

const DIA_MS = 24 * 60 * 60 * 1000;

export function normalizarTexto(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Uma linha da contagem do banco. */
export interface ContagemDoTexto {
  texto: string;
  conversas: number;
  vezes: number;
  no_prazo: number;
}

/** Os textos automáticos: 3+ conversas e 80% ou mais das vezes no prazo. */
export function textosAutomaticos(linhas: readonly ContagemDoTexto[]): Set<string> {
  const out = new Set<string>([TEXTO_NAO_IMPORTADO]);
  for (const l of linhas) {
    if (l.conversas < CONVERSAS_PARA_SER_AUTOMATICA || l.vezes <= 0) continue;
    if (l.no_prazo / l.vezes >= PROPORCAO_NO_PRAZO) out.add(normalizarTexto(l.texto));
  }
  return out;
}

/** Esta mensagem é automática (não é pessoa)? Só vale para a saída do celular. */
export function ehMensagemAutomatica(
  m: { direction: string; sent_via: string | null; body?: string | null },
  automaticos: ReadonlySet<string>,
): boolean {
  if (m.direction !== "outbound" || m.sent_via !== "external_device") return false;
  const t = normalizarTexto(m.body);
  return t === TEXTO_NAO_IMPORTADO || automaticos.has(t);
}

/**
 * Lê a contagem da organização e devolve os textos automáticos. Lança quando o
 * banco falha: tratar a falha como "nenhuma automática" contaria o robô como
 * pessoa e esconderia lead — melhor a rodada falhar e aparecer.
 */
export async function lerTextosAutomaticos(admin: SupabaseClient, orgId: string, agora: Date): Promise<Set<string>> {
  const { data, error } = await admin.rpc("fn_textos_automaticos_do_celular", {
    p_org: orgId,
    p_desde: new Date(agora.getTime() - DIAS_DA_JANELA_DAS_AUTOMATICAS * DIA_MS).toISOString(),
    p_segundos: SEGUNDOS_DA_AUTOMATICA,
    p_min_conversas: CONVERSAS_PARA_SER_AUTOMATICA,
  });
  if (error) throw new Error(`textos automáticos: ${error.message}`);
  return textosAutomaticos((data ?? []) as ContagemDoTexto[]);
}

/**
 * OS CAMPOS DO NEGÓCIO NO TEXTO DO TURNO (PC-003, critério A10).
 *
 * O modelo precisa LER o estado da qualificação para não adivinhar: quais
 * campos o negócio já tem, com que status (CONFIRMADO, NEGADO, NAO_SABE,
 * NAO_SE_APLICA, PENDENTE, CONTRADITORIO) e com que dado. Sem isto, a trava de
 * etapa recusaria e o modelo só descobriria o que falta pela recusa.
 *
 * Formato, uma linha por campo do NEGÓCIO (campos do contato ficam de fora; o
 * campo oculto por condição também):
 *
 *   - Categoria na data: CONFIRMADO — Segurado empregado
 *   - Data do acidente: PENDENTE — (vazio)
 *   - Observação: texto livre              ← campo sem status
 *
 * Vai no SUFIXO por-lead do turno (volátil), nunca no prefixo cacheável.
 * Contato sem negócio aberto, ou com mais de um (ambíguo): bloco vazio — o
 * mesmo critério de "qual negócio deste contato" do espelho do funil.
 */
import type { Queryable } from '../queue/queue';
import { resolveActiveLeadForContact } from '@/lib/leads/active-lead';
import { camposDoFunil, escopoDoCampo } from '@/lib/leads/campos-do-funil';
import { statusDosCampos } from '@/lib/leads/status-dos-campos';
import { camposVisiveis } from '@/lib/schemas/mostrar-quando';

interface LinhaDoNegocio {
  id: string;
  organization_id: string;
  pipeline_id: string;
  status: 'open' | 'won' | 'lost';
  created_at: string;
  last_activity_at: string | null;
  custom_fields: Record<string, unknown> | null;
  status_dos_campos: unknown;
  etapa: string | null;
  settings: Record<string, unknown> | null;
}

function textoDoValor(v: unknown): string {
  if (v === undefined || v === null) return '(vazio)';
  if (typeof v === 'string') return v.trim() === '' ? '(vazio)' : v.trim();
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (Array.isArray(v)) return v.length === 0 ? '(vazio)' : v.map((x) => String(x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** O bloco a partir do negócio já lido — puro, para teste. */
export function formatarCamposDoNegocio(negocio: {
  etapa: string | null;
  settings: Record<string, unknown> | null;
  custom_fields: Record<string, unknown> | null;
  status_dos_campos: unknown;
}): string {
  const valores = negocio.custom_fields ?? {};
  const campos = camposDoFunil(negocio.settings).filter((c) => escopoDoCampo(c) === 'negocio');
  const visiveis = new Set(camposVisiveis(campos, valores).map((c) => c.key));
  const statuses = statusDosCampos(negocio.status_dos_campos);
  const linhas = campos
    .filter((c) => visiveis.has(c.key))
    .map((c) => {
      const dado = textoDoValor(valores[c.key]);
      if (c.com_status === true) {
        return `- ${c.label}: ${statuses[c.key] ?? 'PENDENTE'} — ${dado}`;
      }
      return `- ${c.label}: ${dado}`;
    });
  if (linhas.length === 0) return '';
  return [
    `## Campos do negócio (etapa atual: ${negocio.etapa ?? 'sem etapa'})`,
    'Formato: nome: status — dado. Status: CONFIRMADO, NEGADO, NAO_SE_APLICA (respondido); ' +
      'NAO_SABE, PENDENTE, CONTRADITORIO (ainda não respondido — pergunte antes de avançar a etapa).',
    ...linhas,
  ].join('\n');
}

/** Lê o negócio aberto do contato e monta o bloco. Falha de leitura = bloco vazio. */
export async function blocoDosCamposDoNegocio(
  db: Queryable,
  organizationId: string,
  contactId: string | null,
): Promise<string> {
  if (!contactId) return '';
  try {
    const { rows } = await db.query<LinhaDoNegocio>(
      `select l.id, l.organization_id, l.pipeline_id, l.status, l.created_at::text,
              l.last_activity_at::text, l.custom_fields, l.status_dos_campos,
              s.name as etapa, p.settings
         from crm_leads l
         left join crm_stages s on s.id = l.stage_id
         left join crm_pipelines p on p.id = l.pipeline_id
        where l.organization_id = $1 and l.contact_id = $2`,
      [organizationId, contactId],
    );
    const rota = resolveActiveLeadForContact(
      rows.map((r) => ({
        id: r.id,
        organization_id: r.organization_id,
        pipeline_id: r.pipeline_id,
        status: r.status,
        created_at: r.created_at,
        last_activity_at: r.last_activity_at,
      })),
    );
    if (!rota.routed) return '';
    const negocio = rows.find((r) => r.id === rota.leadId);
    return negocio ? formatarCamposDoNegocio(negocio) : '';
  } catch {
    return '';
  }
}

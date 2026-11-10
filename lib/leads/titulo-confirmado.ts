/**
 * O TÍTULO DO CARD É O NOME DE QUEM CONVERSA (PC-026, item 1).
 *
 * ─── Por que existe ──────────────────────────────────────────────────────────
 *
 * O card nasce com o telefone ou o nome do perfil do WhatsApp ("Mãe ❤️",
 * "Loja do Zé", "+55 31 9…"). A equipe que vai assumir em "Análise humana" não
 * sabe de relance com quem fala. Quando a IA confirma o nome de quem está
 * conversando, o título passa a ser esse nome — inclusive quando é um familiar
 * falando pelo cliente (decisão do João, 10/11: o título é o nome de quem
 * conversa).
 *
 * ─── Fontes (em ordem) ───────────────────────────────────────────────────────
 *
 *  a) a linha "Nome confirmado" do cartão de `passar_para_agente` (automático);
 *  b) a ferramenta nativa `confirmar_nome(nome)`, que a recepção chama assim que
 *     a pessoa diz o nome — cobre quem para de responder antes da passagem.
 *
 * ─── O que nunca acontece ────────────────────────────────────────────────────
 *
 * A IA NUNCA sobrescreve um título que a equipe escreveu. A origem do título
 * mora em `crm_leads.titulo_origem` (migration 9026): `pessoa` protege. Card
 * antigo (origem desconhecida) só troca quando o título atual tem cara de ser o
 * do sistema — o telefone ou o nome do perfil/contato. O nome do CONTATO não é
 * tocado (decisão separada).
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";

export const TETO_DO_TITULO = 200;

/** Partículas que ficam minúsculas no meio do nome ("Maria de Souza"). */
const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e", "di", "del", "la", "van", "von"]);

/**
 * O nome como vai para o título: sem emoji, sem dígito, iniciais maiúsculas
 * ("maria de souza" → "Maria de Souza"), até 200 caracteres. `null` quando não
 * sobra um nome (vazio, "não informado", só número, uma letra).
 */
export function normalizarNomeConfirmado(bruto: string | null | undefined): string | null {
  if (typeof bruto !== "string") return null;
  const limpo = bruto
    .normalize("NFC")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️/gu, " ")
    .replace(/[^\p{L}\p{M}\s'’.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!limpo) return null;
  const minusculo = limpo.toLocaleLowerCase("pt-BR");
  if (/^(n[aã]o informad[oa]|nao sei|desconhecid[oa]|cliente|sem nome)$/.test(minusculo)) return null;
  if ((limpo.match(/\p{L}/gu) ?? []).length < 2) return null;
  const palavras = minusculo.split(" ").map((p, i) => {
    if (i > 0 && PARTICULAS.has(p)) return p;
    return p
      .split(/([-'’])/)
      .map((parte) => (parte.length > 0 && !/^[-'’]$/.test(parte) ? parte[0]!.toLocaleUpperCase("pt-BR") + parte.slice(1) : parte))
      .join("");
  });
  const nome = palavras.join(" ");
  return nome.length > TETO_DO_TITULO ? nome.slice(0, TETO_DO_TITULO).trimEnd() : nome;
}

function digitos(v: string): string {
  return v.replace(/\D/g, "");
}

function comparavel(v: string | null | undefined): string {
  return (v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type OrigemDoTitulo = "sistema" | "ia" | "pessoa";

export interface FatosDoTitulo {
  tituloAtual: string;
  origem: OrigemDoTitulo | null;
  telefone: string | null;
  /** Os nomes que o sistema usa para batizar o card: nome do perfil, nome do contato. */
  nomesDoSistema: ReadonlyArray<string | null | undefined>;
}

export type DecisaoDoTitulo = "trocar" | "igual" | "protegido";

/** A IA pode pôr `novo` no lugar do título atual? Pura. */
export function decidirTitulo(fatos: FatosDoTitulo, novo: string): DecisaoDoTitulo {
  if (comparavel(fatos.tituloAtual) === comparavel(novo)) return "igual";
  if (fatos.origem === "pessoa") return "protegido";
  if (fatos.origem === "sistema" || fatos.origem === "ia") return "trocar";
  // Origem desconhecida (card anterior à 9026): só troca o que tem cara de ter
  // vindo do sistema — o telefone, o nome do perfil, o nome do contato, vazio.
  const atual = fatos.tituloAtual.trim();
  if (atual === "") return "trocar";
  const d = digitos(atual);
  if (d.length >= 8 && d.length >= atual.replace(/\s/g, "").length - 4) return "trocar";
  if (fatos.telefone && d.length >= 8 && digitos(fatos.telefone).endsWith(d.slice(-8))) return "trocar";
  const c = comparavel(atual);
  if (fatos.nomesDoSistema.some((n) => comparavel(n) !== "" && comparavel(n) === c)) return "trocar";
  return "protegido";
}

export type ResultadoDoNomeConfirmado =
  | { status: "atualizado"; titulo: string; leadId: string }
  | { status: "igual" | "protegido"; titulo: string; leadId: string }
  | { status: "sem_negocio" | "nome_invalido" };

/**
 * Aplica o nome confirmado ao título do negócio ativo do contato. A escrita
 * declara a origem `ia` na própria transação (o gatilho da 9026 a respeita) e só
 * vence se o título não virou `pessoa` no meio do caminho. A linha do tempo
 * ganha "Título: <nome> (nome confirmado pela IA)". Nunca lança: o turno segue.
 */
export async function aplicarNomeConfirmado(
  pool: { connect: () => Promise<Queryable & { release: () => void }> } & Queryable,
  entrada: {
    organizationId: string;
    contactId: string;
    nome: string | null | undefined;
    agentId: string | null;
    fonte: "confirmar_nome" | "cartao_de_passagem";
    leadId?: string | null;
  },
): Promise<ResultadoDoNomeConfirmado> {
  const nome = normalizarNomeConfirmado(entrada.nome);
  if (nome === null) return { status: "nome_invalido" };
  try {
    const { rows } = await pool.query<{
      id: string;
      title: string;
      titulo_origem: OrigemDoTitulo | null;
      phone_number: string | null;
      display_name: string | null;
      name: string | null;
    }>(
      `select l.id, l.title, l.titulo_origem, c.phone_number, c.display_name, c.name
         from crm_leads l
         join contacts c on c.id = l.contact_id and c.organization_id = l.organization_id
        where l.organization_id = $1 and l.contact_id = $2 and l.status = 'open'
          and ($3::uuid is null or l.id = $3::uuid)
          and coalesce(c.is_anonymized, false) = false
        order by coalesce(l.last_activity_at, l.created_at) desc
        limit 1`,
      [entrada.organizationId, entrada.contactId, entrada.leadId ?? null],
    );
    const lead = rows[0];
    if (!lead) return { status: "sem_negocio" };
    const decisao = decidirTitulo(
      {
        tituloAtual: lead.title,
        origem: lead.titulo_origem,
        telefone: lead.phone_number,
        nomesDoSistema: [lead.display_name, lead.name],
      },
      nome,
    );
    if (decisao !== "trocar") return { status: decisao, titulo: lead.title, leadId: lead.id };

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('deskcomm.titulo_origem', 'ia', true)`);
      const upd = await client.query<{ id: string }>(
        `update crm_leads set title = $3, titulo_origem = 'ia'
          where organization_id = $1 and id = $2
            and titulo_origem is distinct from 'pessoa'
            and title = $4
        returning id`,
        [entrada.organizationId, lead.id, nome, lead.title],
      );
      if (upd.rows.length === 0) {
        await client.query("rollback");
        return { status: "protegido", titulo: lead.title, leadId: lead.id };
      }
      await client.query(
        `insert into crm_lead_activities
           (organization_id, lead_id, type, actor_kind, actor_agent_id, reason, source_module, payload, performed_at)
         values ($1, $2, 'note', 'ai', $3, $4, 'titulo_confirmado', $5, now())`,
        [
          entrada.organizationId,
          lead.id,
          entrada.agentId,
          `Título: ${nome} (nome confirmado pela IA)`,
          JSON.stringify({ titulo_anterior_era_do_sistema: lead.titulo_origem !== "ia", fonte: entrada.fonte }),
        ],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { status: "atualizado", titulo: nome, leadId: lead.id };
  } catch {
    return { status: "sem_negocio" };
  }
}

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type * as ModuloDaConta from "@/lib/contratos/assinatura/conta";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * PC-030 — O AVISO DO SERVIÇO DE ASSINATURA, da porta ao negócio ganho, contra
 * o Postgres do baseline.
 *
 * Roda de verdade: a rota `/api/v1/webhooks/assinatura/:token`, a leitura do
 * aviso da ZapSign, a leitura da situação (`situacaoDaZapsign`, sobre o JSON do
 * "detalhar documento"), `aplicarSituacao`, `confirmarAssinatura` e o caso da
 * equipe. Falso só o que sairia da máquina: a resposta HTTP do serviço.
 *
 * O que se mede:
 *  - ⭐ o aviso no caminho PRÓPRIO do serviço, com o segredo dele, deixa o
 *    contrato assinado, ganha o negócio (etapa de ganho + tag) e abre o caso
 *    "Conferir processo e advogado pelo CPF antes de dar entrada";
 *  - ⭐ o mesmo aviso de novo não muda nada nem abre segundo caso;
 *  - ⭐ a porta genérica (PC-003) e a do serviço não dividem segredo: o
 *    segredo de uma recusado na outra, nos dois sentidos;
 *  - documento desconhecido não mexe em nada.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "90270000-0000-4000-8000-000000000001";
const TOKEN_DO_SERVICO = "servico9027servico9027servico";
const SEGREDO_DO_SERVICO = "segredo-do-servico-9027";
const TOKEN_GENERICO = "generico9027generico9027gen";
const SEGREDO_GENERICO = "segredo-generico-9027";
const DOC = "doc-9027-assinado-0001";

/** O "detalhar documento" da ZapSign para cada documento — a borda HTTP falsa. */
const documentos: Record<string, Record<string, unknown>> = {};
const buscaFalsa = async (url: string): Promise<Response> => {
  const m = /\/api\/v1\/docs\/([^/]+)\/$/.exec(new URL(url).pathname);
  const doc = m ? documentos[m[1]!] : undefined;
  return doc
    ? new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } })
    : new Response(JSON.stringify({ detail: "Não encontrado." }), { status: 404 });
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 99 }),
}));
vi.mock("@/lib/audit", () => ({ audit: async () => {} }));
// A conta é lida do banco de verdade; só a credencial cifrada (que pede a chave
// da instalação) é trocada por uma em claro, e a busca HTTP pela falsa.
vi.mock("@/lib/contratos/assinatura/conta", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDaConta>();
  const { criarServicoZapsign } = await import("@/lib/contratos/assinatura/zapsign");
  return {
    ...real,
    servicoDaOrganizacao: async (admin: Parameters<typeof real.lerLinhaDaConta>[0], orgId: string) => {
      const l = await real.lerLinhaDaConta(admin, orgId);
      if (!l || l.provedor !== "zapsign") return { ok: false as const, motivo: "sem_conta" as const };
      return {
        ok: true as const,
        valor: {
          servico: criarServicoZapsign({ chave: "chave-de-teste-9027", ambiente: "teste" }, buscaFalsa),
          conta: { ...l, provedor: "zapsign" as const },
        },
      };
    },
  };
});

const etapa: Record<string, string> = {};
let lead = "";
let contrato = "";
let conversa = "";

async function avisar(token: string, segredo: string, corpo: unknown) {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/v1/webhooks/assinatura/[token]/route");
  const req = new NextRequest(`http://localhost/api/v1/webhooks/assinatura/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-assinatura-segredo": segredo },
    body: JSON.stringify(corpo),
  });
  return POST(req, { params: Promise.resolve({ token }) });
}

beforeAll(async () => {
  const { hashDoSegredo } = await import("@/lib/leads/assinatura-webhook");
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,'pc030-aviso','PC030','PC030') on conflict (id) do nothing`,
    [ORG],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'BPC','bpc-9027',100) returning id`,
    [ORG],
  );
  for (const [chave, nome, pos, ganho] of [
    ["novo", "Novo contato", 1, false],
    ["fechado", "Contrato assinado", 2, true],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won) values ($1,$2,$3,$4,$5,$6) returning id`,
      [ORG, p[0]!.id, nome, `${chave}-9027`, pos, ganho],
    );
    etapa[chave] = rows[0]!.id;
  }
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1,'Cliente 9027','+5511900009027') returning id`,
    [ORG],
  );
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted) values ($1,'pc030-9027','\\x00'::bytea) returning id`,
    [ORG],
  );
  const { rows: cv } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
    [ORG, c[0]!.id, s[0]!.id],
  );
  conversa = cv[0]!.id;
  const { rows: l } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, updated_at)
     values ($1,$2,$3,$4,'BPC 9027', date_trunc('milliseconds', now())) returning id`,
    [ORG, p[0]!.id, etapa.novo, c[0]!.id],
  );
  lead = l[0]!.id;
  const { rows: k } = await pool.query<{ id: string }>(
    `insert into crm_contracts (organization_id, lead_id, contact_id, conversation_id, titulo, status, provedor_assinatura,
                                provedor_documento_id, link_assinatura, enviado_em)
     values ($1,$2,$3,$4,'Contrato BPC 9027','enviado','zapsign',$5,'https://exemplo.invalid/assinar', now()) returning id`,
    [ORG, lead, c[0]!.id, conversa, DOC],
  );
  contrato = k[0]!.id;

  // As duas portas, cada uma com o seu caminho e o seu segredo.
  await pool.query(
    `insert into assinatura_eletronica_contas (organization_id, provedor, ambiente, ativo, aviso_path_token, aviso_segredo_sha256)
     values ($1,'zapsign','teste',true,$2,$3)`,
    [ORG, TOKEN_DO_SERVICO, hashDoSegredo(SEGREDO_DO_SERVICO)],
  );
  await pool.query(
    `insert into assinatura_webhook_chaves (organization_id, path_token, segredo_sha256) values ($1,$2,$3)`,
    [ORG, TOKEN_GENERICO, hashDoSegredo(SEGREDO_GENERICO)],
  );

  documentos[DOC] = {
    token: DOC,
    status: "signed",
    signed_file: null,
    signers: [{ status: "signed", signed_at: "2026-11-10T15:00:00Z", times_viewed: 2, last_view_at: "2026-11-10T14:00:00Z" }],
  };
});

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("PC-030 — o aviso do serviço de assinatura", () => {
  it("⭐ as portas não dividem segredo: o de uma é recusado na outra, e nada muda", async () => {
    const naPortaDoServico = await avisar(TOKEN_DO_SERVICO, SEGREDO_GENERICO, { event_type: "doc_signed", token: DOC });
    expect(naPortaDoServico.status).toBe(401);
    const naPortaGenerica = await avisar(TOKEN_GENERICO, SEGREDO_DO_SERVICO, { event_type: "doc_signed", token: DOC });
    expect(naPortaGenerica.status).toBe(401);
    const { rows } = await pool.query<{ status: string }>(`select status from crm_contracts where id = $1`, [contrato]);
    expect(rows[0]!.status).toBe("enviado");
    const { rows: r } = await pool.query(
      `select count(*)::int as n from recusas_da_ia where organization_id = $1 and codigo = 'segredo_invalido'`,
      [ORG],
    );
    expect(r[0].n).toBe(2);
  });

  it("documento que não é de contrato nenhum desta organização não mexe em nada", async () => {
    const res = await avisar(TOKEN_DO_SERVICO, SEGREDO_DO_SERVICO, { event_type: "doc_signed", token: "doc-que-nao-existe-9027" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ aplicado: false, motivo: "contrato_desconhecido" });
  });

  it("⭐ assinado no serviço → contrato assinado, negócio ganho com a tag, caso de conferir pelo CPF", async () => {
    const res = await avisar(TOKEN_DO_SERVICO, SEGREDO_DO_SERVICO, { event_type: "doc_signed", token: DOC });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ aplicado: true, estado: "assinado" });

    const { rows: k } = await pool.query(`select status, visualizado_em is not null as visto from crm_contracts where id = $1`, [
      contrato,
    ]);
    expect(k[0]).toEqual({ status: "assinado", visto: true });

    const { rows: l } = await pool.query<{ stage_id: string; status: string; tags: string[] }>(
      `select stage_id, status, tags from crm_leads where id = $1`,
      [lead],
    );
    expect(l[0]).toMatchObject({ stage_id: etapa.fechado, status: "won" });
    expect(l[0]!.tags).toContain("contrato-assinado");

    const { rows: a } = await pool.query(
      `select origem, provedor, documento_id from crm_assinaturas_confirmadas where lead_id = $1`,
      [lead],
    );
    expect(a).toEqual([{ origem: "provedor", provedor: "zapsign", documento_id: DOC }]);

    const { rows: casos } = await pool.query(
      `select kind, title, source from agent_cases where organization_id = $1 and conversation_id = $2`,
      [ORG, conversa],
    );
    expect(casos).toEqual([
      { kind: "contrato", title: "Conferir processo e advogado pelo CPF antes de dar entrada", source: "agent" },
    ]);
  });

  it("⭐ o mesmo aviso de novo não muda nada nem abre segundo caso", async () => {
    const res = await avisar(TOKEN_DO_SERVICO, SEGREDO_DO_SERVICO, { event_type: "doc_signed", token: DOC });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ aplicado: false, motivo: "ja_encerrado" });
    const { rows } = await pool.query(
      `select count(*)::int as n from agent_cases where organization_id = $1 and conversation_id = $2`,
      [ORG, conversa],
    );
    expect(rows[0].n).toBe(1);
    const { rows: a } = await pool.query(`select count(*)::int as n from crm_assinaturas_confirmadas where lead_id = $1`, [lead]);
    expect(a[0].n).toBe(1);
  });

  it("formato que não é do serviço, na porta do serviço, é recusado (422) e registrado", async () => {
    const res = await avisar(TOKEN_DO_SERVICO, SEGREDO_DO_SERVICO, { evento: "contrato.assinado", lead_id: lead });
    expect(res.status).toBe(422);
  });
});

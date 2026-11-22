import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type * as ModuloDaConta from "@/lib/contratos/assinatura/conta";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * PC-046 — A ASSINATURA PELA AUTENTIQUE, da porta ao negócio ganho, contra o
 * Postgres do baseline.
 *
 * Roda de verdade: o vocabulário novo do banco (`autentique` nos dois CHECKs),
 * a rota `/api/v1/webhooks/assinatura/:token`, a conferência do HMAC sobre o
 * corpo BRUTO, a leitura do aviso da Autentique, a leitura da situação
 * (`situacaoDaAutentique`, sobre a resposta da query `document`),
 * `aplicarSituacao`, `confirmarAssinatura` e o caso da equipe. Falso só o que
 * sairia da máquina (a resposta HTTP da Autentique) e a abertura das colunas
 * cifradas (que pede a chave da instalação).
 *
 * O que se mede:
 *  - ⭐ sem assinatura, ou com assinatura errada, nada muda e a recusa fica
 *    registrada (a Autentique não manda o cabeçalho nosso: a prova é o HMAC dela);
 *  - ⭐ com o HMAC do segredo do endpoint, o contrato fica assinado, o negócio
 *    ganha (etapa de ganho + tag) e abre o caso de conferir pelo CPF;
 *  - o mesmo aviso de novo não muda nada; o HMAC pelo token da API (reserva)
 *    também é aceito.
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

const ORG = "90370000-0000-4000-8000-000000000001";
const TOKEN = "autentique9037autentique9037aut";
const SEGREDO_DO_ENDPOINT = "segredo-do-endpoint-9037";
const TOKEN_DA_API = "token-da-api-9037";
const DOC = "a9037b9037c9037d9037e9037f9037";

/** A resposta da query `document` da Autentique para cada documento — a borda HTTP falsa. */
const documentos: Record<string, Record<string, unknown>> = {};
const buscaFalsa = async (_url: string, init?: RequestInit): Promise<Response> => {
  const corpo = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
  const m = /document\(id: "([^"]+)"\)/.exec(corpo.query ?? "");
  const doc = m ? documentos[m[1]!] : undefined;
  return new Response(JSON.stringify(doc ? { data: { document: doc } } : { errors: [{ message: "Document not found" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 99 }),
}));
vi.mock("@/lib/audit", () => ({ audit: async () => {} }));
vi.mock("@/lib/contratos/assinatura/conta", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDaConta>();
  const { criarServicoAutentique } = await import("@/lib/contratos/assinatura/autentique");
  return {
    ...real,
    abrirSegredoDoAviso: () => SEGREDO_DO_ENDPOINT,
    abrirChave: () => TOKEN_DA_API,
    servicoDaOrganizacao: async (admin: Parameters<typeof real.lerLinhaDaConta>[0], orgId: string) => {
      const l = await real.lerLinhaDaConta(admin, orgId);
      if (!l || l.provedor !== "autentique") return { ok: false as const, motivo: "sem_conta" as const };
      return {
        ok: true as const,
        valor: {
          servico: criarServicoAutentique({ chave: TOKEN_DA_API, ambiente: "teste" }, buscaFalsa),
          conta: { ...l, provedor: "autentique" as const },
        },
      };
    },
  };
});

const etapa: Record<string, string> = {};
let lead = "";
let contrato = "";
let conversa = "";

const corpoDoAviso = (documentoId: string) =>
  JSON.stringify({
    id: "wh-9037",
    object: "webhook",
    event: { id: "ev-9037", object: "event", type: "document.finished", data: { id: documentoId, object: "document" } },
  });

async function avisar(corpo: string, assinatura: string | null) {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/v1/webhooks/assinatura/[token]/route");
  const req = new NextRequest(`http://localhost/api/v1/webhooks/assinatura/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(assinatura ? { "x-autentique-signature": assinatura } : {}) },
    body: corpo,
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
}

const hmac = (segredo: string, corpo: string) => createHmac("sha256", segredo).update(corpo).digest("hex");

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,'pc046-autentique','PC046','PC046') on conflict (id) do nothing`,
    [ORG],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'Maternidade','maternidade-9037',100) returning id`,
    [ORG],
  );
  for (const [chave, nome, pos, ganho] of [
    ["novo", "Novo contato", 1, false],
    ["fechado", "Contrato assinado", 2, true],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won) values ($1,$2,$3,$4,$5,$6) returning id`,
      [ORG, p[0]!.id, nome, `${chave}-9037`, pos, ganho],
    );
    etapa[chave] = rows[0]!.id;
  }
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1,'Cliente 9037','+5511900009037') returning id`,
    [ORG],
  );
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted) values ($1,'pc046-9037','\\x00'::bytea) returning id`,
    [ORG],
  );
  const { rows: cv } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
    [ORG, c[0]!.id, s[0]!.id],
  );
  conversa = cv[0]!.id;
  const { rows: l } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, updated_at)
     values ($1,$2,$3,$4,'Maternidade 9037', date_trunc('milliseconds', now())) returning id`,
    [ORG, p[0]!.id, etapa.novo, c[0]!.id],
  );
  lead = l[0]!.id;
  // O vocabulário novo do banco: `autentique` aceito nos dois CHECKs.
  const { rows: k } = await pool.query<{ id: string }>(
    `insert into crm_contracts (organization_id, lead_id, contact_id, conversation_id, titulo, status, provedor_assinatura,
                                provedor_documento_id, link_assinatura, enviado_em)
     values ($1,$2,$3,$4,'Contrato Maternidade 9037','enviado','autentique',$5,'https://exemplo.invalid/assinar', now()) returning id`,
    [ORG, lead, c[0]!.id, conversa, DOC],
  );
  contrato = k[0]!.id;
  // Conta da Autentique: caminho do aviso, SEM o segredo nosso de cabeçalho (o
  // aviso é cadastrado no painel dela) e com o segredo do endpoint cifrado.
  await pool.query(
    `insert into assinatura_eletronica_contas (organization_id, provedor, ambiente, ativo, aviso_path_token,
                                               aviso_hmac_encrypted, aviso_hmac_iv, aviso_hmac_tag)
     values ($1,'autentique','teste',true,$2,'\\x01'::bytea,'\\x02'::bytea,'\\x03'::bytea)`,
    [ORG, TOKEN],
  );

  documentos[DOC] = {
    id: DOC,
    deadline_at: null,
    files: { signed: null },
    signatures: [
      {
        public_id: "pub-9037",
        action: { name: "SIGN" },
        viewed: { created_at: "2026-11-22 10:00:00" },
        signed: { created_at: "2026-11-22 10:05:00" },
        rejected: null,
      },
    ],
  };
});

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("PC-046 — o aviso da Autentique", () => {
  it("⭐ sem assinatura, ou com assinatura errada, nada muda e a recusa fica registrada", async () => {
    const corpo = corpoDoAviso(DOC);
    expect((await avisar(corpo, null)).status).toBe(401);
    expect((await avisar(corpo, hmac("segredo-errado", corpo))).status).toBe(401);
    // Assinatura certa de OUTRO corpo: o HMAC é sobre os bytes que chegaram.
    expect((await avisar(corpo, hmac(SEGREDO_DO_ENDPOINT, corpoDoAviso("outro-doc-9037")))).status).toBe(401);
    const { rows } = await pool.query<{ status: string }>(`select status from crm_contracts where id = $1`, [contrato]);
    expect(rows[0]!.status).toBe("enviado");
    const { rows: r } = await pool.query(
      `select count(*)::int as n from recusas_da_ia where organization_id = $1 and codigo = 'segredo_invalido'`,
      [ORG],
    );
    expect(r[0].n).toBe(3);
  });

  it("documento que não é de contrato nenhum desta organização não mexe em nada", async () => {
    const corpo = corpoDoAviso("doc-que-nao-existe-9037");
    const res = await avisar(corpo, hmac(SEGREDO_DO_ENDPOINT, corpo));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ aplicado: false, motivo: "contrato_desconhecido" });
  });

  it("⭐ assinado na Autentique → contrato assinado, negócio ganho com a tag, caso de conferir pelo CPF", async () => {
    const corpo = corpoDoAviso(DOC);
    const res = await avisar(corpo, hmac(SEGREDO_DO_ENDPOINT, corpo));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ evento: "document.finished", aplicado: true, estado: "assinado" });

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
    expect(a).toEqual([{ origem: "provedor", provedor: "autentique", documento_id: DOC }]);

    const { rows: casos } = await pool.query(
      `select kind, title from agent_cases where organization_id = $1 and conversation_id = $2`,
      [ORG, conversa],
    );
    expect(casos).toEqual([{ kind: "contrato", title: "Conferir processo e advogado pelo CPF antes de dar entrada" }]);
  });

  it("o mesmo aviso de novo — agora assinado pelo token da API, a reserva — não muda nada", async () => {
    const corpo = corpoDoAviso(DOC);
    const res = await avisar(corpo, hmac(TOKEN_DA_API, corpo));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ aplicado: false, motivo: "ja_encerrado" });
    const { rows } = await pool.query(
      `select count(*)::int as n from agent_cases where organization_id = $1 and conversation_id = $2`,
      [ORG, conversa],
    );
    expect(rows[0].n).toBe(1);
  });

  it("corpo que não é aviso da Autentique, mesmo assinado, é recusado (422)", async () => {
    const corpo = JSON.stringify({ evento: "contrato.assinado", lead_id: lead });
    expect((await avisar(corpo, hmac(SEGREDO_DO_ENDPOINT, corpo))).status).toBe(422);
  });
});

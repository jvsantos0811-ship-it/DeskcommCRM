import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * PC-030 (item 4) — A IA ENVIA O CONTRATO, contra o Postgres do baseline.
 *
 * Roda de verdade: `enviarContratoPelaIa` (negócio ativo, regra, contrato vivo,
 * caso, janela, tag), `levarParaAnaliseHumana` (com `moveLeadHandler`) e o
 * caso da equipe. Dublês só no que sai da máquina ou pede a chave da
 * instalação: o serviço de assinatura (conta), a geração do PDF e o envio pelo
 * WhatsApp.
 *
 *  - ⭐ "já tem advogado ou processo?" = SIM → não gera, devolve para a equipe;
 *  - sem NÃO confirmado, ou fora da etapa → não gera, e diz o que fazer;
 *  - ⭐ aprovação da equipe LIGADA → caso "Contrato pronto para aprovar", nada sai;
 *  - ⭐ desligada → envia, o negócio ganha a tag `contrato-enviado`;
 *  - contrato já enviado → não manda outro;
 *  - ⭐ "Análise humana" tira o card de "Aguardando assinatura" (para trás).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "90271a00-0000-4000-8000-000000000001";
const etapa: Record<string, string> = {};
let pipeline = "";
let contato = "";
let conversa = "";
let lead = "";
const conta = { aprovacao_da_equipe: false };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db }));
vi.mock("@/lib/audit", () => ({ audit: async () => {} }));
vi.mock("@/lib/contratos/assinatura/conta", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    servicoDaOrganizacao: async () => ({
      ok: true,
      valor: { servico: {}, conta: { provedor: "zapsign", prazo_para_assinar_dias: 7, aprovacao_da_equipe: conta.aprovacao_da_equipe } },
    }),
  };
});
// A geração do PDF (storage) e o envio pelo WhatsApp: dublês que gravam no banco
// o mesmo que os de verdade gravam.
vi.mock("@/lib/contratos/gerar-do-modelo", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    gerarContratoDoModelo: async (_admin: unknown, a: { orgId: string; leadId: string }) => {
      const { rows } = await pool.query(
        `insert into crm_contracts (organization_id, lead_id, contact_id, titulo, provedor_assinatura, origem_envio, arquivo_path)
         values ($1, $2, $3, 'Contrato BPC', 'zapsign', 'ia', $4) returning *`,
        [a.orgId, a.leadId, contato, `${a.orgId}/x.pdf`],
      );
      return { ok: true, contrato: rows[0], modelo: { id: "m", versao: 1 }, cpf: null };
    },
  };
});
vi.mock("@/lib/contratos/enviar", () => ({
  enviarContrato: async (_admin: unknown, e: { orgId: string; contratoId: string }) => {
    await pool.query(`update crm_contracts set status = 'enviado', enviado_em = now() where id = $1`, [e.contratoId]);
    return { ok: true, enviado: true, contrato: { id: e.contratoId } };
  },
}));

async function preparar(campos: Record<string, unknown>, status: Record<string, string>, etapaAtual = "aguardando") {
  await pool.query(`delete from crm_contracts where organization_id = $1`, [ORG]);
  await pool.query(`delete from agent_case_events where organization_id = $1`, [ORG]);
  await pool.query(`delete from agent_cases where organization_id = $1`, [ORG]);
  // Os gatilhos do negócio desligados SÓ nesta preparação: o `updated_at` fica
  // em milissegundos (a trava otimista do move compara com o Date do JS).
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(
      `update crm_leads set stage_id = $2, custom_fields = $3::jsonb, status_dos_campos = $4::jsonb, tags = '{}',
              updated_at = date_trunc('milliseconds', now())
        where id = $1`,
      [lead, etapa[etapaAtual], JSON.stringify(campos), JSON.stringify(status)],
    );
    await c.query("commit");
  } finally {
    c.release();
  }
}

async function enviar() {
  const { enviarContratoPelaIa } = await import("@/lib/contratos/enviar-pela-ia");
  return enviarContratoPelaIa(db as never, {
    orgId: ORG,
    contactId: contato,
    conversationId: conversa,
    agentId: null,
    requestId: "req-9027-ia",
  });
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, 'pc030-ia', 'PC030 IA', 'PC030 IA') on conflict (id) do nothing`,
    [ORG],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position, is_default) values ($1, 'BPC', 'bpc-ia-9027', 100, false) returning id`,
    [ORG],
  );
  pipeline = p[0]!.id;
  for (const [chave, nome, pos, ganho] of [
    ["novo", "Novo contato", 1, false],
    ["analise", "Análise humana", 2, false],
    ["aguardando", "Aguardando assinatura", 3, false],
    ["ganho", "Contrato assinado", 4, true],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won) values ($1,$2,$3,$4,$5,$6) returning id`,
      [ORG, pipeline, nome, `${chave}-ia-9027`, pos, ganho],
    );
    etapa[chave] = rows[0]!.id;
  }
  await pool.query(`update crm_pipelines set settings = $2::jsonb where id = $1`, [
    pipeline,
    JSON.stringify({
      etapa_do_contrato: etapa.aguardando,
      etapa_quando_equipe_assume: etapa.analise,
      fields: [{ key: "ja_tem_advogado_ou_processo", label: "Já tem advogado ou processo?", type: "text", com_status: true }],
    }),
  ]);
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, 'Cliente IA 9027', '+5511900009127') returning id`,
    [ORG],
  );
  contato = c[0]!.id;
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted) values ($1, 'pc030-ia', '\\x00'::bytea) returning id`,
    [ORG],
  );
  const { rows: cv } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, last_inbound_at) values ($1, $2, $3, now()) returning id`,
    [ORG, contato, s[0]!.id],
  );
  conversa = cv[0]!.id;
  const { rows: l } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title) values ($1, $2, $3, $4, 'BPC IA') returning id`,
    [ORG, pipeline, etapa.aguardando, contato],
  );
  lead = l[0]!.id;
});

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

beforeEach(() => {
  conta.aprovacao_da_equipe = false;
});

const NAO = { ja_tem_advogado_ou_processo: "não" };
const CONFIRMADO = { ja_tem_advogado_ou_processo: "CONFIRMADO" };

describe("PC-030 — a IA envia o contrato", () => {
  it("⭐ já tem advogado ou processo (SIM) → não gera, volta para a equipe", async () => {
    await preparar({ ja_tem_advogado_ou_processo: "sim" }, CONFIRMADO);
    const r = await enviar();
    expect(r).toMatchObject({ status: "tem_advogado_ou_processo", leadId: lead });
    const { rows } = await pool.query(`select count(*)::int as n from crm_contracts where organization_id = $1`, [ORG]);
    expect(rows[0].n).toBe(0);
  });

  it("sem NÃO confirmado → não gera, e manda perguntar", async () => {
    await preparar({ ja_tem_advogado_ou_processo: "não" }, {});
    const r = await enviar();
    expect(r).toMatchObject({ status: "recusado", motivo: "falta_conferir_advogado" });
  });

  it("fora da etapa configurada → não gera", async () => {
    await preparar(NAO, CONFIRMADO, "novo");
    const r = await enviar();
    expect(r).toMatchObject({ status: "recusado", motivo: "fora_da_etapa" });
  });

  it("⭐ aprovação da equipe LIGADA → caso 'Contrato pronto para aprovar', nada sai; pedir de novo não duplica", async () => {
    conta.aprovacao_da_equipe = true;
    await preparar(NAO, CONFIRMADO);
    const r = await enviar();
    expect(r.status).toBe("aguardando_aprovacao");
    const { rows: k } = await pool.query(`select status, origem_envio from crm_contracts where organization_id = $1`, [ORG]);
    expect(k).toEqual([{ status: "rascunho", origem_envio: "ia" }]);
    const { rows: casos } = await pool.query(`select title, kind from agent_cases where organization_id = $1`, [ORG]);
    expect(casos).toEqual([{ title: "Contrato pronto para aprovar", kind: "contrato" }]);

    const de_novo = await enviar();
    expect(de_novo.status).toBe("aguardando_aprovacao");
    const { rows: n } = await pool.query(`select count(*)::int as n from crm_contracts where organization_id = $1`, [ORG]);
    expect(n[0].n).toBe(1);
  });

  it("⭐ aprovação desligada (o padrão) → envia e o negócio ganha a tag contrato-enviado", async () => {
    await preparar(NAO, CONFIRMADO);
    const r = await enviar();
    expect(r).toMatchObject({ status: "enviado", leadId: lead });
    const { rows } = await pool.query<{ tags: string[] }>(`select tags from crm_leads where id = $1`, [lead]);
    expect(rows[0]!.tags).toContain("contrato-enviado");
  });

  it("contrato já enviado → não manda outro", async () => {
    // continua do caso anterior: há um contrato enviado.
    const r = await enviar();
    expect(r.status).toBe("ja_enviado");
    const { rows } = await pool.query(`select count(*)::int as n from crm_contracts where organization_id = $1`, [ORG]);
    expect(rows[0].n).toBe(1);
  });

  it("⭐ 'Análise humana' tira o card de 'Aguardando assinatura' (para trás), nunca de um ganho", async () => {
    const { levarParaAnaliseHumana } = await import("@/lib/contratos/analise-humana");
    await preparar(NAO, CONFIRMADO, "aguardando");
    const r = await levarParaAnaliseHumana(db as never, {
      orgId: ORG,
      leadId: lead,
      motivo: 'Cliente questionou o contrato: "não concordo com a cláusula"',
      requestId: "req-analise",
    });
    expect(r).toEqual({ moveu: true, etapa: etapa.analise });
    const { rows } = await pool.query<{ stage_id: string }>(`select stage_id from crm_leads where id = $1`, [lead]);
    expect(rows[0]!.stage_id).toBe(etapa.analise);

    await preparar(NAO, CONFIRMADO, "ganho");
    const g = await levarParaAnaliseHumana(db as never, { orgId: ORG, leadId: lead, motivo: "x", requestId: "req-ganho" });
    expect(g.moveu).toBe(false);
  });
});

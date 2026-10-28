import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { pgComoSupabase } from "../pg-como-supabase";
import { lastLine, sql } from "./gov-helpers";

/**
 * PC-003 — A TRAVA DE ETAPA E DE GANHO PARA A IA, contra o Postgres do baseline.
 *
 * O código que decide roda de verdade (`moveLeadHandler`, a ferramenta MCP
 * `crm_close_demand`, `confirmarAssinatura`, a rota do aviso de assinatura, o
 * bloco do turno); o transporte é `pgComoSupabase` (sem PostgREST, sem RLS —
 * o isolamento entre organizações é medido em `rls-isolation.test.ts`, onde
 * `recusas_da_ia` e `crm_assinaturas_confirmadas` entraram em `TABLES`, e aqui
 * para a tabela só do servidor `assinatura_webhook_chaves`).
 *
 * Um caso por critério do pedido (A1–A10).
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

// A rota do aviso de assinatura usa o cliente de serviço, a régua de ritmo e a
// auditoria: o cliente vira o MESMO adaptador sobre o Postgres do teste; ritmo
// e auditoria não são o que se mede aqui.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 99 }),
}));
vi.mock("@/lib/audit", () => ({ audit: async () => {} }));

const ORG = "9011aaaa-0000-4000-8000-000000000001";
const ORG_B = "9011aaaa-0000-4000-8000-000000000002";
const AGENTE = "9011aaaa-0000-4000-8000-0000000000a1";
const VERSAO = "9011aaaa-0000-4000-8000-0000000000a2";
const AGENTE_LIVRE = "9011aaaa-0000-4000-8000-0000000000b1";
const VERSAO_LIVRE = "9011aaaa-0000-4000-8000-0000000000b2";

let pipeline = "";
const etapa: Record<string, string> = {};
let contato = "";
let leadDeB = "";

function ctxDaIa(agentId = AGENTE): HandlerCtx {
  return {
    organization_id: ORG,
    actor: { type: "ai_agent", id: "run-9011", role: "ai_operator", agent_id: agentId },
    requestId: "req-9011",
    serviceOrigin: { kind: "unavailable", reason: "origin_capture_failed" },
  };
}

async function novoLead(titulo: string, campos: Record<string, unknown> = {}, status: Record<string, string> = {}) {
  const { rows } = await pool.query<{ id: string }>(
    // `updated_at` em milissegundos: o move usa trava otimista por `updated_at`,
    // e o Date do JS (ms) não casaria com o microssegundo do Postgres.
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, custom_fields, status_dos_campos, updated_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb, date_trunc('milliseconds', now())) returning id`,
    [ORG, pipeline, etapa.novo, contato, titulo, JSON.stringify(campos), JSON.stringify(status)],
  );
  return rows[0]!.id;
}

async function etapaDo(leadId: string): Promise<string> {
  const { rows } = await pool.query<{ stage_id: string }>(`select stage_id from crm_leads where id = $1`, [leadId]);
  return rows[0]!.stage_id;
}

async function recusas(leadId: string) {
  const { rows } = await pool.query<{
    tipo: string;
    ferramenta: string;
    codigo: string;
    agent_id: string | null;
    agent_version_id: string | null;
    campos_faltantes: Array<{ chave: string }>;
  }>(
    `select tipo, ferramenta, codigo, agent_id, agent_version_id, campos_faltantes
       from recusas_da_ia where organization_id = $1 and lead_id = $2 order by created_at`,
    [ORG, leadId],
  );
  return rows;
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "pc003-a"],
    [ORG_B, "pc003-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1,$2,'PC003','PC003')
       on conflict (id) do nothing`,
      [id, slug],
    );
  }
  const settings = {
    fields: [
      {
        key: "categoria",
        label: "Categoria na data",
        type: "text",
        com_status: true,
        obrigatorio_em: { etapas: [] as string[] },
      },
      { key: "data_acidente", label: "Data do acidente", type: "date", obrigatorio_em: { etapas: [] as string[] } },
    ],
  };
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'Auxílio','auxilio-9011',100) returning id`,
    [ORG],
  );
  pipeline = p[0]!.id;
  const etapas: Array<[string, string, number, string]> = [
    ["novo", "Novo contato", 1, ""],
    ["qualificado", "Qualificado", 2, ""],
    ["proposta", "Proposta", 3, ""],
    ["fechado", "Fechado", 4, "won"],
    ["perdido", "Perdido", 5, "lost"],
  ];
  for (const [chave, nome, pos, fim] of etapas) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost, so_pessoa_move)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [ORG, pipeline, nome, `${chave}-9011`, pos, fim === "won", fim === "lost", chave === "proposta"],
    );
    etapa[chave] = rows[0]!.id;
  }
  // As duas regras de campo exigem a etapa "Qualificado".
  settings.fields[0]!.obrigatorio_em.etapas = [etapa.qualificado!];
  settings.fields[1]!.obrigatorio_em.etapas = [etapa.qualificado!];
  await pool.query(`update crm_pipelines set settings = $2::jsonb where id = $1`, [pipeline, JSON.stringify(settings)]);

  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1,'Cliente 9011','+5511900009011') returning id`,
    [ORG],
  );
  contato = c[0]!.id;

  // Agente CONSERVADOR (publicado) e agente LIVRE (publicado).
  for (const [ag, ve, conservador] of [
    [AGENTE, VERSAO, true],
    [AGENTE_LIVRE, VERSAO_LIVRE, false],
  ] as const) {
    await pool.query(
      `insert into ai_agents (id, organization_id, name, system_prompt) values ($1,$2,'Agente 9011 ' || $3,'s') on conflict (id) do nothing`,
      [ag, ORG, conservador ? "conservador" : "livre"],
    );
    await pool.query(
      `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model, status, modo_conservador)
       values ($1,$2,$3,1,'s','anthropic','claude-sonnet-4-6','published',$4) on conflict (id) do nothing`,
      [ve, ORG, ag, conservador],
    );
    await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [ve, ag]);
  }

  // Um negócio da OUTRA organização (para A7/A9).
  const { rows: pb } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'B','b-9011',100) returning id`,
    [ORG_B],
  );
  const { rows: sb } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1,$2,'E','e-9011',1) returning id`,
    [ORG_B, pb[0]!.id],
  );
  const { rows: lb } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,'Negócio de B') returning id`,
    [ORG_B, pb[0]!.id, sb[0]!.id],
  );
  leadDeB = lb[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, ORG_B]]);
  await pool.end();
});

describe("PC-003 — a IA não move etapa com campo obrigatório vazio", () => {
  it("⭐ A1: campo vazio → recusado, com a etapa e os campos na frase; card parado; recusa registrada", async () => {
    const { moveLeadHandler } = await import("@/app/api/v1/leads/_handler");
    const lead = await novoLead("A1");
    await expect(moveLeadHandler(db, ctxDaIa(AGENTE_LIVRE), lead, { to_stage_id: etapa.qualificado! })).rejects.toMatchObject({
      status: 422,
      code: "required_fields_missing",
      message: expect.stringContaining('Não dá para mover para "Qualificado": faltam os campos Categoria na data, Data do acidente.'),
    });
    expect(await etapaDo(lead)).toBe(etapa.novo);
    const r = await recusas(lead);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      tipo: "etapa_recusada",
      ferramenta: "crm_move_lead_stage",
      codigo: "required_fields_missing",
      agent_id: AGENTE_LIVRE,
      agent_version_id: VERSAO_LIVRE,
    });
    expect(r[0]!.campos_faltantes.map((c) => c.chave)).toEqual(["categoria", "data_acidente"]);
  });

  it.each(["NAO_SABE", "CONTRADITORIO", "PENDENTE"])(
    "⭐ A3: status %s no campo de qualificação → recusado mesmo com o dado escrito",
    async (status) => {
      const { moveLeadHandler } = await import("@/app/api/v1/leads/_handler");
      const lead = await novoLead(`A3-${status}`, { categoria: "empregado", data_acidente: "2026-01-10" }, { categoria: status });
      await expect(moveLeadHandler(db, ctxDaIa(AGENTE_LIVRE), lead, { to_stage_id: etapa.qualificado! })).rejects.toMatchObject({
        code: "required_fields_missing",
        message: expect.stringContaining("faltam os campos Categoria na data."),
      });
      expect(await etapaDo(lead)).toBe(etapa.novo);
    },
  );

  it.each(["CONFIRMADO", "NEGADO", "NAO_SE_APLICA"])("⭐ A2: status %s + campos preenchidos → aceito", async (status) => {
    const { moveLeadHandler } = await import("@/app/api/v1/leads/_handler");
    const lead = await novoLead(`A2-${status}`, { data_acidente: "2026-01-10" }, { categoria: status });
    await moveLeadHandler(db, ctxDaIa(AGENTE_LIVRE), lead, { to_stage_id: etapa.qualificado! });
    expect(await etapaDo(lead)).toBe(etapa.qualificado);
    expect(await recusas(lead)).toEqual([]);
  });

  it("controle: PESSOA movendo segue a régua de sempre (o dado, sem olhar o status)", async () => {
    const { moveLeadHandler } = await import("@/app/api/v1/leads/_handler");
    const lead = await novoLead("humano", { categoria: "empregado", data_acidente: "2026-01-10" }, { categoria: "NAO_SABE" });
    const ctxPessoa: HandlerCtx = {
      organization_id: ORG,
      actor: { type: "automation" as never, id: "x" } as never,
      requestId: "r",
      serviceOrigin: { kind: "unavailable", reason: "origin_capture_failed" },
    };
    ctxPessoa.actor = { type: "webhook_source", id: "teste" };
    await moveLeadHandler(db, ctxPessoa, lead, { to_stage_id: etapa.qualificado! });
    expect(await etapaDo(lead)).toBe(etapa.qualificado);
  });
});

describe("PC-003 — ganho só por evento", () => {
  it("⭐ A4: a IA levando o card à etapa de ganho → recusado sempre", async () => {
    const { moveLeadHandler } = await import("@/app/api/v1/leads/_handler");
    const lead = await novoLead("A4", { data_acidente: "2026-01-10" }, { categoria: "CONFIRMADO" });
    await expect(moveLeadHandler(db, ctxDaIa(AGENTE_LIVRE), lead, { to_stage_id: etapa.fechado! })).rejects.toMatchObject({
      code: "ganho_so_por_assinatura",
    });
    expect(await etapaDo(lead)).toBe(etapa.novo);
    expect((await recusas(lead))[0]).toMatchObject({ tipo: "ganho_recusado", codigo: "ganho_so_por_assinatura" });
  });

  it("⭐ A4: `crm_close_demand` com ganho, chamado pela IA → recusado; o status não muda", async () => {
    const { crmCloseDemand } = await import("@/lib/mcp/tools/retencao");
    const lead = await novoLead("A4-close");
    const r = await crmCloseDemand.handler({ lead_id: lead, outcome: "won" } as never, {
      supabase: db,
      organizationId: ORG,
      actor: { type: "ai_agent", id: "run", role: "ai_operator", agent_id: AGENTE_LIVRE },
      requestId: "r",
      role: "ai_operator",
    } as never);
    expect(r).toMatchObject({ encerrado: false, motivo: "ganho_so_por_assinatura" });
    const { rows } = await pool.query<{ status: string }>(`select status from crm_leads where id = $1`, [lead]);
    expect(rows[0]!.status).toBe("open");
    expect((await recusas(lead))[0]).toMatchObject({ tipo: "ganho_recusado", ferramenta: "crm_close_demand" });
  });

  it("⭐ A6: pessoa gerente confirma a assinatura → Fechado, tag, data e quem registrou", async () => {
    const { confirmarAssinatura } = await import("@/lib/leads/assinatura-confirmada");
    const lead = await novoLead("A6");
    const { rows: u } = await pool.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'gerente-9011@invariant.test') returning id`,
    );
    const gerente = u[0]!.id;
    await confirmarAssinatura(
      db,
      { organization_id: ORG, actor: { type: "user", id: gerente }, requestId: "r6" },
      { leadId: lead, dataAssinatura: "2026-10-27", origem: "pessoa", registradoPorUserId: gerente },
    );
    const { rows } = await pool.query<{ stage_id: string; status: string; tags: string[] }>(
      `select stage_id, status, tags from crm_leads where id = $1`,
      [lead],
    );
    expect(rows[0]).toMatchObject({ stage_id: etapa.fechado, status: "won" });
    expect(rows[0]!.tags).toContain("contrato-assinado");
    const { rows: a } = await pool.query(
      `select origem, data_assinatura::text, registrado_por_user_id from crm_assinaturas_confirmadas where lead_id = $1`,
      [lead],
    );
    expect(a).toEqual([{ origem: "pessoa", data_assinatura: "2026-10-27", registrado_por_user_id: gerente }]);
  });

  describe("A7: aviso `contrato.assinado` de provedor", () => {
    const TOKEN = "tok9011tok9011tok9011tok";
    const SEGREDO = "segredo-certo-9011";

    beforeAll(async () => {
      const { hashDoSegredo } = await import("@/lib/leads/assinatura-webhook");
      await pool.query(
        `insert into assinatura_webhook_chaves (organization_id, path_token, segredo_sha256) values ($1,$2,$3)`,
        [ORG, TOKEN, hashDoSegredo(SEGREDO)],
      );
    });

    async function avisar(segredo: string, corpo: Record<string, unknown>) {
      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/api/v1/webhooks/assinatura/[token]/route");
      const req = new NextRequest(`http://localhost/api/v1/webhooks/assinatura/${TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-assinatura-segredo": segredo },
        body: JSON.stringify(corpo),
      });
      return POST(req, { params: Promise.resolve({ token: TOKEN }) });
    }

    it("⭐ válido (segredo e organização certos) → mesmo efeito de A6, com origem provedor", async () => {
      const lead = await novoLead("A7");
      const res = await avisar(SEGREDO, {
        evento: "contrato.assinado",
        lead_id: lead,
        data_assinatura: "2026-10-26",
        provedor: "zapsign",
        documento_id: "doc-1",
      });
      expect(res.status).toBe(200);
      const { rows } = await pool.query<{ stage_id: string; status: string; tags: string[] }>(
        `select stage_id, status, tags from crm_leads where id = $1`,
        [lead],
      );
      expect(rows[0]).toMatchObject({ stage_id: etapa.fechado, status: "won" });
      expect(rows[0]!.tags).toContain("contrato-assinado");
      const { rows: a } = await pool.query(
        `select origem, provedor, documento_id, data_assinatura::text from crm_assinaturas_confirmadas where lead_id = $1`,
        [lead],
      );
      expect(a).toEqual([{ origem: "provedor", provedor: "zapsign", documento_id: "doc-1", data_assinatura: "2026-10-26" }]);
    });

    it("⭐ segredo errado → ignorado (401), nada muda, recusa registrada", async () => {
      const lead = await novoLead("A7-segredo");
      const res = await avisar("segredo-errado", { evento: "contrato.assinado", lead_id: lead });
      expect(res.status).toBe(401);
      expect(await etapaDo(lead)).toBe(etapa.novo);
      const { rows } = await pool.query(
        `select codigo from recusas_da_ia where organization_id = $1 and tipo = 'assinatura_recusada' and codigo = 'segredo_invalido'`,
        [ORG],
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it("⭐ negócio de OUTRA organização → ignorado, nada muda lá, recusa registrada", async () => {
      const res = await avisar(SEGREDO, { evento: "contrato.assinado", lead_id: leadDeB });
      expect(res.status).toBe(404);
      const { rows } = await pool.query<{ status: string }>(`select status from crm_leads where id = $1`, [leadDeB]);
      expect(rows[0]!.status).toBe("open");
      const { rows: r } = await pool.query(
        `select 1 from recusas_da_ia where organization_id = $1 and codigo = 'negocio_de_outra_organizacao'`,
        [ORG],
      );
      expect(r.length).toBe(1);
    });
  });
});

describe("PC-003 — modo conservador", () => {
  it("⭐ A8: agente conservador + etapa 'só pessoa move' → recusado com frase clara", async () => {
    const { moveLeadHandler } = await import("@/app/api/v1/leads/_handler");
    const lead = await novoLead("A8");
    await expect(moveLeadHandler(db, ctxDaIa(AGENTE), lead, { to_stage_id: etapa.proposta! })).rejects.toMatchObject({
      code: "etapa_so_pessoa_move",
      message: expect.stringContaining('Não dá para mover para "Proposta": neste atendimento só uma pessoa da equipe move'),
    });
    expect(await etapaDo(lead)).toBe(etapa.novo);
    expect((await recusas(lead))[0]).toMatchObject({ codigo: "etapa_so_pessoa_move", agent_version_id: VERSAO });
  });

  it("controle: agente SEM modo conservador move para a mesma etapa", async () => {
    const { moveLeadHandler } = await import("@/app/api/v1/leads/_handler");
    const lead = await novoLead("A8-livre");
    await moveLeadHandler(db, ctxDaIa(AGENTE_LIVRE), lead, { to_stage_id: etapa.proposta! });
    expect(await etapaDo(lead)).toBe(etapa.proposta);
  });
});

describe("PC-003 — a chave de update_lead_state (A5)", () => {
  it("⭐ versão NOVA nasce desligada; a ordem da migration mantém ligadas as versões que já existiam", async () => {
    const { rows } = await pool.query<{ estado_do_funil_ligado: boolean }>(
      `insert into ai_agent_versions (organization_id, agent_id, version_number, system_prompt, provider, model)
       values ($1,$2,2,'s','anthropic','claude-sonnet-4-6') returning estado_do_funil_ligado`,
      [ORG, AGENTE_LIVRE],
    );
    expect(rows[0]!.estado_do_funil_ligado).toBe(false);
    // O mesmo par de comandos da migration 9011, numa tabela com linhas
    // ANTERIORES: elas ficam ligadas, as novas nascem desligadas.
    expect(
      lastLine(sql(`
        create temp table versoes_9011 (id int);
        insert into versoes_9011 values (1), (2);
        alter table versoes_9011 add column if not exists estado_do_funil_ligado boolean not null default true;
        alter table versoes_9011 alter column estado_do_funil_ligado set default false;
        insert into versoes_9011 (id) values (3);
        select string_agg(id || ':' || estado_do_funil_ligado, ',' order by id) from versoes_9011;
      `)),
    ).toBe("1:true,2:true,3:false");
  });
});

describe("PC-003 — o texto do turno inclui os campos com status (A10)", () => {
  it("⭐ nome: status — dado, para os campos de qualificação do negócio aberto do contato", async () => {
    const { blocoDosCamposDoNegocio } = await import("@/lib/agent-engine/agent/campos-do-negocio-no-turno");
    // Contato novo com UM negócio aberto (o resolvedor exige não-ambíguo).
    const { rows: c } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, name, phone_number) values ($1,'Cliente A10','+5511900009012') returning id`,
      [ORG],
    );
    await pool.query(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, custom_fields, status_dos_campos)
       values ($1,$2,$3,$4,'A10','{"categoria":"Segurado empregado"}','{"categoria":"CONFIRMADO"}')`,
      [ORG, pipeline, etapa.novo, c[0]!.id],
    );
    const bloco = await blocoDosCamposDoNegocio(pool, ORG, c[0]!.id);
    expect(bloco).toContain("## Campos do negócio (etapa atual: Novo contato)");
    expect(bloco).toContain("- Categoria na data: CONFIRMADO — Segurado empregado");
    expect(bloco).toContain("- Data do acidente: (vazio)");
  });
});

describe("PC-003 — isolamento (A9)", () => {
  it("⭐ a chave do aviso de assinatura é só do servidor: anon e authenticated não leem nem escrevem", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(sql(`select has_table_privilege('${role}', 'public.assinatura_webhook_chaves', '${priv}')`)).toBe("f");
      }
    }
    expect(sql("select relrowsecurity from pg_class where oid = 'public.assinatura_webhook_chaves'::regclass")).toBe("t");
    // E por JWT real de um membro de cada organização: permission denied.
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000099"}', false);
        select count(*) from public.assinatura_webhook_chaves;`),
    ).toThrow();
  });

  it("⭐ recusas e assinaturas de uma organização não aparecem para a outra (filtro do servidor)", async () => {
    const { rows } = await pool.query(
      `select count(*)::int as n from recusas_da_ia where organization_id = $1`,
      [ORG_B],
    );
    expect(rows[0]).toEqual({ n: 0 });
    const { rows: a } = await pool.query(
      `select count(*)::int as n from crm_assinaturas_confirmadas where organization_id = $1`,
      [ORG_B],
    );
    expect(a[0]).toEqual({ n: 0 });
  });
});

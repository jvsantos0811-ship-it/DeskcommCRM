/**
 * O CONTRATO DO NEGÓCIO (fork, migration 9008 — item 7 do briefing de 26/10/2026).
 *
 * Contra o que o `baseline.sql` instala de verdade:
 *
 *   1. o bucket `contratos` é privado, só aceita PDF e para em 20 MB;
 *   2. ⭐ a sessão (`authenticated`) só LÊ — criar, enviar e decidir são do
 *      servidor, pelas rotas de sessão `agent`+; `anon` não vê nada;
 *   3. os CHECKs recusam status e provedor fora do vocabulário, e título vazio;
 *   4. ⭐ a trava de organização recusa negócio, contato, conversa e mensagem
 *      de OUTRA organização — o servidor escreve com service_role, que ignora RLS;
 *   5. ⭐ a virada de `is_anonymized` manda os arquivos do contato (original e
 *      via assinada) para a fila de expurgo do bucket `contratos` e tira o texto
 *      que nomeia a pessoa; status e datas ficam; o contrato do VIZINHO e um
 *      caminho apontando para outra organização não são tocados;
 *   6. apagar o negócio não apaga o contrato (documento sobrevive ao card);
 *   7. as funções novas fechadas para `anon` e `authenticated`.
 *
 * O isolamento entre organizações pela RLS está em `rls-isolation.test.ts`, e a
 * decisão LGPD da tabela, em `lgpd-redact-unificado-alcanca-pelo-catalogo.test.ts`.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = randomUUID();
const OUTRA = randomUUID();

interface Cenario {
  pipeline: string;
  stage: string;
  sessao: string;
}
const cenario: Record<string, Cenario> = {};

async function seedOrg(org: string, nome: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1::uuid, $1::text, $2, $2)`,
    [org, nome],
  );
  const pipeline = randomUUID();
  const stage = randomUUID();
  const sessao = randomUUID();
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values ($1, $2, 'Funil', $3)`,
    [pipeline, org, `funil-${pipeline.slice(0, 8)}`],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1, $2, $3, 'Etapa', $4, 1000)`,
    [stage, org, pipeline, `etapa-${stage.slice(0, 8)}`],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1, $2, $3, '\\x00'::bytea)`,
    [sessao, org, `contratos-${sessao.slice(0, 8)}`],
  );
  cenario[org] = { pipeline, stage, sessao };
}

async function contato(org: string, nome = "Maria Prudente Ramos"): Promise<string> {
  const id = randomUUID();
  await pool.query(`insert into contacts (id, organization_id, name, display_name) values ($1, $2, $3, $3)`, [
    id,
    org,
    nome,
  ]);
  return id;
}

async function negocio(org: string, contatoId: string): Promise<string> {
  const id = randomUUID();
  const c = cenario[org]!;
  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id) values ($1, $2, $3, $4, 'Negócio', $5)`,
    [id, org, c.pipeline, c.stage, contatoId],
  );
  return id;
}

async function contrato(
  org: string,
  campos: { lead?: string | null; contato?: string | null; arquivo?: string | null; assinado?: string | null; status?: string },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into crm_contracts (id, organization_id, lead_id, contact_id, titulo, arquivo_path, arquivo_nome, assinado_path, status, enviado_em, motivo, link_assinatura)
     values ($1, $2, $3, $4, 'Contrato de honorários - Maria Prudente', $5, 'contrato-maria.pdf', $6, $7,
             case when $7 = 'rascunho' then null else now() end, 'Cliente Maria pediu ajuste', 'https://assinar.exemplo/maria')`,
    [id, org, campos.lead ?? null, campos.contato ?? null, campos.arquivo ?? null, campos.assinado ?? null, campos.status ?? "rascunho"],
  );
  return id;
}

async function naFila(caminho: string): Promise<number> {
  const r = await pool.query(
    `select count(*)::int as n from storage_redaction_queue where bucket = 'contratos' and object_path = $1 and status = 'pending'`,
    [caminho],
  );
  return r.rows[0].n as number;
}

async function codigoDoErro(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string; message?: string }).code ?? "erro";
  }
}

beforeAll(async () => {
  await seedOrg(ORG, "Contratos A");
  await seedOrg(OUTRA, "Contratos B");
});

afterAll(async () => {
  await pool.query("delete from storage_redaction_queue where organization_id = any($1::uuid[])", [[ORG, OUTRA]]);
  await pool.query("delete from organizations where id = any($1::uuid[])", [[ORG, OUTRA]]);
  await pool.end();
});

describe("contrato do negócio — o que o baseline instala", () => {
  it("o bucket `contratos` é privado, só PDF, até 20 MB", async () => {
    const r = await pool.query(
      `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'contratos'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].public).toBe(false);
    expect(Number(r.rows[0].file_size_limit)).toBe(20 * 1024 * 1024);
    expect(r.rows[0].allowed_mime_types).toEqual(["application/pdf"]);
  });

  it("⭐ a sessão só LÊ; anon não tem nada — a escrita é do servidor", async () => {
    const r = await pool.query(
      `select grantee, string_agg(privilege_type, ',' order by privilege_type) as p
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'crm_contracts'
          and grantee in ('anon', 'authenticated', 'PUBLIC')
        group by grantee order by grantee`,
    );
    expect(r.rows).toEqual([{ grantee: "authenticated", p: "SELECT" }]);
    const rls = await pool.query(`select relrowsecurity from pg_class where oid = 'public.crm_contracts'::regclass`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });

  it("os CHECKs recusam status e provedor fora do vocabulário, e título vazio", async () => {
    expect(
      await codigoDoErro(() =>
        pool.query(`insert into crm_contracts (organization_id, titulo, status) values ($1, 'x', 'aprovado')`, [ORG]),
      ),
    ).toBe("23514");
    expect(
      await codigoDoErro(() =>
        pool.query(`insert into crm_contracts (organization_id, titulo, provedor_assinatura) values ($1, 'x', 'zapsign')`, [ORG]),
      ),
    ).toBe("23514");
    expect(
      await codigoDoErro(() => pool.query(`insert into crm_contracts (organization_id, titulo) values ($1, '   ')`, [ORG])),
    ).toBe("23514");
  });

  it("⭐ a trava de organização recusa negócio, contato e conversa de OUTRA organização", async () => {
    const contatoAlheio = await contato(OUTRA);
    const negocioAlheio = await negocio(OUTRA, contatoAlheio);
    const conversaAlheia = randomUUID();
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id) values ($1, $2, $3, $4)`,
      [conversaAlheia, OUTRA, contatoAlheio, cenario[OUTRA]!.sessao],
    );

    for (const [coluna, valor] of [
      ["lead_id", negocioAlheio],
      ["contact_id", contatoAlheio],
      ["conversation_id", conversaAlheia],
    ] as const) {
      const erro = await pool
        .query(`insert into crm_contracts (organization_id, titulo, ${coluna}) values ($1, 'x', $2)`, [ORG, valor])
        .then(() => null)
        .catch((e: { code?: string; message?: string }) => `${e.code}:${e.message}`);
      expect(erro, coluna).toMatch(/^23514:crm_contract_\w+_org_mismatch$/);
    }

    // controle positivo: o MESMO insert com o negócio da própria organização passa.
    const meu = await negocio(ORG, await contato(ORG));
    await expect(
      pool.query(`insert into crm_contracts (organization_id, titulo, lead_id) values ($1, 'x', $2)`, [ORG, meu]),
    ).resolves.toBeTruthy();
  });

  it("⭐ anonimizar o contato manda os PDFs dele para a fila de expurgo e tira o texto que o nomeia", async () => {
    const alvo = await contato(ORG);
    const vizinho = await contato(ORG);
    const leadAlvo = await negocio(ORG, alvo);
    const leadVizinho = await negocio(ORG, vizinho);

    const c1 = randomUUID();
    const original1 = `${ORG}/${c1}.pdf`;
    const assinado1 = `${ORG}/${c1}-assinado.pdf`;
    const k1 = await contrato(ORG, { lead: leadAlvo, contato: alvo, arquivo: original1, assinado: assinado1, status: "assinado" });
    const original2 = `${ORG}/${randomUUID()}.pdf`;
    const k2 = await contrato(ORG, { lead: leadAlvo, contato: alvo, arquivo: original2, status: "enviado" });
    // Caminho gravado apontando para OUTRA organização: o expurgo não confia na linha.
    const alheio = `${OUTRA}/${randomUUID()}.pdf`;
    await contrato(ORG, { lead: leadAlvo, contato: alvo, arquivo: alheio });
    const originalVizinho = `${ORG}/${randomUUID()}.pdf`;
    const kv = await contrato(ORG, { lead: leadVizinho, contato: vizinho, arquivo: originalVizinho });

    // ANTES (controle): nada na fila.
    expect(await naFila(original1)).toBe(0);

    await pool.query(`update contacts set is_anonymized = true, anonymized_at = now() where id = $1`, [alvo]);

    expect(await naFila(original1)).toBe(1);
    expect(await naFila(assinado1)).toBe(1);
    expect(await naFila(original2)).toBe(1);
    expect(await naFila(alheio)).toBe(0);
    expect(await naFila(originalVizinho)).toBe(0);

    const r = await pool.query(
      `select id, titulo, arquivo_path, arquivo_nome, assinado_path, motivo, link_assinatura, status, enviado_em
         from crm_contracts where id = any($1::uuid[])`,
      [[k1, k2, kv]],
    );
    const porId = new Map(r.rows.map((l) => [l.id as string, l]));
    for (const k of [k1, k2]) {
      const l = porId.get(k)!;
      expect(l.titulo).toBe("Contrato (anonimizado)");
      expect([l.arquivo_path, l.arquivo_nome, l.assinado_path, l.motivo, l.link_assinatura]).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
    }
    // status e datas ficam: dizem que houve um contrato, não de quem.
    expect(porId.get(k1)!.status).toBe("assinado");
    expect(porId.get(k2)!.enviado_em).not.toBeNull();
    // o vizinho não perde nada.
    expect(porId.get(kv)!.titulo).toBe("Contrato de honorários - Maria Prudente");
    expect(porId.get(kv)!.arquivo_path).toBe(originalVizinho);
  });

  it("apagar o negócio não apaga o contrato — o documento sobrevive ao card", async () => {
    const c = await contato(ORG);
    const lead = await negocio(ORG, c);
    const k = await contrato(ORG, { lead, contato: c, arquivo: `${ORG}/${randomUUID()}.pdf`, status: "enviado" });
    await pool.query(`delete from crm_leads where id = $1`, [lead]);
    const r = await pool.query(`select lead_id, status from crm_contracts where id = $1`, [k]);
    expect(r.rows).toEqual([{ lead_id: null, status: "enviado" }]);
  });

  it("as funções novas não são executáveis por anon nem por authenticated", async () => {
    const r = await pool.query(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('fn_redigir_contratos_ao_anonimizar', 'fn_crm_contracts_org_consistente')
        order by 1`,
    );
    expect(r.rows).toEqual([
      { proname: "fn_crm_contracts_org_consistente", anon: false, auth: false },
      { proname: "fn_redigir_contratos_ao_anonimizar", anon: false, auth: false },
    ]);
  });
});

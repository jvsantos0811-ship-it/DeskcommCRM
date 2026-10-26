/**
 * O `remove_tag` CONTRA O POSTGRES (fork, migration 9006).
 *
 * O unitário (`lib/automation/actions/remove-tag.test.ts`) mede o que a ação
 * faz com a resposta da função num banco de mentira. Aqui é a função de
 * verdade, aplicada pelo `baseline.sql`:
 *
 *   1. ⭐ a TROCA de trimestre com um `add_tag` concorrente: dois eventos do
 *      mesmo negócio em dois drenos — um põe `2o-trimestre` e SEGURA a linha, o
 *      outro tira `1o-trimestre` e tem de ESPERAR. Se a remoção fosse ler,
 *      filtrar e regravar no aplicativo (o que `crm_manage_tags` ainda faz), ela
 *      gravaria a foto que leu e apagaria o `2o-trimestre` sem erro nenhum;
 *   2. comparação sem maiúsculas nem espaços nas pontas, ordem preservada;
 *   3. linha de outra organização: nulo, nada tocado;
 *   4. as duas origens de EXECUTE fechadas para `anon` e `authenticated`.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/register-all";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
afterAll(() => pool.end());

type Resultado = { data: unknown; error: { message: string } | null };

const FUNCOES_DE_ETIQUETA = new Set([
  "fn_lead_adicionar_etiquetas",
  "fn_contato_adicionar_etiquetas",
  "fn_lead_remover_etiquetas",
  "fn_contato_remover_etiquetas",
]);

/** O suficiente do client admin, PRESO a uma transação — o commit é do teste. */
function adminDaTransacao(client: pg.PoolClient): ActionCtx["admin"] {
  return {
    rpc: async (nome: string, params: Record<string, unknown>): Promise<Resultado> => {
      try {
        if (FUNCOES_DE_ETIQUETA.has(nome)) {
          const id = String(nome.startsWith("fn_lead_") ? params.p_lead : params.p_contato);
          const r = await client.query(`select public.${nome}($1::uuid, $2::uuid, $3::text[]) as resposta;`, [
            params.p_org,
            id,
            params.p_etiquetas,
          ]);
          return { data: r.rows[0].resposta, error: null };
        }
        if (nome === "emit_event") {
          await client.query(
            `select public.emit_event($1::text, $2::text, $3::uuid, $4::jsonb, $5::jsonb, $6::uuid);`,
            [
              params.p_event_type,
              params.p_entity_kind,
              params.p_entity_id,
              JSON.stringify(params.p_payload ?? {}),
              JSON.stringify(params.p_metadata ?? {}),
              params.p_organization_id,
            ],
          );
          return { data: null, error: null };
        }
        throw new Error(`dublê: rpc desconhecida ${nome}`);
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },
  } as unknown as ActionCtx["admin"];
}

async function fixture(etiquetasDoNegocio: string[]) {
  const org = randomUUID();
  const pipeline = randomUUID();
  const stage = randomUUID();
  const lead = randomUUID();
  const contato = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'RemoveTag','RemoveTag')",
    [org],
  );
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1::uuid,$2,'Funil',$1::text)", [
    pipeline,
    org,
  ]);
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Entrada','entrada',1)",
    [stage, org, pipeline],
  );
  await pool.query("insert into contacts(id,organization_id,display_name,tags) values($1,$2,'Contato','{}')", [
    contato,
    org,
  ]);
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title,contact_id,tags) values($1,$2,$3,$4,'Negócio',$5,$6)",
    [lead, org, pipeline, stage, contato, etiquetasDoNegocio],
  );
  return { org, lead, contato };
}

function evento(f: { org: string }, client: pg.PoolClient, contexto: Record<string, unknown>): ActionCtx {
  const regra = randomUUID();
  return {
    admin: adminDaTransacao(client),
    organizationId: f.org,
    ruleId: regra,
    ruleName: regra,
    event: { id: randomUUID() } as unknown as EventRow,
    requestId: `rule:${regra}`,
    context: contexto,
  } as ActionCtx;
}

const tagsDoNegocio = async (id: string) =>
  (await pool.query("select tags from crm_leads where id=$1", [id])).rows[0].tags as string[];

async function esperandoTrava(observer: pg.PoolClient, pid: number) {
  await expect
    .poll(
      async () =>
        (await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]
          ?.wait_event_type === "Lock",
      { timeout: 5000, interval: 20 },
    )
    .toBe(true);
}

describe("remove_tag contra o Postgres", () => {
  it("⭐ troca de trimestre com um add_tag concorrente: nenhuma das duas mudanças se perde", async () => {
    const f = await fixture(["vip", "1o-trimestre"]);
    const a = await pool.connect();
    const b = await pool.connect();
    const observer = await pool.connect();
    const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
    try {
      await a.query("begin; set local statement_timeout='10s'");
      await b.query("begin; set local statement_timeout='10s'");
      const foto = () => ({ lead: { id: f.lead, contact_id: f.contato, tags: ["vip", "1o-trimestre"] } });

      // A põe a etiqueta nova e SEGURA a linha.
      await getAction("add_tag")!.execute(evento(f, a, foto()), { tags: ["2o-trimestre"] });

      // B tira a antiga: tem de esperar A, e não passar por cima com a foto que leu.
      const pendenteB = getAction("remove_tag")!.execute(evento(f, b, foto()), { tags: ["1o-trimestre"] });
      await esperandoTrava(observer, bpid);

      await a.query("commit");
      const resultadoB = await pendenteB;
      await b.query("commit");

      expect(await tagsDoNegocio(f.lead)).toEqual(["vip", "2o-trimestre"]);
      expect(resultadoB).toMatchObject({ status: "success", detail: { removed: ["1o-trimestre"] } });
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
      observer.release();
    }
  });

  it("compara sem maiúsculas nem espaços nas pontas, e preserva a ordem do que fica", async () => {
    const f = await fixture(["vip", "1o-Trimestre", "gestante"]);
    const r = await pool.query("select public.fn_lead_remover_etiquetas($1, $2, $3::text[]) as j", [
      f.org,
      f.lead,
      [" 1O-TRIMESTRE "],
    ]);
    expect(r.rows[0].j).toEqual({ tags: ["vip", "gestante"], removidas: ["1o-Trimestre"] });
    expect(await tagsDoNegocio(f.lead)).toEqual(["vip", "gestante"]);
  });

  it("negócio de OUTRA organização: nulo, e nada é tocado", async () => {
    const f = await fixture(["vip"]);
    const outra = await fixture([]);
    const r = await pool.query("select public.fn_lead_remover_etiquetas($1, $2, $3::text[]) as j", [
      outra.org,
      f.lead,
      ["vip"],
    ]);
    expect(r.rows[0].j).toBeNull();
    expect(await tagsDoNegocio(f.lead)).toEqual(["vip"]);
  });

  it("EXECUTE fechado para anon e authenticated, aberto só para service_role", async () => {
    for (const fn of ["fn_lead_remover_etiquetas", "fn_contato_remover_etiquetas"]) {
      const assinatura = `public.${fn}(uuid,uuid,text[])`;
      const r = await pool.query(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc`,
        [assinatura],
      );
      expect(r.rows[0]).toEqual({ anon: false, auth: false, svc: true });
    }
  });
});

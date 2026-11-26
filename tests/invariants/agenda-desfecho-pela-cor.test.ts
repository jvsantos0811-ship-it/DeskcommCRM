import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * PC-062 (migration 9046) — O DESFECHO PELA COR DO GOOGLE TEM UMA PORTA SÓ.
 *
 * O desfecho (`completed` / `no_show`) é declaração humana (migration 0224): o
 * carimbo recusa quem não é pessoa da equipe. A exceção da cor do Google mora
 * em `fn_appointment_outcome_from_google` e precisa continuar estreita:
 *  - só sem sessão de usuário (service_role), e o PostgREST não a expõe a
 *    anon nem a authenticated;
 *  - só com a cor daquele desfecho configurada no tipo do compromisso;
 *  - só depois do início;
 *  - a autoria fica `google_color`, sem usuário;
 *  - fora dela, o service_role continua sem conseguir gravar desfecho.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
const org = randomUUID();
const user = randomUUID();
const tipoComCor = randomUUID();
const tipoSemCor = randomUUID();

async function asRole(role: "anon" | "authenticated" | "service_role", sub: string | null, query: string, values: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role, aal: "aal1", ...(sub ? { sub } : {}) }),
    ]);
    const result = await client.query(query, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Desfecho cor','Desfecho cor')",
    [org],
  );
  await pool.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@invariant.test`]);
  await pool.query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",
    [user, org],
  );
  await pool.query(
    "insert into calendar_event_types(id,organization_id,name,slug,outcome_color_completed,outcome_color_no_show) values($1,$2,'Ligação','ligacao-cor','9','8')",
    [tipoComCor, org],
  );
  await pool.query(
    "insert into calendar_event_types(id,organization_id,name,slug) values($1,$2,'Sem cor','sem-cor')",
    [tipoSemCor, org],
  );
});
afterAll(() => pool.end());

async function compromisso(tipo: string, inicio: string, noGoogle = true) {
  const id = randomUUID();
  await pool.query(
    `insert into calendar_appointments(id,organization_id,event_type_id,title,starts_at,ends_at,status,google_event_id)
     values($1,$2,$3,'Desfecho cor',${inicio},${inicio}+interval '40 minutes','confirmed',$4)`,
    [id, org, tipo, noGoogle ? `evt${id.replace(/-/g, "")}` : null],
  );
  return id;
}

const porta = "select fn_appointment_outcome_from_google($1,$2,1,$3) r";

describe("desfecho pela cor do Google (PC-062)", () => {
  it("service_role com a cor configurada grava o desfecho com autoria google_color", async () => {
    const id = await compromisso(tipoComCor, "now()-interval '2 hours'");
    await asRole("service_role", null, porta, [org, id, "completed"]);
    const { rows } = await pool.query(
      "select status, outcome_source_kind, outcome_user_id, outcome_recorded_at from calendar_appointments where id=$1",
      [id],
    );
    expect(rows[0]).toMatchObject({ status: "completed", outcome_source_kind: "google_color", outcome_user_id: null });
    expect(rows[0].outcome_recorded_at).not.toBeNull();
  });

  it("a marca da transação volta ao valor anterior depois da porta", async () => {
    const id = await compromisso(tipoComCor, "now()-interval '2 hours'");
    const { rows } = await asRole(
      "service_role",
      null,
      "select fn_appointment_outcome_from_google($1,$2,1,'no_show') is not null as ok, coalesce(current_setting('deskcomm.desfecho_pelo_google', true),'') as marca",
      [org, id],
    );
    expect(rows[0]).toMatchObject({ ok: true, marca: "" });
  });

  it("compromisso que não está no Google: recusa", async () => {
    const id = await compromisso(tipoComCor, "now()-interval '2 hours'", false);
    await expect(asRole("service_role", null, porta, [org, id, "completed"])).rejects.toThrow(/google_outcome_sem_evento/);
  });

  it("tipo sem a cor daquele desfecho: recusa", async () => {
    const id = await compromisso(tipoSemCor, "now()-interval '2 hours'");
    await expect(asRole("service_role", null, porta, [org, id, "no_show"])).rejects.toThrow(/google_outcome_off/);
  });

  it("antes do início: recusa", async () => {
    const id = await compromisso(tipoComCor, "now()+interval '2 hours'");
    await expect(asRole("service_role", null, porta, [org, id, "no_show"])).rejects.toThrow(/appointment_not_started/);
  });

  it("anon e authenticated não alcançam a porta", async () => {
    const id = await compromisso(tipoComCor, "now()-interval '2 hours'");
    await expect(asRole("authenticated", user, porta, [org, id, "completed"])).rejects.toThrow(/permission denied/);
    await expect(asRole("anon", null, porta, [org, id, "completed"])).rejects.toThrow(/permission denied/);
  });

  it("fora da porta, o service_role continua sem gravar desfecho", async () => {
    const id = await compromisso(tipoComCor, "now()-interval '2 hours'");
    await expect(
      asRole("service_role", null, "select fn_appointment_change($1,$2,1,$3) r", [org, id, { status: "no_show" }]),
    ).rejects.toThrow(/appointment_human_confirmation_required/);
  });

  it("a constraint recusa cor da presença e as duas cores iguais", async () => {
    await expect(
      pool.query("update calendar_event_types set outcome_color_completed='10' where id=$1", [tipoSemCor]),
    ).rejects.toThrow(/outcome_colors_check/);
    await expect(
      pool.query("update calendar_event_types set outcome_color_completed='9', outcome_color_no_show='9' where id=$1", [tipoSemCor]),
    ).rejects.toThrow(/outcome_colors_check/);
  });
});

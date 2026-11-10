/**
 * A EQUIPE QUE ASSUME RESPONDENDO CANCELA AS AGENDADAS DA CONVERSA
 * (fork, migration 9026 — PC-029).
 *
 * `fn_cancelar_agendadas_da_conversa(org, conversa)` é chamada pelo servidor
 * quando uma pessoa da equipe responde (tela ou celular) e quando alguém clica
 * em "Assumir". Contra a função de verdade, aplicada pelo `baseline.sql`:
 *
 *   1. ⭐ cancela as `scheduled` DAQUELA conversa, devolve quantas, e deixa uma
 *      nota por mensagem assinada "Sistema" (a mesma frase da passagem, 9007);
 *   2. `sending`, `sent`, a conversa vizinha e OUTRA organização não são tocadas
 *      — a organização errada no parâmetro não alcança nada;
 *   3. a organização em espanhol recebe a nota em espanhol, no fuso dela;
 *   4. ⭐ falha dentro da função não sobe e não deixa cancelamento sem nota;
 *   5. só `service_role` executa; a coluna do responsável do número existe e
 *      solta a pessoa que sai da equipe (`on delete set null`).
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_PT = randomUUID();
const ORG_ES = randomUUID();
const SESSAO_PT = randomUUID();
const SESSAO_ES = randomUUID();

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone, locale) values
       ($1::uuid, $1::text, 'Equipe PT', 'Equipe PT', 'America/Sao_Paulo', 'pt-BR'),
       ($2::uuid, $2::text, 'Equipe ES', 'Equipe ES', 'America/Mexico_City', 'es-MX')`,
    [ORG_PT, ORG_ES],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
       ($1, $2, 'equipe-pt', '\\x00'::bytea), ($3, $4, 'equipe-es', '\\x00'::bytea)`,
    [SESSAO_PT, ORG_PT, SESSAO_ES, ORG_ES],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1::uuid[])", [[ORG_PT, ORG_ES]]);
  await pool.end();
});

async function conversa(org: string, sessao: string) {
  const contato = randomUUID();
  const id = randomUUID();
  await pool.query(
    "insert into contacts (id, organization_id, display_name) values ($1, $2, 'Cliente')",
    [contato, org],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status)
     values ($1, $2, $3, $4, 'open')`,
    [id, org, contato, sessao],
  );
  return { id, contato, org };
}

async function agendar(
  c: { id: string; org: string },
  body: string,
  sendAt: string,
  status = "scheduled",
) {
  const id = randomUUID();
  await pool.query(
    `insert into scheduled_messages (id, organization_id, conversation_id, body, send_at, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, c.org, c.id, body, sendAt, status],
  );
  return id;
}

const cancelar = async (org: string, conversaId: string) =>
  (
    await pool.query("select public.fn_cancelar_agendadas_da_conversa($1, $2) as n", [
      org,
      conversaId,
    ])
  ).rows[0].n as number;

const estado = async (id: string) =>
  (await pool.query("select status, cancelled_at from scheduled_messages where id = $1", [id]))
    .rows[0] as {
    status: string;
    cancelled_at: Date | null;
  };

const notas = async (conversaId: string) =>
  (
    await pool.query(
      "select body, created_by_name, created_by_user_id from conversation_notes where conversation_id = $1 order by body",
      [conversaId],
    )
  ).rows as Array<{ body: string; created_by_name: string; created_by_user_id: string | null }>;

describe("a equipe assumiu × mensagens agendadas (migration 9026)", () => {
  it("⭐ cancela as agendadas da conversa, devolve quantas e deixa uma nota por mensagem", async () => {
    const c = await conversa(ORG_PT, SESSAO_PT);
    const vizinha = await conversa(ORG_PT, SESSAO_PT);
    const link = await agendar(
      c,
      "Te mando o link amanhã às 9h, combinado?",
      "2026-11-12T12:00:00Z",
    );
    const outra = await agendar(c, "Lembrete do documento", "2026-11-13T15:30:00Z");
    const saindo = await agendar(c, "já saindo", "2026-11-10T01:00:00Z", "sending");
    const foi = await agendar(c, "já foi", "2026-11-09T01:00:00Z", "sent");
    const daVizinha = await agendar(vizinha, "da vizinha", "2026-11-12T12:00:00Z");

    expect(await cancelar(ORG_PT, c.id)).toBe(2);

    expect((await estado(link)).status).toBe("cancelled");
    expect((await estado(link)).cancelled_at).not.toBeNull();
    expect((await estado(outra)).status).toBe("cancelled");
    expect((await estado(saindo)).status).toBe("sending");
    expect((await estado(foi)).status).toBe("sent");
    expect((await estado(daVizinha)).status).toBe("scheduled");

    const n = await notas(c.id);
    expect(n).toHaveLength(2);
    expect(n.every((x) => x.created_by_name === "Sistema" && x.created_by_user_id === null)).toBe(
      true,
    );
    // 12:00 UTC = 09:00 em São Paulo.
    expect(n.map((x) => x.body).join("\n")).toContain("Ela sairia em 12/11 às 09:00");
    expect(n.map((x) => x.body).join("\n")).toContain(
      'Texto: "Te mando o link amanhã às 9h, combinado?"',
    );
    expect(await notas(vizinha.id)).toHaveLength(0);

    // Chamar de novo não repete nota (não sobrou nada em `scheduled`).
    expect(await cancelar(ORG_PT, c.id)).toBe(0);
    expect(await notas(c.id)).toHaveLength(2);
  });

  it("organização errada no parâmetro não alcança a conversa de outra", async () => {
    const c = await conversa(ORG_PT, SESSAO_PT);
    const id = await agendar(c, "não é sua", "2026-11-12T12:00:00Z");
    expect(await cancelar(ORG_ES, c.id)).toBe(0);
    expect((await estado(id)).status).toBe("scheduled");
    expect(await notas(c.id)).toHaveLength(0);
  });

  it("organização em espanhol recebe a nota em espanhol, no fuso dela", async () => {
    const c = await conversa(ORG_ES, SESSAO_ES);
    await agendar(c, "Hola, le escribo mañana", "2026-11-12T18:00:00Z");
    expect(await cancelar(ORG_ES, c.id)).toBe(1);
    const [nota] = await notas(c.id);
    expect(nota?.body).toContain("Mensaje programado cancelado");
    expect(nota?.body).toContain("12/11 a las 12:00");
  });

  it("⭐ falha dentro da função não sobe e não deixa cancelamento sem nota", async () => {
    const c = await conversa(ORG_PT, SESSAO_PT);
    const id = await agendar(c, "não pode sumir calada", "2026-11-12T12:00:00Z");
    await pool.query(
      "alter table conversation_notes add constraint sabotagem_9026 check (char_length(body) < 10) not valid",
    );
    try {
      expect(await cancelar(ORG_PT, c.id)).toBe(0);
    } finally {
      await pool.query("alter table conversation_notes drop constraint sabotagem_9026");
    }
    expect((await estado(id)).status).toBe("scheduled");
  });

  it("só service_role executa; o responsável do número solta quem sai da equipe", async () => {
    const r = await pool.query(
      `select has_function_privilege('anon', 'public.fn_cancelar_agendadas_da_conversa(uuid, uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.fn_cancelar_agendadas_da_conversa(uuid, uuid)', 'execute') as auth,
              has_function_privilege('service_role', 'public.fn_cancelar_agendadas_da_conversa(uuid, uuid)', 'execute') as servico`,
    );
    expect(r.rows[0]).toEqual({ anon: false, auth: false, servico: true });

    const fk = await pool.query(
      `select rc.delete_rule
         from information_schema.key_column_usage k
         join information_schema.referential_constraints rc on rc.constraint_name = k.constraint_name
        where k.table_schema = 'public' and k.table_name = 'channel_sessions' and k.column_name = 'responsavel_user_id'`,
    );
    expect(fk.rows[0]?.delete_rule).toBe("SET NULL");
  });
});

/**
 * A PASSAGEM PARA HUMANO CANCELA AS MENSAGENS AGENDADAS DA CONVERSA
 * (fork, migration 9007 — item 2.2 do briefing de 26/10/2026).
 *
 * Contra o gatilho de verdade, aplicado pelo `baseline.sql`:
 *
 *   1. ⭐ a passagem cancela as `scheduled` DAQUELA conversa e deixa uma nota
 *      por mensagem, assinada "Sistema", com o trecho e a hora no fuso da
 *      organização;
 *   2. `sending` (o cron já está enviando), `sent` e a conversa vizinha não
 *      são tocadas;
 *   3. a organização em espanhol recebe a nota em espanhol;
 *   4. ⭐ falha dentro do gatilho NUNCA derruba o registro da passagem — e não
 *      deixa cancelamento sem nota (desfaz os dois juntos);
 *   5. as duas origens de EXECUTE fechadas para `anon` e `authenticated`.
 *
 * A corrida com o cron (a passagem espera a trava da linha que o cron pegou, e
 * a linha em `sending` não vira `cancelled`) foi provada num Postgres 16 real
 * no PR; aqui fica o que o baseline instala.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres). O setupFile recria o
 * banco por arquivo, então a sabotagem do caso 4 não vaza para outro teste.
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
       ($1::uuid, $1::text, 'Agendadas PT', 'Agendadas PT', 'America/Sao_Paulo', 'pt-BR'),
       ($2::uuid, $2::text, 'Agendadas ES', 'Agendadas ES', 'America/Mexico_City', 'es-MX')`,
    [ORG_PT, ORG_ES],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
       ($1, $2, 'agendadas-pt', '\\x00'::bytea), ($3, $4, 'agendadas-es', '\\x00'::bytea)`,
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
  await pool.query("insert into contacts (id, organization_id, display_name) values ($1, $2, 'Gestante')", [
    contato,
    org,
  ]);
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status)
     values ($1, $2, $3, $4, 'open')`,
    [id, org, contato, sessao],
  );
  return { id, contato, org };
}

async function agendar(c: { id: string; org: string }, body: string, sendAt: string, status = "scheduled") {
  const id = randomUUID();
  await pool.query(
    `insert into scheduled_messages (id, organization_id, conversation_id, body, send_at, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, c.org, c.id, body, sendAt, status],
  );
  return id;
}

async function passar(c: { id: string; contato: string; org: string }) {
  await pool.query(
    `insert into passagens_de_atendimento
       (organization_id, contact_id, conversation_id, motor, origem, motivo_codigo, body)
     values ($1, $2, $3, 'engine', 'pedido_explicito', 'requested_human', 'a narrativa da passagem')`,
    [c.org, c.contato, c.id],
  );
}

const estado = async (id: string) =>
  (await pool.query("select status, cancelled_at from scheduled_messages where id = $1", [id])).rows[0] as {
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

describe("passagem para humano × mensagens agendadas (migration 9007)", () => {
  it("⭐ cancela as agendadas da conversa e deixa uma nota por mensagem", async () => {
    const c = await conversa(ORG_PT, SESSAO_PT);
    const vizinha = await conversa(ORG_PT, SESSAO_PT);
    const link = await agendar(c, "Te mando o link amanhã às 9h, combinado?", "2026-10-28T12:00:00Z");
    const outra = await agendar(c, "Lembrete da consulta", "2026-10-29T15:30:00Z");
    const saindo = await agendar(c, "já saindo", "2026-10-27T01:00:00Z", "sending");
    const foi = await agendar(c, "já foi", "2026-10-26T01:00:00Z", "sent");
    const daVizinha = await agendar(vizinha, "da vizinha", "2026-10-28T12:00:00Z");

    await passar(c);

    expect((await estado(link)).status).toBe("cancelled");
    expect((await estado(link)).cancelled_at).not.toBeNull();
    expect((await estado(outra)).status).toBe("cancelled");
    // O cron já está enviando: cancelar não impede a saída e mentiria no estado.
    expect((await estado(saindo)).status).toBe("sending");
    expect((await estado(foi)).status).toBe("sent");
    expect((await estado(daVizinha)).status).toBe("scheduled");

    const n = await notas(c.id);
    expect(n).toHaveLength(2);
    expect(n.every((x) => x.created_by_name === "Sistema" && x.created_by_user_id === null)).toBe(true);
    // 12:00 UTC = 09:00 em São Paulo — a hora que quem agendou escolheu na tela.
    expect(n.map((x) => x.body).join("\n")).toContain("Ela sairia em 28/10 às 09:00");
    expect(n.map((x) => x.body).join("\n")).toContain('Texto: "Te mando o link amanhã às 9h, combinado?"');
    expect(await notas(vizinha.id)).toHaveLength(0);
  });

  it("uma segunda passagem na mesma conversa não repete nota", async () => {
    const c = await conversa(ORG_PT, SESSAO_PT);
    await agendar(c, "uma só", "2026-10-30T12:00:00Z");
    await passar(c);
    await passar(c);
    expect(await notas(c.id)).toHaveLength(1);
  });

  it("organização em espanhol recebe a nota em espanhol, no fuso dela", async () => {
    const c = await conversa(ORG_ES, SESSAO_ES);
    await agendar(c, "Hola, le escribo mañana", "2026-10-28T18:00:00Z");
    await passar(c);
    const [nota] = await notas(c.id);
    expect(nota?.body).toContain("Mensaje programado cancelado");
    expect(nota?.body).toContain("28/10 a las 12:00");
  });

  it("⭐ falha dentro do gatilho não derruba a passagem nem deixa cancelamento sem nota", async () => {
    const c = await conversa(ORG_PT, SESSAO_PT);
    const id = await agendar(c, "não pode sumir calada", "2026-10-30T12:00:00Z");
    // Sabotagem: o banco recusa toda nota nova (as antigas não são revalidadas).
    await pool.query(
      "alter table conversation_notes add constraint sabotagem_9007 check (char_length(body) < 10) not valid",
    );
    try {
      await expect(passar(c)).resolves.toBeUndefined();
    } finally {
      await pool.query("alter table conversation_notes drop constraint sabotagem_9007");
    }
    const passagens = await pool.query("select count(*)::int as n from passagens_de_atendimento where conversation_id = $1", [
      c.id,
    ]);
    expect(passagens.rows[0].n).toBe(1);
    expect((await estado(id)).status).toBe("scheduled");
  });

  it("as duas origens de EXECUTE estão fechadas", async () => {
    const r = await pool.query(
      `select has_function_privilege('anon', 'public.fn_passagem_cancela_agendadas()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.fn_passagem_cancela_agendadas()', 'execute') as auth`,
    );
    expect(r.rows[0]).toEqual({ anon: false, auth: false });
  });
});

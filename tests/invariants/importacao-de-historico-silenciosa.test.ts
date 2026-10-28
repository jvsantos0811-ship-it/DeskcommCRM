import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * A IMPORTAÇÃO DO HISTÓRICO É SILENCIOSA (migration 9012).
 *
 * `fn_importar_conversa_historica` grava uma conversa antiga inteira. O que se
 * cobra aqui, no banco real (o baseline aplicado), é o contrato do PR:
 *
 *   * as mensagens entram com a DATA ORIGINAL (`sent_at` e `created_at`);
 *   * NENHUM evento nasce — nem `message.received`, nem `conversation.routing_requested`
 *     — e nenhuma demanda abre: IA, automação e follow-up não acordam;
 *   * a conversa nova nasce FECHADA, sem não lidas e sem espera de fila;
 *   * nasce UM negócio na etapa pedida, com a origem e a etiqueta certas;
 *   * repetir não duplica nada; contato com negócio aberto não ganha outro;
 *   * fora da função, os gatilhos seguem iguais (controle: uma mensagem nova
 *     de verdade ainda emite `message.received`).
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

let pipeline: string;
let stage: string;

beforeAll(async () => {
  await seedGov();
  pipeline = randomUUID();
  stage = randomUUID();
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1::uuid,$2,'Funil histórico',$1::text)", [
    pipeline,
    GOV_ORG,
  ]);
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Leads antigos','leads-antigos',1)",
    [stage, GOV_ORG, pipeline],
  );
});
afterAll(async () => pool.end());

async function contato(nome: string): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [id, GOV_ORG, nome]);
  return id;
}

function tresMensagens(prefixo: string) {
  return [
    { external_id: `${prefixo}-1`, direction: "inbound", sent_at: "2026-05-01T10:00:00Z", type: "text", body: "Oi, sofri um acidente", status: "delivered", metadata: { historico_importado: "true" } },
    { external_id: `${prefixo}-2`, direction: "outbound", sent_at: "2026-05-01T10:05:00Z", type: "text", body: "Olá! Pode contar mais?", status: "read", metadata: { historico_importado: "true" } },
    { external_id: `${prefixo}-3`, direction: "inbound", sent_at: "2026-05-02T09:00:00Z", type: "text", body: "Depois eu mando os documentos", status: "delivered", metadata: { historico_importado: "true" } },
  ];
}

async function importar(contactId: string, thread: string, mensagens: unknown[], comNegocio = true) {
  const { rows } = await pool.query(
    "select public.fn_importar_conversa_historica($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) as r",
    [
      GOV_ORG,
      GOV_SESSION,
      contactId,
      thread,
      JSON.stringify(mensagens),
      comNegocio ? pipeline : null,
      comNegocio ? stage : null,
      "Maria",
      randomUUID(),
    ],
  );
  return rows[0].r as {
    conversation_id: string;
    gravadas: number;
    repetidas: number;
    lead_id: string | null;
    lead_motivo: string;
  };
}

async function eventosDaConversa(conversationId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select event_type from event_log
      where organization_id=$1 and (entity_id=$2 or payload->>'conversation_id'=$2::text)
      order by event_type`,
    [GOV_ORG, conversationId],
  );
  return rows.map((r) => r.event_type as string);
}

describe("importação do histórico", () => {
  it("grava 3 mensagens com a data original, 1 conversa fechada, 1 negócio — e nenhum evento", async () => {
    const c = await contato("Maria");
    const thread = `thr-${randomUUID()}`;
    const r = await importar(c, thread, tresMensagens(randomUUID()));

    expect(r.gravadas).toBe(3);
    expect(r.lead_motivo).toBe("criado");

    const { rows: msgs } = await pool.query(
      "select sent_at, created_at, service_revision, demanda_id from messages where conversation_id=$1 order by sent_at",
      [r.conversation_id],
    );
    expect(msgs).toHaveLength(3);
    expect(new Date(msgs[0].sent_at).toISOString()).toBe("2026-05-01T10:00:00.000Z");
    expect(new Date(msgs[0].created_at).toISOString()).toBe("2026-05-01T10:00:00.000Z");
    // Nenhuma demanda abriu (fn_service_inbound não rodou).
    expect(msgs.every((m) => m.demanda_id === null && m.service_revision === null)).toBe(true);

    const { rows: conv } = await pool.query(
      "select status, unread_count_for_assignee, awaiting_since, last_message_at, last_inbound_at, provider_conversation_id from conversations where id=$1",
      [r.conversation_id],
    );
    expect(conv[0].status).toBe("closed");
    expect(conv[0].unread_count_for_assignee).toBe(0);
    expect(conv[0].awaiting_since).toBeNull();
    expect(new Date(conv[0].last_message_at).toISOString()).toBe("2026-05-02T09:00:00.000Z");
    expect(conv[0].provider_conversation_id).toBe(thread);

    const { rows: lead } = await pool.query(
      "select pipeline_id, stage_id, source, tags, source_metadata->>'ultima_mensagem_em' as ultima, stage_changed_at from crm_leads where id=$1",
      [r.lead_id],
    );
    expect(lead[0].pipeline_id).toBe(pipeline);
    expect(lead[0].stage_id).toBe(stage);
    expect(lead[0].source).toBe("importado_zernio");
    expect(lead[0].tags).toEqual(["lead-antigo"]);
    expect(lead[0].ultima).toContain("2026-05-02");
    // O tempo na etapa conta de AGORA, não da data da conversa.
    expect(Date.now() - new Date(lead[0].stage_changed_at).getTime()).toBeLessThan(60 * 60_000);

    // Silêncio: nem mensagem, nem roteamento, nem lead.created.
    expect(await eventosDaConversa(r.conversation_id)).toEqual([]);
    const { rows: ev } = await pool.query(
      "select count(*)::int as n from event_log where organization_id=$1 and entity_id=$2",
      [GOV_ORG, r.lead_id],
    );
    expect(ev[0].n).toBe(0);
  });

  it("repetir não duplica mensagem nem negócio", async () => {
    const c = await contato("Repete");
    const thread = `thr-${randomUUID()}`;
    const msgs = tresMensagens(randomUUID());
    const a = await importar(c, thread, msgs);
    const b = await importar(c, thread, msgs);
    expect(b.conversation_id).toBe(a.conversation_id);
    expect(b.gravadas).toBe(0);
    expect(b.lead_motivo).toBe("ja_tinha_negocio_aberto");
    const { rows } = await pool.query("select count(*)::int as n from messages where conversation_id=$1", [a.conversation_id]);
    expect(rows[0].n).toBe(3);
    const { rows: leads } = await pool.query(
      "select count(*)::int as n from crm_leads where contact_id=$1 and status='open'",
      [c],
    );
    expect(leads[0].n).toBe(1);
  });

  it("contato com negócio aberto em outro funil não ganha negócio novo", async () => {
    const c = await contato("Já tem");
    const outroFunil = randomUUID();
    const outraEtapa = randomUUID();
    await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1::uuid,$2,'Outro',$1::text)", [outroFunil, GOV_ORG]);
    await pool.query(
      "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Entrada','entrada',1)",
      [outraEtapa, GOV_ORG, outroFunil],
    );
    await pool.query(
      "insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,'Aberto')",
      [GOV_ORG, outroFunil, outraEtapa, c],
    );
    const r = await importar(c, `thr-${randomUUID()}`, tresMensagens(randomUUID()));
    expect(r.gravadas).toBe(3);
    expect(r.lead_id).toBeNull();
    expect(r.lead_motivo).toBe("ja_tinha_negocio_aberto");
  });

  it("quem pediu para parar não vira negócio", async () => {
    const c = await contato("Parou");
    await pool.query("update contacts set is_blocked=true where id=$1", [c]);
    const r = await importar(c, `thr-${randomUUID()}`, tresMensagens(randomUUID()));
    expect(r.lead_motivo).toBe("contato_bloqueado");
  });

  it("numa conversa que já existe, só entra o que é ANTERIOR à primeira mensagem do CRM", async () => {
    const c = await contato("Já conversa");
    const conv = randomUUID();
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
      [conv, GOV_ORG, c, GOV_SESSION],
    );
    await pool.query(
      `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at,external_id)
       values($1,$2,$3,$4,'text','inbound','delivered','external_device','Mensagem nova','2026-05-01T12:00:00Z',$5)`,
      [GOV_ORG, conv, GOV_SESSION, c, `novo-${randomUUID()}`],
    );
    const r = await importar(c, `thr-${randomUUID()}`, tresMensagens(randomUUID()), false);
    expect(r.conversation_id).toBe(conv);
    // Só a das 10:00 e a das 10:05 de 01/05 vêm antes das 12:00.
    expect(r.gravadas).toBe(2);
  });

  it("controle: fora da importação, a mensagem do cliente ainda emite message.received", async () => {
    const c = await contato("Controle");
    const r = await importar(c, `thr-${randomUUID()}`, tresMensagens(randomUUID()), false);
    const id = randomUUID();
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
       values($1,$2,$3,$4,$5,'text','inbound','delivered','external_device','Voltei',clock_timestamp())`,
      [id, GOV_ORG, r.conversation_id, GOV_SESSION, c],
    );
    const { rows } = await pool.query("select event_type from event_log where organization_id=$1 and entity_id=$2", [GOV_ORG, id]);
    expect(rows.map((x) => x.event_type)).toContain("message.received");
  });

  it("só o service_role executa a função", async () => {
    const { rows } = await pool.query(
      `select has_function_privilege('anon','public.fn_importar_conversa_historica(uuid,uuid,uuid,text,jsonb,uuid,uuid,text,uuid)','execute') as anon,
              has_function_privilege('authenticated','public.fn_importar_conversa_historica(uuid,uuid,uuid,text,jsonb,uuid,uuid,text,uuid)','execute') as auth`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false });
  });
});

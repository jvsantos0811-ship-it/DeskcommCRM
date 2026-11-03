import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import {
  aplicarRegistroDoFechamento,
  blocoDoRegistro,
  equipeFalouPorUltimo,
  lerRegistro,
  statusEfetivo,
} from "@/lib/agent-engine/agent/registro-da-conversa";
import { criarConferenciaDeRepeticao } from "@/lib/agent-engine/agent/repeticao-entre-respostas";

/**
 * PC-019 — O REGISTRO DA CONVERSA, contra o Postgres do baseline.
 *
 * Roda de verdade a gravação do fechamento (`aplicarRegistroDoFechamento`), o
 * bloco do turno (`blocoDoRegistro`) e a trava de repetição do PC-018 lendo o
 * registro. Critérios do pedido:
 *  - licença às 10h02 → "dados de saúde: sim (10h02)" em todos os turnos
 *    seguintes, de qualquer agente; a licença não é pedida de novo;
 *  - promessa "a equipe fala com você a partir das 8h de amanhã" → pendente;
 *    vencida se passar do prazo sem a equipe falar;
 *  - conversa longa (fora da janela de mensagens da trava): o registro segue;
 *  - recepção → especialista: a especialista não repete o que a recepção já
 *    perguntou;
 *  - nenhum diagnóstico ou CID no registro;
 *  - anonimizar o contato apaga o registro (LGPD).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "9019aaaa-0000-4000-8000-000000000001";
const SESSAO = "9019aaaa-0000-4000-8000-0000000000c1";
const SESSAO_2 = "9019aaaa-0000-4000-8000-0000000000c2";
const FUSO = "America/Sao_Paulo";
// 03/11/2026 10h02 em São Paulo.
const AS_10H02 = new Date("2026-11-03T13:02:00Z");

let contato = "";
let conversa = "";
let recepcao = "";
let especialista = "";

async function agente(nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 's') returning id`,
    [ORG, nome],
  );
  return rows[0]!.id;
}

const fechamento = (registro: unknown, agentId: string, agora: Date, promessas: { o_que: string; prazo: string | null }[] = []) =>
  aplicarRegistroDoFechamento(pool, {
    organizationId: ORG,
    contactId: contato,
    registro,
    promessas,
    contexto: { agora, agentId, conversationId: conversa, jobId: null },
  });

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,'pc019','PC019','PC019') on conflict (id) do nothing`,
    [ORG],
  );
  for (const [id, nome] of [
    [SESSAO, "pc019-sessao"],
    [SESSAO_2, "pc019-sessao-2"],
  ]) {
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1,$2,$3,'WORKING','\\x00'::bytea) on conflict (id) do nothing`,
      [id, ORG, nome],
    );
  }
  recepcao = await agente("Recepção PC019");
  especialista = await agente("Especialista PC019");
});

beforeEach(async () => {
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name) values ($1, 'Maria PC019') returning id`,
    [ORG],
  );
  contato = c[0]!.id;
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
    [ORG, contato, SESSAO],
  );
  conversa = v[0]!.id;
});

afterAll(async () => {
  await pool.end();
});

describe("PC-019 — o registro da conversa", () => {
  it("licença às 10h02: o bloco mostra \"dados de saúde: sim (10h02)\" em todo turno seguinte, de qualquer agente", async () => {
    await fechamento(
      {
        perguntas: [{ tema: "licença de saúde", pergunta: "Você autoriza o uso dos seus dados de saúde para analisar o caso?" }],
        respostas: [],
        licencas: [],
        promessas_cumpridas: [],
      },
      recepcao,
      new Date(AS_10H02.getTime() - 60_000),
    );
    await fechamento(
      {
        respostas: [{ tema: "licença de saúde", resposta: "sim, autorizo" }],
        licencas: [{ tema: "dados de saúde", concedida: true }],
      },
      recepcao,
      AS_10H02,
    );
    // Turnos seguintes: o bloco é do CONTATO — vale para a recepção e para a especialista.
    for (const agora of [new Date(AS_10H02.getTime() + 10 * 60_000), new Date(AS_10H02.getTime() + 3 * 3600_000)]) {
      const bloco = await blocoDoRegistro(pool, { organizationId: ORG, contactId: contato, agora, fuso: FUSO });
      expect(bloco).toContain("dados de saúde: sim (10h02)");
      expect(bloco).toContain("licença de saúde → sim");
    }
    // E a trava de repetição não deixa a licença ser pedida de novo (nenhuma
    // mensagem no banco: só o registro sabe que ela foi respondida).
    const r = await criarConferenciaDeRepeticao(pool, { organizationId: ORG, contactId: contato, desde: new Date() }, null).conferir(
      "Antes de seguir: você autoriza o uso dos seus dados de saúde para analisar o caso?",
    );
    expect(r?.tipo).toBe("pergunta_respondida");
  });

  it("promessa da equipe: pendente; vencida depois do prazo sem a equipe falar; cumprida se a equipe falou", async () => {
    await fechamento({}, recepcao, AS_10H02, [
      { o_que: "a equipe fala com você a partir das 8h de amanhã", prazo: "2026-11-04T11:00:00.000Z" },
    ]);
    // 03/11 17h (SP): o prazo é amanhã, então aparece com o dia.
    const antes = await blocoDoRegistro(pool, { organizationId: ORG, contactId: contato, agora: new Date("2026-11-03T20:00:00Z"), fuso: FUSO });
    expect(antes).toContain("a equipe fala com você a partir das 8h de amanhã (pendente até 04/11 08h00)");
    // 04/11 09h (SP): passou das 8h sem a equipe falar.
    const depois = await blocoDoRegistro(pool, { organizationId: ORG, contactId: contato, agora: new Date("2026-11-04T12:00:00Z"), fuso: FUSO });
    expect(depois).toContain("(VENCIDA em 08h00)");

    // A equipe falou com o cliente (mensagem de uma pessoa pelo CRM).
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,'text','outbound','sent','Bom dia, Maria! Aqui é o Dr. João.','crm', now(), now())`,
      [ORG, conversa, SESSAO, contato],
    );
    const [promessa] = await lerRegistro(pool, ORG, contato);
    const equipe = await equipeFalouPorUltimo(pool, ORG, contato);
    expect(statusEfetivo(promessa!, new Date("2099-01-01T00:00:00Z"), equipe)).toBe("cumprida");
  });

  it("recepção → especialista, conversa longa (fora da janela da trava): a especialista não repete", async () => {
    // A recepção perguntou e o cliente respondeu há 5 dias — fora das 72 h e
    // das 10 mensagens que a trava de repetição lê.
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,'text','outbound','sent','Foi com você ou com alguém da família?','ai', now() - interval '5 days', now() - interval '5 days'),
              ($1,$2,$3,$4,'text','inbound','received','foi com meu neto','external_device', now() - interval '5 days' + interval '1 minute', now() - interval '5 days' + interval '1 minute')`,
      [ORG, conversa, SESSAO, contato],
    );
    await fechamento(
      {
        perguntas: [{ tema: "quem sofreu o acidente", pergunta: "Foi com você ou com alguém da família?" }],
        respostas: [{ tema: "quem sofreu o acidente", resposta: "o neto" }],
      },
      recepcao,
      new Date(Date.now() - 5 * 24 * 3600_000),
    );
    // 12 mensagens recentes da IA em outra conversa (outro número, a especialista).
    const { rows } = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
      [ORG, contato, SESSAO_2],
    );
    for (let i = 0; i < 12; i++) {
      await pool.query(
        `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via, sent_at, created_at)
         values ($1,$2,$3,$4,'text','outbound','sent',$5,'ai', now() - make_interval(mins => $6), now() - make_interval(mins => $6))`,
        [ORG, rows[0]!.id, SESSAO_2, contato, `Mensagem ${i} da especialista sobre os documentos.`, 60 - i],
      );
    }
    const bloco = await blocoDoRegistro(pool, { organizationId: ORG, contactId: contato, agora: new Date(), fuso: FUSO });
    expect(bloco).toContain("quem sofreu o acidente → o neto");
    const r = await criarConferenciaDeRepeticao(pool, { organizationId: ORG, contactId: contato, desde: new Date() }, null).conferir(
      "Só confirmando: foi com você ou com alguém da família?",
    );
    expect(r).toMatchObject({ tipo: "pergunta_respondida", fonte: "registro" });
    const [item] = await lerRegistro(pool, ORG, contato);
    expect(item!.agentId).toBe(recepcao);
    void especialista;
  });

  it("nenhum diagnóstico, CID ou remédio é gravado", async () => {
    await fechamento(
      {
        perguntas: [{ tema: "diagnóstico do laudo", pergunta: "Qual o CID que está no seu laudo?" }],
        respostas: [{ tema: "diagnóstico do laudo", resposta: "CID S82.2, fratura exposta, tomo tramadol 50mg" }],
      },
      especialista,
      AS_10H02,
    );
    const { rows } = await pool.query(`select tema, pergunta, resposta from registro_da_conversa where contact_id = $1`, [contato]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/S82|CID|fratura|tramadol|50mg/i);
    expect(rows[0].resposta).toBe("informado");
  });

  it("o mesmo tema em dois fechamentos é UM item (vezes soma)", async () => {
    const turno = { perguntas: [{ tema: "data do acidente", pergunta: "Quando foi o acidente?" }] };
    await fechamento(turno, recepcao, AS_10H02);
    await fechamento(turno, especialista, new Date(AS_10H02.getTime() + 60_000));
    const itens = await lerRegistro(pool, ORG, contato);
    expect(itens).toHaveLength(1);
    expect(itens[0]).toMatchObject({ vezes: 2, status: "sem_resposta", agentId: especialista });
  });

  it("registro fora do formato não grava nada nem lança (o turno segue)", async () => {
    await expect(fechamento({ perguntas: "não é lista" }, recepcao, AS_10H02)).resolves.toBe(0);
    expect(await lerRegistro(pool, ORG, contato)).toEqual([]);
  });

  it("LGPD: anonimizar o contato apaga o registro dele", async () => {
    await fechamento({ respostas: [{ tema: "cidade", resposta: "Contagem" }] }, recepcao, AS_10H02);
    expect(await lerRegistro(pool, ORG, contato)).toHaveLength(1);
    await pool.query(`update contacts set is_anonymized = true, anonymized_at = now() where id = $1`, [contato]);
    expect(await lerRegistro(pool, ORG, contato)).toEqual([]);
  });
});

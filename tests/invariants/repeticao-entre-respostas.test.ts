import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import {
  contarRepeticaoNaConversa,
  criarConferenciaDeRepeticao,
} from "@/lib/agent-engine/agent/repeticao-entre-respostas";

/**
 * PC-018 — A TRAVA DE REPETIÇÃO ENTRE TURNOS, contra o Postgres do baseline.
 *
 * Roda de verdade a conferência do turno (`criarConferenciaDeRepeticao`): o
 * histórico da IA para o CONTATO (de qualquer agente e conversa), a janela de
 * N mensagens / H horas, quem respondeu o quê, os ajustes da organização e a
 * exceção do "repete". Sem chave de embedding aqui: a régua das perguntas é a
 * de texto (Dice ≥ 0,6) — o caminho com embedding é o mesmo `perguntaRepetida`
 * com cosseno, medido nos testes puros.
 *
 * Critérios do pedido:
 *  - régua de follow-up com o cliente calado: a mesma pergunta não sai 2 vezes;
 *  - pergunta já respondida (licença de saúde): não é pedida de novo, por
 *    nenhum agente;
 *  - "Ainda estou aguardando a equipe…" não sai 2 vezes;
 *  - "não entendi, repete": a repetição sai;
 *  - desligada pela organização: nada é conferido;
 *  - o contador por conversa.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "9018aaaa-0000-4000-8000-000000000001";
const SESSAO = "9018aaaa-0000-4000-8000-0000000000c1";
const SESSAO_2 = "9018aaaa-0000-4000-8000-0000000000c2";

let contato = "";
let conversa = "";

async function mensagem(direcao: "inbound" | "outbound", body: string, minutosAtras: number, conv = conversa, sessao = SESSAO) {
  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,'text',$5,$6,$7,$8, now() - make_interval(mins => $9), now() - make_interval(mins => $9))`,
    [ORG, conv, sessao, contato, direcao, direcao === "inbound" ? "received" : "sent", body, direcao === "inbound" ? "external_device" : "ai", minutosAtras],
  );
}

const conferencia = () => criarConferenciaDeRepeticao(pool, { organizationId: ORG, contactId: contato, desde: new Date() }, null);

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,'pc018','PC018','PC018') on conflict (id) do nothing`,
    [ORG],
  );
  for (const [id, nome] of [
    [SESSAO, "pc018-sessao"],
    [SESSAO_2, "pc018-sessao-2"],
  ]) {
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1,$2,$3,'WORKING','\\x00'::bytea) on conflict (id) do nothing`,
      [id, ORG, nome],
    );
  }
});

beforeEach(async () => {
  await pool.query(`update organizations set settings = '{}'::jsonb where id = $1`, [ORG]);
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name) values ($1, 'Maria PC018') returning id`,
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

describe("PC-018 — a IA não repete pergunta nem mensagem entre turnos", () => {
  it("régua de follow-up com o cliente calado: a mesma pergunta não sai 2 vezes", async () => {
    await mensagem("inbound", "Oi, quero saber do auxílio", 300);
    await mensagem("outbound", "Me conta: foi com você ou com alguém da família?", 290);
    const r = await conferencia().conferir("Oi, Maria! Foi com você ou com alguém da família o acidente?", { followup: true });
    expect(r?.tipo).toBe("pergunta_duas_vezes");
  });

  it("licença de saúde já respondida: não é pedida de novo (outra conversa, outro agente)", async () => {
    await mensagem("outbound", "Para analisar, você autoriza o uso dos seus dados de saúde?", 120);
    await mensagem("inbound", "sim, autorizo", 118);
    // Outra conversa do mesmo contato, por outro número (outro agente).
    const { rows } = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
      [ORG, contato, SESSAO_2],
    );
    await mensagem("outbound", "Oi, sou a Raquel e vou seguir com você.", 60, rows[0]!.id, SESSAO_2);
    const r = await conferencia().conferir("Antes de tudo: você autoriza o uso dos seus dados de saúde?");
    expect(r?.tipo).toBe("pergunta_respondida");
    if (r?.tipo === "pergunta_respondida") expect(r.anterior.respostaDoCliente).toBe("sim, autorizo");
  });

  it("\"Ainda estou aguardando a equipe…\" não sai 2 vezes na mesma conversa", async () => {
    await mensagem("outbound", "Ainda estou aguardando a equipe confirmar. Assim que tiver retorno, te aviso por aqui.", 90);
    await mensagem("inbound", "ok", 80);
    const r = await conferencia().conferir("Ainda estou aguardando a equipe confirmar. Assim que tiver retorno te aviso aqui!");
    expect(r?.tipo).toBe("mensagem");
  });

  it("o cliente escreveu \"não entendi, repete\": a repetição sai", async () => {
    await mensagem("outbound", "Você autoriza o uso dos seus dados de saúde?", 30);
    await mensagem("inbound", "não entendi, repete", 29);
    expect(await conferencia().conferir("Você autoriza o uso dos seus dados de saúde?")).toBeNull();
  });

  it("fora da janela (mais de 72 h): não conta", async () => {
    await mensagem("outbound", "Foi com você ou com alguém da família?", 73 * 60);
    await mensagem("inbound", "comigo", 73 * 60 - 1);
    expect(await conferencia().conferir("Foi com você ou com alguém da família?")).toBeNull();
  });

  it("desligada pela organização: nada é conferido", async () => {
    await pool.query(
      `update organizations set settings = jsonb_build_object('conversa', jsonb_build_object('repeticao',
         jsonb_build_object('ligada', false, 'janela_mensagens', 10, 'janela_horas', 72, 'limiar_texto', 0.8, 'limiar_pergunta', 0.85)))
       where id = $1`,
      [ORG],
    );
    await mensagem("outbound", "Foi com você ou com alguém da família?", 10);
    await mensagem("inbound", "comigo", 9);
    expect(await conferencia().conferir("Foi com você ou com alguém da família?")).toBeNull();
  });

  it("o contador por conversa soma, sem chamada de modelo", async () => {
    await contarRepeticaoNaConversa(pool, ORG, conversa, "repeticoes_barradas");
    await contarRepeticaoNaConversa(pool, ORG, conversa, "repeticoes_barradas");
    await contarRepeticaoNaConversa(pool, ORG, conversa, "toques_pulados_por_repeticao");
    const { rows } = await pool.query(`select metadata from conversations where id = $1`, [conversa]);
    expect(rows[0].metadata).toMatchObject({ repeticoes_barradas: 2, toques_pulados_por_repeticao: 1 });
  });
});

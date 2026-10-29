import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * 9013 — QUEM RESPONDEU SOBE AO TOPO DA ETAPA, contra o Postgres do baseline.
 *
 * O pedido: "no kanban, as pessoas que forem respondendo vão para o topo da
 * etapa e os antigos vão ficando para o final". O quadro mostra
 * `position_in_stage` crescente (menor = topo); a mensagem do cliente chega
 * pela `fn_mark_conversation_message`, que avança `conversations.last_inbound_at`,
 * e o gatilho `trg_conversa_respondeu_sobe_no_funil` põe cada negócio aberto
 * do contato acima do menor da etapa.
 *
 * Mede também o que NÃO pode acontecer: negócio fechado, outra organização,
 * grupo, mensagem de saída, mensagem atrasada e a importação de histórico não
 * mexem; a reordenação não troca `updated_at` (trava otimista do arrasto), não
 * grava atividade nem evento; e o arrasto manual continua possível depois.
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

const ORG = "9013aaaa-0000-4000-8000-000000000001";
const ORG_B = "9013aaaa-0000-4000-8000-000000000002";

const sessao: Record<string, string> = {};
const etapa: Record<string, string> = {};
let pipeline = "";
let pipelineDeB = "";
let etapaDeB = "";
let seq = 0;

async function novoContato(org = ORG): Promise<string> {
  seq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, $2, $3) returning id`,
    [org, `Cliente 9013-${seq}`, `+55119013${String(seq).padStart(5, "0")}`],
  );
  return rows[0]!.id;
}

async function novaConversa(contato: string, org = ORG, grupo = false): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group, group_chat_id)
     values ($1, $2, $3, 'open', $4, $5) returning id`,
    [org, contato, sessao[org], grupo, grupo ? `grupo-9013-${seq}@g.us` : null],
  );
  return rows[0]!.id;
}

async function novoLead(
  contato: string,
  posicao: number,
  opcoes: { org?: string; stage?: string; status?: "open" | "won" | "lost" } = {},
): Promise<string> {
  const org = opcoes.org ?? ORG;
  const status = opcoes.status ?? "open";
  const stage = opcoes.stage ?? (status === "won" ? etapa.ganho : status === "lost" ? etapa.perdido : etapa.novo);
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, position_in_stage,
                            status, lost_reason, closed_at)
     values ($1, $2, $3, $4, 'Negócio 9013', $5, $6, $7, $8) returning id`,
    [
      org,
      org === ORG ? pipeline : pipelineDeB,
      stage,
      contato,
      posicao,
      status,
      status === "lost" ? "other" : null,
      status === "open" ? null : new Date().toISOString(),
    ],
  );
  return rows[0]!.id;
}

async function lead(id: string) {
  // `updated_at` como TEXTO: o Date do JS guarda milissegundos e o Postgres
  // microssegundos — comparar Date contra a coluna nunca casaria.
  const { rows } = await pool.query<{ position_in_stage: string; updated_at: string; stage_id: string }>(
    `select position_in_stage, updated_at::text as updated_at, stage_id from crm_leads where id = $1`,
    [id],
  );
  return { ...rows[0]!, pos: Number(rows[0]!.position_in_stage) };
}

async function menorDaEtapa(stage: string): Promise<number> {
  const { rows } = await pool.query<{ m: string }>(
    `select min(position_in_stage) as m from crm_leads where stage_id = $1`,
    [stage],
  );
  return Number(rows[0]!.m);
}

/** A mensagem do cliente chegando pelo caminho real da ingestão. */
async function mensagem(conversa: string, direcao: "inbound" | "outbound", quando: Date) {
  await pool.query(`select public.fn_mark_conversation_message($1, $2, 'oi', $3)`, [
    conversa,
    direcao,
    quando.toISOString(),
  ]);
}

let relogio = Date.parse("2030-01-01T12:00:00Z");
function agora(): Date {
  relogio += 60_000;
  return new Date(relogio);
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "funil-9013-a"],
    [ORG_B, "funil-9013-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'F9013', 'F9013')`,
      [id, slug],
    );
    const { rows } = await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, provider, waha_session_name, status, webhook_secret_encrypted)
       values ($1, 'waha', $2, 'WORKING', '\\x00'::bytea) returning id`,
      [id, `sessao-${slug}`],
    );
    sessao[id] = rows[0]!.id;
  }

  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil', 'funil-9013') returning id`,
    [ORG],
  );
  pipeline = p[0]!.id;
  for (const [chave, pos, ganho, perda] of [
    ["novo", 1, false, false],
    ["ganho", 2, true, false],
    ["perdido", 3, false, true],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [ORG, pipeline, chave, `${chave}-9013`, pos, ganho, perda],
    );
    etapa[chave] = rows[0]!.id;
  }

  const { rows: pb } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil B', 'funil-9013-b') returning id`,
    [ORG_B],
  );
  pipelineDeB = pb[0]!.id;
  const { rows: sb } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position)
     values ($1, $2, 'novo', 'novo-9013-b', 1) returning id`,
    [ORG_B, pipelineDeB],
  );
  etapaDeB = sb[0]!.id;

  // Os "antigos" da etapa: três negócios de outras pessoas, em 1000/2000/3000.
  for (const pos of [1000, 2000, 3000]) {
    await novoLead(await novoContato(), pos);
  }
});

afterAll(() => pool.end());

describe("quem respondeu sobe ao topo da etapa (9013)", () => {
  it("cliente responde → o negócio aberto dele vai para o topo, sem trocar updated_at, sem atividade nem evento", async () => {
    const contato = await novoContato();
    const conversa = await novaConversa(contato);
    const id = await novoLead(contato, 9000);
    const antes = await lead(id);
    const menorAntes = await menorDaEtapa(etapa.novo!);
    const { rows: ev0 } = await pool.query<{ n: string }>(
      `select count(*) as n from event_log where organization_id = $1 and entity_id = $2`,
      [ORG, id],
    );

    await mensagem(conversa, "inbound", agora());

    const depois = await lead(id);
    expect(depois.pos).toBe(menorAntes - 1000);
    expect(depois.pos).toBe(await menorDaEtapa(etapa.novo!));
    expect(depois.stage_id).toBe(antes.stage_id);
    // A trava otimista do arrasto (`.eq('updated_at', …)`) segue valendo.
    expect(depois.updated_at).toBe(antes.updated_at);

    const { rows: at } = await pool.query<{ n: string }>(
      `select count(*) as n from crm_lead_activities where lead_id = $1`,
      [id],
    );
    expect(Number(at[0]!.n)).toBe(0);
    const { rows: ev1 } = await pool.query<{ n: string }>(
      `select count(*) as n from event_log where organization_id = $1 and entity_id = $2`,
      [ORG, id],
    );
    expect(Number(ev1[0]!.n)).toBe(Number(ev0[0]!.n));
  });

  it("quem já está no topo não se mexe; a segunda resposta de outro cliente passa na frente", async () => {
    const a = await novoContato();
    const convA = await novaConversa(a);
    const leadA = await novoLead(a, 8000);
    await mensagem(convA, "inbound", agora());
    const topoA = (await lead(leadA)).pos;

    await mensagem(convA, "inbound", agora());
    expect((await lead(leadA)).pos).toBe(topoA);

    const b = await novoContato();
    const convB = await novaConversa(b);
    const leadB = await novoLead(b, 8500);
    await mensagem(convB, "inbound", agora());
    expect((await lead(leadB)).pos).toBe(topoA - 1000);
    expect((await lead(leadA)).pos).toBe(topoA);
  });

  it("negócio ganho ou perdido não se mexe", async () => {
    const contato = await novoContato();
    const conversa = await novaConversa(contato);
    const ganho = await novoLead(contato, 7000, { status: "won" });
    const perdido = await novoLead(contato, 7000, { status: "lost" });
    // Um vizinho em cada etapa, para haver "topo" a disputar.
    await novoLead(await novoContato(), 100, { stage: etapa.ganho, status: "won" });
    await novoLead(await novoContato(), 100, { stage: etapa.perdido, status: "lost" });

    await mensagem(conversa, "inbound", agora());

    expect((await lead(ganho)).pos).toBe(7000);
    expect((await lead(perdido)).pos).toBe(7000);
  });

  it("outra organização não se mexe", async () => {
    const contatoB = await novoContato(ORG_B);
    await novoLead(contatoB, 10, { org: ORG_B, stage: etapaDeB });
    const leadDeB = await novoLead(contatoB, 5000, { org: ORG_B, stage: etapaDeB });

    // Cliente da organização A responde: o funil de B fica como está.
    const contatoA = await novoContato();
    const convA = await novaConversa(contatoA);
    await novoLead(contatoA, 6000);
    await mensagem(convA, "inbound", agora());
    expect((await lead(leadDeB)).pos).toBe(5000);
  });

  it("conversa de grupo não mexe no funil", async () => {
    const contato = await novoContato();
    const grupo = await novaConversa(contato, ORG, true);
    const id = await novoLead(contato, 6500);
    await mensagem(grupo, "inbound", agora());
    expect((await lead(id)).pos).toBe(6500);
  });

  it("mensagem de saída (equipe ou IA) e mensagem atrasada não mexem", async () => {
    const contato = await novoContato();
    const conversa = await novaConversa(contato);
    const id = await novoLead(contato, 6600);

    await mensagem(conversa, "outbound", agora());
    expect((await lead(id)).pos).toBe(6600);

    // Uma resposta de verdade carimba last_inbound_at...
    const recente = agora();
    await mensagem(conversa, "inbound", recente);
    const topo = (await lead(id)).pos;
    // ...outro cliente passa na frente...
    const outro = await novoContato();
    const convOutro = await novaConversa(outro);
    await novoLead(outro, 6700);
    await mensagem(convOutro, "inbound", agora());
    // ...e uma mensagem ANTIGA do primeiro (carimbo não avança) não o devolve ao topo.
    await mensagem(conversa, "inbound", new Date(recente.getTime() - 3_600_000));
    expect((await lead(id)).pos).toBe(topo);
    expect(await menorDaEtapa(etapa.novo!)).toBeLessThan(topo);
  });

  it("com a chave da importação de histórico ligada, nada se move", async () => {
    const contato = await novoContato();
    const conversa = await novaConversa(contato);
    const id = await novoLead(contato, 6800);
    const cliente = await pool.connect();
    try {
      await cliente.query("begin");
      await cliente.query(`select set_config('deskcomm.importacao_historica', 'on', true)`);
      await cliente.query(`update conversations set last_inbound_at = $2 where id = $1`, [
        conversa,
        agora().toISOString(),
      ]);
      await cliente.query("commit");
    } finally {
      cliente.release();
    }
    expect((await lead(id)).pos).toBe(6800);
  });

  it("conversa que já NASCE com mensagem do cliente também sobe o negócio", async () => {
    const contato = await novoContato();
    const id = await novoLead(contato, 6900);
    const menor = await menorDaEtapa(etapa.novo!);
    await pool.query(
      `insert into conversations (organization_id, contact_id, channel_session_id, status, last_inbound_at)
       values ($1, $2, $3, 'open', $4)`,
      [ORG, contato, sessao[ORG], agora().toISOString()],
    );
    expect((await lead(id)).pos).toBe(menor - 1000);
  });

  it("o arrasto manual continua possível depois (posição e trava otimista)", async () => {
    const contato = await novoContato();
    const conversa = await novaConversa(contato);
    const id = await novoLead(contato, 9100);
    await mensagem(conversa, "inbound", agora());
    const subido = await lead(id);

    // A pessoa arrasta o card para entre 2000 e 3000, com o updated_at que a
    // tela tinha ANTES da resposta chegar — e a trava otimista aceita.
    const { rowCount } = await pool.query(
      `update crm_leads set position_in_stage = 2500, updated_at = now()
        where id = $1 and updated_at = $2::timestamptz`,
      [id, subido.updated_at],
    );
    expect(rowCount).toBe(1);
    const arrastado = await lead(id);
    expect(arrastado.pos).toBe(2500);
    // Arrasto de pessoa é edição: aqui o updated_at anda, como sempre andou.
    expect(arrastado.updated_at).not.toBe(subido.updated_at);

    // E arrastar para o topo continua possível (midpoint(null, topo) = topo - 1000).
    const topo = await menorDaEtapa(etapa.novo!);
    await pool.query(`update crm_leads set position_in_stage = $2 where id = $1`, [id, topo - 1000]);
    expect((await lead(id)).pos).toBe(topo - 1000);
  });
});

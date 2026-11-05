import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { calcularQualidade, sinaisDaLinha, type LinhaDaQualidade } from "@/lib/dados/qualidade";

/**
 * v3 §2 (migration 9019) — OS FATOS DA NOTA DE QUALIDADE, contra o Postgres do
 * baseline.
 *
 *  - os fatos que a função junta (respostas DEPOIS da primeira mensagem da
 *    empresa, última resposta, chance da IA e da etapa, interesse, duplicado)
 *    dão, pela regra de `lib/dados/qualidade.ts`, a nota esperada de cada caso
 *    — a Joana da prévia tem 86, nível A;
 *  - o interesse sai do catálogo da PRÓPRIA organização: o campo, o marcador
 *    `ben-`/`srv-`/`int-` e as palavras do lead, nesta ordem; palavra de uma
 *    família sem tipo de lead no catálogo não vira interesse;
 *  - ⭐ SECURITY INVOKER: o atendente em "só os seus" recebe só os leads dele;
 *    de outra organização, nada; e a função não roda para `anon`;
 *  - ⭐ isolamento: a mensagem, o card perdido e o tipo de lead de OUTRA
 *    organização nunca entram na conta.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90190000-0000-4000-8000-00000000000a";
const OUTRA = "90190000-0000-4000-8000-00000000000b";
const GERENTE = "90190000-1111-4000-8000-000000000001";
const ATENDENTE_X = "90190000-1111-4000-8000-000000000002";
const ATENDENTE_Y = "90190000-1111-4000-8000-000000000003";
const ATENDENTE_DA_OUTRA = "90190000-1111-4000-8000-000000000004";

interface Funil {
  pipeline: string;
  triagem: string;
  proposta: string;
  ganho: string;
  perdido: string;
  sessao: string;
}
const funil: Record<string, Funil> = {};
const L: Record<string, string> = {};

const horasAtras = (h: number) => `now() - interval '${h} hours'`;

async function semearOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1,$2::text,$2::text,$2::text, jsonb_build_object('visibility_mode','own')) on conflict (id) do nothing`,
    [id, slug],
  );
  // A organização nasce com um funil padrão (gatilho); o deste teste passa a ser o padrão.
  await pool.query(`update crm_pipelines set is_default = false where organization_id = $1`, [id]);
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position, is_default) values ($1,'Prev','prev-9019',100,true) returning id`,
    [id],
  );
  const pipeline = p[0]!.id;
  const etapa = async (nome: string, slug: string, pos: number, extra: string) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, win_probability, is_won, is_lost)
       values ($1,$2,$3,$4,$5, ${extra}) returning id`,
      [id, pipeline, nome, slug, pos],
    );
    return rows[0]!.id;
  };
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1, $2, '\\x00'::bytea) returning id`,
    [id, `sessao-9019-${slug}`],
  );
  funil[id] = {
    pipeline,
    triagem: await etapa("Triagem", "triagem-9019", 1, "10, false, false"),
    proposta: await etapa("Proposta", "proposta-9019", 2, "70, false, false"),
    ganho: await etapa("Contratado", "ganho-9019", 3, "100, true, false"),
    perdido: await etapa("Perdido", "perdido-9019", 4, "0, false, true"),
    sessao: s[0]!.id,
  };
}

async function membro(org: string, user: string, papel: string): Promise<void> {
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, `${user}@invariant.test`]);
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3, now()) on conflict do nothing`,
    [user, org, papel],
  );
}

async function tipo(org: string, nome: string): Promise<void> {
  await pool.query(
    `insert into catalog_products (organization_id, codigo, nome, preco_cents, tipo_de_lead, controla_estoque, ativo)
     values ($1, $2, $3, 100000, true, false, true)`,
    [org, `tl-9019-${Math.random().toString(36).slice(2, 10)}`, nome],
  );
}

interface Caso {
  org?: string;
  etapa?: keyof Omit<Funil, "pipeline" | "sessao">;
  status?: "open" | "won" | "lost";
  dono?: string | null;
  campos?: Record<string, unknown>;
  tags?: string[];
  criadoHaHoras?: number;
  contato?: string;
  anuncio?: string;
  /** Mensagens: [direção, horas atrás, texto]. */
  mensagens?: Array<["inbound" | "outbound", number, string]>;
  /** [chance da IA, faixa] */
  score?: [number, "quente" | "morno" | "frio" | null];
}

/** Um contato com conversa (do dono do card) e as mensagens dele. */
async function contato(org: string, nome: string, dono: string | null): Promise<{ contato: string; conversa: string }> {
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1,$2) returning id`,
    [org, nome],
  );
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
     values ($1,$2,$3, $4, $5, case when $5::uuid is null then null else now() end) returning id`,
    [org, c[0]!.id, funil[org]!.sessao, dono ? "claimed" : "open", dono],
  );
  return { contato: c[0]!.id, conversa: v[0]!.id };
}

async function caso(titulo: string, k: Caso): Promise<string> {
  const org = k.org ?? ORG;
  const f = funil[org]!;
  const dono = k.dono === undefined ? GERENTE : k.dono;
  let contatoId = k.contato ?? null;
  let conversaId: string | null = null;
  if (!contatoId) {
    const c = await contato(org, `Contato ${titulo}`, dono);
    contatoId = c.contato;
    conversaId = c.conversa;
  } else {
    const { rows } = await pool.query<{ id: string }>(`select id from conversations where contact_id = $1 limit 1`, [contatoId]);
    conversaId = rows[0]?.id ?? null;
  }
  const status = k.status ?? "open";
  const etapa = k.etapa ?? (status === "won" ? "ganho" : status === "lost" ? "perdido" : "triagem");
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, status, lost_reason, closed_at,
                            owner_user_id, custom_fields, tags, created_at, source_metadata, source)
     values ($1,$2,$3,$4,$5,$6, case when $6 = 'lost' then 'other' end, case when $6 = 'open' then null else now() end,
             $7, $8, $9, ${horasAtras(k.criadoHaHoras ?? 1)}, $10, 'whatsapp')
     returning id`,
    [
      org,
      f.pipeline,
      f[etapa],
      contatoId,
      titulo,
      status,
      dono,
      JSON.stringify(k.campos ?? {}),
      k.tags ?? [],
      JSON.stringify(k.anuncio ? { ad_raw: { welcome_message: { text: k.anuncio } } } : {}),
    ],
  );
  const id = rows[0]!.id;
  for (const [direcao, h, texto] of k.mensagens ?? []) {
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, created_at, sent_at)
       values ($1,$2,$3,$4,'text',$5, $6, $7, $8, ${horasAtras(h)}, ${horasAtras(h)})`,
      [org, conversaId, f.sessao, contatoId, direcao, direcao === "inbound" ? "received" : "sent", direcao === "inbound" ? "external_device" : "ai", texto],
    );
  }
  if (k.score) {
    await pool.query(
      `insert into crm_lead_scores (lead_id, organization_id, ai_probability, ai_probability_band, ai_probability_reason, ai_probability_evidence, ai_probability_at)
       values ($1,$2,$3,$4,'Sinais da conversa', $5, now())`,
      [id, org, k.score[0], k.score[1], JSON.stringify({ factors: [{ pontos: 10, frase: "Respondeu", ancora: { kind: "lead", id } }] })],
    );
  }
  return id;
}

async function linhas(org: string, pipeline: string | null = null): Promise<Map<string, LinhaDaQualidade & Record<string, unknown>>> {
  const { rows } = await pool.query(`select * from public.fn_dados_qualidade_do_lead($1, $2)`, [org, pipeline]);
  return new Map(rows.map((r) => [r.lead_id as string, r]));
}

async function como(user: string, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const { rows } = await c.query(sql, params);
    return rows;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

/** A nota pela regra do TypeScript, com o `agora` do banco. */
async function notaDe(id: string, org = ORG) {
  const l = (await linhas(org)).get(id);
  if (!l) throw new Error(`lead ${id} sem linha`);
  const { rows } = await pool.query<{ agora: Date }>("select now() as agora");
  const json = JSON.parse(JSON.stringify(l)) as LinhaDaQualidade;
  return { linha: l, q: calcularQualidade(sinaisDaLinha(json), rows[0]!.agora) };
}

beforeAll(async () => {
  await semearOrg(ORG, "org-9019-a");
  await semearOrg(OUTRA, "org-9019-b");
  await membro(ORG, GERENTE, "manager");
  await membro(ORG, ATENDENTE_X, "agent");
  await membro(ORG, ATENDENTE_Y, "agent");
  await membro(OUTRA, ATENDENTE_DA_OUTRA, "agent");
  await tipo(ORG, "Auxílio-acidente");
  await tipo(ORG, "BPC/LOAS");
  // A OUTRA organização tem as famílias que a primeira não tem: nada disto pode
  // aparecer nos leads da primeira.
  await tipo(OUTRA, "Salário-maternidade");
  await tipo(OUTRA, "Aposentadoria por idade");

  // A Joana da prévia: 70% × 0,4 = 28, etapa ≥ 50% (+15), interesse (+15),
  // respondeu 4 vezes (+20), a última há 30 h (+8) = 86, nível A.
  L.joana = await caso("Joana P.", {
    etapa: "proposta",
    dono: ATENDENTE_X,
    campos: { servico: "auxilio acidente" },
    score: [70, null],
    criadoHaHoras: 50,
    mensagens: [
      ["inbound", 48, "oi, vi o anúncio"], // ANTES da primeira da empresa: não é resposta
      ["outbound", 47, "Olá! Como posso ajudar?"],
      ["inbound", 46, "quero saber do auxílio"],
      ["inbound", 45, "me machuquei no trabalho"],
      ["inbound", 40, "tenho laudo"],
      ["inbound", 30, "pode me ligar?"],
    ],
  });
  L.marcador = await caso("Pelo marcador", { dono: ATENDENTE_Y, tags: ["vip", "ben-bpc-loas"] });
  L.fala = await caso("Pela fala", {
    dono: ATENDENTE_X,
    mensagens: [
      ["outbound", 5, "Olá!"],
      ["inbound", 4, "Sofri um ACIDENTE de moto"],
    ],
  });
  L.semCatalogo = await caso("Família sem tipo no catálogo", {
    mensagens: [
      ["outbound", 5, "Olá!"],
      ["inbound", 4, "estou grávida de 5 meses"],
    ],
  });
  L.campoLivre = await caso("Campo fora do catálogo", { campos: { beneficio: "Aposentadoria especial" } });
  L.campoOutro = await caso("Campo sem família", { campos: { procedimento: "Revisão da vida toda" } });
  L.anuncio = await caso("Pelo anúncio", { anuncio: "Quero saber sobre auxílio por acidente" });

  const repetido = await contato(ORG, "Contato repetido", GERENTE);
  L.perdido = await caso("Card perdido", { status: "lost", contato: repetido.contato });
  L.duplicado = await caso("Card duplicado", {
    etapa: "proposta",
    contato: repetido.contato,
    score: [90, "quente"],
    mensagens: [
      ["outbound", 3, "Olá"],
      ["inbound", 2, "oi"],
    ],
  });
  L.ganho = await caso("Card ganho", { status: "won" });
  L.calado = await caso("Nunca respondeu", { criadoHaHoras: 60, mensagens: [["outbound", 59, "Olá!"]] });

  // ⭐ A OUTRA organização: um contato com o MESMO nome e um card perdido.
  await caso("Contato repetido", { org: OUTRA, status: "lost", dono: ATENDENTE_DA_OUTRA });
  L.daOutra = await caso("Lead da outra", {
    org: OUTRA,
    dono: ATENDENTE_DA_OUTRA,
    mensagens: [
      ["outbound", 5, "Olá!"],
      ["inbound", 4, "estou grávida"],
    ],
  });
});

afterAll(async () => {
  await pool.end();
});

describe("9019 — os fatos dão a nota da regra", () => {
  it("a Joana da prévia: 86, nível A, e a parcela de cada fato", async () => {
    const { linha, q } = await notaDe(L.joana!);
    expect(linha).toMatchObject({
      mensagens_da_empresa: 1,
      respostas: 4,
      chance_da_etapa: 70,
      interesse: "Auxílio-acidente",
      interesse_registrado: true,
      duplicado_de_desqualificado: false,
      no_universo: true,
    });
    expect(q.nota).toBe(86);
    expect(q.nivel).toBe("A");
    expect(q.parcelas.map((p) => [p.chave, p.pontos])).toEqual([
      ["chance", 28],
      ["etapa", 15],
      ["interesse", 15],
      ["respondeu_engajado", 20],
      ["janela_longa", 8],
    ]);
    expect(q.situacoes).toEqual(["esperando_fechamento"]);
  });

  it("nunca respondeu e entrou há 60 h: −10; nota 0 (o limite)", async () => {
    const { linha, q } = await notaDe(L.calado!);
    expect(linha).toMatchObject({ mensagens_da_empresa: 1, respostas: 0, ultima_resposta_em: null });
    // 10% × 0,4 = 4, −10 → −6 → 0
    expect(q.nota).toBe(0);
    expect(q.parcelas.map((p) => p.chave)).toEqual(["chance", "nunca_respondeu", "limite"]);
  });

  it("ganho = 100; perdido = 0; card duplicado de contato desqualificado = 0", async () => {
    expect((await notaDe(L.ganho!)).q).toMatchObject({ nota: 100, estado: "ganho" });
    expect((await notaDe(L.perdido!)).q).toMatchObject({ nota: 0, estado: "perdido" });
    const dup = await notaDe(L.duplicado!);
    expect(dup.linha.duplicado_de_desqualificado).toBe(true);
    expect(dup.q).toMatchObject({ nota: 0, nivel: "D", estado: "duplicado" });
  });

  it("o recorte por funil devolve só o funil pedido", async () => {
    const todas = await linhas(ORG, funil[ORG]!.pipeline);
    expect(todas.has(L.joana!)).toBe(true);
    const nenhum = await linhas(ORG, "90190000-9999-4000-8000-000000000000");
    expect(nenhum.size).toBe(0);
  });
});

describe("9019 — o interesse sai do catálogo da própria organização", () => {
  it("campo → o nome do tipo de lead; marcador ben- → o tipo; palavras do lead → a família com tipo", async () => {
    const m = await linhas(ORG);
    expect(m.get(L.joana!)).toMatchObject({ interesse: "Auxílio-acidente", interesse_registrado: true });
    expect(m.get(L.marcador!)).toMatchObject({ interesse: "BPC/LOAS", interesse_registrado: true });
    expect(m.get(L.fala!)).toMatchObject({ interesse: "Auxílio-acidente", interesse_registrado: false });
    expect(m.get(L.anuncio!)).toMatchObject({ interesse: "Auxílio-acidente", interesse_registrado: false });
  });

  it("campo fora do catálogo: a família da ordem, ou o texto como foi escrito", async () => {
    const m = await linhas(ORG);
    // A OUTRA organização tem "Aposentadoria por idade" — não vale aqui.
    expect(m.get(L.campoLivre!)?.interesse).toBe("Aposentadoria");
    expect(m.get(L.campoOutro!)?.interesse).toBe("Revisão da vida toda");
  });

  it("palavra de família SEM tipo no catálogo não vira interesse (nem com o tipo da outra organização)", async () => {
    const m = await linhas(ORG);
    expect(m.get(L.semCatalogo!)?.interesse).toBeNull();
    // Na outra, que TEM "Salário-maternidade", a mesma palavra vira interesse.
    expect((await linhas(OUTRA)).get(L.daOutra!)?.interesse).toBe("Salário-maternidade");
  });
});

describe("9019 — ⭐ security invoker: vale a RLS de quem pergunta", () => {
  it("a função é SECURITY INVOKER e não roda para anon", async () => {
    const { rows } = await pool.query(
      `select p.prosecdef,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as autenticado
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fn_dados_qualidade_do_lead'`,
    );
    expect(rows).toEqual([{ prosecdef: false, anon: false, autenticado: true }]);
  });

  it("o gerente recebe todos os leads da organização", async () => {
    const rows = await como(GERENTE, `select lead_id from public.fn_dados_qualidade_do_lead($1)`, [ORG]);
    const ids = new Set(rows.map((r) => r.lead_id));
    for (const k of ["joana", "marcador", "fala", "ganho", "duplicado"]) expect(ids.has(L[k])).toBe(true);
  });

  it("o atendente em \"só os seus\" recebe só os dele, com os mesmos fatos do gerente", async () => {
    const rows = await como(ATENDENTE_X, `select lead_id, respostas, interesse from public.fn_dados_qualidade_do_lead($1)`, [ORG]);
    expect(new Set(rows.map((r) => r.lead_id))).toEqual(new Set([L.joana, L.fala]));
    expect(rows.find((r) => r.lead_id === L.joana)).toMatchObject({ respostas: 4, interesse: "Auxílio-acidente" });
    const y = await como(ATENDENTE_Y, `select lead_id from public.fn_dados_qualidade_do_lead($1)`, [ORG]);
    expect(y.map((r) => r.lead_id)).toEqual([L.marcador]);
  });

  it("⭐ quem é de outra organização não recebe nada, nem passando o id dela", async () => {
    const rows = await como(ATENDENTE_DA_OUTRA, `select lead_id from public.fn_dados_qualidade_do_lead($1)`, [ORG]);
    expect(rows).toEqual([]);
    const a = await como(ATENDENTE_X, `select lead_id from public.fn_dados_qualidade_do_lead($1)`, [OUTRA]);
    expect(a).toEqual([]);
  });

  it("⭐ o card perdido da OUTRA organização não marca o contato de mesmo nome desta como duplicado", async () => {
    const m = await linhas(ORG);
    const desta = [...m.values()].filter((r) => r.duplicado_de_desqualificado);
    expect(desta.map((r) => r.lead_id)).toEqual([L.duplicado]);
  });
});

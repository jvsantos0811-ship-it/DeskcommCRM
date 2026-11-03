/**
 * PASSAGEM ENTRE AGENTES DO ROTEADOR — PELA TELA (PC-014, fork).
 *
 * O que a pessoa da equipe vê e faz, num número com roteador (Recepção →
 * Raquel → especialista):
 *
 *   1. a Central mostra o painel de passagens do dia, com os quatro números
 *      (passagens, sem resposta do destino em 2 min, laços, roteador ×
 *      ferramenta) e de quem para quem;
 *   2. o card do negócio mostra o CARTÃO da passagem, fixo abaixo do contato,
 *      no formato padronizado e sem telefone;
 *   3. a conversa passada para a equipe só volta para a IA pelo clique em
 *      "Devolver": com roteador, a pessoa escolhe o agente e escreve em uma
 *      linha o que fez — e a conversa fica com o agente escolhido.
 *
 * O turno do agente (a ferramenta `passar_para_agente` chamada pelo modelo e o
 * turno do destino que fala primeiro) é provado contra o Postgres do baseline em
 * `tests/invariants/passagem-entre-agentes.test.ts`; aqui as passagens já
 * gravadas são semeadas pelo cliente de serviço.
 *
 * Capturas em `evidence/pc-014/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-014");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string; id: string }>;
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager || !c.org_id;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`) });
}

interface Cenario {
  conversa: string;
  contato: string;
  pipeline: string;
  titulo: string;
  raquel: string;
  recepcao: string;
  nomeDaRaquel: string;
  cartao: string;
}

async function agentePublicado(org: string, nome: string): Promise<string> {
  const id = randomUUID();
  const { error: e1 } = await admin.from("ai_agents").insert({ id, organization_id: org, name: nome, system_prompt: "s" });
  if (e1) throw new Error(`agente: ${e1.message}`);
  const versao = randomUUID();
  const { error: e2 } = await admin.from("ai_agent_versions").insert({
    id: versao,
    organization_id: org,
    agent_id: id,
    version_number: 1,
    system_prompt: "s",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    status: "published",
  });
  if (e2) throw new Error(`versão: ${e2.message}`);
  const { error: e3 } = await admin.from("ai_agents").update({ published_version_id: versao }).eq("id", id);
  if (e3) throw new Error(`publicar: ${e3.message}`);
  return id;
}

async function cenario(): Promise<Cenario> {
  const org = creds.org_id;
  const sufixo = String(Date.now()).slice(-8);
  const titulo = `Passagem E2E ${sufixo}`;
  const nomeDaRaquel = `Raquel ${sufixo}`;

  const { data: sessao, error: e0 } = await admin
    .from("channel_sessions")
    .insert({ organization_id: org, waha_session_name: `e2e-passagem-${sufixo}`, webhook_secret_encrypted: "\\x00", status: "STOPPED" })
    .select("id")
    .single();
  if (e0 || !sessao) throw new Error(`sessão: ${e0?.message}`);

  const recepcao = await agentePublicado(org, `Recepção ${sufixo}`);
  const raquel = await agentePublicado(org, nomeDaRaquel);
  const { data: roteador, error: e1 } = await admin
    .from("ai_routers")
    .insert({ organization_id: org, name: `Roteador ${sufixo}`, channel_session_id: sessao.id, is_active: true, fallback_agent_id: recepcao })
    .select("id")
    .single();
  if (e1 || !roteador) throw new Error(`roteador: ${e1?.message}`);
  const { error: e2 } = await admin.from("ai_router_members").insert({
    organization_id: org,
    router_id: roteador.id,
    agent_id: raquel,
    intent_name: "auxilio",
    intent_description: "auxílio-acidente",
  });
  if (e2) throw new Error(`membro: ${e2.message}`);

  const nome = `Maria Passagem ${sufixo}`;
  const { data: contato, error: e3 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+55319${sufixo}`, display_name: nome, name: nome })
    .select("id")
    .single();
  if (e3 || !contato) throw new Error(`contato: ${e3?.message}`);

  // A conversa foi passada para a equipe: a IA está calada até alguém devolver.
  const agora = new Date();
  const { data: conversa, error: e4 } = await admin
    .from("conversations")
    .insert({
      organization_id: org,
      contact_id: contato.id,
      channel_session_id: sessao.id,
      status: "pending",
      bot_silenced_until: "infinity",
      last_handoff_at: agora.toISOString(),
      last_handoff_reason: "pediu uma pessoa",
      last_inbound_at: agora.toISOString(),
      last_message_at: agora.toISOString(),
    })
    .select("id")
    .single();
  if (e4 || !conversa) throw new Error(`conversa: ${e4?.message}`);
  const { error: e5 } = await admin.from("messages").insert({
    organization_id: org,
    conversation_id: conversa.id,
    channel_session_id: sessao.id,
    contact_id: contato.id,
    direction: "inbound",
    status: "received",
    sent_via: "external_device",
    type: "text",
    body: "Quero falar com uma pessoa, por favor",
    sent_at: agora.toISOString(),
  });
  if (e5) throw new Error(`mensagem: ${e5.message}`);

  const pipeline = randomUUID();
  const { error: e6 } = await admin
    .from("crm_pipelines")
    .insert({ id: pipeline, organization_id: org, name: `Funil passagem ${sufixo}`, slug: `funil-passagem-${sufixo}` });
  if (e6) throw new Error(`funil: ${e6.message}`);
  const etapa = randomUUID();
  const { error: e7 } = await admin
    .from("crm_stages")
    .insert({ id: etapa, organization_id: org, pipeline_id: pipeline, name: "Em análise", slug: "em-analise", position: 1000 });
  if (e7) throw new Error(`etapa: ${e7.message}`);
  const { error: e8 } = await admin.from("crm_leads").insert({
    organization_id: org,
    pipeline_id: pipeline,
    stage_id: etapa,
    title: titulo,
    contact_id: contato.id,
    owner_kind: "user",
    owner_user_id: creds.users.manager!.id,
  });
  if (e8) throw new Error(`negócio: ${e8.message}`);

  // As passagens de hoje: uma pela ferramenta (com o cartão), uma pela regra do
  // roteador e um laço (a 3ª na mesma hora, que não passou).
  const cartao = [
    `Nome confirmado: ${nome}`,
    "Quem fala: a própria",
    "Benefício e situação: auxílio-acidente; negado no INSS",
    "Qualificação: não informado",
    "Urgência: nenhuma",
    "O que falta: data do acidente",
    "Próximo passo: pedir os documentos",
    "Jeito do cliente: manda áudio",
  ].join("\n");
  const base = { organization_id: org, conversation_id: conversa.id, contact_id: contato.id, router_id: roteador.id };
  const { error: e9 } = await admin.from("passagens_entre_agentes").insert([
    {
      ...base,
      de_agente_id: recepcao,
      para_agente_id: raquel,
      intencao: "auxilio",
      origem: "ferramenta",
      desfecho: "passou",
      motivo: "confirmou nome e benefício",
      cartao,
      destino_respondeu_em: new Date(agora.getTime() + 20_000).toISOString(),
      created_at: agora.toISOString(),
    },
    { ...base, de_agente_id: raquel, para_agente_id: recepcao, origem: "roteador", desfecho: "passou" },
    { ...base, de_agente_id: recepcao, para_agente_id: raquel, intencao: "auxilio", origem: "ferramenta", desfecho: "laco" },
  ]);
  if (e9) throw new Error(`passagens: ${e9.message}`);

  return { conversa: conversa.id, contato: contato.id, pipeline, titulo, raquel, recepcao, nomeDaRaquel, cartao };
}

test.describe("PC-014 — passagem entre agentes pela tela", () => {
  test.describe.configure({ mode: "serial" });
  let c: Cenario;

  test.beforeAll(async () => {
    c = await cenario();
  });

  test("a Central mostra o painel de passagens do dia", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto("/app/ai/inbox");
    const painel = page.getByTestId("painel-de-passagens");
    await expect(painel).toBeVisible({ timeout: 30_000 });
    await expect(painel.getByRole("heading", { name: "Passagens entre agentes" })).toBeVisible();
    // Pelo menos as duas desta conversa (a organização de teste pode ter outras).
    expect(Number(await painel.getByTestId("passagens-total").innerText())).toBeGreaterThanOrEqual(2);
    expect(Number(await painel.getByTestId("passagens-lacos").innerText())).toBeGreaterThanOrEqual(1);
    await expect(painel.getByTestId("passagens-roteador-ferramenta")).toContainText("×");
    await expect(painel.getByTestId("passagens-pares")).toContainText(c.nomeDaRaquel);
    await captura(page, "central-painel-de-passagens");
  });

  test("o card do negócio mostra o cartão da passagem, fixo abaixo do contato", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto(`/app/pipelines/${c.pipeline}`);
    const card = page.getByRole("group", { name: `Lead: ${c.titulo}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: c.titulo }).click();
    const dossie = page.getByRole("dialog");
    const cartao = dossie.getByTestId("cartao-da-passagem");
    await expect(cartao).toBeVisible({ timeout: 30_000 });
    await expect(cartao).toContainText("Cartão da passagem");
    await expect(cartao).toContainText(c.nomeDaRaquel);
    await expect(cartao).toContainText("Próximo passo: pedir os documentos");
    await expect(cartao).not.toContainText("+5531");
    await captura(page, "card-cartao-da-passagem");
  });

  test("Devolver: com roteador, escolhe o agente e escreve o que fez; a conversa fica com ele", async ({ page }) => {
    test.setTimeout(150_000);
    await login(page);
    await page.goto(`/app/inbox/${c.conversa}`);
    const devolver = page.getByTestId("devolver-ao-automatico");
    await expect(devolver).toBeVisible({ timeout: 30_000 });
    await devolver.click();

    const dialogo = page.getByTestId("devolver-para-agente-dialogo");
    await expect(dialogo).toBeVisible();
    const confirmar = dialogo.getByTestId("devolver-para-agente-confirmar");
    await expect(confirmar, "sem agente e sem a linha, não devolve").toBeDisabled();
    await dialogo.getByTestId("devolver-agente").click();
    await page.getByRole("option", { name: c.nomeDaRaquel }).click();
    await dialogo.getByTestId("devolver-nota").fill("Confirmei os documentos por telefone");
    await captura(page, "devolver-para-agente");
    await expect(confirmar).toBeEnabled();
    await confirmar.click();
    await expect(dialogo).toBeHidden({ timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("conversations")
            .select("active_ai_agent_id, bot_silenced_until")
            .eq("id", c.conversa)
            .single();
          return data;
        },
        { timeout: 30_000 },
      )
      .toEqual({ active_ai_agent_id: c.raquel, bot_silenced_until: null });

    const { data: volta } = await admin
      .from("passagens_entre_agentes")
      .select("origem, para_agente_id, cartao, por_user_id")
      .eq("conversation_id", c.conversa)
      .eq("origem", "equipe");
    expect(volta).toEqual([
      {
        origem: "equipe",
        para_agente_id: c.raquel,
        cartao: "Confirmei os documentos por telefone",
        por_user_id: creds.users.manager!.id,
      },
    ]);
  });
});

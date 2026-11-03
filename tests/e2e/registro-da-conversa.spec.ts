/**
 * "CONVERSA ATÉ AQUI" NO CARD DO NEGÓCIO — PELA TELA (PC-019, fork).
 *
 * O que a pessoa da equipe vê ao abrir o card: o mesmo registro que todo agente
 * lê no turno — o que a IA já perguntou e o cliente respondeu, o que ficou sem
 * resposta, as licenças dadas e o que foi prometido (pendente ou vencida). Saúde
 * só como tema ("dados de saúde: Sim"), nunca diagnóstico.
 *
 * A gravação pelo fechamento do turno e a trava de repetição lendo o registro
 * são provadas contra o Postgres do baseline em
 * `tests/invariants/registro-da-conversa.test.ts`; aqui o registro já gravado é
 * semeado pelo cliente de serviço.
 *
 * Capturas em `evidence/pc-019/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-019");

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

interface Cenario {
  pipeline: string;
  titulo: string;
}

async function cenario(): Promise<Cenario> {
  const org = creds.org_id;
  const sufixo = String(Date.now()).slice(-8);
  const titulo = `Registro E2E ${sufixo}`;
  const nome = `Joana Registro ${sufixo}`;

  const { data: contato, error: e1 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+55318${sufixo}`, display_name: nome, name: nome })
    .select("id")
    .single();
  if (e1 || !contato) throw new Error(`contato: ${e1?.message}`);

  const pipeline = randomUUID();
  const { error: e2 } = await admin
    .from("crm_pipelines")
    .insert({ id: pipeline, organization_id: org, name: `Funil registro ${sufixo}`, slug: `funil-registro-${sufixo}` });
  if (e2) throw new Error(`funil: ${e2.message}`);
  const etapa = randomUUID();
  const { error: e3 } = await admin
    .from("crm_stages")
    .insert({ id: etapa, organization_id: org, pipeline_id: pipeline, name: "Em análise", slug: "em-analise", position: 1000 });
  if (e3) throw new Error(`etapa: ${e3.message}`);
  const { error: e4 } = await admin.from("crm_leads").insert({
    organization_id: org,
    pipeline_id: pipeline,
    stage_id: etapa,
    title: titulo,
    contact_id: contato.id,
    owner_kind: "user",
    owner_user_id: creds.users.manager!.id,
  });
  if (e4) throw new Error(`negócio: ${e4.message}`);

  // O registro como o fechamento do turno o grava (todas as linhas com as
  // mesmas chaves: o insert em lote manda NULL na coluna que falta).
  const agora = Date.now();
  const linha = (
    tipo: string,
    tema: string,
    status: string,
    extra: { resposta?: string | null; prazo?: string | null; vezes?: number; minutosAtras?: number },
  ) => ({
    organization_id: org,
    contact_id: contato.id,
    tipo,
    tema,
    chave: tema.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
    status,
    pergunta: null,
    resposta: extra.resposta ?? null,
    prazo: extra.prazo ?? null,
    vezes: extra.vezes ?? 1,
    atualizado_em: new Date(agora - (extra.minutosAtras ?? 0) * 60_000).toISOString(),
    resolvido_em: status === "sem_resposta" || status === "pendente" ? null : new Date(agora - (extra.minutosAtras ?? 0) * 60_000).toISOString(),
  });
  const { error: e5 } = await admin.from("registro_da_conversa").insert([
    linha("pergunta", "cidade", "respondida", { resposta: "Contagem", minutosAtras: 30 }),
    linha("pergunta", "licença de saúde", "respondida", { resposta: "sim", minutosAtras: 25 }),
    linha("pergunta", "data do acidente", "sem_resposta", { vezes: 2, minutosAtras: 10 }),
    linha("licenca", "dados de saúde", "concedida", { minutosAtras: 25 }),
    linha("promessa", "a equipe fala com você amanhã às 8h", "pendente", {
      prazo: new Date(agora + 20 * 3600_000).toISOString(),
      minutosAtras: 5,
    }),
    linha("promessa", "mandar a lista de documentos", "pendente", {
      prazo: new Date(agora - 3600_000).toISOString(),
      minutosAtras: 120,
    }),
  ]);
  if (e5) throw new Error(`registro: ${e5.message}`);
  return { pipeline, titulo };
}

test.describe("PC-019 — Conversa até aqui no card do negócio", () => {
  let c: Cenario;

  test.beforeAll(async () => {
    c = await cenario();
  });

  test("a equipe vê o que já foi perguntado, respondido, autorizado e prometido", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto(`/app/pipelines/${c.pipeline}`);
    const card = page.getByRole("group", { name: `Lead: ${c.titulo}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: c.titulo }).click();
    const dossie = page.getByRole("dialog");
    const bloco = dossie.getByTestId("conversa-ate-aqui");
    await expect(bloco).toBeVisible({ timeout: 30_000 });
    await expect(bloco).toContainText("Conversa até aqui");
    await expect(bloco.getByTestId("registro-respondidas")).toContainText("cidade: Contagem");
    await expect(bloco.getByTestId("registro-respondidas")).toContainText("licença de saúde: sim");
    await expect(bloco.getByTestId("registro-sem-resposta")).toContainText("data do acidente (2x)");
    await expect(bloco.getByTestId("registro-licencas")).toContainText("dados de saúde: Sim");
    const promessas = bloco.getByTestId("registro-promessas");
    await expect(promessas).toContainText("a equipe fala com você amanhã às 8h · Pendente");
    await expect(promessas).toContainText("mandar a lista de documentos · Vencida");
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "card-conversa-ate-aqui.png") });
  });
});

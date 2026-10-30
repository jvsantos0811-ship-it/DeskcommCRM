import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As ferramentas do prompt do agente (porta Admin) contra um banco de mentira
 * em memória: o que importa aqui é a DECISÃO — rascunho existente é atualizado,
 * sem rascunho nasce cópia, versão no ar nunca é tocada, pedido não publica,
 * voltar só para versão que já esteve no ar.
 */

vi.mock("@/lib/ai/agents/publish", () => ({ publishAgentVersion: vi.fn() }));
vi.mock("@/lib/ai/agents/escopo", () => ({
  validarEscopoDaVersao: vi.fn(async () => ({ ok: true })),
  codigoDoEscopo: () => "escopo",
  mensagemDoEscopo: () => "escopo",
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/ambiente", () => ({ lerAmbiente: () => ({ chavesDeProvedor: { anthropic: true } }) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.exemplo/" } }));
vi.mock("@/lib/mcp/tools", () => ({ VALID_TOOL_IDS: ["crm_list_leads"] }));

import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { audit } from "@/lib/audit";

import type { McpContext } from "../types";
import {
  crmGetAiAgentPrompt,
  crmRequestAiAgentPublish,
  crmRevertAiAgentVersion,
  crmSaveAiAgentDraft,
} from "./ferramentas-do-agente";

type Linha = Record<string, unknown>;
const ORG = "00000000-0000-4000-8000-0000000000aa";
const AGENTE = "00000000-0000-4000-8000-0000000000a1";

/** Um construtor de consulta mínimo: eq, is, order, limit, maybeSingle, single, insert, update, delete. */
function bancoDeMentira(tabelas: Record<string, Linha[]>) {
  function consulta(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let ordem: { col: string; asc: boolean } | null = null;
    let limite: number | null = null;
    let modo: "select" | "insert" | "update" | "delete" = "select";
    let carga: Linha | null = null;
    const linhas = () => {
      let r = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      if (ordem) {
        const { col, asc } = ordem;
        r = [...r].sort((a, b) => ((a[col] as number) - (b[col] as number)) * (asc ? 1 : -1));
      }
      return limite === null ? r : r.slice(0, limite);
    };
    const executar = () => {
      if (modo === "insert") {
        const nova = { id: `v-${(tabelas[tabela] ?? []).length + 1}`, ...carga, published_at: null };
        (tabelas[tabela] ??= []).push(nova);
        return [nova];
      }
      if (modo === "update") {
        const alvo = linhas();
        for (const l of alvo) Object.assign(l, carga);
        return alvo;
      }
      if (modo === "delete") {
        const alvo = new Set(linhas());
        tabelas[tabela] = (tabelas[tabela] ?? []).filter((l) => !alvo.has(l));
        return [...alvo];
      }
      return linhas();
    };
    const q = {
      select: () => q,
      insert: (l: Linha) => ((modo = "insert"), (carga = l), q),
      update: (l: Linha) => ((modo = "update"), (carga = l), q),
      delete: () => ((modo = "delete"), q),
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      order: (c: string, o: { ascending: boolean }) => ((ordem = { col: c, asc: o.ascending }), q),
      limit: (n: number) => ((limite = n), q),
      maybeSingle: async () => ({ data: executar()[0] ?? null, error: null }),
      single: async () => ({ data: executar()[0] ?? null, error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) => Promise.resolve({ data: executar(), error: null }).then(ok),
    };
    return q;
  }
  return { from: (t: string) => consulta(t) };
}

function versao(numero: number, status: string, extra: Linha = {}): Linha {
  return {
    id: `v${numero}`,
    organization_id: ORG,
    agent_id: AGENTE,
    version_number: numero,
    status,
    system_prompt: `prompt da v${numero}`,
    provider: "anthropic",
    model: "claude",
    credential_id: null,
    tool_ids: ["crm_list_leads"],
    created_at: `2026-10-0${numero}T00:00:00Z`,
    published_at: status === "draft" ? null : `2026-10-0${numero}T00:00:00Z`,
    ...extra,
  };
}

let tabelas: Record<string, Linha[]>;
let ctx: McpContext;

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    ai_agents: [{ id: AGENTE, organization_id: ORG, name: "Raquel", archived_at: null, paused_at: null, published_version_id: "v2" }],
    ai_agent_versions: [versao(1, "superseded"), versao(2, "published")],
    event_log: [],
  };
  ctx = {
    organizationId: ORG,
    role: "manager",
    actor: { type: "api_token", id: "tok", role: "manager" },
    apiTokenId: "tok",
    requestId: "req",
    supabase: bancoDeMentira(tabelas) as never,
  };
});

describe("crm_save_ai_agent_draft", () => {
  it("sem rascunho: nasce a v3 como RASCUNHO, cópia da no ar com o prompt novo; a v2 no ar não muda", async () => {
    const r = (await crmSaveAiAgentDraft.handler({ agent_id: AGENTE, system_prompt: "prompt novo e melhor" }, ctx)) as Linha;
    expect(r).toMatchObject({ criado: true, no_ar: false, rascunho: { numero: 3 } });
    const v3 = tabelas.ai_agent_versions!.find((v) => v.version_number === 3)!;
    expect(v3).toMatchObject({ status: "draft", system_prompt: "prompt novo e melhor", provider: "anthropic", created_by: null });
    expect(tabelas.ai_agent_versions!.find((v) => v.id === "v2")!.system_prompt).toBe("prompt da v2");
    expect(tabelas.ai_agents![0]!.published_version_id).toBe("v2");
    expect(publishAgentVersion).not.toHaveBeenCalled();
  });

  it("com rascunho em aberto: atualiza o MESMO rascunho, sem criar outro", async () => {
    tabelas.ai_agent_versions!.push(versao(3, "draft"));
    const r = (await crmSaveAiAgentDraft.handler({ agent_id: AGENTE, system_prompt: "segunda redação" }, ctx)) as Linha;
    expect(r).toMatchObject({ criado: false, rascunho: { id: "v3", numero: 3 } });
    expect(tabelas.ai_agent_versions).toHaveLength(3);
    expect(tabelas.ai_agent_versions!.find((v) => v.id === "v3")!.system_prompt).toBe("segunda redação");
  });

  it("rascunho ANTERIOR ao que está no ar não é regravado: nasce um novo", async () => {
    tabelas.ai_agent_versions = [versao(1, "draft"), versao(2, "published")];
    ctx = { ...ctx, supabase: bancoDeMentira(tabelas) as never };
    await crmSaveAiAgentDraft.handler({ agent_id: AGENTE, system_prompt: "prompt depois do superado" }, ctx);
    expect(tabelas.ai_agent_versions!.find((v) => v.id === "v1")!.system_prompt).toBe("prompt da v1");
    expect(tabelas.ai_agent_versions!.find((v) => v.version_number === 3)!.status).toBe("draft");
  });

  it("agente de outra organização: não acha", async () => {
    ctx = { ...ctx, organizationId: "00000000-0000-4000-8000-0000000000bb" };
    await expect(crmSaveAiAgentDraft.handler({ agent_id: AGENTE, system_prompt: "qualquer coisa aqui" }, ctx)).rejects.toThrow(
      /not_found/,
    );
  });
});

describe("crm_request_ai_agent_publish", () => {
  it("sem rascunho em aberto: recusa", async () => {
    await expect(
      crmRequestAiAgentPublish.handler({ agent_id: AGENTE, motivo: "melhorar a triagem" }, ctx),
    ).rejects.toThrow(/no_draft/);
  });

  it("com rascunho: registra o pedido com o link e NÃO publica", async () => {
    tabelas.ai_agent_versions!.push(versao(3, "draft"));
    const r = (await crmRequestAiAgentPublish.handler({ agent_id: AGENTE, motivo: "melhorar a triagem" }, ctx)) as Linha;
    expect(r).toMatchObject({
      pedido: "registrado",
      rascunho: { numero: 3 },
      versao_no_ar: 2,
      link_para_publicar: `https://crm.exemplo/app/ai/agents/${AGENTE}`,
    });
    expect(publishAgentVersion).not.toHaveBeenCalled();
    expect(tabelas.ai_agents![0]!.published_version_id).toBe("v2");
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ action: "ai_agent.publicacao_pedida", actorApiTokenId: "tok" });
  });
});

describe("crm_revert_ai_agent_version", () => {
  it("volta para a v1 (já esteve no ar): copia como v3 e publica a cópia", async () => {
    vi.mocked(publishAgentVersion).mockResolvedValue({
      ok: true,
      agent_id: AGENTE,
      version_id: "v-3",
      previous_version_id: "v2",
      published_at: "2026-10-30T00:00:00Z",
    });
    const r = (await crmRevertAiAgentVersion.handler({ agent_id: AGENTE, version_id: "v1" }, ctx)) as Linha;
    const v3 = tabelas.ai_agent_versions!.find((v) => v.version_number === 3)!;
    expect(v3.system_prompt).toBe("prompt da v1");
    expect(vi.mocked(publishAgentVersion).mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      agentId: AGENTE,
      versionId: v3.id,
      quemPublicou: { actorApiTokenId: "tok" },
    });
    expect(r).toMatchObject({ no_ar: { numero: 3, copia_de: "v1" }, versao_anterior: "v2" });
  });

  it("recusa rascunho que nunca esteve no ar e a própria versão no ar", async () => {
    tabelas.ai_agent_versions!.push(versao(3, "draft"));
    await expect(crmRevertAiAgentVersion.handler({ agent_id: AGENTE, version_id: "v3" }, ctx)).rejects.toThrow(/never_published/);
    await expect(crmRevertAiAgentVersion.handler({ agent_id: AGENTE, version_id: "v2" }, ctx)).rejects.toThrow(/already_live/);
    expect(publishAgentVersion).not.toHaveBeenCalled();
  });

  it("se publicar falha, a cópia em rascunho é apagada", async () => {
    vi.mocked(publishAgentVersion).mockResolvedValue({ ok: false, code: "channel_session_not_found", message: "sem canal" });
    await expect(crmRevertAiAgentVersion.handler({ agent_id: AGENTE, version_id: "v1" }, ctx)).rejects.toThrow(
      /channel_session_not_found/,
    );
    expect(tabelas.ai_agent_versions!.map((v) => v.version_number).sort()).toEqual([1, 2]);
  });
});

describe("crm_get_ai_agent_prompt", () => {
  it("devolve o texto no ar, o rascunho e quais versões dá para voltar", async () => {
    tabelas.ai_agent_versions!.push(versao(3, "draft"));
    const r = (await crmGetAiAgentPrompt.handler({ agent_id: AGENTE }, ctx)) as {
      publicada: Linha;
      rascunho: Linha;
      historico: Array<{ numero: number; pode_voltar_para_ela: boolean }>;
    };
    expect(r.publicada).toMatchObject({ numero: 2, system_prompt: "prompt da v2" });
    expect(r.rascunho).toMatchObject({ numero: 3, system_prompt: "prompt da v3" });
    expect(Object.fromEntries(r.historico.map((h) => [h.numero, h.pode_voltar_para_ela]))).toEqual({ 1: true, 2: false, 3: false });
  });
});

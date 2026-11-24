import { describe, expect, it, vi } from "vitest";

vi.mock("../contato-por-telefone", () => ({ encontrarContatoPorTelefone: vi.fn(async () => null) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { campoPodeSerVoto, interpretarVoto, nomesDosCampos, tratarEnqueteDoPost, valorDoCampo, type EnqueteCadastrada } from "./enquete";

const REPARADORA: EnqueteCadastrada = {
  id: "e1",
  codigo: "reparadora",
  pergunta: "Quer saber se o seu caso tem reparadora?",
  ativa: true,
  opcoes: [
    { valor: "Quero que me chamem", significado: "Pede contato no privado", chamar: true },
    { valor: "Agora não", significado: "Não quer contato", chamar: false },
  ],
};
const OUTRA: EnqueteCadastrada = { ...REPARADORA, id: "e2", codigo: "plano", opcoes: [{ valor: "Sim", significado: "", chamar: true }] };

describe("o voto que o diálogo manda (PC-050)", () => {
  it("⭐ contrato recomendado enquete:<código>:<opção>, sem acento e sem caixa", () => {
    expect(interpretarVoto("enquete:reparadora:quero que me chamem", [REPARADORA, OUTRA])).toMatchObject({ enquete: { id: "e1" }, opcao: { chamar: true } });
    expect(interpretarVoto("ENQUETE:reparadora:Agora nao", [REPARADORA, OUTRA])).toMatchObject({ opcao: { valor: "Agora não", chamar: false } });
  });

  it("<código>:<opção> também; só a opção, apenas com UMA enquete ativa", () => {
    expect(interpretarVoto("plano:Sim", [REPARADORA, OUTRA])).toMatchObject({ enquete: { id: "e2" } });
    expect(interpretarVoto("Agora não", [REPARADORA, OUTRA])).toBeNull();
    expect(interpretarVoto("Agora não", [REPARADORA, { ...OUTRA, ativa: false }])).toMatchObject({ enquete: { id: "e1" } });
  });

  it("enquete inativa, código ou opção desconhecidos: não é voto", () => {
    expect(interpretarVoto("enquete:reparadora:Talvez", [REPARADORA])).toBeNull();
    expect(interpretarVoto("enquete:outra:Sim", [REPARADORA])).toBeNull();
    expect(interpretarVoto("enquete:reparadora:Agora não", [{ ...REPARADORA, ativa: false }])).toBeNull();
  });

  it("lê o campo de cima e o campo personalizado (objeto ou JSON em texto); guarda só NOMES", () => {
    const corpo = { celular: "5511999990000", bot_context: "enquete:reparadora:Agora não", campos_personalizados: JSON.stringify({ ia_origem: "x" }) };
    expect(valorDoCampo(corpo, "bot_context")).toBe("enquete:reparadora:Agora não");
    expect(valorDoCampo(corpo, "campos_personalizados.ia_origem")).toBe("x");
    expect(valorDoCampo({ campos_personalizados: { ia_origem: "y" } }, "campos_personalizados.ia_origem")).toBe("y");
    expect(nomesDosCampos(corpo)).toEqual(["bot_context", "campos_personalizados.ia_origem"]);
  });

  it("⭐ campo de conteúdo nunca é o voto: nem na lista da tela, nem escolhido", () => {
    const corpo = { texto_mensagem: "oi", nome: "x", celular: "1", email: "a@b", responsavel_nome: "y", link_chat: "l", bot_context: "v" };
    expect(nomesDosCampos(corpo)).toEqual(["bot_context"]);
    for (const c of ["texto_mensagem", "nome", "celular", "email", "username", "chat_id", "phone_id", "datetime_post", "tipo_mensagem", "responsavel_email", "campos_personalizados"]) {
      expect(campoPodeSerVoto(c), c).toBe(false);
    }
    expect(campoPodeSerVoto("bot_context")).toBe(true);
    expect(campoPodeSerVoto("campos_personalizados.ia_origem")).toBe(true);
    expect(campoPodeSerVoto("outro.ia_origem")).toBe(false);
  });
});

/** Dublê do PostgREST: config e enquetes por tabela, e o registro de cada escrita. */
function adminFalso(p: { config: unknown; enquetes?: unknown[]; votoAtual?: unknown }) {
  const escritas: Array<{ tabela: string; v: unknown }> = [];
  const rpc = vi.fn(async () => ({ data: "contato-1", error: null }));
  function from(tabela: string) {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order"]) q[m] = () => q;
    q.upsert = async (v: unknown) => {
      escritas.push({ tabela, v });
      return { error: null };
    };
    q.maybeSingle = async () => ({ data: tabela === "enquetes_config" ? p.config : tabela === "enquetes_votos" ? (p.votoAtual ?? null) : null, error: null });
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: p.enquetes ?? [], error: null }).then(ok);
    return q;
  }
  return { admin: { from, rpc } as unknown as SupabaseClient, escritas, rpc };
}

const POST = { celular: "5511999990000", nome: "Fulana", bot_context: "enquete:reparadora:Quero que me chamem" };

describe("tratarEnqueteDoPost", () => {
  it("⭐ chave desligada: nada de voto, nada de contato (só os nomes dos campos)", async () => {
    const { admin, escritas, rpc } = adminFalso({ config: null, enquetes: [REPARADORA] });
    expect(await tratarEnqueteDoPost(admin, { orgId: "org", corpo: POST })).toEqual({ status: "sem_enquete" });
    expect(rpc).not.toHaveBeenCalled();
    expect(escritas.map((e) => e.tabela)).toEqual(["enquetes_config"]);
    expect(JSON.stringify(escritas[0]!.v)).not.toContain("5511999990000");
  });

  it("⭐ ligada: grava o voto do contato; o mesmo voto de novo não escreve", async () => {
    const config = { ligada: true, campo_do_voto: "bot_context", campos_vistos: nomesDosCampos(POST) };
    const novo = adminFalso({ config, enquetes: [REPARADORA] });
    expect(await tratarEnqueteDoPost(novo.admin, { orgId: "org", corpo: POST })).toMatchObject({ status: "registrado", mudou: true, opcao: "Quero que me chamem" });
    expect(novo.escritas).toEqual([{ tabela: "enquetes_votos", v: expect.objectContaining({ enquete_id: "e1", contact_id: "contato-1", chamar: true }) }]);

    const repetido = adminFalso({ config, enquetes: [REPARADORA], votoAtual: { id: "v1", opcao: "Quero que me chamem" } });
    expect(await tratarEnqueteDoPost(repetido.admin, { orgId: "org", corpo: POST })).toMatchObject({ status: "registrado", mudou: false });
    expect(repetido.escritas).toHaveLength(0);
  });

  it("⭐ 'não quero contato' de quem não é contato: não cria contato nem grava voto", async () => {
    const config = { ligada: true, campo_do_voto: "bot_context", campos_vistos: nomesDosCampos(POST) };
    const f = adminFalso({ config, enquetes: [REPARADORA] });
    expect(await tratarEnqueteDoPost(f.admin, { orgId: "org", corpo: { ...POST, bot_context: "enquete:reparadora:Agora não" } })).toEqual({ status: "sem_contato" });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.escritas).toHaveLength(0);
  });

  it("nomes vistos SOMAM: POST com menos campos não escreve; nome novo escreve a união", async () => {
    const config = { ligada: false, campo_do_voto: null, campos_vistos: ["bot_context", "campos_personalizados.ia_origem"] };
    const menos = adminFalso({ config, enquetes: [] });
    await tratarEnqueteDoPost(menos.admin, { orgId: "org", corpo: { celular: "5511999990000", bot_context: "x" } });
    expect(menos.escritas).toHaveLength(0);
    const mais = adminFalso({ config, enquetes: [] });
    await tratarEnqueteDoPost(mais.admin, { orgId: "org", corpo: { celular: "5511999990000", origem: "y" } });
    expect(mais.escritas).toEqual([
      { tabela: "enquetes_config", v: expect.objectContaining({ campos_vistos: ["bot_context", "campos_personalizados.ia_origem", "origem"] }) },
    ]);
  });

  it("grupo nunca vira contato; valor que não é voto não grava nada", async () => {
    const config = { ligada: true, campo_do_voto: "bot_context", campos_vistos: nomesDosCampos(POST) };
    const grupo = adminFalso({ config, enquetes: [REPARADORA] });
    expect(await tratarEnqueteDoPost(grupo.admin, { orgId: "org", corpo: { ...POST, celular: "120363000000000000@g.us" } })).toEqual({ status: "nao_reconhecido" });
    expect(grupo.rpc).not.toHaveBeenCalled();
    const lixo = adminFalso({ config, enquetes: [REPARADORA] });
    expect(await tratarEnqueteDoPost(lixo.admin, { orgId: "org", corpo: { ...POST, bot_context: "oi" } })).toEqual({ status: "nao_reconhecido" });
    expect(lixo.escritas).toHaveLength(0);
  });

  it("falha do banco não derruba a entrada", async () => {
    const admin = { from: () => { throw new Error("caiu"); } } as unknown as SupabaseClient;
    await expect(tratarEnqueteDoPost(admin, { orgId: "org", corpo: POST })).resolves.toEqual({ status: "sem_enquete" });
  });
});

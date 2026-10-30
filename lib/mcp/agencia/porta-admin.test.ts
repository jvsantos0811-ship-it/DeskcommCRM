import { describe, expect, it } from "vitest";

import { resumirAlteracao, textoDoAviso } from "./alerta";
import {
  ESCRITAS_DA_PORTA_ADMIN,
  LEITURAS_DA_PORTA_ADMIN,
  MASCARA_DA_CONVERSA,
  MASCARA_DO_NEGOCIO,
  aplicarMascara,
} from "./porta-admin";

/**
 * A porta Admin não vê conteúdo de lead (PM das duas portas, 2.2): a máscara
 * é o que garante isso nas ferramentas que devolvem negócio ou conversa. Aqui,
 * com o formato REAL das respostas (o de `crm_list_conversations` e o de
 * `crm_update_lead`), prova-se o que sai e o que some.
 */
describe("aplicarMascara", () => {
  it("lista de conversas: some a prévia da mensagem; ficam ids, status e datas", () => {
    const bruto = {
      conversations: [
        {
          id: "c1",
          contact_id: "k1",
          channel: "whatsapp",
          status: "open",
          last_message_preview: "meu CPF é 123.456.789-00 e sofri o acidente",
          last_message_at: "2026-10-30T10:00:00Z",
          tags: ["lead-antigo"],
          unread_count: 2,
        },
      ],
      cursor: "abc",
      has_more: true,
    };
    const saida = aplicarMascara(bruto, LEITURAS_DA_PORTA_ADMIN.crm_list_conversations!.projetar!);
    expect(saida).toEqual({
      conversations: [
        {
          id: "c1",
          contact_id: "k1",
          channel: "whatsapp",
          status: "open",
          last_message_at: "2026-10-30T10:00:00Z",
          tags: ["lead-antigo"],
          unread_count: 2,
        },
      ],
      cursor: "abc",
      has_more: true,
    });
    expect(JSON.stringify(saida)).not.toContain("CPF");
  });

  it("negócio: some título, descrição, contato embutido e campos personalizados; a etapa fica legível", () => {
    const bruto = {
      lead: {
        id: "l1",
        title: "Maria Souza — auxílio-acidente",
        description: "neto sofreu acidente de moto",
        stage_id: "s1",
        stage: { id: "s1", name: "Qualificado", color: "#000" },
        contact: { id: "k1", name: "Maria Souza", phone_number: "+5531999999999" },
        custom_fields: { cpf: "123.456.789-00", nb: "999" },
        status: "open",
        value_cents: 100000,
        tags: ["quente"],
      },
      campos_nao_gravados: [{ campo: "nb", motivo: "sem_evidencia", mensagem: "o cliente não disse o NB", valor: "999" }],
    };
    const saida = aplicarMascara(bruto, ESCRITAS_DA_PORTA_ADMIN.crm_update_lead!.projetar!) as Record<string, unknown>;
    expect(saida).toEqual({
      lead: {
        id: "l1",
        stage_id: "s1",
        stage: { id: "s1", name: "Qualificado" },
        status: "open",
        value_cents: 100000,
        tags: ["quente"],
      },
      campos_nao_gravados: [{ campo: "nb", motivo: "sem_evidencia", mensagem: "o cliente não disse o NB" }],
    });
    const texto = JSON.stringify(saida);
    for (const vazamento of ["Maria", "acidente", "123.456", "+5531", "999\""]) expect(texto).not.toContain(vazamento);
  });

  it("texto onde se esperava objeto não passa (a etapa como string some)", () => {
    expect(aplicarMascara({ stage: "Maria Souza" }, MASCARA_DO_NEGOCIO)).toEqual({});
  });

  it("chave nula é preservada como nula; chave ausente não é inventada", () => {
    expect(aplicarMascara({ id: "x", owner_user_id: null }, MASCARA_DO_NEGOCIO)).toEqual({ id: "x", owner_user_id: null });
    expect(aplicarMascara({ id: "x" }, MASCARA_DA_CONVERSA)).toEqual({ id: "x" });
  });

  it("as máscaras não deixam sair chave de conteúdo", () => {
    const proibidas = ["title", "description", "contact", "custom_fields", "last_message_preview", "name", "phone_number", "body", "content"];
    for (const chave of proibidas) {
      expect(Object.keys(MASCARA_DO_NEGOCIO), chave).not.toContain(chave);
      expect(Object.keys(MASCARA_DA_CONVERSA), chave).not.toContain(chave);
    }
  });
});

describe("aviso ao dono — nunca leva valor de argumento que não seja id", () => {
  it("resume só nomes de argumentos e ids", () => {
    const r = resumirAlteracao("crm_update_lead", {
      lead_id: "11111111-2222-4333-8444-555555555555",
      custom_fields: { cpf: "123.456.789-00" },
      title: "Maria Souza",
    });
    expect(r).toEqual({
      ferramenta: "crm_update_lead",
      argumentos: ["custom_fields", "lead_id", "title"],
      ids: { lead_id: "11111111-2222-4333-8444-555555555555" },
    });
    const aviso = textoDoAviso({ id: "o1", nome: "Bórbora <Advogados>" }, r, new Date("2026-10-30T15:00:00Z"), "req-1");
    expect(aviso.texto).not.toContain("Maria");
    expect(aviso.texto).not.toContain("123.456");
    expect(aviso.assunto).toBe("[Porta Admin] crm_update_lead em Bórbora <Advogados>");
    expect(aviso.html).toContain("Bórbora &lt;Advogados&gt;");
  });
});

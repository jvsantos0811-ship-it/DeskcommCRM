/**
 * PC-003 — as regras puras da trava de etapa e de ganho (o caminho contra o
 * banco e pelo turno real está em `tests/invariants/trava-de-etapa-e-de-ganho`
 * e `update-lead-state-respeita-a-trava`).
 */
import { describe, expect, it } from "vitest";

import { validaCamposExigidos } from "@/lib/leads/campos-exigidos";
import { recusaDeEtapaParaAIa, recusaDeEtapaSoPessoa, RECUSA_DE_GANHO_PELA_IA } from "@/lib/leads/trava-da-ia";
import { mesclaStatusDosCampos, statusDosCampos, statusDosCamposEntradaSchema } from "@/lib/leads/status-dos-campos";
import { formatarCamposDoNegocio } from "@/lib/agent-engine/agent/campos-do-negocio-no-turno";
import { dataDeAssinaturaValida } from "@/lib/leads/assinatura-confirmada";
import { hashDoSegredo, segredoConfere } from "@/lib/leads/assinatura-webhook";

const ETAPA = "00000000-0000-4000-8000-0000000000e1";
const settings = {
  fields: [
    { key: "categoria", label: "Categoria na data", type: "text", com_status: true, obrigatorio_em: { etapas: [ETAPA] } },
    { key: "data_acidente", label: "Data do acidente", type: "date", obrigatorio_em: { etapas: [ETAPA] } },
  ],
};

function falta(lead: Record<string, unknown>, exigirStatus: boolean): string[] {
  return validaCamposExigidos({ lead, settingsDoFunil: settings, destino: { stageId: ETAPA }, exigirStatus }).faltando.map(
    (c) => c.chave,
  );
}

describe("a régua de campos com status (PC-003, item 2)", () => {
  const preenchido = { custom_fields: { categoria: "empregado", data_acidente: "2026-01-10" } };

  it.each(["CONFIRMADO", "NEGADO", "NAO_SE_APLICA"])("⭐ IA: %s conta como preenchido", (s) => {
    expect(falta({ ...preenchido, status_dos_campos: { categoria: s } }, true)).toEqual([]);
  });
  it.each(["NAO_SABE", "PENDENTE", "CONTRADITORIO"])("⭐ IA: %s barra, mesmo com o dado escrito", (s) => {
    expect(falta({ ...preenchido, status_dos_campos: { categoria: s } }, true)).toEqual(["categoria"]);
  });
  it("IA: sem status nenhum barra o campo com status", () => {
    expect(falta(preenchido, true)).toEqual(["categoria"]);
  });
  it("IA: NEGADO dispensa o dado (a pessoa respondeu que não)", () => {
    expect(falta({ custom_fields: { data_acidente: "2026-01-10" }, status_dos_campos: { categoria: "NEGADO" } }, true)).toEqual([]);
  });
  it("PESSOA (sem exigirStatus): a régua de sempre — o dado basta", () => {
    expect(falta({ ...preenchido, status_dos_campos: { categoria: "NAO_SABE" } }, false)).toEqual([]);
    expect(falta({ custom_fields: {} }, false)).toEqual(["categoria", "data_acidente"]);
  });
  it("campo SEM com_status segue pelo dado, com ou sem exigirStatus", () => {
    expect(falta({ custom_fields: { categoria: "x" }, status_dos_campos: { categoria: "CONFIRMADO" } }, true)).toEqual([
      "data_acidente",
    ]);
  });
});

describe("as frases que o modelo lê", () => {
  it("⭐ A1: a frase do pedido, com a etapa e os campos", () => {
    expect(
      recusaDeEtapaParaAIa("Qualificado", [
        { chave: "categoria", rotulo: "Categoria na data" },
        { chave: "data_acidente", rotulo: "Data do acidente" },
      ]),
    ).toMatch(/^Não dá para mover para "Qualificado": faltam os campos Categoria na data, Data do acidente\. /);
  });
  it("A8 e A4: frases claras, sem prometer nada ao cliente", () => {
    expect(recusaDeEtapaSoPessoa("Proposta")).toMatch(/^Não dá para mover para "Proposta": .*só uma pessoa da equipe/);
    expect(RECUSA_DE_GANHO_PELA_IA).toMatch(/contrato é assinado/);
    expect(RECUSA_DE_GANHO_PELA_IA).toMatch(/não diga ao cliente que o contrato está fechado/);
  });
});

describe("o status dos campos", () => {
  it("leitura tolerante, mescla com null apagando, entrada validada", () => {
    expect(statusDosCampos({ a: "CONFIRMADO", b: "talvez", c: 3 })).toEqual({ a: "CONFIRMADO" });
    expect(statusDosCampos(null)).toEqual({});
    expect(mesclaStatusDosCampos({ a: "CONFIRMADO", b: "NEGADO" }, { a: null, c: "NAO_SABE" })).toEqual({
      b: "NEGADO",
      c: "NAO_SABE",
    });
    expect(statusDosCamposEntradaSchema.safeParse({ categoria: "CONFIRMADO" }).success).toBe(true);
    expect(statusDosCamposEntradaSchema.safeParse({ categoria: "SIM" }).success).toBe(false);
    expect(statusDosCamposEntradaSchema.safeParse({ "1x": "CONFIRMADO" }).success).toBe(false);
  });
});

describe("A10: o bloco do turno", () => {
  it("⭐ nome: status — dado; campo sem status só com o dado; status ausente = PENDENTE", () => {
    const bloco = formatarCamposDoNegocio({
      etapa: "Novo contato",
      settings,
      custom_fields: { categoria: "Segurado empregado" },
      status_dos_campos: {},
    });
    expect(bloco).toContain("## Campos do negócio (etapa atual: Novo contato)");
    expect(bloco).toContain("- Categoria na data: PENDENTE — Segurado empregado");
    expect(bloco).toContain("- Data do acidente: (vazio)");
  });
  it("funil sem campos do negócio: bloco vazio (nada a mostrar, nada a gastar)", () => {
    expect(formatarCamposDoNegocio({ etapa: "X", settings: {}, custom_fields: {}, status_dos_campos: {} })).toBe("");
  });
});

describe("a assinatura", () => {
  it("data AAAA-MM-DD válida e não futura", () => {
    const agora = new Date("2026-10-28T15:00:00Z");
    expect(dataDeAssinaturaValida("2026-10-28", agora)).toBe(true);
    expect(dataDeAssinaturaValida("2026-10-27", agora)).toBe(true);
    expect(dataDeAssinaturaValida("2026-11-05", agora)).toBe(false);
    expect(dataDeAssinaturaValida("2026-02-30", agora)).toBe(false);
    expect(dataDeAssinaturaValida("28/10/2026", agora)).toBe(false);
  });
  it("o segredo confere só com o certo (hash, tempo constante)", () => {
    const h = hashDoSegredo("certo");
    expect(segredoConfere("certo", h)).toBe(true);
    expect(segredoConfere("errado", h)).toBe(false);
    expect(segredoConfere(null, h)).toBe(false);
  });
});

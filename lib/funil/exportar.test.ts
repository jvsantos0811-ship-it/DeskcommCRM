import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";

import { gerarXlsx, letraDaColuna } from "@/lib/planilha/xlsx";
import { parseImportFile } from "@/lib/crm-b2b/spreadsheet";
import { periodoNoFuso } from "@/lib/datas/periodo-no-fuso";
import {
  campoSensivel,
  csvDaPlanilha,
  dataNoFuso,
  montarPlanilha,
  nomeDoArquivo,
  valorDoCampo,
  type CardParaPlanilha,
} from "./exportar";

const t = (s: string) => s;

const CARD: CardParaPlanilha = {
  titulo: "Maria de Souza",
  contato: "Maria",
  telefone: "+5531998761234",
  etapa: "Qualificado",
  status: "lost",
  motivoDePerda: null,
  etiquetas: ["vip", "bpc"],
  responsavel: "Ana",
  agenteDeIa: "Recepção",
  origem: "whatsapp · Anúncio: Auxílio",
  criadoEm: "2026-11-01T03:00:00.000Z",
  entrouNaEtapaEm: "2026-11-07T23:30:00.000Z",
  ultimaDoCliente: null,
  ultimaEnviada: "2026-11-08T12:00:00.000Z",
  camposPersonalizados: { servico: "auxilio", cid: "M54", ja_pediu: true },
};

describe("campos sensíveis ficam fora por padrão (PC-024 item 4)", () => {
  it.each([
    ["cid", "CID"],
    ["doenca", "Doença"],
    ["laudo_medico", "Tem laudo?"],
    ["x", "Diagnóstico"],
    ["data_parto", "Data do parto"],
    ["cpf", "CPF"],
    ["rg", "RG do cliente"],
    ["endereco", "Endereço"],
    ["nasc", "Data de nascimento"],
  ])("%s (%s) é sensível", (key, label) => {
    expect(campoSensivel({ key, label })).toBe(true);
  });

  it.each([
    ["cidade", "Cidade"],
    ["cargo", "Cargo"],
    ["servico", "Benefício"],
    ["origem", "Origem do lead"],
  ])("%s (%s) não é", (key, label) => {
    expect(campoSensivel({ key, label })).toBe(false);
  });

  it("a marca de Configurações › Funis vale para qualquer campo", () => {
    expect(campoSensivel({ key: "renda", label: "Renda", sensivel: true })).toBe(true);
  });
});

describe("a matriz da planilha", () => {
  it("perdido sem motivo diz 'Sem motivo'; datas no fuso da organização", () => {
    const { cabecalho, linhas } = montarPlanilha({
      cards: [CARD],
      campos: [{ key: "servico", label: "Benefício" }],
      fuso: "America/Sao_Paulo",
      t,
    });
    expect(cabecalho.at(-1)).toBe("Benefício");
    const l = linhas[0]!;
    expect(l[4]).toBe("Perdido");
    expect(l[5]).toBe("Sem motivo");
    expect(l[6]).toBe("vip; bpc");
    // 01/11 03:00Z é meia-noite em Brasília; 07/11 23:30Z é 20:30 do dia 07.
    expect(l[10]).toBe("01/11/2026 00:00");
    expect(l[11]).toBe("07/11/2026 20:30");
    expect(l[12]).toBe("");
    expect(l.at(-1)).toBe("auxilio");
  });

  it("só os campos escolhidos entram — o campo sensível não pedido não aparece", () => {
    const { cabecalho, linhas } = montarPlanilha({ cards: [CARD], campos: [], fuso: "America/Sao_Paulo", t });
    expect(cabecalho).not.toContain("cid");
    expect(linhas[0]!.join("|")).not.toContain("M54");
  });

  it("valores: opção vira rótulo, sim/não, lista", () => {
    const campo = { key: "b", label: "B", options: [{ value: "auxilio", label: "Auxílio-acidente" }] };
    expect(valorDoCampo(campo, "auxilio", t)).toBe("Auxílio-acidente");
    expect(valorDoCampo(campo, true, t)).toBe("Sim");
    expect(valorDoCampo(campo, ["auxilio", "x"], t)).toBe("Auxílio-acidente; x");
    expect(valorDoCampo(campo, null, t)).toBe("");
  });

  it("fuso inválido não derruba: cai em São Paulo", () => {
    expect(dataNoFuso("2026-11-01T03:00:00.000Z", "Lua/Base")).toBe("01/11/2026 00:00");
  });
});

describe("CSV para o Excel em português", () => {
  it("BOM, ponto e vírgula, acentos e fórmula neutralizada", () => {
    const csv = csvDaPlanilha(["Título", "Observação"], [["=SOMA(1;2)", "João; \"Zé\""]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("Título;Observação\r\n");
    expect(csv).toContain("'=SOMA(1");
    expect(csv).toContain('"João; ""Zé"""');
  });

  it("telefone E.164 passa intacto", () => {
    expect(csvDaPlanilha(["Telefone"], [["+5531998761234"]])).toContain("\r\n+5531998761234\r\n");
  });
});

describe("XLSX sem dependência nova", () => {
  it("o leitor de planilhas do próprio CRM lê de volta o que foi escrito", async () => {
    const bytes = gerarXlsx("Funil: Vendas", ["Título", "Telefone"], [
      ["Maria & Filha <teste>", "+5531998761234"],
      ["=1+1", ""],
    ]);
    const r = await parseImportFile(bytes.slice().buffer, "funil.xlsx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheet.headers).toEqual(["Título", "Telefone"]);
    expect(r.sheet.rows[0]).toEqual(["Maria & Filha <teste>", "+5531998761234"]);
    // Texto, nunca fórmula: a célula é inlineStr, sem <f>.
    expect(r.sheet.rows[1]![0]).toBe("=1+1");
    const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
    expect(sheet).not.toContain("<f>");
  });

  it("nome da aba sem caracteres proibidos", () => {
    const wb = strFromU8(unzipSync(gerarXlsx("a/b:c?", ["x"], []))["xl/workbook.xml"]!);
    expect(wb).toContain('name="a b c "');
  });

  it("letras das colunas", () => {
    expect([0, 25, 26, 27, 701, 702].map(letraDaColuna)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });
});

describe("período em dias inteiros no fuso da organização", () => {
  it("01/11 a 07/11 em Brasília = 01/11 03:00Z até 08/11 03:00Z (exclusivo)", () => {
    const p = periodoNoFuso("2026-11-01", "2026-11-07", "America/Sao_Paulo");
    expect(p.inicio?.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(p.fimExclusivo?.toISOString()).toBe("2026-11-08T03:00:00.000Z");
  });
  it("lado ausente ou inválido fica aberto", () => {
    const p = periodoNoFuso(null, "2026-02-31", "America/Sao_Paulo");
    expect(p.inicio).toBeNull();
    expect(p.fimExclusivo).toBeNull();
  });
});

it("nome do arquivo sem acento nem espaço", () => {
  expect(nomeDoArquivo("Previdenciário · Vendas", "2026-11-10", "xlsx")).toBe(
    "funil-previdenciario-vendas-2026-11-10.xlsx",
  );
});

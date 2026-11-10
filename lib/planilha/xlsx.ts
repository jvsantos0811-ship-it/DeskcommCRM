/**
 * Escreve um `.xlsx` de UMA aba, só com texto — o mínimo do formato, sem
 * dependência nova.
 *
 * Um `.xlsx` é um zip de XML. O `fflate` já está instalado (o leitor de
 * planilhas do import, `lib/crm-b2b/spreadsheet.ts`, e o pacote de skills o
 * usam), então escrever é montar cinco arquivos de XML e zipá-los. O motivo de
 * não trazer uma biblioteca é o mesmo do leitor: a SheetJS do npm parou numa
 * versão com CVE, e a `exceljs` traz ~100 pacotes para algo que cabe aqui.
 *
 * Toda célula é TEXTO (`t="inlineStr"`). Telefone, CPF e datas formatadas não
 * viram número no Excel — "+5531998761234" viraria 5,53E+12 e "01/11/2026"
 * poderia virar uma data em outro fuso. Quem abre vê exatamente o que o CRM
 * mostra. E texto não é fórmula: `=HIPERLINK(...)` sai escrito, nunca avaliado
 * (a injeção de fórmula do CSV não existe aqui, porque nenhuma célula é `<f>`).
 */
import { strToU8, zipSync } from "fflate";

function escaparXml(texto: string): string {
  return (
    texto
      // Caracteres de controle são inválidos em XML 1.0 e corrompem o arquivo
      // inteiro no Excel ("encontramos um problema no conteúdo"). TAB, LF e CR passam.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function letraDaColuna(indice: number): string {
  let n = indice + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** O Excel recusa célula com mais de 32.767 caracteres. */
const TETO_DA_CELULA = 32_767;

function celula(ref: string, valor: string, estilo: number): string {
  const texto = valor.length > TETO_DA_CELULA ? valor.slice(0, TETO_DA_CELULA) : valor;
  const s = estilo ? ` s="${estilo}"` : "";
  if (texto === "") return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escaparXml(texto)}</t></is></c>`;
}

/** Largura da coluna em "caracteres", pelo maior texto (com teto, para não virar faixa). */
function larguras(cabecalho: readonly string[], linhas: readonly (readonly string[])[]): number[] {
  return cabecalho.map((h, i) => {
    let max = h.length;
    for (const l of linhas) max = Math.max(max, (l[i] ?? "").length);
    return Math.min(Math.max(max + 2, 8), 60);
  });
}

export function gerarXlsx(
  nomeDaAba: string,
  cabecalho: readonly string[],
  linhas: readonly (readonly string[])[],
): Uint8Array {
  const aba = escaparXml(nomeDaAba.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Planilha");
  const cols = larguras(cabecalho, linhas)
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");
  const linhaXml = (valores: readonly string[], numero: number, estilo: number) =>
    `<row r="${numero}">${valores.map((v, i) => celula(`${letraDaColuna(i)}${numero}`, v ?? "", estilo)).join("")}</row>`;
  const corpo = [linhaXml(cabecalho, 1, 1), ...linhas.map((l, i) => linhaXml(l, i + 2, 0))].join("");
  const ultimaColuna = letraDaColuna(Math.max(cabecalho.length - 1, 0));

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${corpo}</sheetData>` +
    (cabecalho.length > 0 ? `<autoFilter ref="A1:${ultimaColuna}${linhas.length + 1}"/>` : "") +
    `</worksheet>`;

  const arquivos: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${aba}" sheetId="1" r:id="rId1"/></sheets>` +
        (cabecalho.length > 0
          ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${aba.replace(/'/g, "''")}'!$A$1:$${ultimaColuna}$${linhas.length + 1}</definedName></definedNames>`
          : "") +
        `</workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    ),
    // Dois estilos: 0 = normal, 1 = negrito (o cabeçalho).
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
        `</styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
  return zipSync(arquivos, { level: 6 });
}

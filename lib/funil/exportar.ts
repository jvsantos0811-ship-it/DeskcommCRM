/**
 * A PLANILHA DO FUNIL (PC-024, item 4) — as regras, sem banco e sem rede.
 *
 * ─── Para que serve ──────────────────────────────────────────────────────────
 *
 * A equipe confere o funil fora do CRM (reunião, planilha do escritório,
 * conferência com o financeiro). Antes não havia porta de saída: copiava-se card
 * por card.
 *
 * ─── O que entra, e o que NUNCA entra (LGPD) ─────────────────────────────────
 *
 * Entra o que o card já mostra a quem trabalha no funil: título, contato,
 * telefone, etapa, situação, motivo de perda, etiquetas, responsável, agente de
 * IA, origem/anúncio, datas e os campos personalizados que a pessoa escolher.
 *
 * NUNCA entra: texto de conversa, notas, cartão de passagem, anexos e a
 * DESCRIÇÃO do negócio (é onde a equipe escreve à mão e onde mora o resumo da IA
 * do PC-026 — conteúdo de conversa por outro nome).
 *
 * Campo de SAÚDE ou de DOCUMENTO (pelo nome) e campo MARCADO como sensível em
 * Configurações › Funis ficam fora por padrão: só saem quando quem exporta os
 * marca de propósito (`campoSensivel`). Documento entra na mesma régua de saúde
 * porque é o dado que mais dano causa vazado (CPF, RG, endereço, nascimento).
 *
 * ─── Formato ─────────────────────────────────────────────────────────────────
 *
 * CSV em UTF-8 com BOM e `;` de separador — é o que o Excel em português abre
 * com duplo clique sem perguntar nada, com os acentos certos. Toda célula passa
 * por `neutralizarFormula` (a planilha não avalia `=`/`+`/`-`/`@` vindos de um
 * nome de contato). XLSX sai com toda célula como texto (`lib/planilha/xlsx.ts`).
 * Datas no fuso da ORGANIZAÇÃO.
 */
import { neutralizarFormula } from "@/lib/csv/neutralizar-formula";
import { rotuloDoMotivoDePerda } from "@/lib/schemas/leads";
import { partesNoFuso } from "@/lib/agenda/fuso";

export const FORMATOS_DA_PLANILHA = ["xlsx", "csv"] as const;
export type FormatoDaPlanilha = (typeof FORMATOS_DA_PLANILHA)[number];

/** Teto de linhas por arquivo: o quadro carrega até isto, e cabe na memória do processo. */
export const TETO_DE_LINHAS = 5_000;

export interface CampoDoFunil {
  key: string;
  label: string;
  type?: string;
  sensivel?: boolean;
  options?: Array<{ value: string; label: string }>;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Raízes de nome de campo de saúde e de documento. Raiz, e não palavra inteira:
 * "doença", "doenças preexistentes" e "doenca_cronica" caem na mesma. `cid` e
 * `rg` exigem fronteira de palavra, senão "cidade" e "cargo" cairiam junto.
 */
const RAIZES_SENSIVEIS = [
  "saude",
  "doenc",
  "laudo",
  "diagnost",
  "medic",
  "remedio",
  "tratament",
  "cirurg",
  "deficien",
  "patolog",
  "sequela",
  "lesao",
  "lesoes",
  "internac",
  "gestac",
  "gestant",
  "gravidez",
  "gravida",
  "parto",
  "cpf",
  "documento",
  "endereco",
  "nascimento",
  "passaporte",
  "cnh",
] as const;
const PALAVRAS_SENSIVEIS = /(^|[^a-z0-9])(cid|cid10|rg|nis|pis|cep)([^a-z0-9]|$)/;

/** O campo fica fora da planilha por padrão? */
export function campoSensivel(campo: Pick<CampoDoFunil, "key" | "label" | "sensivel">): boolean {
  if (campo.sensivel === true) return true;
  const alvo = normalizar(`${campo.key} ${campo.label}`);
  return RAIZES_SENSIVEIS.some((r) => alvo.includes(r)) || PALAVRAS_SENSIVEIS.test(alvo);
}

/** O que a rota leu do banco, por card — já sem nada de conversa. */
export interface CardParaPlanilha {
  titulo: string;
  contato: string;
  telefone: string;
  etapa: string;
  status: string;
  motivoDePerda: string | null;
  etiquetas: readonly string[];
  responsavel: string;
  agenteDeIa: string;
  origem: string;
  criadoEm: string | null;
  entrouNaEtapaEm: string | null;
  ultimaDoCliente: string | null;
  ultimaEnviada: string | null;
  camposPersonalizados: Record<string, unknown>;
}

type T = (texto: string) => string;

const SITUACAO: Record<string, string> = { open: "Aberto", won: "Ganho", lost: "Perdido" };

/**
 * "10/11/2026 14:32" no fuso da organização; vazio sem data. Dia/mês/ano com
 * hora de 24h, sem vírgula: é o que a planilha em português e em espanhol lê
 * como data e hora, e o que se filtra e ordena sem surpresa.
 */
export function dataNoFuso(iso: string | null, fuso: string, _locale = "pt-BR"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  let p;
  try {
    p = partesNoFuso(d, fuso);
  } catch {
    // Fuso inválido gravado na organização não derruba a planilha: São Paulo.
    p = partesNoFuso(d, "America/Sao_Paulo");
  }
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(p.dia)}/${dois(p.mes)}/${p.ano} ${dois(p.hora)}:${dois(p.minuto)}`;
}

/** O valor de um campo personalizado como TEXTO legível (opção vira o rótulo). */
export function valorDoCampo(campo: CampoDoFunil, bruto: unknown, t: T): string {
  if (bruto === null || bruto === undefined) return "";
  const rotuloDaOpcao = (v: unknown) =>
    campo.options?.find((o) => o.value === String(v))?.label ?? String(v);
  if (typeof bruto === "boolean") return bruto ? t("Sim") : t("Não");
  if (Array.isArray(bruto)) return bruto.map(rotuloDaOpcao).join("; ");
  if (typeof bruto === "object") {
    const o = bruto as Record<string, unknown>;
    const v = o.valor ?? o.value ?? o.label;
    return v === undefined ? "" : rotuloDaOpcao(v);
  }
  return rotuloDaOpcao(bruto);
}

/** Cabeçalho + linhas, já em texto. A mesma matriz vira CSV ou XLSX. */
export function montarPlanilha(args: {
  cards: readonly CardParaPlanilha[];
  campos: readonly CampoDoFunil[];
  fuso: string;
  locale?: string;
  t: T;
}): { cabecalho: string[]; linhas: string[][] } {
  const { cards, campos, fuso, t } = args;
  const locale = args.locale ?? "pt-BR";
  const cabecalho = [
    t("Título"),
    t("Contato"),
    t("Telefone"),
    t("Etapa"),
    t("Situação"),
    t("Motivo de perda"),
    t("Etiquetas"),
    t("Responsável"),
    t("Agente de IA"),
    t("Origem / anúncio"),
    t("Criado em"),
    t("Entrou na etapa em"),
    t("Última mensagem do cliente"),
    t("Última mensagem enviada"),
    ...campos.map((c) => c.label || c.key),
  ];
  const linhas = cards.map((c) => [
    c.titulo,
    c.contato,
    c.telefone,
    c.etapa,
    t(SITUACAO[c.status] ?? c.status),
    c.status === "lost" ? (c.motivoDePerda ? t(rotuloDoMotivoDePerda(c.motivoDePerda)) : t("Sem motivo")) : "",
    c.etiquetas.join("; "),
    c.responsavel,
    c.agenteDeIa,
    c.origem,
    dataNoFuso(c.criadoEm, fuso, locale),
    dataNoFuso(c.entrouNaEtapaEm, fuso, locale),
    dataNoFuso(c.ultimaDoCliente, fuso, locale),
    dataNoFuso(c.ultimaEnviada, fuso, locale),
    ...campos.map((campo) => valorDoCampo(campo, c.camposPersonalizados[campo.key], t)),
  ]);
  return { cabecalho, linhas };
}

function celulaCsv(valor: string): string {
  const texto = neutralizarFormula(valor);
  return /[";\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/** CSV: BOM + `;` + CRLF — o que o Excel em português abre direto, com acento. */
export function csvDaPlanilha(cabecalho: readonly string[], linhas: readonly (readonly string[])[]): string {
  const todas = [cabecalho, ...linhas].map((l) => l.map(celulaCsv).join(";"));
  return `﻿${todas.join("\r\n")}\r\n`;
}

/** "funil-vendas-2026-11-10.xlsx" — sem acento nem espaço, para qualquer sistema. */
export function nomeDoArquivo(nomeDoFunil: string, dia: string, formato: FormatoDaPlanilha): string {
  const slug =
    normalizar(nomeDoFunil)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "funil";
  return `funil-${slug}-${dia}.${formato}`;
}

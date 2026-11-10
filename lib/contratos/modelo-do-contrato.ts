/**
 * O MODELO DE CONTRATO PREENCHIDO (PC-030, itens 2 e 3) — a regra pura.
 *
 * O modelo é um texto com variáveis `{{chave}}`. A chave é a de um campo do
 * negócio (`crm_leads.custom_fields`, os "Dados do contrato" que a IA pede no
 * "sim" e grava com status) ou uma das variáveis do sistema abaixo. Gerar o
 * contrato só é possível quando:
 *
 *  - TODA variável do texto tem valor (nada de "[a definir]" num contrato);
 *  - todo campo obrigatório do modelo está CONFIRMADO;
 *  - CPF tem dígito verificador válido e CEP tem 8 dígitos (pela chave do
 *    campo: quem tem "cpf" ou "cep" no nome).
 *
 * Quando não dá, a resposta diz o que falta, campo a campo, para a IA (ou a
 * pessoa) perguntar — nunca um erro genérico.
 *
 * OAB: o texto do contrato é do escritório e foi aprovado pelo advogado. Nada
 * aqui reescreve cláusula, valor ou condição: só troca as variáveis pelos
 * dados do cliente.
 */
import { extrairVariaveis, substituirVariaveis } from "@/lib/propostas/documento/variaveis";
import type { StatusDeCampo } from "@/lib/leads/status-dos-campos";

/** As variáveis que o sistema preenche sozinho (não são campos do negócio). */
export const VARIAVEIS_DO_SISTEMA = {
  nome_do_contato: "Nome do contato no CRM",
  telefone: "Telefone do contato",
  data_de_hoje: "Data de hoje (dd/mm/aaaa)",
  escritorio: "Nome do escritório",
} as const;
export type VariavelDoSistema = keyof typeof VARIAVEIS_DO_SISTEMA;

export interface DadosParaOContrato {
  contato: { nome: string | null; telefone: string | null };
  /** `crm_leads.custom_fields`. */
  campos: Record<string, unknown>;
  /** `crm_leads.status_dos_campos`. */
  status: Record<string, StatusDeCampo>;
  /** dd/mm/aaaa no fuso da organização. */
  hoje: string;
  escritorio: string;
}

export interface ModeloParaPreencher {
  corpo: string;
  campos_obrigatorios: readonly string[];
}

export type MotivoDaFalta = "vazio" | "nao_confirmado" | "cpf_invalido" | "cep_invalido";

export interface FaltaNoContrato {
  campo: string;
  motivo: MotivoDaFalta;
}

export type ContratoPreenchido =
  | { ok: true; texto: string; cpf: string | null }
  | { ok: false; faltas: FaltaNoContrato[] };

/** Só dígitos. */
const digitos = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "");

/** CPF com os dois dígitos verificadores válidos (e não todos iguais). */
export function cpfValido(valor: unknown): boolean {
  const d = digitos(valor);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (base: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return dv(d.slice(0, 9), 10) === Number(d[9]) && dv(d.slice(0, 10), 11) === Number(d[10]);
}

/** CEP com 8 dígitos, formatado 00000-000; `null` quando não é CEP. */
export function cepFormatado(valor: unknown): string | null {
  const d = digitos(valor);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : null;
}

/** CPF formatado 000.000.000-00. */
export function cpfFormatado(valor: unknown): string {
  const d = digitos(valor);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

const ehChaveDeCpf = (chave: string) => /(^|_)cpf($|_)/i.test(chave);
const ehChaveDeCep = (chave: string) => /(^|_)cep($|_)/i.test(chave);

/** As variáveis do texto que NÃO são do sistema — os campos do negócio que o modelo usa. */
export function camposDoModelo(corpo: string): string[] {
  return extrairVariaveis(corpo).filter((v) => !(v in VARIAVEIS_DO_SISTEMA));
}

export function preencherContrato(modelo: ModeloParaPreencher, d: DadosParaOContrato): ContratoPreenchido {
  const faltas: FaltaNoContrato[] = [];
  const valores: Record<string, unknown> = {};
  const vazio = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

  const usados = new Set([...camposDoModelo(modelo.corpo), ...modelo.campos_obrigatorios]);
  let cpf: string | null = null;
  for (const campo of usados) {
    const bruto = d.campos[campo];
    if (vazio(bruto)) {
      faltas.push({ campo, motivo: "vazio" });
      continue;
    }
    if (modelo.campos_obrigatorios.includes(campo) && d.status[campo] !== "CONFIRMADO") {
      faltas.push({ campo, motivo: "nao_confirmado" });
      continue;
    }
    if (ehChaveDeCpf(campo)) {
      if (!cpfValido(bruto)) {
        faltas.push({ campo, motivo: "cpf_invalido" });
        continue;
      }
      cpf = digitos(bruto);
      valores[campo] = cpfFormatado(bruto);
      continue;
    }
    if (ehChaveDeCep(campo)) {
      const cep = cepFormatado(bruto);
      if (!cep) {
        faltas.push({ campo, motivo: "cep_invalido" });
        continue;
      }
      valores[campo] = cep;
      continue;
    }
    valores[campo] = Array.isArray(bruto) ? bruto.join(", ") : String(bruto).trim();
  }

  valores.nome_do_contato = d.contato.nome ?? "";
  valores.telefone = d.contato.telefone ?? "";
  valores.data_de_hoje = d.hoje;
  valores.escritorio = d.escritorio;

  if (faltas.length > 0) return { ok: false, faltas };
  const { textoRenderizado, faltantes } = substituirVariaveis(modelo.corpo, valores);
  if (faltantes.length > 0) {
    return { ok: false, faltas: faltantes.map((campo) => ({ campo, motivo: "vazio" as const })) };
  }
  return { ok: true, texto: textoRenderizado, cpf };
}

/** A frase que a IA (ou a tela) recebe para cada falta. */
export function fraseDaFalta(f: FaltaNoContrato, rotulo: string): string {
  switch (f.motivo) {
    case "vazio":
      return `${rotulo}: falta perguntar ao cliente.`;
    case "nao_confirmado":
      return `${rotulo}: o cliente ainda não confirmou.`;
    case "cpf_invalido":
      return `${rotulo}: o CPF não é válido (confira os 11 números com o cliente).`;
    case "cep_invalido":
      return `${rotulo}: o CEP precisa ter 8 números.`;
  }
}

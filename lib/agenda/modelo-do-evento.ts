/**
 * O MODELO DO EVENTO NA AGENDA (PC-044) — como o compromisso marcado aparece
 * no calendário da equipe: o título e o que vai na descrição.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * Quem marca pela IA hoje escreve o título que quiser (ou nenhum, e fica o
 * nome do tipo de atendimento). Cada escritório quer ver a agenda de um jeito:
 * uns com o nome completo e o telefone para ligar dali, outros só com o
 * primeiro nome e o final do telefone, porque a agenda fica no celular da
 * recepção. E a reunião rende mais quando quem atende já abre o evento sabendo
 * o que a IA levantou.
 *
 * ─── A régua da chave ───────────────────────────────────────────────────────
 *
 * Mora em `organizations.settings.modelo_do_evento_agenda` (chave de topo, pelo
 * mesmo motivo da 0343 e da 0648: `fn_agenda_settings` substitui o objeto
 * `settings.agenda` inteiro). AUSENTE = o comportamento de sempre — título da
 * IA ou nome do tipo, descrição da IA. Só quem grava um modelo pela tela muda
 * alguma coisa. Ler nunca lança: um jsonb torto é "sem modelo".
 *
 * ─── LGPD: o que entra na descrição ────────────────────────────────────────
 *
 * A agenda costuma ser vista por mais gente que o CRM (e às vezes mora no
 * celular pessoal). Por isso a descrição tem três níveis e o padrão da tela é o
 * do meio:
 *
 *   "nenhuma"  — o que a IA escreveu, como sempre;
 *   "basica"   — tipo do atendimento, etapa do funil e a próxima ação que a IA
 *                anotou. Sem o resumo da conversa, que pode trazer fato de saúde;
 *   "completa" — a básica MAIS o resumo da conversa e a observação da IA. A
 *                tela avisa que pode levar dado sensível para fora do CRM.
 *
 * Função pura, sem banco: quem busca os dados é o handler da agenda.
 */
import { z } from "zod";

/** Os campos que o título aceita. A tela mostra esta lista. */
export const CAMPOS_DO_TITULO = [
  "tipo",
  "primeiro_nome",
  "nome_completo",
  "telefone",
  "final_telefone",
  "etapa",
] as const;
export type CampoDoTitulo = (typeof CAMPOS_DO_TITULO)[number];

export const NIVEIS_DA_DESCRICAO = ["nenhuma", "basica", "completa"] as const;
export type NivelDaDescricao = (typeof NIVEIS_DA_DESCRICAO)[number];

/** O título que a tela sugere quando a pessoa liga o modelo. Sem dado sensível. */
export const TITULO_SUGERIDO = "{tipo} – {primeiro_nome} – final {final_telefone}";

export const TETO_DO_TITULO = 200;

export const modeloDoEventoSchema = z.strictObject({
  titulo: z.string().trim().min(1).max(TETO_DO_TITULO),
  descricao: z.enum(NIVEIS_DA_DESCRICAO),
});
export type ModeloDoEvento = z.infer<typeof modeloDoEventoSchema>;

/** Lê o modelo da organização. Ausente ou torto = `null` (comportamento de sempre). */
export function lerModeloDoEvento(settings: unknown): ModeloDoEvento | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const bruto = (settings as Record<string, unknown>).modelo_do_evento_agenda;
  const r = modeloDoEventoSchema.safeParse(bruto);
  return r.success ? r.data : null;
}

/** O que o handler junta para preencher o modelo. Tudo pode faltar. */
export interface DadosDoEvento {
  tipo: string;
  nomeDoContato?: string | null;
  telefone?: string | null;
  etapa?: string | null;
  proximaAcao?: string | null;
  resumoDaConversa?: string | null;
  /** A descrição que a IA (ou a pessoa) mandou ao marcar. */
  descricaoDeQuemMarcou?: string | null;
}

function limpo(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

/** Só os dígitos. O telefone gravado vem em formatos variados (+55, máscara, wa_id). */
function digitos(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

function valorDoCampo(campo: CampoDoTitulo, d: DadosDoEvento): string {
  const nome = limpo(d.nomeDoContato);
  switch (campo) {
    case "tipo":
      return limpo(d.tipo);
    case "nome_completo":
      return nome;
    case "primeiro_nome":
      return nome.split(" ")[0] ?? "";
    case "telefone": {
      const t = digitos(d.telefone);
      return t ? `+${t}` : "";
    }
    case "final_telefone":
      return digitos(d.telefone).slice(-4);
    case "etapa":
      return limpo(d.etapa);
  }
}

/**
 * Preenche o título. Campo desconhecido fica como está (a pessoa vê o erro de
 * digitação no próprio calendário e conserta); campo sem valor some, e os
 * separadores que sobram nas pontas ou repetidos também.
 */
export function montarTitulo(modelo: string, d: DadosDoEvento): string {
  // "final {final_telefone}" sem telefone: some o par inteiro, e só ele — a
  // palavra "final" no nome do tipo ("Reunião final") não é tocada.
  const semFinalVazio = valorDoCampo("final_telefone", d)
    ? modelo
    : modelo.replace(/\bfinal\s*\{final_telefone\}/gi, "{final_telefone}");
  const preenchido = semFinalVazio.replace(/\{([a-z_]+)\}/g, (inteiro, nome: string) =>
    (CAMPOS_DO_TITULO as readonly string[]).includes(nome)
      ? valorDoCampo(nome as CampoDoTitulo, d)
      : inteiro,
  );
  const SEP = "[-–|·,/:]";
  const arrumado = preenchido
    .replace(/\s+/g, " ")
    // separador colado em separador ("X –  – Y")
    .replace(new RegExp(`\\s*(${SEP})\\s*(?:${SEP}\\s*)+`, "g"), " $1 ")
    .replace(new RegExp(`^\\s*${SEP}\\s*|\\s*${SEP}\\s*$`, "g"), "")
    .replace(/\s+([,:])/g, "$1")
    .trim();
  const titulo = arrumado || limpo(d.tipo);
  return titulo.slice(0, TETO_DO_TITULO);
}

/** Monta a descrição do nível escolhido. `null` = não mexer no que veio. */
export function montarDescricao(
  nivel: NivelDaDescricao,
  d: DadosDoEvento,
  rotulos: { atendimento: string; etapa: string; proximaAcao: string; resumo: string; observacao: string },
): string | null {
  if (nivel === "nenhuma") return null;
  const linhas: string[] = [];
  const tipo = limpo(d.tipo);
  if (tipo) linhas.push(`${rotulos.atendimento}: ${tipo}`);
  const etapa = limpo(d.etapa);
  if (etapa) linhas.push(`${rotulos.etapa}: ${etapa}`);
  const proxima = limpo(d.proximaAcao);
  if (proxima) linhas.push(`${rotulos.proximaAcao}: ${proxima}`);
  if (nivel === "completa") {
    const resumo = (d.resumoDaConversa ?? "").trim();
    if (resumo) linhas.push("", `${rotulos.resumo}:`, resumo);
    const obs = (d.descricaoDeQuemMarcou ?? "").trim();
    if (obs) linhas.push("", `${rotulos.observacao}:`, obs);
  }
  const texto = linhas.join("\n").trim();
  // O teto do Google para descrição é largo; o nosso é o da coluna da agenda.
  return texto ? texto.slice(0, 4000) : null;
}

/**
 * SEM FONTE, NÃO AFIRMA (PC-020, Pacote Conversa) — a IA não inventa regra nem
 * fato sobre o cliente.
 *
 * ## O defeito
 *
 * A conferência de fato (#2231, `./factual-claim.ts`) confere a afirmação contra
 * a evidência consultada NO TURNO — e, quando a IA respondeu sem consultar a
 * base, não roda e grava "não conferido". Na bateria da Raquel (OE-010) TODAS
 * as respostas saíram "não conferido": o caso mais perigoso, a IA falando de
 * memória, era o único que ninguém conferia. E nada conferia o que a IA atribui
 * ao próprio cliente ("como você comentou…").
 *
 * ## A régua
 *
 *  1. As frases que AFIRMAM (pergunta, saudação e link saem por regra, sem
 *     rede — `frasesParaConferir` da #2231) e, delas, só as que importam:
 *     - REGRA: benefício, requisito, prazo, valor, honorário, documento,
 *       processo, carência, INSS… (`ehAfirmacaoDeRegra`);
 *     - SOBRE O CLIENTE: "você disse…", "como você comentou…", "pelo que o
 *       senhor contou…" (`ehAfirmacaoSobreOCliente`).
 *     Sem nenhuma dessas: NENHUMA chamada de modelo.
 *  2. A fonte de cada uma: regra → o material consultado no turno MAIS a busca
 *     na base com a própria frase como consulta (fim do "não conferido" para
 *     regra); cliente → as falas dele na conversa e as notas do contato.
 *  3. UMA chamada barata por mensagem com afirmação: o modelo diz, por frase,
 *     `sustentada` · `contradiz` · `sem_base`. A decisão é em código.
 *  4. Estado por organização: `decidindo` (padrão — veta com erro de ensino),
 *     `observando` (registra o que vetaria, não veta) ou `desligada`.
 *
 * Falha do provedor nunca deixa o cliente sem resposta (fail-open, registrado).
 */
import { z } from "zod";

import { frasesParaConferir } from "./factual-claim";

// ─── O estado da organização ────────────────────────────────────────────────

export type EstadoSemFonte = "decidindo" | "observando" | "desligada";
export const ESTADO_PADRAO_SEM_FONTE: EstadoSemFonte = "decidindo";

export const ajustesSemFonteSchema = z.strictObject({
  estado: z.enum(["decidindo", "observando", "desligada"]),
});
export type AjustesSemFonteGravados = z.infer<typeof ajustesSemFonteSchema>;

/** `settings.conversa.sem_fonte.estado`. Ausente ou inválido = `decidindo`. Nunca lança. */
export function lerEstadoSemFonte(settings: unknown): EstadoSemFonte {
  const conversa = (settings as { conversa?: unknown } | null)?.conversa;
  const cru = (conversa as { sem_fonte?: unknown } | null)?.sem_fonte;
  const p = ajustesSemFonteSchema.safeParse(cru);
  return p.success ? p.data.estado : ESTADO_PADRAO_SEM_FONTE;
}

// ─── Quais frases conferir (puro, sem rede) ─────────────────────────────────

export type TipoDeAfirmacao = "regra" | "cliente";

export interface AfirmacaoParaConferir {
  i: number;
  frase: string;
  tipo: TipoDeAfirmacao;
}

function semAcento(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** O que a IA atribui ao cliente: "você disse", "como o senhor comentou"… */
const SOBRE_O_CLIENTE =
  /\b(voce|o senhor|a senhora|vc)\s+(me\s+)?(disse|falou|comentou|mencionou|contou|informou|relatou|explicou|respondeu|mandou)\b|\b(como|conforme|pelo que|segundo o que)\s+(voce|o senhor|a senhora|vc)\s+(me\s+)?(disse|falou|comentou|mencionou|contou|informou|relatou|explicou)\b/;

/** Vocabulário de regra (previdenciário e o que todo escritório afirma). */
const DE_REGRA =
  /\b(beneficio|auxilio|aposentadori\w*|pensao|bpc|loas|salario[- ]maternidade|requisit\w*|carencia|prazo\w*|\d+\s*(dia|dias|mes|meses|ano|anos|hora|horas)\b|valor\w*|r\$|reais|\d+\s*%|honorari\w*|documento\w*|laudo\w*|pericia\w*|inss|recurso\w*|processo\w*|acao judicial|direito\w*|lei\b|contribui\w*|qualidade de segurado|segurad\w*|indeniza\w*|revisao|cid\b|incapacidade|sequela\w*|atestado\w*)/;

export function ehAfirmacaoSobreOCliente(frase: string): boolean {
  return SOBRE_O_CLIENTE.test(semAcento(frase));
}

export function ehAfirmacaoDeRegra(frase: string): boolean {
  return DE_REGRA.test(semAcento(frase));
}

/**
 * As frases da candidata que precisam de fonte. Pergunta, saudação e link já
 * saíram em `frasesParaConferir`. Uma frase que fala do cliente E de regra é
 * conferida como fala do cliente (é a acusação mais grave: inventar o que ele
 * disse). Puro.
 */
export function afirmacoesParaConferir(candidata: string): AfirmacaoParaConferir[] {
  const out: AfirmacaoParaConferir[] = [];
  for (const frase of frasesParaConferir(candidata)) {
    if (ehAfirmacaoSobreOCliente(frase)) out.push({ i: out.length, frase, tipo: "cliente" });
    else if (ehAfirmacaoDeRegra(frase)) out.push({ i: out.length, frase, tipo: "regra" });
  }
  return out;
}

// ─── A pergunta ao modelo e a decisão em código ─────────────────────────────

export type VereditoDaFrase = "sustentada" | "contradiz" | "sem_base";

const respostaSchema = z.object({
  frases: z.array(
    z.object({
      i: z.number().int().min(0),
      veredito: z.enum(["sustentada", "contradiz", "sem_base"]),
      correcao: z.string().max(300).nullish(),
    }),
  ),
});

export const SISTEMA_DA_CONFERENCIA =
  "Você confere mensagens de um assistente virtual de escritório de advocacia ANTES de saírem. " +
  "Para cada frase numerada, decida se ela está SUSTENTADA pela fonte indicada: " +
  "regra → o MATERIAL do escritório; fala do cliente → as FALAS DO CLIENTE e as NOTAS. " +
  "\"sustentada\": a fonte diz isso (em qualquer redação). \"contradiz\": a fonte diz outra coisa (dê em \"correcao\" o que ela diz). " +
  "\"sem_base\": a fonte não diz nada sobre isso. Não use conhecimento próprio: só a fonte vale. " +
  'Responda SOMENTE com JSON: {"frases": [{"i": 0, "veredito": "sustentada|contradiz|sem_base", "correcao": "…"|null}]}.';

/** O texto da pergunta: as frases numeradas e as duas fontes. Puro. */
export function montarPergunta(
  afirmacoes: readonly AfirmacaoParaConferir[],
  fontes: { material: readonly string[]; falasDoCliente: readonly string[]; notas: readonly string[] },
): string {
  const corte = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n)}…`);
  const partes: string[] = ["FRASES:"];
  for (const a of afirmacoes) partes.push(`${a.i}. [${a.tipo === "regra" ? "regra" : "fala do cliente"}] ${a.frase}`);
  if (afirmacoes.some((a) => a.tipo === "regra")) {
    partes.push(
      "",
      "MATERIAL DO ESCRITÓRIO:",
      fontes.material.length > 0 ? fontes.material.map((m) => `- ${corte(m, 1200)}`).join("\n") : "(nenhum trecho encontrado)",
    );
  }
  if (afirmacoes.some((a) => a.tipo === "cliente")) {
    partes.push(
      "",
      "FALAS DO CLIENTE (da mais antiga para a mais nova):",
      fontes.falasDoCliente.length > 0 ? fontes.falasDoCliente.map((f) => `- ${corte(f, 400)}`).join("\n") : "(nenhuma)",
      "",
      "NOTAS DO CONTATO:",
      fontes.notas.length > 0 ? fontes.notas.map((n) => `- ${corte(n, 300)}`).join("\n") : "(nenhuma)",
    );
  }
  return partes.join("\n");
}

export interface VetoSemFonte {
  frase: string;
  tipo: TipoDeAfirmacao;
  veredito: Exclude<VereditoDaFrase, "sustentada">;
  correcao: string | null;
}

/** Lê o JSON do modelo e devolve os vetos. Resposta ilegível = `null` (fail-open). Puro. */
export function vetosDaResposta(texto: string, afirmacoes: readonly AfirmacaoParaConferir[]): VetoSemFonte[] | null {
  const inicio = texto.indexOf("{");
  const fim = texto.lastIndexOf("}");
  if (inicio < 0 || fim <= inicio) return null;
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto.slice(inicio, fim + 1));
  } catch {
    return null;
  }
  const p = respostaSchema.safeParse(bruto);
  if (!p.success) return null;
  const vetos: VetoSemFonte[] = [];
  for (const r of p.data.frases) {
    const a = afirmacoes.find((x) => x.i === r.i);
    if (!a || r.veredito === "sustentada") continue;
    vetos.push({ frase: a.frase, tipo: a.tipo, veredito: r.veredito, correcao: r.correcao?.trim() || null });
  }
  return vetos;
}

/** O erro de ensino: o que reescrever e a partir de quê. Puro. */
export function erroDeEnsinoSemFonte(vetos: readonly VetoSemFonte[]): string {
  const linhas = vetos.map((v) => {
    const f = JSON.stringify(v.frase.length > 160 ? `${v.frase.slice(0, 159)}…` : v.frase);
    if (v.tipo === "cliente") {
      return v.veredito === "contradiz"
        ? `${f}: o cliente NÃO disse isso${v.correcao ? ` (ele disse: ${JSON.stringify(v.correcao)})` : ""}. Corrija ou tire.`
        : `${f}: o cliente não disse isso em nenhuma mensagem. Não atribua a ele o que ele não falou.`;
    }
    return v.veredito === "contradiz"
      ? `${f}: o material do escritório diz outra coisa${v.correcao ? ` (${JSON.stringify(v.correcao)})` : ""}. Reescreva a partir do material.`
      : `${f}: isso não está no material do escritório. Tire a afirmação ou diga que vai confirmar com a equipe.`;
  });
  return `A mensagem afirma o que não tem fonte:\n- ${linhas.join("\n- ")}\nA mensagem NÃO foi enviada. Reescreva só com o que o material e a conversa sustentam.`;
}

/**
 * O que sai quando a reescrita AINDA afirma sem fonte (2ª vez no turno): a
 * mensagem SEM as frases vetadas, se sobrar algo útil; senão `null` (sai como
 * está e fica registrado — o cliente nunca fica sem resposta). Puro.
 */
export function semAsFrasesVetadas(candidata: string, vetos: readonly VetoSemFonte[]): string | null {
  let out = candidata;
  for (const v of vetos) out = out.replace(v.frase, "");
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return out.length >= 12 && out !== candidata.trim() ? out : null;
}

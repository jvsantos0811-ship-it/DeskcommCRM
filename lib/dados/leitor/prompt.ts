/**
 * O PROMPT DO LEITOR — molde por organização (PM-027 §4; Regra v2 §6).
 *
 * O texto é o da ordem, com as variáveis no lugar do que era do primeiro cliente:
 * organização, agentes de IA, tipos de lead do catálogo com o checklist de cada
 * um, prefixos das mensagens prontas de anúncio e o termo do segmento para
 * "contrato". Nada de nome de cliente, de agente ou de funil escrito aqui.
 *
 * `VERSAO_DO_PROMPT` vai para a ficha: trocar o texto é trocar a versão, e a
 * bateria roda de novo (Regra v2 §4).
 */
export const VERSAO_DO_PROMPT = "pm027-v1";

export interface TipoDeLeadNoPrompt {
  nome: string;
  requisitos: string[];
}

export interface VariaveisDoPrompt {
  organizacao: string;
  agentes: string[];
  tipos: TipoDeLeadNoPrompt[];
  prefixosDeAnuncio: string[];
  termoDoContrato: string;
}

function listaDosTipos(tipos: TipoDeLeadNoPrompt[]): string {
  if (tipos.length === 0) return "(nenhum tipo cadastrado: use \"a_confirmar\")";
  return tipos.map((t) => `"${t.nome}"`).join(", ");
}

function checklists(tipos: TipoDeLeadNoPrompt[]): string {
  const com = tipos.filter((t) => t.requisitos.length > 0);
  if (com.length === 0) return "(nenhum checklist cadastrado: use \"a_confirmar\" em requisitos)";
  return com.map((t) => `- ${t.nome}: ${t.requisitos.join("; ")}`).join("\n");
}

export function montarPromptDoLeitor(v: VariaveisDoPrompt): string {
  const agentes = v.agentes.length > 0 ? v.agentes.join(", ") : "o assistente virtual";
  const prefixos =
    v.prefixosDeAnuncio.length > 0
      ? `As mensagens prontas de anúncio começam com ${v.prefixosDeAnuncio.map((p) => `"${p}"`).join(", ")}.`
      : "Mensagem pronta de anúncio é o texto padrão que o contato manda ao clicar no anúncio.";
  const contrato = v.termoDoContrato.trim() || "contrato";

  return `Você lê a conversa inteira entre a equipe de ${v.organizacao} e um contato de WhatsApp e preenche a FICHA DO LEAD.
Na conversa, "Assistente virtual" é a IA da empresa (${agentes}); "Equipe" é uma pessoa da empresa, pelo CRM ou pelo celular.
Use só o que está escrito na conversa (mensagens do contato, da equipe, da IA e as descrições de documentos e áudios).
Não deduza nem complete. Na dúvida, use "a_confirmar". Para cada campo diferente do padrão, copie em "provas" o trecho curto que prova.
${prefixos}

contato: "cliente" se já assinou ${contrato} ou tem caso em andamento com ESTA empresa (link de assinatura enviado pela equipe e confirmado, "já assinei",
"meu processo com vocês", "a doutora me pediu", a equipe pedindo documento ou senha para tocar o caso); "interno" se é a equipe da empresa;
"engano" se escreveu por engano ou para outra pessoa; "ilegivel" se o conteúdo não pode ser entendido (áudio transcrito em outra língua, mensagem que não abre); senão "lead".
interesse: o tipo de lead do catálogo [${listaDosTipos(v.tipos)}] que o caso do contato indica pelo que ELE contou (não pelo anúncio). Escreva o nome exatamente como na lista.
Se não der para saber: "a_confirmar", com o que a conversa diz em interesse_texto. Se nada indica interesse: null.
contou_o_caso: "sim" se disse o problema e pelo menos um dado de requisito; "parcial" se só disse o problema; "nao" se só mandou a mensagem pronta, saudação, link ou mídia.
requisitos: compare com o checklist do tipo de lead:
${checklists(v.tipos)}
"atende" se todos foram confirmados; "nao_atende" se um foi negado na conversa; senão "a_confirmar". Em requisitos_faltando, liste os itens do checklist que faltam confirmar.
requisito_em_risco: true se a conversa mostra risco concreto (ex.: contribuiu pouco, benefício cessou há anos, vínculo de outra pessoa).
negociacao: "assinado" / "contrato_enviado" (link de assinatura ou ${contrato} enviado) / "proposta" (honorários ou valores apresentados) / "nenhuma".
objecao: a objeção que o contato levantou: "confianca", "preco", "pensar", "familia", "documento", "outra" ou "nenhuma".
aguardando: preencha quando o contato disse que espera algo antes de seguir (perícia, alta, resultado de um pedido, uma consulta) ou quando foi combinado voltar numa data. Em data, a data se a conversa disser; senão null.
proximo_passo_com: "escritorio" se a última pergunta, pedido ou promessa pendente é da empresa ("a equipe vai assumir", "te aviso", pergunta do contato sem resposta); senão "lead".
recusou: true só se disse que não quer.
ja_atendido_por_outro: true só se o contato disse que OUTRO profissional, escritório, clínica ou fornecedor cuida do caso agora.
fora_da_area: true se o pedido não é do que a empresa faz. sem_caso: true se o contato não tem caso (só curiosidade, situação que não dá direito a nada).
confirmar_assinatura: true se o contato parece cliente, mas a assinatura do ${contrato} não aparece confirmada na conversa.
midia_nao_entendida: true se algum áudio ou documento do contato não pôde ser entendido.
palavras_proprias: true se escreveu qualquer coisa além da mensagem pronta do anúncio.
esperando_a_equipe: preencha quando a última pendência é uma PESSOA da equipe falar com o contato, com o motivo e a data da mensagem que criou a espera: "ia_disse_que_equipe_chama" (a IA disse que a equipe, o advogado ou uma pessoa vai chamar, assumir ou retornar), "lead_pediu_pessoa" (o contato pediu para falar com uma pessoa), "equipe_prometeu_retorno" (alguém da equipe disse "te retorno", "vou verificar e te aviso"). Se depois disso uma pessoa da equipe falou com o contato, use null. Resposta da IA não encerra a espera. Copie o trecho em prova. Em desde, a data e hora da mensagem como aparecem na conversa, no formato AAAA-MM-DDTHH:MM.
Responda só a ficha.`;
}

// ─── A conversa transcrita ──────────────────────────────────────────────────

export interface MensagemParaOLeitor {
  direction: "inbound" | "outbound";
  sent_via: string | null;
  type: string;
  body: string | null;
  media_derived_text: string | null;
  status: string | null;
  created_at: string;
}

/** Teto do que vai ao modelo: as mais recentes ficam, as antigas saem primeiro. */
export const MAXIMO_DE_MENSAGENS = 300;
export const MAXIMO_DE_CARACTERES = 24_000;

const ROTULO_DO_TIPO: Record<string, string> = {
  audio: "[áudio]",
  image: "[imagem]",
  video: "[vídeo]",
  document: "[documento]",
  sticker: "[figurinha]",
  location: "[localização]",
  contact: "[contato compartilhado]",
  reaction: "[reação]",
};

function quemFalou(m: MensagemParaOLeitor): string | null {
  if (m.direction === "inbound") return "Contato";
  switch (m.sent_via) {
    case "ai":
      return "Assistente virtual";
    case "external_device":
      return "Equipe (pelo celular)";
    case "automation":
      return "Mensagem automática";
    case "system":
      return null; // nota interna do sistema: não é conversa com o contato
    default:
      return "Equipe";
  }
}

function quando(iso: string, fuso: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}T${v("hour")}:${v("minute")}`;
}

/**
 * A conversa como o Leitor a lê: uma linha por mensagem, com data e hora no fuso
 * da organização, quem falou e o conteúdo (a transcrição do áudio e a leitura da
 * imagem entram no lugar do arquivo). Sem nome nem telefone do contato.
 */
export function transcreverConversa(mensagens: MensagemParaOLeitor[], fuso: string): string {
  const linhas: string[] = [];
  for (const m of mensagens) {
    const quem = quemFalou(m);
    if (quem === null) continue;
    const texto = (m.body?.trim() || m.media_derived_text?.trim() || "").replace(/\s+/g, " ");
    const rotulo = m.type === "text" ? "" : `${ROTULO_DO_TIPO[m.type] ?? `[${m.type}]`} `;
    const entrega = m.direction === "outbound" && m.status === "failed" ? " (não entregue)" : "";
    linhas.push(`[${quando(m.created_at, fuso)}] ${quem}${entrega}: ${rotulo}${texto}`.trimEnd());
  }
  let recorte = linhas.slice(-MAXIMO_DE_MENSAGENS);
  let total = recorte.reduce((s, l) => s + l.length + 1, 0);
  while (recorte.length > 1 && total > MAXIMO_DE_CARACTERES) {
    total -= recorte[0]!.length + 1;
    recorte = recorte.slice(1);
  }
  const omitidas = linhas.length - recorte.length;
  return (omitidas > 0 ? `(${omitidas} mensagens mais antigas omitidas)\n` : "") + recorte.join("\n");
}

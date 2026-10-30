/**
 * AVISO AO DONO A CADA ALTERAÇÃO PELA PORTA ADMIN numa empresa CLIENTE
 * (PM das duas portas, item 4.2).
 *
 * Dois caminhos, que se somam:
 *
 *   1. A auditoria (`mcp.tool_called` com `porta_da_agencia = admin`, antes e
 *      depois) sempre — e a tela Administração › Chaves da agência lista as
 *      últimas alterações a partir dela. É o aviso que não depende de nada.
 *   2. Um e-mail para quem criou a chave, quando a instalação tem e-mail
 *      configurado (SMTP ou Resend). Sem e-mail configurado, não há envio e a
 *      tela segue sendo o aviso.
 *
 * O e-mail diz ONDE (empresa), O QUÊ (ferramenta e os nomes dos argumentos) e
 * QUANDO, mais os ids tocados. Nunca leva valor de argumento que não seja id:
 * um `crm_update_lead` pode carregar um campo do cliente, e e-mail não é lugar
 * de dado pessoal.
 *
 * Nunca lança e nunca atrasa a resposta: quem chama não espera (`void`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcaDaSaida } from "@/lib/branding/saida";
import { emailConfigurado, sendEmail } from "@/lib/email/roteador";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapar(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface ResumoDaAlteracao {
  ferramenta: string;
  /** Só os NOMES dos argumentos. */
  argumentos: string[];
  /** Os valores que são id (uuid), por nome do argumento. */
  ids: Record<string, string>;
}

export function resumirAlteracao(ferramenta: string, args: Record<string, unknown>): ResumoDaAlteracao {
  const ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && UUID.test(v)) ids[k] = v;
  }
  return { ferramenta, argumentos: Object.keys(args).sort(), ids };
}

export function textoDoAviso(
  organizacao: { id: string; nome: string },
  resumo: ResumoDaAlteracao,
  quando: Date,
  requestId: string,
): { assunto: string; texto: string; html: string } {
  const ids = Object.entries(resumo.ids).map(([k, v]) => `${k}: ${v}`);
  const linhas = [
    `Empresa: ${organizacao.nome} (${organizacao.id})`,
    `Ferramenta: ${resumo.ferramenta}`,
    `Argumentos: ${resumo.argumentos.join(", ") || "(nenhum)"}`,
    ...(ids.length > 0 ? [`Ids: ${ids.join("; ")}`] : []),
    `Quando: ${quando.toISOString()}`,
    `Pedido: ${requestId}`,
    "",
    "O antes e o depois estão na auditoria (Administração › Audit), e as últimas alterações em Administração › Chaves da agência.",
    "Se não reconhece esta alteração, revogue a chave operador-admin agora, na mesma tela.",
  ];
  return {
    assunto: `[Porta Admin] ${resumo.ferramenta} em ${organizacao.nome}`,
    texto: linhas.join("\n"),
    html: `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">${linhas
      .map((l) => (l ? `<p style="margin:0 0 4px">${escapar(l)}</p>` : "<br>"))
      .join("")}</div>`,
  };
}

export async function avisarDonoDaAlteracao(
  db: SupabaseClient,
  opcoes: {
    criadaPor: string;
    organizacao: { id: string; nome: string };
    resumo: ResumoDaAlteracao;
    requestId: string;
  },
): Promise<void> {
  try {
    if (!(await emailConfigurado())) return;
    const { data } = await db.auth.admin.getUserById(opcoes.criadaPor);
    const para = data?.user?.email;
    if (!para) return;
    const aviso = textoDoAviso(opcoes.organizacao, opcoes.resumo, new Date(), opcoes.requestId);
    const marca = await marcaDaSaida(null);
    await sendEmail({ to: para, subject: aviso.assunto, text: aviso.texto, html: aviso.html, fromName: marca.nome });
  } catch {
    // O aviso por e-mail é um extra: a auditoria já gravou a alteração.
  }
}

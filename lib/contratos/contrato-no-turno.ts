/**
 * O CONTRATO NO TURNO DA IA (PC-030, itens 4 e 5).
 *
 * O que o agente precisa saber, a cada turno, sobre o contrato do cliente:
 *  - se a ferramenta `enviar_contrato` existe neste turno (assinatura
 *    eletrônica ligada e "Etapa em que a IA envia o contrato" configurada no
 *    funil do negócio ativo);
 *  - a situação do contrato mais recente (enviado, aberto pelo cliente,
 *    assinado, recusado, prazo vencido, cancelado — com data e hora);
 *  - as duas regras do contrato enviado: reclamação ou pedido de mudança vai
 *    para uma pessoa (`reclamacao_do_contrato`); dúvida de COMO assinar a IA
 *    ajuda. A IA nunca muda cláusula, valor ou condição (OAB).
 *
 * O bloco entra no sufixo do turno (fora do prefixo em cache), e some quando
 * não há contrato nem envio disponível. Nunca lança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerLinhaDaConta } from "@/lib/contratos/assinatura/conta";
import { negocioAtivoDoContato } from "@/lib/contratos/enviar-pela-ia";
import { etapaDoContrato } from "@/lib/contratos/regra-da-ia";
import { ehProvedorEletronico, type StatusDoContrato } from "@/lib/contratos/vocabulario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export interface ContratoParaOTurno {
  id: string;
  lead_id: string | null;
  titulo: string;
  status: StatusDoContrato;
  enviado_em: string | null;
  visualizado_em: string | null;
  decidido_em: string | null;
}

export interface ContratoNoTurno {
  /** A ferramenta `enviar_contrato` entra neste turno? */
  enviarDisponivel: boolean;
  /** O contrato mais recente do negócio ativo, se houver. */
  contrato: ContratoParaOTurno | null;
  /** O negócio ativo (para mover o card na reclamação). */
  leadId: string | null;
}

/** "10/11 às 14:00" no fuso da organização: texto do prompt do agente, não interface. */
function quando(iso: string | null, fuso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat(tagDeIdioma(IDIOMA_PADRAO), {
    timeZone: fuso,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("day")}/${v("month")} às ${v("hour")}:${v("minute")}`;
}

/** O bloco do turno. Vazio quando não há o que dizer. Pura. */
export function blocoDoContrato(c: ContratoNoTurno, fuso: string): string {
  const linhas: string[] = [];
  const k = c.contrato;
  if (k) {
    const situacao =
      k.status === "enviado"
        ? `enviado em ${quando(k.enviado_em, fuso)}, aguardando assinatura${k.visualizado_em ? ` (o cliente abriu o link em ${quando(k.visualizado_em, fuso)})` : " (o cliente ainda não abriu o link)"}`
        : k.status === "assinado"
          ? `ASSINADO em ${quando(k.decidido_em, fuso)}. Siga o que o atendimento diz para depois da assinatura (boas-vindas e documentos).`
          : k.status === "recusado"
            ? `recusado pelo cliente em ${quando(k.decidido_em, fuso)}. A equipe vai falar com ele; não reenvie.`
            : k.status === "expirado"
              ? `o prazo para assinar venceu em ${quando(k.decidido_em, fuso)}. A equipe decide se envia de novo; não reenvie.`
              : k.status === "cancelado"
                ? "cancelado pela equipe."
                : "em preparo pela equipe (ainda não foi enviado).";
    linhas.push(`Situação do contrato "${k.titulo}": ${situacao}`);
    if (k.status === "enviado") {
      linhas.push(
        "Se o cliente reclamar ou questionar o contrato (cláusula, valor, condição, dado errado, \"não concordo\", pedido de mudança), " +
          "chame `reclamacao_do_contrato` com as palavras dele: uma pessoa da equipe assume. Dúvida de COMO assinar não é reclamação: ajude com o passo a passo. " +
          "Você nunca muda cláusula, valor ou condição do contrato.",
      );
    }
  }
  if (c.enviarDisponivel && (!k || !["enviado", "assinado"].includes(k.status))) {
    linhas.push(
      "Quando o cliente aceitar seguir com o contrato e os dados estiverem confirmados, use `enviar_contrato`. " +
        'Antes, pergunte se ele já tem advogado ou processo sobre esse pedido e registre a resposta confirmada.',
    );
  }
  return linhas.length === 0 ? "" : `## Contrato do cliente\n${linhas.join("\n")}`;
}

export async function contratoNoTurno(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<ContratoNoTurno> {
  const vazio: ContratoNoTurno = { enviarDisponivel: false, contrato: null, leadId: null };
  try {
    const lead = await negocioAtivoDoContato(admin, orgId, contactId);
    if (!lead) return vazio;
    const [conta, { data: contratos }] = await Promise.all([
      lerLinhaDaConta(admin, orgId).catch(() => null),
      admin
        .from("crm_contracts")
        .select("id, lead_id, titulo, status, enviado_em, visualizado_em, decidido_em")
        .eq("organization_id", orgId)
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    const servicoLigado = Boolean(conta && conta.ativo && conta.chave_encrypted && ehProvedorEletronico(conta.provedor));
    return {
      enviarDisponivel: servicoLigado && etapaDoContrato(lead.settings) !== null,
      contrato: ((contratos ?? [])[0] as ContratoParaOTurno | undefined) ?? null,
      leadId: lead.id,
    };
  } catch {
    return vazio;
  }
}

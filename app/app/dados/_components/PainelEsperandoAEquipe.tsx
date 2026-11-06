"use client";
/**
 * Painel "Esperando a equipe" (PM-027 §6), no topo da aba Gestão de Dados.
 *
 * Os leads que esperam uma PESSOA da equipe há mais de 2 dias úteis — a IA disse
 * que a equipe ia chamar, o lead pediu uma pessoa, houve passagem para humano,
 * há caso aberto ou o lead está numa etapa só de atendimento humano. Sai quando
 * alguém da equipe responde (pelo CRM ou pelo celular); resposta da IA não tira.
 *
 * Aparece só quando a organização tem o Leitor ligado e para quem vê a
 * organização inteira. O clique abre o funil com `?esperando=equipe`.
 */
import Link from "next/link";

import { useEsperandoAEquipe } from "@/hooks/dados/useEsperandoAEquipe";
import { useT } from "@/hooks/i18n/useT";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import type { MotivoDaEspera, QuemFalouPorUltimo } from "@/lib/dados/esperando-a-equipe";

import { nomeDoLead, Secao, type T } from "./pecas";

export function rotuloDoMotivoDaEspera(m: MotivoDaEspera, t: T): string {
  switch (m) {
    case "ia_disse_que_equipe_chama":
      return t("A IA disse que a equipe ia chamar");
    case "lead_pediu_pessoa":
      return t("O lead pediu para falar com uma pessoa");
    case "equipe_prometeu_retorno":
      return t("A equipe prometeu retorno");
    case "passagem_para_humano":
      return t("Passado para atendimento humano");
    case "caso_humano_aberto":
      return t("Caso aberto esperando a equipe");
    case "etapa_so_humano":
      return t("Etapa só de atendimento humano");
  }
}

export function rotuloDeQuemFalou(q: QuemFalouPorUltimo, t: T): string {
  switch (q) {
    case "lead":
      return t("O lead");
    case "ia":
      return t("A IA");
    case "pessoa":
      return t("A equipe");
    case "automacao":
      return t("Mensagem automática");
    default:
      return "—";
  }
}

function linkDoFunilEsperando(pipelineId: string, leadId?: string): string {
  const p = new URLSearchParams({ esperando: "equipe" });
  if (leadId) p.set("lead", leadId);
  return `/app/pipelines/${pipelineId}?${p.toString()}`;
}

export function PainelEsperandoAEquipe({ fuso }: { fuso: string }) {
  const t = useT();
  const idioma = useIdioma();
  const q = useEsperandoAEquipe();
  const r = q.data;
  if (!r || !r.disponivel || !r.ligado) return null;

  const quando = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(idioma, {
        timeZone: fuso,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(iso));
    } catch {
      return iso.slice(0, 16).replace("T", " ");
    }
  };
  const dias = (n: number) => t("{n} dias úteis").replace("{n}", n.toLocaleString(idioma, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const titulo = t("Esperando a equipe");
  const explicacao = t(
    "Leads que esperam uma pessoa da equipe há mais de 2 dias úteis, no horário da equipe. Saem daqui quando alguém da equipe responde, pelo CRM ou pelo celular. Resposta da IA não conta.",
  );
  const falhas = r.falhas > 0 ? t("Não consegui avaliar {n} leads agora.").replace("{n}", String(r.falhas)) : null;
  const total = String(r.leads.length);

  return (
    <Secao
      rotulo={titulo}
      titulo={
        <span className="flex items-baseline gap-2">
          {titulo}
          <span data-testid="esperando-a-equipe-total" className="text-2xl font-bold tabular-nums">
            {total}
          </span>
        </span>
      }
    >
      <div data-testid="esperando-a-equipe" className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">{explicacao}</p>
        {r.leads.length === 0 ? (
          <p className="text-sm text-text-muted">{t("Ninguém esperando a equipe há mais de 2 dias úteis.")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-text-muted">
                <tr>
                  <th className="py-1 pr-3 font-semibold">{t("Lead")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("Motivo")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("Desde")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("Esperando")}</th>
                  <th className="py-1 pr-3 font-semibold">{t("Quem falou por último")}</th>
                </tr>
              </thead>
              <tbody>
                {r.leads.map((l) => (
                  <tr key={l.lead_id} data-testid="linha-esperando-a-equipe" className="border-t border-border">
                    <td className="py-2 pr-3">
                      <Link
                        href={linkDoFunilEsperando(l.pipeline_id, l.lead_id)}
                        className="whitespace-nowrap font-semibold text-text underline-offset-2 hover:underline"
                      >
                        {nomeDoLead({ nome: l.titulo }, t)}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-xs font-semibold">{rotuloDoMotivoDaEspera(l.motivo, t)}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-text-muted tabular-nums">{quando(l.desde)}</td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{dias(l.dias_uteis)}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-text-muted">{rotuloDeQuemFalou(l.quem_falou_por_ultimo, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.funis.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {r.funis.map((f) => (
              <Link
                key={f.pipeline_id}
                data-testid="esperando-a-equipe-no-funil"
                href={linkDoFunilEsperando(f.pipeline_id)}
                className="text-xs font-semibold text-accent underline-offset-2 hover:underline"
              >
                {textoDoLinkDoFunil(f.nome, f.leads, t)}
              </Link>
            ))}
          </div>
        )}
        {falhas && <p className="text-xs text-warning-fg">{falhas}</p>}
      </div>
    </Secao>
  );
}

function textoDoLinkDoFunil(nome: string, n: number, t: T): string {
  return t("Abrir no funil {funil} ({n}) →").replace("{funil}", nome).replace("{n}", String(n));
}

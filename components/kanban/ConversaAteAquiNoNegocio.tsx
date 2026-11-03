"use client";
import { useT } from "@/hooks/i18n/useT";
import { useRegistroDaConversa, type ItemDoRegistroDaConversa } from "@/hooks/leads/useRegistroDaConversa";

interface Props {
  contactId: string | null;
  aberto: boolean;
}

type T = ReturnType<typeof useT>;

function quandoCurto(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function situacaoDaPromessa(item: ItemDoRegistroDaConversa, t: T): string {
  if (item.status === "vencida") return t("Vencida");
  if (item.status === "cumprida") return t("Cumprida");
  return t("Pendente");
}

function corDaPromessa(status: ItemDoRegistroDaConversa["status"]): string {
  if (status === "vencida") return "text-error-fg";
  if (status === "cumprida") return "text-text-muted";
  return "text-warning-fg";
}

function respostaNaTela(item: ItemDoRegistroDaConversa, t: T): string {
  if (item.status === "recusada") return t("não quis responder");
  return item.resposta ?? "";
}

/**
 * PC-019: "Conversa até aqui" no card do negócio — o mesmo registro que todo
 * agente lê no turno: o que já foi perguntado e respondido, o que ficou sem
 * resposta, as licenças dadas e o que foi prometido (pendente, cumprida ou
 * vencida). Sem registro, não aparece. Saúde só como tema ("licença de saúde:
 * sim"), nunca diagnóstico.
 */
export function ConversaAteAquiNoNegocio({ contactId, aberto }: Props) {
  const t = useT();
  const { data } = useRegistroDaConversa(contactId, aberto);
  if (!data || data.length === 0) return null;

  const respondidas = data.filter((i) => i.tipo === "pergunta" && (i.status === "respondida" || i.status === "recusada"));
  const semResposta = data.filter((i) => i.tipo === "pergunta" && i.status === "sem_resposta");
  const licencas = data.filter((i) => i.tipo === "licenca");
  const promessas = data.filter((i) => i.tipo === "promessa");
  const tituloRespondidas = t("Já perguntado e respondido");
  const tituloSemResposta = t("Sem resposta");
  const tituloLicencas = t("Licenças");
  const tituloPrometido = t("Prometido");
  const ate = t("até");

  return (
    <section className="border-b border-border py-3" data-testid="conversa-ate-aqui">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">{t("Conversa até aqui")}</h3>
      <div className="space-y-2 rounded-md border border-border bg-surface-elevated p-2 text-sm">
        {respondidas.length > 0 ? (
          <div data-testid="registro-respondidas">
            <p className="text-xs font-medium text-text-muted">{tituloRespondidas}</p>
            <ul className="mt-1 space-y-0.5">
              {respondidas.map((i) => (
                <li key={i.id}>
                  <span className="font-medium">{i.tema}</span>
                  {": "}
                  {respostaNaTela(i, t)}
                  <span className="text-xs text-text-muted"> {quandoCurto(i.quando)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {semResposta.length > 0 ? (
          <div data-testid="registro-sem-resposta">
            <p className="text-xs font-medium text-text-muted">{tituloSemResposta}</p>
            <ul className="mt-1 space-y-0.5">
              {semResposta.map((i) => (
                <li key={i.id}>
                  {i.tema}
                  {i.vezes > 1 ? <span className="text-xs text-text-muted"> ({i.vezes}x)</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {licencas.length > 0 ? (
          <div data-testid="registro-licencas">
            <p className="text-xs font-medium text-text-muted">{tituloLicencas}</p>
            <ul className="mt-1 space-y-0.5">
              {licencas.map((i) => (
                <li key={i.id}>
                  <span className="font-medium">{i.tema}</span>
                  {": "}
                  {i.status === "concedida" ? t("Sim") : t("Não")}
                  <span className="text-xs text-text-muted"> {quandoCurto(i.quando)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {promessas.length > 0 ? (
          <div data-testid="registro-promessas">
            <p className="text-xs font-medium text-text-muted">{tituloPrometido}</p>
            <ul className="mt-1 space-y-0.5">
              {promessas.map((i) => (
                <li key={i.id}>
                  {i.tema}
                  {" · "}
                  <span className={`text-xs font-medium ${corDaPromessa(i.status)}`}>{situacaoDaPromessa(i, t)}</span>
                  {i.prazo ? (
                    <span className="text-xs text-text-muted">
                      {" "}
                      {ate} {quandoCurto(i.prazo)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

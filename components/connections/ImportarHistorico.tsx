"use client";
/**
 * "Trazer as conversas antigas" — a importação do histórico do número
 * conectado pelo parceiro (migration 9010).
 *
 * O botão só ENFILEIRA; o trabalho anda em segundo plano, um pouco por minuto,
 * e esta tela acompanha (consulta a cada 10 s enquanto há importação viva).
 * O texto diz, antes do clique, as duas coisas que o escritório precisa saber:
 * nada é enviado a ninguém, e cada contato antigo vira um card na etapa
 * escolhida, já separado pela IA.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { useEtapas, useFunis } from "@/hooks/campanhas/useDestinoDaCampanha";
import { apiClient } from "@/lib/api/client";

type Estado = "na_fila" | "importando" | "triando" | "concluida" | "falhou" | "cancelada";

interface Importacao {
  id: string;
  estado: Estado;
  contagens: Record<string, number>;
  falhas: Array<{ quando: string; conversa?: string; motivo: string }>;
  criada_em: string;
  concluida_em: string | null;
}

interface Resposta {
  disponivel: boolean;
  importacao: Importacao | null;
}

const VIVOS: Estado[] = ["na_fila", "importando", "triando"];

export function ImportarHistorico({ channelId }: { channelId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [pipelineId, setPipelineId] = useState<string>("");
  const [stageId, setStageId] = useState<string>("");
  const [triagem, setTriagem] = useState(true);
  const [enviando, setEnviando] = useState(false);

  const consulta = useQuery({
    queryKey: ["importar-historico", channelId],
    queryFn: async () =>
      (await apiClient.get<{ data: Resposta }>(`/api/v1/channel-sessions/${channelId}/importar-historico`, {
        semDesvioDeSuspensao: true,
      })).data,
    refetchInterval: (q) => (q.state.data?.importacao && VIVOS.includes(q.state.data.importacao.estado) ? 10_000 : false),
  });
  const funis = useFunis();
  const etapas = useEtapas(pipelineId || null);

  if (!consulta.data?.disponivel) return null;
  const imp = consulta.data.importacao;
  const viva = imp ? VIVOS.includes(imp.estado) : false;
  const c = imp?.contagens ?? {};
  const n = (k: string) => c[k] ?? 0;
  // Fora do JSX: as chaves das contagens não são texto de tela.
  const jaTinhaNegocio = n("negocios_pulados_ja_tinha_negocio_aberto");
  const falhas = n("falhas");
  const triagemFalhas = n("triagem_falhas");

  const comecar = async () => {
    setEnviando(true);
    try {
      await apiClient.post(`/api/v1/channel-sessions/${channelId}/importar-historico`, {
        pipeline_id: pipelineId,
        stage_id: stageId,
        triagem,
      });
      toast.success(t("Importação começou. Ela anda em segundo plano — pode sair desta tela."));
      await qc.invalidateQueries({ queryKey: ["importar-historico", channelId] });
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível começar a importação."));
    } finally {
      setEnviando(false);
    }
  };

  const rotuloDoEstado: Record<Estado, string> = {
    na_fila: t("Na fila"),
    importando: t("Trazendo as conversas"),
    triando: t("Separando os contatos"),
    concluida: t("Concluída"),
    falhou: t("Não concluiu"),
    cancelada: t("Cancelada"),
  };

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="importar-historico">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("Trazer as conversas antigas")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "O provedor guardou até 6 meses de conversas deste número. A importação traz essas conversas para o CRM com as datas originais e cria um card para cada contato antigo na etapa que você escolher. Ninguém recebe mensagem: a IA, as automações e os follow-ups não são acionados.",
            )}
          </p>
        </div>
        {imp && (
          <Badge variant={viva ? "warning" : imp.estado === "concluida" ? "secondary" : "outline"}>
            {rotuloDoEstado[imp.estado]}
          </Badge>
        )}
      </div>

      {imp && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs" data-testid="importar-historico-relatorio">
          <ul className="grid gap-1 sm:grid-cols-2">
            <li>{t("Conversas lidas")}: {n("conversas_lidas")}</li>
            <li>{t("Mensagens gravadas")}: {n("mensagens_gravadas")}</li>
            <li>{t("Contatos novos")}: {n("contatos_criados")}</li>
            <li>{t("Contatos que já existiam")}: {n("contatos_reaproveitados")}</li>
            <li>{t("Cards criados")}: {n("negocios_criados")}</li>
            <li>
              {t("Sem card (já tinham negócio aberto)")}: {jaTinhaNegocio}
            </li>
            <li>{t("Sem card (pediram para não receber)")}: {n("negocios_pulados_contato_bloqueado")}</li>
            <li>{t("Mídias antigas sem arquivo")}: {n("midias_sem_arquivo")}</li>
            <li>{t("Grupos ignorados")}: {n("grupos_pulados")}</li>
            <li>{t("Falhas")}: {falhas}</li>
          </ul>
          {(n("triagem_parou-no-meio") + n("triagem_ja-cliente") + n("triagem_recusou") + n("triagem_nao-e-lead") > 0 ||
            triagemFalhas > 0) && (
            <div className="mt-2 border-t border-border pt-2">
              <p className="font-medium">{t("Separação pela IA")}</p>
              <ul className="grid gap-1 sm:grid-cols-2">
                <li>{t("Pararam no meio (seguem para a retomada)")}: {n("triagem_parou-no-meio")}</li>
                <li>{t("Já são clientes")}: {n("triagem_ja-cliente")}</li>
                <li>{t("Recusaram")}: {n("triagem_recusou")}</li>
                <li>{t("Não são contatos de venda")}: {n("triagem_nao-e-lead")}</li>
                <li>{t("Sem separação (a equipe decide)")}: {triagemFalhas}</li>
              </ul>
            </div>
          )}
          {n("triagem_sem_ia") > 0 && (
            <p className="mt-2">{t("A separação pela IA não rodou: falta a chave de IA da organização.")}</p>
          )}
          {n("triagem_parada_pelo_teto") > 0 && (
            <p className="mt-2">{t("A separação pela IA parou no teto de gasto de IA do mês.")}</p>
          )}
          {imp.falhas[0] && (
            <p className="mt-2 text-muted-foreground">
              {t("Último aviso")}: {imp.falhas[0].motivo}
            </p>
          )}
        </div>
      )}

      {!viva && (
        <div className="flex flex-col gap-3">
          <label className="block text-sm">
            {t("Funil")}
            <select
              className="mt-1 w-full rounded-md border bg-surface p-2"
              value={pipelineId}
              onChange={(e) => {
                setPipelineId(e.target.value);
                setStageId("");
              }}
              data-testid="importar-historico-funil"
            >
              <option value="">{t("Escolha o funil")}</option>
              {(funis.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            {t("Etapa")}
            <select
              className="mt-1 w-full rounded-md border bg-surface p-2"
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              disabled={!pipelineId}
              data-testid="importar-historico-etapa"
            >
              <option value="">{t("Escolha a etapa (ex.: Leads antigos)")}</option>
              {(etapas.data ?? [])
                .filter((s) => !s.is_won && !s.is_lost)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={triagem} onChange={(e) => setTriagem(e.target.checked)} />
            <span>
              {t(
                "Separar os contatos com a IA: marca quem já é cliente, quem recusou, quem não é contato de venda e quem parou no meio. Só quem parou no meio segue para a retomada.",
              )}
            </span>
          </label>
          <div>
            <Button onClick={comecar} disabled={enviando || !pipelineId || !stageId} data-testid="importar-historico-comecar">
              {enviando ? t("Começando…") : imp ? t("Importar de novo") : t("Importar conversas antigas")}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("Repetir é seguro: o que já foi importado não é duplicado.")}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

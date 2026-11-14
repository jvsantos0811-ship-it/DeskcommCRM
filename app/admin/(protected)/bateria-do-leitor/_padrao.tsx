"use client";

/**
 * O MODELO PADRÃO DO LEITOR, na página da bateria (PM-027; decisão do dono de
 * 06/11: o Leitor liga sozinho nas empresas que existem e nas novas).
 *
 * O dono escolhe o modelo e a reserva padrão entre os APROVADOS na bateria. Toda
 * empresa que não escolheu outro modelo nem desligou o Leitor passa a ler com ele
 * a partir do momento em que o padrão passa a valer (nada de antes é lido);
 * empresa nova já nasce lendo. Trocar o modelo não relê nada. A lista embaixo
 * mostra como cada empresa está diante do padrão e QUAIS FUNIS ela tem lidos —
 * para o dono conferir, antes de salvar, que nenhum funil de clientes entra.
 */
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { PadraoNaTela } from "@/lib/dados/leitor/padrao";

const chave = (m: { provider: string; model_id: string }) => `${m.provider}/${m.model_id}`;

export function PadraoDoLeitorNaBateria({ padrao, aoSalvar }: { padrao: PadraoNaTela; aoSalvar: () => Promise<unknown> }) {
  const t = useT();
  const [modeloEscolhido, setModelo] = useState<string | null>(null);
  const [reservaEscolhida, setReserva] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const atual = padrao.atual;
  const modelo = modeloEscolhido ?? (atual ? chave(atual.modelo) : "");
  const reserva = reservaEscolhida ?? (atual?.reserva ? chave(atual.reserva) : "");
  const porChave = new Map(padrao.aprovados.map((m) => [chave(m), m]));
  const nomeDe = (m: { provider: string; model_id: string } | null) => (m ? (porChave.get(chave(m))?.nome ?? m.model_id) : "—");
  const comoModelo = (k: string) => {
    const m = porChave.get(k);
    return m ? { provider: m.provider, model_id: m.model_id } : null;
  };

  async function gravar(tirar: boolean) {
    setOcupado(true);
    try {
      const r = await apiClient.put<{ data: { passaramALer: number } }>("/api/v1/admin/bateria-do-leitor/padrao", {
        modelo: tirar ? null : comoModelo(modelo),
        reserva: tirar || !reserva ? null : comoModelo(reserva),
      });
      toast.success(
        tirar
          ? t("Padrão retirado. As empresas que o seguiam pararam de ler.")
          : r.data.passaramALer > 0
            ? t("Padrão salvo. {n} empresas passaram a ler a partir de agora.").replace("{n}", String(r.data.passaramALer))
            : t("Padrão salvo."),
      );
      setModelo(null);
      setReserva(null);
      await aoSalvar();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  const situacaoAtual = atual
    ? (atual.reserva
        ? t("Padrão: {modelo} (reserva: {reserva}), valendo desde {quando}.")
        : t("Padrão: {modelo}, valendo desde {quando}.")
      )
        .replace("{modelo}", nomeDe(atual.modelo))
        .replace("{reserva}", nomeDe(atual.reserva))
        .replace("{quando}", new Date(atual.ativo_desde).toLocaleString())
    : t("Sem padrão: o Leitor não liga sozinho em nenhuma empresa.");
  const escolhido = porChave.get(modelo);
  const semChaveNaInstalacao =
    escolhido && !escolhido.instalacaoTemChave
      ? t("A instalação não tem chave para {modelo}: só as empresas com chave própria desse provedor vão ler.").replace("{modelo}", escolhido.nome)
      : null;
  const grupos = [
    { escolha: "padrao" as const, rotulo: t("Seguem o padrão") },
    { escolha: "propria" as const, rotulo: t("Modelo próprio") },
    { escolha: "desligado" as const, rotulo: t("Desligado") },
    // PC-036: as lidas pelo Claude não seguem o padrão, e o padrão não as liga.
    { escolha: "claude" as const, rotulo: t("Lidas pelo Claude") },
  ].map((g) => {
    const empresas = padrao.organizacoes.filter((o) => o.escolha === g.escolha);
    return {
      ...g,
      titulo: `${g.rotulo} (${empresas.length})`,
      empresas: empresas.map((o) => ({
        id: o.id,
        linha:
          g.escolha === "desligado"
            ? o.nome
            : t("{empresa} — lê: {funis}")
                .replace("{empresa}", o.nome)
                .replace("{funis}", o.funis_lidos.join(", ") || t("nenhum funil")),
      })),
    };
  });

  return (
    <Card className="space-y-3 p-4" data-testid="bateria-padrao">
      <div>
        <h2 className="text-base font-semibold">{t("Modelo padrão do Leitor (todas as empresas)")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("As empresas que não escolheram outro modelo nem desligaram o Leitor leem com este modelo, a partir do momento em que ele passa a valer. Empresa nova já nasce lendo. Trocar o modelo não relê nada.")}
        </p>
      </div>
      <p className="text-sm" data-testid="bateria-padrao-atual">
        {situacaoAtual}
      </p>
      {padrao.aprovados.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="bateria-padrao-sem-aprovado">
          {t("Nenhum modelo aprovado na bateria ainda: teste um modelo antes de escolher o padrão.")}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span>{t("Modelo padrão (só os aprovados)")}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2"
              data-testid="bateria-padrao-modelo"
              value={modelo}
              onChange={(e) => setModelo(e.target.value)}
            >
              <option value="">{t("Escolha")}</option>
              {padrao.aprovados.map((m) => (
                <option key={chave(m)} value={chave(m)}>
                  {m.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("Reserva padrão (opcional)")}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2"
              data-testid="bateria-padrao-reserva"
              value={reserva}
              onChange={(e) => setReserva(e.target.value)}
            >
              <option value="">{t("Sem reserva")}</option>
              {padrao.aprovados
                .filter((m) => chave(m) !== modelo)
                .map((m) => (
                  <option key={chave(m)} value={chave(m)}>
                    {m.nome}
                  </option>
                ))}
            </select>
          </label>
          {semChaveNaInstalacao ? (
            <p className="rounded-md border border-border bg-muted/40 p-2 text-xs md:col-span-2" data-testid="bateria-padrao-sem-chave">
              {semChaveNaInstalacao}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button type="button" size="sm" disabled={ocupado || !modelo} data-testid="bateria-padrao-salvar" onClick={() => void gravar(false)}>
              {t("Salvar o padrão")}
            </Button>
            {atual ? (
              <Button type="button" size="sm" variant="outline" disabled={ocupado} data-testid="bateria-padrao-tirar" onClick={() => void gravar(true)}>
                {t("Tirar o padrão")}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <div className="space-y-2 text-xs text-muted-foreground" data-testid="bateria-padrao-empresas">
        <p>
          {t("Confira os funis antes de salvar: um funil de clientes que não está marcado como tal seria lido. O alcance de cada empresa fica em Configurações › Distribuição de atendimento.")}
        </p>
        {grupos.map((g) => (
          <div key={g.escolha} data-escolha={g.escolha}>
            <p className="font-medium text-foreground">{g.titulo}</p>
            <ul className="ml-4 list-disc">
              {g.empresas.map((e) => (
                <li key={e.id}>{e.linha}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

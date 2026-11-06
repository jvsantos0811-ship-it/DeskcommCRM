"use client";

/**
 * O CARTÃO DO LEITOR DA CONVERSA na tela Provedores (PM-027 §8).
 *
 * Mostra, por modelo, o preço do catálogo, o custo estimado por mês nesta
 * empresa, a nota na bateria (acertos/total, com a data) e o tempo médio. Liga o
 * Leitor só com modelo aprovado na bateria (100% nos casos que bloqueiam) e com a
 * chave do provedor cadastrada; a reserva segue a mesma régua. A bateria roda na
 * área do dono da plataforma (a aprovação vale para todos os escritórios,
 * decisão de 06/11): aqui o dono vê o atalho "Testar na bateria".
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { DadosDoLeitor, ModeloNoCartao } from "@/lib/dados/leitor/leitor-da-org";

type Dados = DadosDoLeitor & { podeEditar: boolean; ehDonoDaPlataforma: boolean };

const chave = (m: { provider: string; model_id: string }) => `${m.provider}/${m.model_id}`;

function dolares(cents: number | null): string {
  if (cents === null) return "—";
  return `US$ ${(cents / 100).toFixed(2)}`;
}

function precoPorMilhao(m: ModeloNoCartao): string {
  if (m.precoEntrada === null || m.precoSaida === null) return "—";
  return `${(m.precoEntrada / 100).toFixed(2)} / ${(m.precoSaida / 100).toFixed(2)}`;
}

export function CartaoDoLeitor() {
  const t = useT();
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [verTodos, setVerTodos] = useState(false);
  const [modelo, setModelo] = useState<string>("");
  const [reserva, setReserva] = useState<string>("");
  const [prefixos, setPrefixos] = useState("");
  const [termo, setTermo] = useState("contrato");
  const [salvando, startTransition] = useTransition();

  const aplicar = useCallback((d: Dados) => {
    setDados(d);
    setModelo(d.config.modelo ? chave(d.config.modelo) : "");
    setReserva(d.config.reserva ? chave(d.config.reserva) : "");
    setPrefixos(d.config.prefixos_de_anuncio.join(", "));
    setTermo(d.config.termo_do_contrato);
  }, []);

  const carregar = useCallback(async () => {
    try {
      const r = await apiClient.get<{ data: Dados }>("/api/v1/ai/leitor");
      setErro(null);
      aplicar(r.data);
    } catch {
      setErro(t("Não consegui carregar o cartão agora."));
    }
  }, [aplicar, t]);

  useEffect(() => {
    let vivo = true;
    void apiClient
      .get<{ data: Dados }>("/api/v1/ai/leitor")
      .then((r) => {
        if (vivo) aplicar(r.data);
      })
      .catch(() => {
        if (vivo) setErro(t("Não consegui carregar o cartão agora."));
      });
    return () => {
      vivo = false;
    };
  }, [aplicar, t]);

  const aprovados = useMemo(() => (dados?.modelos ?? []).filter((m) => m.bateria?.aprovado), [dados]);
  const visiveis = useMemo(
    () => (dados?.modelos ?? []).filter((m) => verTodos || m.principal || m.bateria !== null),
    [dados, verTodos],
  );

  if (erro) {
    return (
      <Card className="p-4 text-sm" data-testid="cartao-do-leitor">
        <p className="text-muted-foreground">{erro}</p>
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void carregar()}>
          {t("Tentar de novo")}
        </Button>
      </Card>
    );
  }
  if (!dados) return null;

  const porChave = new Map(dados.modelos.map((m) => [chave(m), m]));
  const comoModelo = (k: string) => {
    const m = porChave.get(k);
    return m ? { provider: m.provider, model_id: m.model_id } : null;
  };

  function salvar(ligar: boolean) {
    startTransition(async () => {
      try {
        await apiClient.patch<{ data: unknown }>("/api/v1/ai/leitor", {
          ligado: ligar,
          modelo: modelo ? comoModelo(modelo) : null,
          reserva: reserva ? comoModelo(reserva) : null,
          prefixos_de_anuncio: prefixos
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
          termo_do_contrato: termo.trim() || "contrato",
        });
        toast.success(ligar ? t("Leitor da conversa ligado.") : t("Leitor da conversa desligado."));
        await carregar();
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  const ligadoDesde = dados.config.ligado && dados.config.ligado_em
    ? t("Ligado desde {quando}, com {modelo}.")
        .replace("{quando}", new Date(dados.config.ligado_em).toLocaleString())
        .replace("{modelo}", dados.config.modelo ? (porChave.get(chave(dados.config.modelo))?.nome ?? dados.config.modelo.model_id) : "—")
    : t("Desligado. Os painéis de Dados seguem com a regra de antes.");
  const avisoDaBateria = dados.bateriaPequena
    ? dados.casosNaBateria
      ? t("A bateria ainda é pequena ({n} casos). A nota vale, mas siga validando antes de tratar o modelo como definitivo.").replace(
          "{n}",
          String(dados.casosNaBateria),
        )
      : t("Nenhum modelo foi testado na bateria ainda.")
    : null;
  const semAprovado = aprovados.length === 0 ? t("Escolha um modelo e rode a bateria para ligar o Leitor.") : null;
  const linhas = visiveis.map((m) => ({
    m,
    nota: m.bateria
      ? t("{acertos}/{total} em {data}")
          .replace("{acertos}", String(m.bateria.acertos))
          .replace("{total}", String(m.bateria.total))
          .replace("{data}", m.bateria.data ? new Date(m.bateria.data).toLocaleDateString() : "—")
      : t("Sem teste"),
    tempo: m.bateria?.tempoMedioMs ? `${(m.bateria.tempoMedioMs / 1000).toFixed(1)} s` : "—",
  }));

  return (
    <Card className="space-y-4 p-4" data-testid="cartao-do-leitor">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("Leitor da conversa")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Lê, uma vez por dia, a conversa dos leads que tiveram mensagem nova e preenche a ficha que os painéis de Dados usam.")}
          </p>
        </div>
        <Badge variant={dados.config.ligado ? "default" : "outline"} data-testid="leitor-estado">
          {dados.config.ligado ? t("Ligado") : t("Desligado")}
        </Badge>
      </div>
      <p className="text-sm" data-testid="leitor-ligado-desde">
        {ligadoDesde}
      </p>
      {avisoDaBateria ? (
        <p className="rounded-md border border-border bg-muted/40 p-2 text-xs" data-testid="leitor-aviso-bateria">
          {avisoDaBateria}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs" data-testid="leitor-modelos">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">{t("Modelo")}</th>
              <th className="py-1 pr-3 font-medium">{t("Preço (US$ por milhão: entrada / saída)")}</th>
              <th className="py-1 pr-3 font-medium">{t("Custo estimado por mês")}</th>
              <th className="py-1 pr-3 font-medium">{t("Nota na bateria")}</th>
              <th className="py-1 pr-3 font-medium">{t("Tempo médio")}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map(({ m, nota, tempo }) => {
              return (
                <tr key={chave(m)} className="border-t border-border" data-testid="leitor-modelo" data-modelo={chave(m)}>
                  <td className="py-1 pr-3">
                    <span className="font-medium">{m.nome}</span>
                    {!m.temChave ? <span className="block text-muted-foreground">{t("sem chave nesta empresa")}</span> : null}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">{precoPorMilhao(m)}</td>
                  <td className="py-1 pr-3 tabular-nums">{dolares(m.custoPorMesCents)}</td>
                  <td className="py-1 pr-3">
                    {nota}{" "}
                    {m.bateria ? (
                      <Badge variant={m.bateria.aprovado ? "default" : "outline"}>{m.bateria.aprovado ? t("Aprovado") : t("Não aprovado")}</Badge>
                    ) : null}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">{tempo}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Button type="button" size="sm" variant="ghost" className="mt-1" data-testid="leitor-ver-todos" onClick={() => setVerTodos((v) => !v)}>
          {verTodos ? t("Ver só os principais") : t("Ver todos")}
        </Button>
      </div>

      {dados.ehDonoDaPlataforma ? (
        <p className="text-xs">
          <Link className="underline underline-offset-4" href="/admin/bateria-do-leitor" data-testid="leitor-testar-na-bateria">
            {t("Testar na bateria")}
          </Link>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("O teste na bateria é feito pela equipe da plataforma.")}</p>
      )}

      {dados.podeEditar ? (
        <div className="grid gap-3 md:grid-cols-2" data-testid="leitor-form">
          <label className="block space-y-1 text-xs">
            <span>{t("Modelo do Leitor (só os aprovados)")}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2"
              data-testid="leitor-escolher-modelo"
              value={modelo}
              onChange={(e) => setModelo(e.target.value)}
            >
              <option value="">{t("Escolha")}</option>
              {aprovados.map((m) => (
                <option key={chave(m)} value={chave(m)} disabled={!m.temChave}>
                  {m.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("Modelo de reserva (opcional)")}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2"
              data-testid="leitor-escolher-reserva"
              value={reserva}
              onChange={(e) => setReserva(e.target.value)}
            >
              <option value="">{t("Sem reserva")}</option>
              {aprovados
                .filter((m) => chave(m) !== modelo)
                .map((m) => (
                  <option key={chave(m)} value={chave(m)} disabled={!m.temChave}>
                    {m.nome}
                  </option>
                ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("Prefixos das mensagens prontas de anúncio (separados por vírgula)")}</span>
            <Input data-testid="leitor-prefixos" value={prefixos} onChange={(e) => setPrefixos(e.target.value)} />
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("Como o segmento chama o contrato")}</span>
            <Input data-testid="leitor-termo" value={termo} onChange={(e) => setTermo(e.target.value)} />
          </label>
          {semAprovado ? <p className="text-xs text-muted-foreground md:col-span-2">{semAprovado}</p> : null}
          <div className="flex gap-2 md:col-span-2">
            <Button type="button" size="sm" disabled={salvando || !modelo} data-testid="leitor-ligar" onClick={() => salvar(true)}>
              {dados.config.ligado ? t("Salvar") : t("Ligar o Leitor")}
            </Button>
            {dados.config.ligado ? (
              <Button type="button" size="sm" variant="outline" disabled={salvando} data-testid="leitor-desligar" onClick={() => salvar(false)}>
                {t("Desligar")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

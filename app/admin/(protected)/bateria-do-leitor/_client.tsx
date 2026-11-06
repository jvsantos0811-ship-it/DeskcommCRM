"use client";

/**
 * A página da bateria do Leitor (PM-027 §8–§9) para o dono da plataforma:
 *  1. os casos (quantos, de onde) e "Carregar casos" a partir do arquivo do Gestor;
 *  2. "Testar na bateria": o modelo, o juiz (nunca o mesmo) e a empresa cuja chave paga;
 *  3. as rodadas, com o placar, e caso a caso com a decisão do juiz.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { ResultadoNaTela, ResumoDaBateria, RodadaNaTela } from "@/lib/dados/leitor/bateria-admin";

const TAMANHO_MAXIMO = 2 * 1024 * 1024;
const chave = (m: { provider: string; model_id: string }) => `${m.provider}/${m.model_id}`;

export function BateriaDoLeitorClient() {
  const t = useT();
  const queryClient = useQueryClient();
  const consulta = useQuery({
    queryKey: ["admin", "bateria-do-leitor"],
    queryFn: () => apiClient.get<{ data: ResumoDaBateria }>("/api/v1/admin/bateria-do-leitor").then((r) => r.data),
    refetchInterval: 20_000,
  });
  const resumo = consulta.data ?? null;
  const recarregar = () => queryClient.invalidateQueries({ queryKey: ["admin", "bateria-do-leitor"] });

  const [ocupado, setOcupado] = useState(false);
  const [formato, setFormato] = useState<"regra_v2" | "gestor">("regra_v2");
  const [origemEscolhida, setOrigem] = useState("");
  const [arquivo, setArquivo] = useState<string | null>(null);
  const [nomeDoArquivo, setNomeDoArquivo] = useState("");
  const [substituir, setSubstituir] = useState(false);
  const [carga, setCarga] = useState<{ criados: string[]; ignorados: Array<{ id: string; motivo: string }> } | null>(null);
  const [orgDaChaveEscolhida, setOrgDaChave] = useState("");
  const [juiz, setJuiz] = useState("");
  const [aberta, setAberta] = useState<string | null>(null);

  const origem = origemEscolhida || resumo?.organizacoes[0]?.id || "";
  const orgDaChave = orgDaChaveEscolhida || origem;

  async function escolherArquivo(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > TAMANHO_MAXIMO) {
      toast.error(t("O arquivo passa de 2 MB."));
      return;
    }
    setNomeDoArquivo(f.name);
    setArquivo(await f.text());
  }

  async function carregarCasos() {
    if (!arquivo) return;
    let conteudo: unknown;
    try {
      conteudo = JSON.parse(arquivo);
    } catch {
      toast.error(t("O arquivo não é um JSON válido."));
      return;
    }
    setOcupado(true);
    try {
      const r = await apiClient.post<{ data: { criados: string[]; ignorados: Array<{ id: string; motivo: string }> } }>(
        "/api/v1/admin/bateria-do-leitor/casos",
        { formato, origem_organization_id: origem || null, arquivo: conteudo, substituir },
      );
      setCarga(r.data);
      toast.success(t("{n} casos carregados.").replace("{n}", String(r.data.criados.length)));
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  async function testar(m: { provider: string; model_id: string }) {
    setOcupado(true);
    try {
      const j = juiz ? resumo?.principais.find((p) => chave(p) === juiz) : null;
      await apiClient.post("/api/v1/admin/bateria-do-leitor/rodadas", {
        testado: { provider: m.provider, model_id: m.model_id },
        juiz: j ? { provider: j.provider, model_id: j.model_id } : null,
        credencial_organization_id: orgDaChave,
      });
      toast.success(t("Teste pedido. A bateria roda em segundo plano, caso a caso."));
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  if (consulta.isError) {
    return <p className="p-6 text-sm text-muted-foreground">{t("Não consegui carregar a bateria agora.")}</p>;
  }
  if (!resumo) return <p className="p-6 text-sm text-muted-foreground">{t("Carregando…")}</p>;

  const ultimaPorModelo = new Map<string, RodadaNaTela>();
  for (const r of resumo.rodadas) if (!ultimaPorModelo.has(chave(r))) ultimaPorModelo.set(chave(r), r);
  const avisoDaBateria = resumo.casos.pequena
    ? t("A bateria ainda é pequena ({n} casos). A nota de um modelo vale para todos os escritórios, mas siga acrescentando casos antes de tratar um modelo como definitivo.").replace(
        "{n}",
        String(resumo.casos.total),
      )
    : null;
  const totais = t("{total} casos ativos · {bloqueiam} bloqueiam · {regra} da Regra v2 · {inventados} inventados · {revisar} decisões do juiz para revisar")
    .replace("{total}", String(resumo.casos.total))
    .replace("{bloqueiam}", String(resumo.casos.bloqueantes))
    .replace("{regra}", String(resumo.casos.regraV2))
    .replace("{inventados}", String(resumo.casos.inventados))
    .replace("{revisar}", String(resumo.casos.paraRevisar));
  const resultadoDaCarga = carga
    ? t("{criados} criados, {ignorados} ignorados.").replace("{criados}", String(carga.criados.length)).replace("{ignorados}", String(carga.ignorados.length))
    : null;

  return (
    <div className="space-y-6 p-6" data-testid="bateria-do-leitor">
      <div>
        <h1 className="text-xl font-semibold">{t("Bateria do Leitor da conversa")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Testa um modelo nas conversas reais congeladas e nos casos inventados. O modelo só pode ser ligado num escritório com 100% nos casos que bloqueiam.")}
        </p>
      </div>
      {avisoDaBateria ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm" data-testid="bateria-pequena">
          {avisoDaBateria}
        </p>
      ) : null}

      <Card className="space-y-3 p-4">
        <h2 className="font-medium">{t("Casos")}</h2>
        <p className="text-sm" data-testid="bateria-totais">
          {totais}
        </p>
        {resumo.casos.porOrigem.length > 0 ? (
          <ul className="text-xs text-muted-foreground">
            {resumo.casos.porOrigem.map((o) => (
              <li key={o.organization_id}>
                {o.nome}: {o.casos}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span>{t("Formato do arquivo")}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2"
              data-testid="bateria-formato"
              value={formato}
              onChange={(e) => setFormato(e.target.value as "regra_v2" | "gestor")}
            >
              <option value="regra_v2">{t("Regra v2 (bateria_48.json)")}</option>
              <option value="gestor">{t("Casos novos do Gestor (Casos_Novos_Gestor.json)")}</option>
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("Empresa de onde vêm as conversas")}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2"
              data-testid="bateria-origem"
              value={origem}
              onChange={(e) => setOrigem(e.target.value)}
            >
              {resumo.organizacoes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("Arquivo do Gestor (.json)")}</span>
            <Input type="file" accept=".json,application/json" data-testid="bateria-arquivo" onChange={(e) => void escolherArquivo(e)} />
            {nomeDoArquivo ? <span className="text-muted-foreground">{nomeDoArquivo}</span> : null}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={substituir} onChange={(e) => setSubstituir(e.target.checked)} />
            {t("Substituir os casos que já estão na bateria (vira uma versão nova)")}
          </label>
        </div>
        <Button type="button" size="sm" disabled={!arquivo || ocupado} data-testid="bateria-carregar" onClick={() => void carregarCasos()}>
          {t("Carregar casos")}
        </Button>
        {carga ? (
          <div className="text-xs" data-testid="bateria-resultado-da-carga">
            <p>{resultadoDaCarga}</p>
            {carga.ignorados.length > 0 ? (
              <ul className="mt-1 text-muted-foreground">
                {carga.ignorados.map((i) => (
                  <li key={i.id}>
                    {i.id}: {i.motivo}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-medium">{t("Testar na bateria")}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span>{t("Empresa cuja chave paga o teste")}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2"
              data-testid="bateria-org-da-chave"
              value={orgDaChave}
              onChange={(e) => setOrgDaChave(e.target.value)}
            >
              {resumo.organizacoes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("Juiz (nunca o modelo testado)")}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2"
              data-testid="bateria-juiz"
              value={juiz}
              onChange={(e) => setJuiz(e.target.value)}
            >
              <option value="">{t("Automático (Opus 5.5; testando o Opus, GPT-6.1 Sol)")}</option>
              {resumo.principais.map((p) => (
                <option key={chave(p)} value={chave(p)}>
                  {p.display_name ?? p.model_id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <table className="w-full text-left text-xs" data-testid="bateria-modelos">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">{t("Modelo")}</th>
              <th className="py-1 pr-3 font-medium">{t("Última rodada")}</th>
              <th className="py-1 pr-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {resumo.principais.map((m) => {
              const r = ultimaPorModelo.get(chave(m));
              return (
                <tr key={chave(m)} className="border-t border-border" data-testid="bateria-modelo" data-modelo={chave(m)}>
                  <td className="py-1 pr-3 font-medium">{m.display_name ?? m.model_id}</td>
                  <td className="py-1 pr-3">{r ? <ResumoDaRodada r={r} /> : t("Sem teste")}</td>
                  <td className="py-1 pr-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={ocupado || resumo.casos.total === 0 || r?.status === "pendente" || r?.status === "rodando"}
                      data-testid="bateria-testar"
                      onClick={() => void testar(m)}
                    >
                      {t("Testar na bateria")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-medium">{t("Rodadas")}</h2>
        {resumo.rodadas.length === 0 ? <p className="text-sm text-muted-foreground">{t("Nenhuma rodada ainda.")}</p> : null}
        <ul className="space-y-2">
          {resumo.rodadas.map((r) => (
            <li key={r.id} className="rounded-md border border-border p-2 text-xs" data-testid="bateria-rodada">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{chave(r)}</span>
                <ResumoDaRodada r={r} />
                <Button type="button" size="sm" variant="ghost" onClick={() => setAberta(aberta === r.id ? null : r.id)}>
                  {aberta === r.id ? t("Fechar") : t("Ver caso a caso")}
                </Button>
              </div>
              {aberta === r.id ? <CasoACaso rodadaId={r.id} /> : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ResumoDaRodada({ r }: { r: RodadaNaTela }) {
  const t = useT();
  if (r.status === "pendente" || r.status === "rodando") {
    const progresso = t("rodando: {feitos} de {total}").replace("{feitos}", String(r.casos_feitos)).replace("{total}", String(r.casos_total));
    return <span data-testid="bateria-progresso">{progresso}</span>;
  }
  if (r.status !== "terminada") {
    const falha = t("não terminou: {erro}").replace("{erro}", r.erro ?? r.status);
    return <span className="text-destructive">{falha}</span>;
  }
  const placar = t("{acertos}/{total} · que bloqueiam {b}/{bt} · qualidade {q}/{qt} · {tempo} s por caso")
    .replace("{acertos}", String(r.acertos))
    .replace("{total}", String(r.casos_total))
    .replace("{b}", String(r.bloqueantes_acertos))
    .replace("{bt}", String(r.bloqueantes))
    .replace("{q}", String(r.qualidade_acertos))
    .replace("{qt}", String(r.regra_v2))
    .replace("{tempo}", r.tempo_medio_ms ? (r.tempo_medio_ms / 1000).toFixed(1) : "—");
  return (
    <span className="flex items-center gap-2">
      <span>{placar}</span>
      <Badge variant={r.aprovado ? "default" : "outline"} data-testid="bateria-aprovado">
        {r.aprovado ? t("Aprovado") : t("Não aprovado")}
      </Badge>
    </span>
  );
}

function CasoACaso({ rodadaId }: { rodadaId: string }) {
  const t = useT();
  const consulta = useQuery({
    queryKey: ["admin", "bateria-do-leitor", rodadaId],
    queryFn: () =>
      apiClient
        .get<{ data: { resultados: ResultadoNaTela[] } }>(`/api/v1/admin/bateria-do-leitor/rodadas/${rodadaId}`)
        .then((r) => r.data.resultados),
  });
  if (!consulta.data) return <p className="mt-2 text-muted-foreground">{t("Carregando…")}</p>;
  return (
    <table className="mt-2 w-full text-left" data-testid="bateria-caso-a-caso">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 pr-2 font-medium">{t("Caso")}</th>
          <th className="py-1 pr-2 font-medium">{t("Resultado")}</th>
          <th className="py-1 pr-2 font-medium">{t("Juiz")}</th>
        </tr>
      </thead>
      <tbody>
        {consulta.data.map((c) => (
          <tr key={`${c.caso_id}-${c.caso_versao}`} className="border-t border-border align-top">
            <td className="py-1 pr-2">
              {c.caso_id} <span className="text-muted-foreground">v{c.caso_versao}</span>
            </td>
            <td className="py-1 pr-2">
              {c.acerto ? t("acertou") : t("errou")}
              {c.erro ? <span className="block text-destructive">{c.erro}</span> : null}
            </td>
            <td className="py-1 pr-2">
              {c.juiz_decisao ? (
                <span>
                  {c.juiz_decisao === c.juiz_lado_do_gabarito ? t("com o gabarito") : c.juiz_decisao === "A" || c.juiz_decisao === "B" ? t("com o modelo") : c.juiz_decisao === "duvida" ? t("dúvida") : t("as duas erradas")}
                  {c.revisar ? <Badge variant="outline" className="ml-1">{t("revisar")}</Badge> : null}
                  {c.juiz_motivo ? <span className="block text-muted-foreground">{c.juiz_motivo}</span> : null}
                  {c.juiz_trecho ? <span className="block italic text-muted-foreground">“{c.juiz_trecho}”</span> : null}
                </span>
              ) : (
                "—"
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

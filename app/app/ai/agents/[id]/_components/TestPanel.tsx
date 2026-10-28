"use client";
/**
 * TestPanel — dry-run de uma version (S-13.12).
 *
 * Envia sample message via POST `:test` (admin-only). Renderiza trace +
 * "Mensagem que SERIA enviada". Não toca WAHA, não cria messages.outbound.
 * Quando `INTERNAL_AGENT_RUN_STUB=true` o backend devolve trace stub com
 * `stub: true`; o componente mostra um aviso amigável.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { agentRunsKey } from "@/hooks/ai/useAgentRuns";
import { useT } from "@/hooks/i18n/useT";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

import { RunTrace } from "./RunTrace";

interface Props {
  agent: AgentRow;
  draft: AgentVersionRow | null;
  published: AgentVersionRow | null;
  readOnly?: boolean;
}

interface TestResponse {
  data: {
    run_id: string;
    status: string;
    final_text?: string | null;
    tool_calls?: unknown;
    tokens_in?: number;
    tokens_out?: number;
    cost_cents?: number;
    latency_ms?: number;
    would_send_to?: { session?: string | null; chat_id?: string | null };
    stub?: boolean;
    candidates?: Array<{ body: string; trace: Array<{ gate: string; verdict: string; code?: string }> }>;
    proposals?: Array<{ tool: string; arguments: unknown }>;
    impediments?: Array<{ code: string; message: string }>;
    /**
     * Não bloqueiam o teste: dizem o que impediria o ENVIO real agora (ex.: fora
     * do horário). Ver `gatesDoSandbox` em lib/agent-engine/agent/preview.ts.
     */
    warnings?: Array<{ code: string; message: string }>;
    restrictions?: string[];
    /** Ver lib/ai/agents/avaliar-resposta-de-teste.ts. */
    guardrails?: {
      passou: boolean;
      /** false = não havia texto para avaliar (teste sem resposta). */
      avaliado?: boolean;
      categorias: string[];
      termos: string[];
      naoAvaliados: Array<{ gate: string; porque: string }>;
    };
  };
}

/**
 * O que as verificações disseram sobre a resposta — e o que elas NÃO puderam
 * dizer.
 *
 * Este componente mostra o resultado da checagem textual suplementar. O motor
 * de prévia executa verificações próprias com contexto simulado; nenhuma delas
 * é prova de que o envio real esteja liberado.
 */
function Verificacoes({ g }: { g: NonNullable<TestResponse["data"]["guardrails"]> }) {
  const t = useT();
  return (
    <div className="space-y-2" data-testid="teste-verificacoes">
      {/* Sem texto não há veredito: nem "limpo", nem "vazou". */}
      {g.avaliado === false ? null : g.passou ? (
        <p
          data-testid="teste-vazamento-limpo"
          className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs"
        >
          {t("A resposta não usa palavras internas do sistema.")}
        </p>
      ) : (
        <div
          data-testid="teste-vazamento-achado"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs"
        >
          <p className="font-medium text-destructive">
            {t("Esta resposta usa palavras que o cliente não deveria ver.")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("Em produção ela seria barrada e o assistente teria que reescrever. Encontrado:")}{" "}
            <span className="font-mono">{g.termos.join(", ")}</span>
          </p>
        </div>
      )}

      {/* Esta lista descreve somente o alcance da checagem textual adicional. */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer" data-testid="teste-nao-verificado">
          {t("A checagem textual não reavalia todas as regras (")}
          {g.naoAvaliados.length} {t("verificações fora desta camada)")}
        </summary>
        <ul className="mt-2 space-y-1 pl-4">
          {g.naoAvaliados.map((n) => (
            <li key={n.gate}>— {n.porque}</li>
          ))}
        </ul>
        <p className="mt-2">
          {t(
            "O motor de prévia pode executar algumas dessas verificações com dados simulados e fazer chamadas ao modelo. Isso não comprova liberação para envio real. Para ver as regras de envio, abra a aba",
          )}{" "}
          <span className="font-medium text-foreground">{t("Confere antes de enviar")}</span>.
        </p>
      </details>
    </div>
  );
}

export function TestPanel({ agent, draft, published, readOnly }: Props) {
  const t = useT();
  const target = draft ?? published;
  const qc = useQueryClient();

  const [message, setMessage] = React.useState("");
  const [contactName, setContactName] = React.useState("");
  const [contactPhone, setContactPhone] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<TestResponse["data"] | null>(null);
  // PC-002b (F1-l): a conversa da sessão de teste. Cada "Executar teste" manda o
  // histórico junto e acrescenta a mensagem e a resposta — o terceiro turno de
  // uma qualificação se testa como ele acontece, não como uma conversa nova.
  const [conversa, setConversa] = React.useState<
    Array<{ direcao: "cliente" | "agente"; texto: string }>
  >([]);
  // PC-002b (F1-l): "que dia e hora é agora" no teste (vazio = agora de verdade).
  const [agoraSimulado, setAgoraSimulado] = React.useState("");

  if (!target) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Configure e salve uma versão antes de testar.")}
      </p>
    );
  }

  const versionLabel =
    target.status === "published"
      ? `v${target.version_number} ${t("(publicada)")}`
      : `v${target.version_number} ${t("(rascunho)")}`;

  async function handleRun() {
    if (!message.trim()) {
      toast.error(t("Informe uma mensagem de teste."));
      return;
    }
    if (!target) return;
    setPending(true);
    setResult(null);
    try {
      const enviada = message.trim();
      const body: Record<string, unknown> = { sample_message: enviada };
      if (conversa.length > 0) body.historico = conversa.slice(-40);
      if (agoraSimulado) {
        const instante = new Date(agoraSimulado);
        if (!Number.isNaN(instante.getTime())) body.agora = instante.toISOString();
      }
      if (contactName.trim() || contactPhone.trim()) {
        body.sample_contact = {
          ...(contactName.trim() ? { name: contactName.trim() } : {}),
          ...(contactPhone.trim() ? { phone: contactPhone.trim() } : {}),
        };
      }
      const res = await apiClient.post<TestResponse>(
        `/api/v1/ai/agents/${agent.id}/versions/${target.id}/test`,
        body,
        // ⚠️ O padrão do cliente é 10s, e um turno de agente NÃO cabe nele: o
        // teste roda o motor inteiro (classificador de etapa, jailbreak, o
        // agente com as ferramentas, checkpoint, verificação de promessa).
        // Medido numa instalação real: 14,5s só na chamada ao modelo. Com 10s,
        // o resultado nunca chegava — o painel ficava em "Nenhum teste
        // executado ainda" enquanto o servidor terminava e devolvia para
        // ninguém (issue #783).
        //
        // 120s é o teto do orçamento de passos do agente, não um chute
        // confortável: acima disso o problema é o agente, não a espera.
        { timeoutMs: 120_000 },
      );
      setResult(res.data);
      const resposta = (res.data.candidates ?? []).map((c) => c.body).join("\n\n").trim();
      setConversa((atual) => [
        ...atual,
        { direcao: "cliente" as const, texto: enviada },
        ...(resposta ? [{ direcao: "agente" as const, texto: resposta }] : []),
      ]);
      setMessage("");
      qc.invalidateQueries({ queryKey: agentRunsKey(agent.id) });
      toast.success(t("Teste executado."));
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(t(err.message) || `${t("Erro")}: ${err.code}`);
      } else {
        toast.error(t("Erro inesperado."));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("Versão alvo")}
          </p>
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline">{versionLabel}</Badge>
            <span className="font-mono text-xs">
              {target.provider} / {target.model}
            </span>
          </div>
        </div>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {t("⚠ Modo teste consome créditos do provider.")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("Nenhuma mensagem é enviada via WhatsApp. O run é registrado como dry-run.")}
          </p>
        </div>

        <div className="space-y-2" data-testid="teste-conversa">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("Conversa deste teste")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="teste-nova-conversa"
              disabled={pending || conversa.length === 0}
              onClick={() => {
                setConversa([]);
                setResult(null);
              }}
            >
              {t("Nova conversa")}
            </Button>
          </div>
          {conversa.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("Cada teste continua a conversa: o agente lê o que já foi dito aqui.")}
            </p>
          ) : (
            <ol className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2 text-xs">
              {conversa.map((m, i) => (
                <li
                  key={i}
                  data-testid="teste-conversa-linha"
                  className={m.direcao === "cliente" ? "text-foreground" : "text-muted-foreground"}
                >
                  <span className="font-medium">
                    {m.direcao === "cliente" ? t("Cliente") : t("Agente")}:
                  </span>{" "}
                  <span className="whitespace-pre-wrap">{m.texto}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="test-agora">{t("Simular dia e hora (opcional)")}</Label>
          <Input
            id="test-agora"
            type="datetime-local"
            data-testid="teste-agora"
            value={agoraSimulado}
            onChange={(e) => setAgoraSimulado(e.target.value)}
            disabled={pending || readOnly}
          />
          <p className="text-xs text-muted-foreground">
            {t("Vazio usa a hora de agora. O agente lê este dia e hora como o momento da mensagem.")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="test-message">{t("Mensagem do cliente (sample)")}</Label>
          <Textarea
            id="test-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("Oi, quanto custa X?")}
            rows={4}
            disabled={pending || readOnly}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <Label htmlFor="test-name">{t("Nome (opcional)")}</Label>
            <Input
              id="test-name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Maria"
              disabled={pending || readOnly}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="test-phone">{t("Telefone (opcional)")}</Label>
            <Input
              id="test-phone"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+55..."
              disabled={pending || readOnly}
            />
          </div>
        </div>

        <Button onClick={handleRun} disabled={pending || readOnly} className="self-start">
          {pending ? t("Executando…") : t("Executar teste")}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("Resultado")}
        </p>

        {!result && !pending ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum teste executado ainda.")}</p>
        ) : null}

        {pending ? (
          <p className="text-sm text-muted-foreground">{t("Executando dry-run…")}</p>
        ) : null}

        {result ? (
          <>
            {result.stub ? (
              <p className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs text-muted-foreground">
                {t(
                  "Provedor de teste controlado. O motor e as verificações são os mesmos; não há chamada a uma IA externa.",
                )}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-2 text-xs">
              <Cell label={t("Status")}>{result.status}</Cell>
              <Cell label={t("Latência")}>
                {typeof result.latency_ms === "number" ? `${result.latency_ms}ms` : "—"}
              </Cell>
              <Cell label={t("Tokens in/out")}>
                {result.tokens_in?.toLocaleString()??"—"} /{" "}
                {result.tokens_out?.toLocaleString()??"—"}
              </Cell>
              <Cell label={t("Custo (cents)")}>{result.cost_cents ?? "—"}</Cell>
            </div>

            <RunTrace
              toolCalls={result.tool_calls}
              finalText={result.final_text ?? null}
              emptyMessage={t("Sem tool calls (resposta direta do LLM).")}
            />

            {result.candidates ? (
              <div className="space-y-2 text-xs">
                <p>
                  {t(
                    "Mesmo motor e conhecimento do agente; nenhuma alteração é aplicada ao cliente.",
                  )}
                </p>
                <p>
                  {t(
                    "Estado do contato simulado. Canal, opt-out e contexto serão conferidos novamente antes de um envio real.",
                  )}
                </p>
                <TravasAcionadas
                  traces={result.candidates.map((c) => c.trace)}
                  impedimentos={result.impediments ?? []}
                />
                {result.candidates.map((candidate, i) => (
                  <details key={i}>
                    <summary>{t("Verificações da resposta")}</summary>
                    <pre className="overflow-auto whitespace-pre-wrap">
                      {JSON.stringify(candidate.trace, null, 2)}
                    </pre>
                  </details>
                ))}
                {result.warnings?.map((x, i) => (
                  <p
                    role="status"
                    key={`aviso-${i}`}
                    data-testid="teste-aviso-de-envio"
                    className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
                  >
                    {x.message}
                  </p>
                ))}
                {result.impediments?.map((x, i) => (
                  <p role="status" key={i}>
                    {x.message}
                  </p>
                ))}
                {!!result.proposals?.length && (
                  <div>
                    <p className="font-medium">
                      {t("Ações propostas: precisam de autorização separada")}
                    </p>
                    <ul data-testid="teste-ferramentas-chamadas">
                      {result.proposals.map((x, i) => (
                        <li key={i}>
                          <span className="font-mono">{x.tool}</span>
                          <pre className="overflow-auto whitespace-pre-wrap text-muted-foreground">
                            {JSON.stringify(x.arguments, null, 2)}
                          </pre>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : result.guardrails ? (
              <Verificacoes g={result.guardrails} />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * PC-002b (F1-l): as travas que AGIRAM nesta resposta, em linguagem de gente —
 * a que barrou (impedimento) e a que mexeu sem barrar (ex.: aviso de IA
 * acrescentado). As que só passaram ficam no detalhe técnico logo abaixo.
 */
function TravasAcionadas({
  traces,
  impedimentos,
}: {
  traces: Array<Array<{ gate: string; verdict: string; code?: string }>>;
  impedimentos: Array<{ code: string; message: string }>;
}) {
  const t = useT();
  const agiram = traces
    .flat()
    // "skipped" SEM código é só o resto da cadeia depois de um veto; COM código
    // é uma trava que agiu sem barrar (ex.: barraria o envio real agora).
    .filter((e) => e.verdict === "veto" || (e.verdict === "skipped" && !!e.code))
    .map((e) => `${e.gate}: ${e.code ?? e.verdict}`);
  if (agiram.length === 0 && impedimentos.length === 0) {
    return (
      <p data-testid="teste-travas-nenhuma" className="text-muted-foreground">
        {t("Nenhuma trava barrou ou alterou esta resposta.")}
      </p>
    );
  }
  return (
    <div data-testid="teste-travas-acionadas" className="rounded-md border border-border/60 p-2">
      <p className="font-medium">{t("Travas acionadas")}</p>
      <ul className="mt-1 space-y-1">
        {impedimentos.map((x, i) => (
          <li key={`imp-${i}`}>
            <span className="font-mono">{x.code}</span> — {x.message}
          </li>
        ))}
        {agiram.map((linha, i) => (
          <li key={`ag-${i}`} className="font-mono">
            {linha}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 px-2 py-1">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="font-mono">{children}</p>
    </div>
  );
}

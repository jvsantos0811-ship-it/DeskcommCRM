"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { nomeDoCanal } from "@/lib/channels/estado";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { FunilDoNumero } from "./FunilDoNumero";
import { ResponsavelDoNumero } from "./ResponsavelDoNumero";

/**
 * A IA atendendo DENTRO da plataforma de atendimento que o escritório já usa
 * (PC-047). A marca vem do servidor (`label`): a tela não pode nomear provider
 * (`lint:channels`), e quem usa reconhece o nome do sistema que contratou.
 *
 * ─── Três passos, na ordem em que dá errado ─────────────────────────────────
 *
 * 1. A credencial da conta (servidor, ID da conta, ID do número, chave). Com
 *    ela o CRM RESPONDE dentro da plataforma.
 * 2. O endereço de entrada: vai no disparo "POST PARA URL" do diálogo que liga a
 *    IA no chat. Sem ele o CRM não RECEBE nada.
 * 3. A passagem e as ações: qual diálogo devolve o chat à equipe, qual campo
 *    desliga a IA no chat, e o que a IA pode executar lá dentro. Opcional — sem
 *    isso a passagem acontece só no CRM.
 *
 * A IA do número nasce FECHADA: ninguém recebe resposta automática até o
 * operador abrir o acesso no cartão de IA desta tela.
 */

const ROTA = "/api/v1/channels/atendimento-externo";
const CHAVE_DA_CONSULTA = ["canal-atendimento-externo"];

interface Acao {
  nome: string;
  dialogo_id: string;
  quando_usar: string;
}

interface Estado {
  label: string;
  connected: boolean;
  channel_session_id: string | null;
  servidor: string | null;
  account_id: string | null;
  phone_id: string | null;
  tem_chave: boolean;
  display_name: string | null;
  status: string | null;
  endereco_de_entrada: string | null;
  config: {
    dialogo_transferencia: string | null;
    campo_da_ia: { nome: string; valor_ao_passar: string } | null;
    acoes: (Acao & { chave: string })[];
  } | null;
}

// Espelha `MAXIMO_DE_ACOES` de `lib/channels/atendimento-externo/config.ts` (PC-052).
const MAXIMO_DE_ACOES = 15;

function ParaColar({ rotulo, valor }: { rotulo: string; valor: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{rotulo}</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">{valor}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await copyToClipboard(valor);
            toast.success(t("Copiado."));
          }}
        >
          {t("Copiar")}
        </Button>
      </div>
    </div>
  );
}

export function CanalAtendimentoExternoClient() {
  const { data: estado = null, isLoading } = useQuery({
    queryKey: CHAVE_DA_CONSULTA,
    queryFn: async () => (await apiClient.get<{ data: Estado }>(ROTA)).data,
  });
  // A chave remonta o formulário quando o estado do servidor chega (ou a conexão
  // muda): os campos nascem com o que está gravado, e depois disso o que vale é
  // o que o operador digita — recarregar a consulta não apaga a edição.
  const chave = isLoading ? "carregando" : (estado?.channel_session_id ?? "novo");
  return <FormularioDoAtendimentoExterno key={chave} estado={estado} />;
}

function FormularioDoAtendimentoExterno({ estado }: { estado: Estado | null }) {
  const t = useT();
  const qc = useQueryClient();

  const [servidor, setServidor] = useState(() => estado?.servidor ?? "");
  const [accountId, setAccountId] = useState(() => estado?.account_id ?? "");
  const [phoneId, setPhoneId] = useState(() => estado?.phone_id ?? "");
  const [chave, setChave] = useState("");
  const [transferencia, setTransferencia] = useState(() => estado?.config?.dialogo_transferencia ?? "");
  const [campoNome, setCampoNome] = useState(() => estado?.config?.campo_da_ia?.nome ?? "");
  const [campoValor, setCampoValor] = useState(() => estado?.config?.campo_da_ia?.valor_ao_passar ?? "");
  const [acoes, setAcoes] = useState<Acao[]>(() =>
    (estado?.config?.acoes ?? []).map(({ nome, dialogo_id, quando_usar }) => ({ nome, dialogo_id, quando_usar })),
  );
  const [salvando, setSalvando] = useState<"conta" | "config" | "segredo" | null>(null);

  const recarregar = () => qc.invalidateQueries({ queryKey: CHAVE_DA_CONSULTA });
  const rotulo = estado?.label ?? t("plataforma de atendimento");
  const conectado = estado?.connected ?? false;

  const erroDaTela = (e: unknown, padrao: string) =>
    toast.error(e instanceof Error ? t(e.message) : padrao);

  const conectar = async () => {
    setSalvando("conta");
    try {
      await apiClient.post(ROTA, { servidor, account_id: accountId, phone_id: phoneId, api_key: chave });
      setChave("");
      toast.success(t("Conta conectada."));
      await recarregar();
    } catch (e) {
      erroDaTela(e, t("Não foi possível conectar."));
    } finally {
      setSalvando(null);
    }
  };

  const salvarConfig = async () => {
    setSalvando("config");
    try {
      await apiClient.patch(ROTA, {
        config: {
          dialogo_transferencia: transferencia.trim() || null,
          campo_da_ia: campoNome.trim() ? { nome: campoNome.trim(), valor_ao_passar: campoValor } : null,
          acoes: acoes.filter((a) => a.nome.trim() || a.dialogo_id.trim() || a.quando_usar.trim()),
        },
      });
      toast.success(t("Configuração salva."));
      await recarregar();
    } catch (e) {
      erroDaTela(e, t("Não foi possível salvar a configuração."));
    } finally {
      setSalvando(null);
    }
  };

  const trocarSegredo = async () => {
    setSalvando("segredo");
    try {
      await apiClient.patch(ROTA, { trocar_segredo: true });
      toast.success(t("Endereço novo gerado. Atualize o diálogo na plataforma: o antigo deixou de valer."));
      await recarregar();
    } catch (e) {
      erroDaTela(e, t("Não foi possível trocar o endereço."));
    } finally {
      setSalvando(null);
    }
  };

  const mudarAcao = (i: number, campo: keyof Acao, valor: string) =>
    setAcoes((atual) => atual.map((a, j) => (j === i ? { ...a, [campo]: valor } : a)));

  const podeConectar =
    servidor.trim().length > 0 && accountId.trim().length >= 4 && phoneId.trim().length >= 4 && chave.trim().length >= 16;

  return (
    <div className="flex flex-col gap-4" data-testid="canal-atendimento-externo">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t("Atender dentro do")} {rotulo}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "A IA responde dentro da plataforma que o escritório já usa: a equipe continua trabalhando lá, e o CRM recebe cada mensagem pelo diálogo que liga a IA no chat.",
              )}
            </p>
          </div>
          {conectado ? (
            <Badge variant="secondary">{t("Conectado")}</Badge>
          ) : (
            <Badge variant="outline">{t("Não conectado")}</Badge>
          )}
        </div>

        {conectado && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{nomeDoCanal(estado ?? {}, t)}</p>
            <p className="text-xs text-muted-foreground">
              {estado?.servidor ?? "—"} · {estado?.status ?? "—"}
            </p>
          </div>
        )}

        {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}
        {estado?.channel_session_id && <FunilDoNumero channelId={estado.channel_session_id} />}
        {estado?.channel_session_id && <ResponsavelDoNumero channelId={estado.channel_session_id} />}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ae-servidor">{t("Servidor da conta")}</Label>
            <Input
              id="ae-servidor"
              value={servidor}
              onChange={(e) => setServidor(e.target.value)}
              placeholder="s7"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ae-conta">{t("ID da conta")}</Label>
            <Input id="ae-conta" value={accountId} onChange={(e) => setAccountId(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ae-numero">{t("ID do número")}</Label>
            <Input id="ae-numero" value={phoneId} onChange={(e) => setPhoneId(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("Os três aparecem na tela de celulares da plataforma, junto com a chave da API. O servidor é o começo do endereço (ex.: s7).")}
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ae-chave">{t("Chave da API")}</Label>
          <Input
            id="ae-chave"
            type="password"
            value={chave}
            onChange={(e) => setChave(e.target.value)}
            placeholder={estado?.tem_chave ? t("gravada — preencha para trocar") : ""}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t("Guardada cifrada. Depois de gravar ela não é mostrada de novo — para trocar, cole a nova.")}
          </p>
        </div>

        <div>
          <Button onClick={conectar} disabled={salvando !== null || !podeConectar}>
            {salvando === "conta" ? t("Salvando…") : conectado ? t("Trocar a credencial") : t("Conectar")}
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("A plataforma não tem como conferir a chave antes do uso: o primeiro envio é a prova. Faça o teste num chat de teste.")}
          </p>
        </div>
      </Card>

      {conectado && estado?.endereco_de_entrada && (
        <Card className="flex flex-col gap-4 p-4">
          <div>
            <h3 className="text-sm font-semibold">{t("Receber as mensagens")}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "No diálogo da plataforma que liga a IA no chat, adicione a ação POST PARA URL com o endereço abaixo. Teste primeiro num chat de teste. Não deixe ligado ao mesmo tempo o diálogo de outra IA no mesmo chat.",
              )}
            </p>
          </div>
          <ParaColar rotulo={t("Endereço de entrada")} valor={estado.endereco_de_entrada} />
          <div>
            <Button variant="outline" onClick={trocarSegredo} disabled={salvando !== null}>
              {salvando === "segredo" ? t("Gerando…") : t("Gerar endereço novo")}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("Use se o endereço vazou. O antigo para de funcionar na hora.")}
            </p>
          </div>
        </Card>
      )}

      {conectado && (
        <Card className="flex flex-col gap-4 p-4">
          <div>
            <h3 className="text-sm font-semibold">{t("Passagem para a equipe e ações da IA")}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "Opcional. Quando a IA passa o atendimento para a equipe, o CRM anota o resumo no chat, desliga a IA no campo escolhido e executa o diálogo de transferência.",
              )}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ae-transferencia">{t("ID do diálogo de transferência")}</Label>
            <Input
              id="ae-transferencia"
              value={transferencia}
              onChange={(e) => setTransferencia(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ae-campo">{t("Campo que liga a IA no chat")}</Label>
              <Input id="ae-campo" value={campoNome} onChange={(e) => setCampoNome(e.target.value)} autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ae-campo-valor">{t("Valor gravado ao passar para a equipe")}</Label>
              <Input
                id="ae-campo-valor"
                value={campoValor}
                onChange={(e) => setCampoValor(e.target.value)}
                placeholder={t("vazio desliga")}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("Ações que a IA pode executar")}
            </span>
            {acoes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("Nenhuma. A IA só anota para a equipe.")}
              </p>
            )}
            {acoes.map((a, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
                <Input
                  aria-label={t("Nome da ação")}
                  value={a.nome}
                  onChange={(e) => mudarAcao(i, "nome", e.target.value)}
                  placeholder={t("Nome (ex.: Etiquetar como qualificado)")}
                />
                <Input
                  aria-label={t("ID do diálogo")}
                  value={a.dialogo_id}
                  onChange={(e) => mudarAcao(i, "dialogo_id", e.target.value)}
                  placeholder={t("ID do diálogo")}
                />
                <Input
                  aria-label={t("Quando a IA deve usar")}
                  value={a.quando_usar}
                  onChange={(e) => mudarAcao(i, "quando_usar", e.target.value)}
                  placeholder={t("Quando a IA deve usar")}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAcoes((atual) => atual.filter((_, j) => j !== i))}
                >
                  {t("Remover")}
                </Button>
              </div>
            ))}
            {acoes.length < MAXIMO_DE_ACOES && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAcoes((atual) => [...atual, { nome: "", dialogo_id: "", quando_usar: "" }])}
                >
                  {t("Adicionar ação")}
                </Button>
              </div>
            )}
          </div>

          <div>
            <Button onClick={salvarConfig} disabled={salvando !== null}>
              {salvando === "config" ? t("Salvando…") : t("Salvar configuração")}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

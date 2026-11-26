"use client";
import { useId, useState } from "react";
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
import { EnquetesDoGrupo } from "./EnquetesDoGrupo";
import { FunilDoNumero } from "./FunilDoNumero";
import { RenomearConexao } from "./RenomearConexao";
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
 *
 * ─── Dois números (PC-053) ──────────────────────────────────────────────────
 *
 * Um bloco por número conectado, na ordem em que foram conectados, cada um com
 * o seu endereço, a sua configuração e o seu acesso da IA. "Adicionar outro
 * número" aparece quando o servidor diz que cabe (`pode_adicionar`) e pode usar
 * a mesma chave do número já conectado: a chave nunca volta à tela, o servidor
 * copia a cifrada.
 */

const ROTA = "/api/v1/channels/atendimento-externo";
const CHAVE_DA_CONSULTA = ["canal-atendimento-externo"];

interface Acao {
  nome: string;
  dialogo_id: string;
  quando_usar: string;
}

interface Conexao {
  channel_session_id: string;
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
    /** PC-058: o diálogo da equipe na plataforma cala a IA. */
    valor_quando_equipe_assume?: string | null;
    /** A IA só responde no chat sem responsável na plataforma. */
    ia_so_sem_responsavel?: boolean;
    /** PC-052 parte 3: diálogo por uso, fora da janela de 24 h. */
    roteiros_fora_da_janela?: Partial<Record<UsoForaDaJanela, string | null>>;
  } | null;
}

type UsoForaDaJanela =
  | "confirmacao_vespera"
  | "confirmacao_do_dia"
  | "lembrete"
  | "followup_1"
  | "followup_2"
  | "followup_3"
  | "followup_4"
  | "followup_5";

const FOLLOWUPS = ["followup_1", "followup_2", "followup_3", "followup_4", "followup_5"] as const;

interface Estado {
  label: string;
  connected: boolean;
  conexoes?: Conexao[];
  pode_adicionar?: boolean;
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
  const t = useT();
  const { data: estado = null, isLoading } = useQuery({
    queryKey: CHAVE_DA_CONSULTA,
    queryFn: async () => (await apiClient.get<{ data: Estado }>(ROTA)).data,
  });
  const [adicionando, setAdicionando] = useState(false);
  const rotulo = estado?.label ?? t("plataforma de atendimento");
  const conexoes = estado?.conexoes ?? [];
  const primeira = conexoes[0] ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="canal-atendimento-externo">
      {/* Sempre uma LISTA: sem número conectado, o formulário da primeira conexão
          ocupa o lugar do número 1. A chave de cada bloco é a conexão dele, então
          os campos nascem com o que está gravado e, depois, o que vale é o que o
          operador digita — recarregar a consulta não apaga a edição. */}
      {(conexoes.length === 0 ? [null] : conexoes).map((conexao, indice) => (
        <FormularioDoAtendimentoExterno
          key={isLoading ? "carregando" : (conexao?.channel_session_id ?? "novo")}
          rotulo={rotulo}
          conexao={conexao}
          indice={indice}
          varios={conexoes.length > 1}
        />
      ))}

      {primeira && estado?.pode_adicionar && (
        adicionando ? (
          <AdicionarNumero rotulo={rotulo} primeira={primeira} onFechar={() => setAdicionando(false)} />
        ) : (
          <div>
            <Button variant="outline" onClick={() => setAdicionando(true)}>
              {t("Adicionar outro número")}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t(
                "Para o outro número da mesma conta — por exemplo, o oficial e o do QR. A IA atende nos dois, cada um com o seu endereço e a sua configuração.",
              )}
            </p>
          </div>
        )
      )}

      {/* PC-050: enquetes do grupo (desligadas de fábrica). Uma por empresa. */}
      {conexoes.length > 0 && <EnquetesDoGrupo />}
    </div>
  );
}

/** O segundo número da mesma conta (PC-053). */
function AdicionarNumero({
  rotulo,
  primeira,
  onFechar,
}: {
  rotulo: string;
  primeira: Conexao;
  onFechar: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [apelido, setApelido] = useState("");
  const [servidor, setServidor] = useState(() => primeira.servidor ?? "");
  const [accountId, setAccountId] = useState(() => primeira.account_id ?? "");
  const [phoneId, setPhoneId] = useState("");
  const [mesmaChave, setMesmaChave] = useState(true);
  const [chave, setChave] = useState("");
  const [salvando, setSalvando] = useState(false);

  const podeAdicionar =
    servidor.trim().length > 0 &&
    accountId.trim().length >= 4 &&
    phoneId.trim().length >= 4 &&
    (mesmaChave || chave.trim().length >= 16);

  const adicionar = async () => {
    setSalvando(true);
    try {
      await apiClient.post(ROTA, {
        servidor,
        account_id: accountId,
        phone_id: phoneId,
        novo: true,
        ...(apelido.trim() ? { apelido: apelido.trim() } : {}),
        ...(mesmaChave ? { usar_chave_de: primeira.channel_session_id } : { api_key: chave }),
      });
      setChave("");
      toast.success(t("Número conectado. Agora cole o endereço de entrada dele no diálogo da plataforma."));
      await qc.invalidateQueries({ queryKey: CHAVE_DA_CONSULTA });
      onFechar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="adicionar-numero-atendimento-externo">
      <div>
        <h3 className="text-sm font-semibold">
          {t("Adicionar outro número do")} {rotulo}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("O ID do número aparece na tela de celulares da plataforma, ao lado de cada número.")}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ae-novo-apelido">{t("Como a equipe chama este número")}</Label>
        <Input
          id="ae-novo-apelido"
          value={apelido}
          onChange={(e) => setApelido(e.target.value)}
          placeholder={t("ex.: Número do QR")}
          autoComplete="off"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ae-novo-servidor">{t("Servidor da conta")}</Label>
          <Input id="ae-novo-servidor" value={servidor} onChange={(e) => setServidor(e.target.value)} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ae-novo-conta">{t("ID da conta")}</Label>
          <Input id="ae-novo-conta" value={accountId} onChange={(e) => setAccountId(e.target.value)} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ae-novo-numero">{t("ID do número")}</Label>
          <Input id="ae-novo-numero" value={phoneId} onChange={(e) => setPhoneId(e.target.value)} autoComplete="off" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={mesmaChave}
          onChange={(e) => setMesmaChave(e.target.checked)}
          className="size-4"
        />
        {t("Usar a mesma chave da API do número já conectado")}
      </label>
      {!mesmaChave && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ae-novo-chave">{t("Chave da API")}</Label>
          <Input
            id="ae-novo-chave"
            type="password"
            value={chave}
            onChange={(e) => setChave(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={adicionar} disabled={salvando || !podeAdicionar}>
          {salvando ? t("Salvando…") : t("Conectar este número")}
        </Button>
        <Button variant="ghost" onClick={onFechar} disabled={salvando}>
          {t("Cancelar")}
        </Button>
      </div>
    </Card>
  );
}

function FormularioDoAtendimentoExterno({
  rotulo,
  conexao: estado,
  indice,
  varios,
}: {
  rotulo: string;
  conexao: Conexao | null;
  indice: number;
  varios: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  // Com dois blocos na tela, um id fixo se repetiria e o rótulo do número 2
  // focaria o campo do número 1 (PC-053).
  const uid = useId();
  // Com dois números, toda escrita diz de qual deles é (PC-053).
  const alvo = estado ? { channel_session_id: estado.channel_session_id } : {};

  const [servidor, setServidor] = useState(() => estado?.servidor ?? "");
  const [accountId, setAccountId] = useState(() => estado?.account_id ?? "");
  const [phoneId, setPhoneId] = useState(() => estado?.phone_id ?? "");
  const [chave, setChave] = useState("");
  const [transferencia, setTransferencia] = useState(() => estado?.config?.dialogo_transferencia ?? "");
  const [campoNome, setCampoNome] = useState(() => estado?.config?.campo_da_ia?.nome ?? "");
  const [campoValor, setCampoValor] = useState(() => estado?.config?.campo_da_ia?.valor_ao_passar ?? "");
  const [valorEquipe, setValorEquipe] = useState(() => estado?.config?.valor_quando_equipe_assume ?? "");
  const [soSemResponsavel, setSoSemResponsavel] = useState(() => estado?.config?.ia_so_sem_responsavel === true);
  const [acoes, setAcoes] = useState<Acao[]>(() =>
    (estado?.config?.acoes ?? []).map(({ nome, dialogo_id, quando_usar }) => ({ nome, dialogo_id, quando_usar })),
  );
  const [roteiros, setRoteiros] = useState<Record<UsoForaDaJanela, string>>(() => ({
    confirmacao_vespera: estado?.config?.roteiros_fora_da_janela?.confirmacao_vespera ?? "",
    confirmacao_do_dia: estado?.config?.roteiros_fora_da_janela?.confirmacao_do_dia ?? "",
    lembrete: estado?.config?.roteiros_fora_da_janela?.lembrete ?? "",
    followup_1: estado?.config?.roteiros_fora_da_janela?.followup_1 ?? "",
    followup_2: estado?.config?.roteiros_fora_da_janela?.followup_2 ?? "",
    followup_3: estado?.config?.roteiros_fora_da_janela?.followup_3 ?? "",
    followup_4: estado?.config?.roteiros_fora_da_janela?.followup_4 ?? "",
    followup_5: estado?.config?.roteiros_fora_da_janela?.followup_5 ?? "",
  }));
  const [salvando, setSalvando] = useState<"conta" | "config" | "segredo" | null>(null);

  const recarregar = () => qc.invalidateQueries({ queryKey: CHAVE_DA_CONSULTA });
  const conectado = estado !== null;

  const erroDaTela = (e: unknown, padrao: string) =>
    toast.error(e instanceof Error ? t(e.message) : padrao);

  const conectar = async () => {
    setSalvando("conta");
    try {
      await apiClient.post(ROTA, { ...alvo, servidor, account_id: accountId, phone_id: phoneId, api_key: chave });
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
        ...alvo,
        config: {
          dialogo_transferencia: transferencia.trim() || null,
          campo_da_ia: campoNome.trim() ? { nome: campoNome.trim(), valor_ao_passar: campoValor } : null,
          valor_quando_equipe_assume: valorEquipe.trim() || null,
          ia_so_sem_responsavel: soSemResponsavel,
          acoes: acoes.filter((a) => a.nome.trim() || a.dialogo_id.trim() || a.quando_usar.trim()),
          roteiros_fora_da_janela: {
            confirmacao_vespera: roteiros.confirmacao_vespera.trim() || null,
            confirmacao_do_dia: roteiros.confirmacao_do_dia.trim() || null,
            lembrete: roteiros.lembrete.trim() || null,
            followup_1: roteiros.followup_1.trim() || null,
            followup_2: roteiros.followup_2.trim() || null,
            followup_3: roteiros.followup_3.trim() || null,
            followup_4: roteiros.followup_4.trim() || null,
            followup_5: roteiros.followup_5.trim() || null,
          },
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
      await apiClient.patch(ROTA, { ...alvo, trocar_segredo: true });
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
    <div className="flex flex-col gap-4" data-testid={`numero-atendimento-externo-${indice + 1}`}>
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {varios ? `${t("Número")} ${indice + 1} · ` : ""}
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

        {estado && (
          <div className="flex items-start justify-between gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
            <div>
              <p className="font-medium">{nomeDoCanal(estado, t)}</p>
              <p className="text-xs text-muted-foreground">
                {estado.servidor ?? "—"} · {estado.status ?? "—"}
              </p>
            </div>
            <RenomearConexao
              channelId={estado.channel_session_id}
              currentName={estado.display_name}
              onSaved={recarregar}
            />
          </div>
        )}

        {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}
        {estado?.channel_session_id && <FunilDoNumero channelId={estado.channel_session_id} />}
        {estado?.channel_session_id && <ResponsavelDoNumero channelId={estado.channel_session_id} />}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-ae-servidor`}>{t("Servidor da conta")}</Label>
            <Input
              id={`${uid}-ae-servidor`}
              value={servidor}
              onChange={(e) => setServidor(e.target.value)}
              placeholder="s7"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-ae-conta`}>{t("ID da conta")}</Label>
            <Input id={`${uid}-ae-conta`} value={accountId} onChange={(e) => setAccountId(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-ae-numero`}>{t("ID do número")}</Label>
            <Input id={`${uid}-ae-numero`} value={phoneId} onChange={(e) => setPhoneId(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("Os três aparecem na tela de celulares da plataforma, junto com a chave da API. O servidor é o começo do endereço (ex.: s7).")}
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-ae-chave`}>{t("Chave da API")}</Label>
          <Input
            id={`${uid}-ae-chave`}
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
            <Label htmlFor={`${uid}-ae-transferencia`}>{t("ID do diálogo de transferência")}</Label>
            <Input
              id={`${uid}-ae-transferencia`}
              value={transferencia}
              onChange={(e) => setTransferencia(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${uid}-ae-campo`}>{t("Campo que liga a IA no chat")}</Label>
              <Input id={`${uid}-ae-campo`} value={campoNome} onChange={(e) => setCampoNome(e.target.value)} autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${uid}-ae-campo-valor`}>{t("Valor gravado ao passar para a equipe")}</Label>
              <Input
                id={`${uid}-ae-campo-valor`}
                value={campoValor}
                onChange={(e) => setCampoValor(e.target.value)}
                placeholder={t("vazio desliga")}
                autoComplete="off"
              />
            </div>
          </div>

          {/* PC-058: o caminho de volta do campo da IA. A equipe executa no chat
              um diálogo que grava ESTE valor (diferente do da passagem) e faz o
              POST: o CRM entende que a equipe assumiu ali. Vazio desliga. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-ae-equipe-assume`}>{t("Valor que a equipe grava ao assumir na plataforma")}</Label>
            <Input
              id={`${uid}-ae-equipe-assume`}
              value={valorEquipe}
              onChange={(e) => setValorEquipe(e.target.value)}
              placeholder={t("vazio desliga")}
              autoComplete="off"
              data-testid="ae-equipe-assumiu"
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "Quando alguém da equipe executa no chat um diálogo que grava este valor no campo da IA e faz o POST para o CRM, a IA para, o follow-up pausa e o card vai para a etapa da equipe. Use um valor diferente do gravado ao passar para a equipe.",
              )}
            </p>
          </div>

          {/* A IA só fala no chat que a plataforma entrega sem responsável (o
              que está num setor). Alguém da equipe virou responsável = a IA
              para sozinha, sem diálogo; o chat voltou ao setor = ela volta. */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={soSemResponsavel}
                onChange={(e) => setSoSemResponsavel(e.target.checked)}
                className="size-4"
                data-testid="ae-so-sem-responsavel"
              />
              {t("A IA só responde no chat sem responsável na plataforma")}
            </label>
            <p className="text-xs text-muted-foreground">
              {t(
                "Ligado: quando alguém da equipe vira responsável pelo chat na plataforma, a IA para, o follow-up pausa e o card vai para a etapa da equipe, sem precisar executar diálogo. Quando o chat volta para um setor sem responsável, a IA volta a atender.",
              )}
            </p>
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

          <div className="flex flex-col gap-2" data-testid="roteiros-fora-da-janela">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("Fora da janela de 24 horas")}
            </span>
            <p className="text-xs text-muted-foreground">
              {t(
                "Opcional. Quando o cliente não escreve há mais de 24 horas, o CRM não pode mandar texto livre: no lugar, executa o diálogo escolhido aqui, que manda o modelo aprovado da conta. Vazio = naquele caso nada sai.",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                "O modelo do diálogo é fixo: não escreva \"amanhã\" no da véspera (quando a véspera cai num dia sem envio, ele sai antes), e lembre que o mesmo diálogo do lembrete sai em cada aviso do tipo de atendimento.",
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-ae-roteiro-vespera`}>{t("Confirmação da véspera")}</Label>
                <Input
                  id={`${uid}-ae-roteiro-vespera`}
                  value={roteiros.confirmacao_vespera}
                  onChange={(e) => setRoteiros((r) => ({ ...r, confirmacao_vespera: e.target.value }))}
                  placeholder={t("ID do diálogo")}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-ae-roteiro-dia`}>{t("Confirmação do dia")}</Label>
                <Input
                  id={`${uid}-ae-roteiro-dia`}
                  value={roteiros.confirmacao_do_dia}
                  onChange={(e) => setRoteiros((r) => ({ ...r, confirmacao_do_dia: e.target.value }))}
                  placeholder={t("ID do diálogo")}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-ae-roteiro-lembrete`}>{t("Lembrete do compromisso")}</Label>
                <Input
                  id={`${uid}-ae-roteiro-lembrete`}
                  value={roteiros.lembrete}
                  onChange={(e) => setRoteiros((r) => ({ ...r, lembrete: e.target.value }))}
                  placeholder={t("ID do diálogo")}
                  autoComplete="off"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Follow-up: o passo do fluxo escolhe qual destes diálogos sai quando a janela fechou.")}
            </p>
            <div className="grid gap-3 sm:grid-cols-5">
              {FOLLOWUPS.map((uso, i) => (
                <div key={uso} className="flex flex-col gap-1.5">
                  <Label htmlFor={`${uid}-ae-roteiro-${uso}`}>
                    {t("Follow-up")} {i + 1}
                  </Label>
                  <Input
                    id={`${uid}-ae-roteiro-${uso}`}
                    value={roteiros[uso]}
                    onChange={(e) => setRoteiros((r) => ({ ...r, [uso]: e.target.value }))}
                    placeholder={t("ID do diálogo")}
                    autoComplete="off"
                  />
                </div>
              ))}
            </div>
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

"use client";

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import type { ContaNaTela } from "@/lib/contratos/assinatura/conta";
import type { AvisoAoSalvar } from "@/lib/contratos/assinatura/configurar";
import { VARIAVEIS_DO_SISTEMA } from "@/lib/contratos/modelo-do-contrato";
import type { ModeloNaTela } from "@/lib/contratos/modelos-servidor";

type T = (texto: string) => string;

interface RespostaDaConta {
  data: { conta: ContaNaTela | null; servicos: Array<{ id: string; nome: string }> };
}

const CHAVE_DA_CONTA = ["assinatura-eletronica", "conta"] as const;
const CHAVE_DOS_MODELOS = ["contratos", "modelos"] as const;

export function AssinaturaEletronicaClient() {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <ServicoDeAssinatura />
      <ModelosDeContrato />
    </div>
  );
}

// ─── O serviço ──────────────────────────────────────────────────────────────

function ServicoDeAssinatura() {
  const atual = useQuery({
    queryKey: CHAVE_DA_CONTA,
    queryFn: () => apiClient.get<RespostaDaConta>("/api/v1/settings/assinatura-eletronica"),
  });
  const conta = atual.data?.data?.conta ?? null;
  // A chave remonta o formulário quando a conta salva muda: o estado nasce da
  // conta, sem efeito copiando o servidor para o estado.
  return (
    <FormularioDoServico
      key={conta?.atualizado_em ?? (atual.isLoading ? "carregando" : "nova")}
      conta={conta}
      servicos={atual.data?.data?.servicos ?? []}
      carregando={atual.isLoading}
    />
  );
}

function FormularioDoServico({
  conta,
  servicos,
  carregando,
}: {
  conta: ContaNaTela | null;
  servicos: Array<{ id: string; nome: string }>;
  carregando: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const ids = { provedor: useId(), chave: useId(), prazo: useId(), ambiente: useId(), endereco: useId(), segredo: useId() };

  const [provedor, setProvedor] = useState(String(conta?.provedor ?? "zapsign"));
  const [ambiente, setAmbiente] = useState<"teste" | "producao">(conta?.ambiente ?? "teste");
  const [chave, setChave] = useState("");
  const [aprovacao, setAprovacao] = useState(conta?.aprovacao_da_equipe ?? false);
  const [prazo, setPrazo] = useState(conta?.prazo_para_assinar_dias ?? 7);
  const [ativo, setAtivo] = useState(conta?.ativo ?? true);
  const [segredoDoAviso, setSegredoDoAviso] = useState("");
  // PC-046: a Autentique não cadastra o aviso pela API — o gerente cola o
  // endereço no painel dela e traz o segredo do endpoint para cá.
  const avisoNoPainel = provedor === "autentique";
  // O endereço e o segredo guardado só valem para o serviço que está salvo.
  const contaDesteServico = conta && conta.provedor === provedor ? conta : null;

  const salvar = useMutation({
    mutationFn: () =>
      apiClient.put<{ data: { conta: ContaNaTela; aviso: AvisoAoSalvar } }>(
        "/api/v1/settings/assinatura-eletronica",
        {
          provedor,
          ambiente,
          ...(chave.trim() ? { chave: chave.trim() } : {}),
          aprovacao_da_equipe: aprovacao,
          prazo_para_assinar_dias: prazo,
          ativo,
          ...(avisoNoPainel && segredoDoAviso.trim() ? { segredo_do_aviso: segredoDoAviso.trim() } : {}),
        },
      ),
    onSuccess: (r) => {
      setChave("");
      setSegredoDoAviso("");
      void qc.invalidateQueries({ queryKey: CHAVE_DA_CONTA });
      const aviso = r.data?.aviso;
      if (aviso === "cadastrado") toast.success(t("Assinatura eletrônica salva e conectada."));
      else if (aviso === "falta_colar_no_painel")
        toast.info(t("Salvo. Agora cadastre o endereço do aviso no painel da Autentique e cole aqui o segredo que ela mostrar."));
      else if (aviso === "sem_endereco_publico")
        toast.warning(t("Salvo. Esta instalação não tem endereço público com https: o serviço não consegue avisar quando o cliente assina."));
      else toast.warning(t("Salvo, mas o serviço não aceitou o aviso de assinatura. Tente salvar de novo em alguns minutos."));
    },
    onError: showApiError,
  });

  return (
    <Card className="space-y-4 p-4" data-testid="servico-de-assinatura">
      <div>
        <h2 className="text-sm font-semibold">{t("Serviço de assinatura")}</h2>
        <p className="text-xs text-muted-foreground">
          {t(
            "O serviço guarda a assinatura com validade jurídica. O escritório precisa ter contrato com ele (ele é operador dos dados do cliente, pela LGPD).",
          )}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={ids.provedor}>{t("Serviço")}</Label>
          <select
            id={ids.provedor}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={provedor}
            onChange={(e) => setProvedor(e.target.value)}
            data-testid="assinatura-provedor"
          >
            {servicos.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("Ambiente")}</legend>
          <div className="flex gap-4 pt-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name={ids.ambiente} checked={ambiente === "teste"} onChange={() => setAmbiente("teste")} />
              {t("Teste (sem validade jurídica)")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={ids.ambiente}
                checked={ambiente === "producao"}
                onChange={() => setAmbiente("producao")}
              />
              {t("Produção")}
            </label>
          </div>
        </fieldset>
      </div>

      <div className="space-y-1">
        <Label htmlFor={ids.chave}>{t("Chave da API do serviço")}</Label>
        <Input
          id={ids.chave}
          type="password"
          autoComplete="off"
          value={chave}
          onChange={(e) => setChave(e.target.value)}
          placeholder={
            conta?.tem_chave ? `${t("Guardada")} ••••${conta.chave_final ?? ""} — ${t("deixe em branco para manter")}` : ""
          }
          data-testid="assinatura-chave"
        />
        <p className="text-xs text-muted-foreground">
          {t("A chave fica guardada cifrada e nunca aparece de novo nesta tela. Ela é testada no serviço antes de salvar.")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={ids.prazo}>{t("Prazo para o cliente assinar (dias)")}</Label>
          <Input
            id={ids.prazo}
            type="number"
            min={1}
            max={60}
            value={prazo}
            onChange={(e) => setPrazo(Number(e.target.value) || 7)}
          />
        </div>
        <div className="flex flex-col gap-3 pt-1">
          <label className="flex items-start gap-3 text-sm">
            <Switch checked={aprovacao} onCheckedChange={setAprovacao} data-testid="assinatura-aprovacao" />
            <span>
              <span className="block font-medium">{t("A equipe aprova antes do envio")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("Desligado (o padrão), a IA envia o contrato sozinha quando o cliente está pronto.")}
              </span>
            </span>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <Switch checked={ativo} onCheckedChange={setAtivo} />
            <span className="font-medium">{t("Ligado")}</span>
          </label>
        </div>
      </div>

      {avisoNoPainel ? (
        <div className="space-y-3 rounded-md border border-border p-3" data-testid="aviso-no-painel">
          <div>
            <h3 className="text-sm font-medium">{t("Aviso de assinatura (cadastrar na Autentique)")}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "A Autentique não deixa o CRM cadastrar o aviso sozinho. No painel dela, na parte de webhooks da API, crie um endpoint com o endereço abaixo, marque os eventos de documento e de assinatura e cole aqui o segredo que ela mostrar.",
              )}
            </p>
          </div>
          {contaDesteServico?.endereco_do_aviso ? (
            <div className="space-y-1">
              <Label htmlFor={ids.endereco}>{t("Endereço do aviso")}</Label>
              <div className="flex gap-2">
                <Input
                  id={ids.endereco}
                  readOnly
                  value={contaDesteServico.endereco_do_aviso}
                  onFocus={(e) => e.currentTarget.select()}
                  data-testid="aviso-endereco"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    const copiou = await copyToClipboard(contaDesteServico.endereco_do_aviso ?? "");
                    if (copiou) toast.success(t("Endereço copiado."));
                    else toast.error(t("Não consegui copiar. Selecione o endereço e copie à mão."));
                  }}
                  data-testid="aviso-copiar"
                >
                  {t("Copiar")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("Este endereço é secreto: só cole no painel da Autentique.")}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="aviso-salve-primeiro">
              {contaDesteServico
                ? t("Esta instalação não tem endereço público com https: o serviço não consegue avisar quando o cliente assina.")
                : t("Salve primeiro com o token da API da Autentique: o endereço do aviso aparece aqui.")}
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor={ids.segredo}>{t("Segredo do endpoint (mostrado pela Autentique)")}</Label>
            <Input
              id={ids.segredo}
              type="password"
              autoComplete="off"
              value={segredoDoAviso}
              onChange={(e) => setSegredoDoAviso(e.target.value)}
              placeholder={contaDesteServico?.tem_segredo_do_aviso ? `${t("Guardado")} — ${t("deixe em branco para manter")}` : ""}
              disabled={!contaDesteServico}
              data-testid="aviso-segredo"
            />
            <p className="text-xs text-muted-foreground">
              {t("É com ele que o CRM confere que o aviso veio mesmo da Autentique. Fica guardado cifrado.")}
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => salvar.mutate()} disabled={salvar.isPending || carregando} data-testid="assinatura-salvar">
          {salvar.isPending ? t("Testando e salvando...") : t("Salvar")}
        </Button>
        {conta ? (
          <span className="text-xs text-muted-foreground">
            {conta.aviso_registrado_em
              ? t("Conectado: o serviço avisa o CRM quando o cliente assina.")
              : conta.cadastro_do_aviso === "no_painel"
                ? t("Falta cadastrar o aviso no painel da Autentique e colar o segredo aqui.")
                : t("O aviso de assinatura ainda não foi cadastrado no serviço.")}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

// ─── Os modelos ─────────────────────────────────────────────────────────────

function dataCurta(iso: string | null, tagDoIdioma: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(tagDoIdioma);
}

function ModelosDeContrato() {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const qc = useQueryClient();
  const lista = useQuery({
    queryKey: CHAVE_DOS_MODELOS,
    queryFn: () => apiClient.get<{ data: ModeloNaTela[] }>("/api/v1/contratos/modelos"),
  });
  const modelos = Array.isArray(lista.data?.data) ? lista.data.data : [];
  const [editando, setEditando] = useState<ModeloNaTela | "novo" | null>(null);
  const [aprovando, setAprovando] = useState<ModeloNaTela | null>(null);
  const recarregar = () => void qc.invalidateQueries({ queryKey: CHAVE_DOS_MODELOS });

  const alternar = useMutation({
    mutationFn: (m: ModeloNaTela) => apiClient.patch(`/api/v1/contratos/modelos/${m.id}`, { ativo: !m.ativo }),
    onSuccess: recarregar,
    onError: showApiError,
  });

  return (
    <Card className="space-y-4 p-4" data-testid="modelos-de-contrato">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("Modelos de contrato")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Um modelo por benefício ou produto. A IA só usa o modelo aprovado pelo advogado; mudar o texto pede nova aprovação.",
            )}
          </p>
        </div>
        <Button size="sm" onClick={() => setEditando("novo")} data-testid="modelo-novo">
          {t("Novo modelo")}
        </Button>
      </div>

      {modelos.length === 0 && !lista.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum modelo ainda.")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {modelos.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3" data-testid="modelo-item">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {m.nome}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    · {m.interesse ? m.interesse : t("qualquer interesse")} · {t("versão")} {m.versao}
                  </span>
                </p>
                {m.aprovado_em ? (
                  <Badge variant="success">
                    {t("Aprovado por")} {m.aprovado_por_nome} {t("em")} {dataCurta(m.aprovado_em, tagDoIdioma)}
                  </Badge>
                ) : (
                  <Badge variant="warning">{t("Aguardando aprovação do advogado")}</Badge>
                )}
                {!m.ativo ? (
                  <Badge variant="neutral" className="ml-2">
                    {t("Desligado")}
                  </Badge>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditando(m)}>
                  {t("Editar")}
                </Button>
                {!m.aprovado_em ? (
                  <Button size="sm" onClick={() => setAprovando(m)} data-testid="modelo-aprovar">
                    {t("Registrar aprovação")}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => alternar.mutate(m)} disabled={alternar.isPending}>
                  {m.ativo ? t("Desligar") : t("Ligar")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editando ? (
        <EditorDoModelo t={t} modelo={editando === "novo" ? null : editando} aoFechar={() => setEditando(null)} aoSalvar={recarregar} />
      ) : null}
      {aprovando ? (
        <AprovacaoDoModelo t={t} modelo={aprovando} aoFechar={() => setAprovando(null)} aoSalvar={recarregar} />
      ) : null}
    </Card>
  );
}

function EditorDoModelo({
  t,
  modelo,
  aoFechar,
  aoSalvar,
}: {
  t: T;
  modelo: ModeloNaTela | null;
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const ids = { nome: useId(), interesse: useId(), corpo: useId(), campos: useId() };
  const [nome, setNome] = useState(modelo?.nome ?? "");
  const [interesse, setInteresse] = useState(modelo?.interesse ?? "");
  const [corpo, setCorpo] = useState(modelo?.corpo ?? "");
  const [campos, setCampos] = useState((modelo?.campos_obrigatorios ?? []).join(", "));
  const salvar = useMutation({
    mutationFn: () => {
      const corpoDoPedido = {
        nome,
        interesse: interesse.trim() || null,
        corpo,
        campos_obrigatorios: campos
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      };
      return modelo
        ? apiClient.patch(`/api/v1/contratos/modelos/${modelo.id}`, corpoDoPedido)
        : apiClient.post("/api/v1/contratos/modelos", corpoDoPedido);
    },
    onSuccess: () => {
      toast.success(modelo?.aprovado_em ? t("Modelo salvo. Se o texto mudou, ele precisa de nova aprovação.") : t("Modelo salvo."));
      aoSalvar();
      aoFechar();
    },
    onError: showApiError,
  });
  const variaveis = Object.entries(VARIAVEIS_DO_SISTEMA)
    .map(([k]) => `{{${k}}}`)
    .join(" ");

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && aoFechar()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{modelo ? t("Editar modelo de contrato") : t("Novo modelo de contrato")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={ids.nome}>{t("Nome do modelo")}</Label>
              <Input id={ids.nome} value={nome} onChange={(e) => setNome(e.target.value)} data-testid="modelo-nome" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={ids.interesse}>{t("Benefício ou produto (vazio = qualquer)")}</Label>
              <Input id={ids.interesse} value={interesse} onChange={(e) => setInteresse(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.corpo}>{t("Texto do contrato")}</Label>
            <Textarea
              id={ids.corpo}
              rows={12}
              value={corpo}
              onChange={(e) => setCorpo(e.target.value)}
              data-testid="modelo-corpo"
            />
            <p className="text-xs text-muted-foreground">
              {t("Use {{chave}} com a chave de um campo do funil (ex.: {{nome_completo}}, {{cpf}}, {{cep}}). Do sistema:")}{" "}
              <code>{variaveis}</code>
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.campos}>{t("Campos que precisam estar CONFIRMADOS (chaves separadas por vírgula)")}</Label>
            <Input id={ids.campos} value={campos} onChange={(e) => setCampos(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => salvar.mutate()} disabled={salvar.isPending} data-testid="modelo-salvar">
            {salvar.isPending ? t("Salvando...") : t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AprovacaoDoModelo({
  t,
  modelo,
  aoFechar,
  aoSalvar,
}: {
  t: T;
  modelo: ModeloNaTela;
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const id = useId();
  const [nome, setNome] = useState("");
  const aprovar = useMutation({
    mutationFn: () => apiClient.post(`/api/v1/contratos/modelos/${modelo.id}/aprovar`, { aprovado_por_nome: nome }),
    onSuccess: () => {
      toast.success(t("Aprovação registrada. A IA já pode usar este modelo."));
      aoSalvar();
      aoFechar();
    },
    onError: showApiError,
  });
  return (
    <Dialog open onOpenChange={(aberto) => !aberto && aoFechar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Aprovação do advogado")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("Registre só depois que o advogado leu e aprovou este texto. Vale para a versão")} {modelo.versao}.
        </p>
        <div className="space-y-1">
          <Label htmlFor={id}>{t("Nome do advogado que aprovou")}</Label>
          <Input id={id} value={nome} onChange={(e) => setNome(e.target.value)} data-testid="modelo-aprovado-por" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => aprovar.mutate()} disabled={aprovar.isPending || nome.trim().length < 3}>
            {t("Registrar aprovação")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

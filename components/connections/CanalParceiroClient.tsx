"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { FunilDoNumero } from "./FunilDoNumero";
import { ResponsavelDoNumero } from "./ResponsavelDoNumero";
import { ImportarHistorico } from "./ImportarHistorico";
import { ParaIntegrar } from "./ParaIntegrar";
import { RenomearConexao } from "./RenomearConexao";

/**
 * Conectar um número por um PROVEDOR PARCEIRO.
 *
 * ─── Por que a tela não escreve o nome do provedor ──────────────────────────
 *
 * O rótulo vem do servidor (`label`), e não de uma string aqui, porque o
 * `lint:channels` proíbe nomear provider fora de `lib/channels/` — e a razão é
 * anterior ao lint: no dia em que houver um segundo parceiro, esta tela não
 * muda. O que o usuário lê continua sendo a marca que ele contratou.
 *
 * ─── A ordem dos passos é a ordem em que dá errado ──────────────────────────
 *
 * Conectar são DUAS pontas: a chave, que deixa a gente FALAR com o provedor, e
 * o webhook, que deixa o provedor falar com a gente. Quem faz só a primeira
 * consegue enviar e nunca recebe — e o defeito aparece como "o cliente
 * respondeu e não chegou", horas depois, sem nada na tela dizendo por quê.
 *
 * Por isso o segundo passo só aparece DEPOIS de conectar, com a URL e o segredo
 * prontos para copiar, e um aviso explícito de que sem colá-los não entra
 * mensagem.
 */

/** Um número conectado por este canal, como a rota o descreve. */
interface Numero {
  channel_session_id: string | null;
  account_id: string | null;
  phone_number: string | null;
  display_name: string | null;
  status: string | null;
  has_api_key: boolean;
  webhook_url: string | null;
}

interface Estado {
  channel_session_id?: string | null;
  label: string;
  connected: boolean;
  account_id: string | null;
  phone_number: string | null;
  display_name: string | null;
  status: string | null;
  has_api_key: boolean;
  webhook_url: string | null;
  /** Endpoint base do provedor — usado no painel "Para integrar". */
  endpoint: string | null;
  /** Todos os números em uso (desde 16/11/2026; até dois por organização). */
  numbers?: Numero[];
  /** Cabe mais um número? */
  can_add?: boolean;
}

interface Conectado {
  /** De qual número é o segredo (servidor de antes desta mudança não manda). */
  channel_session_id?: string | null;
  webhook_url: string;
  webhook_secret: string;
  phone_number: string | null;
  quality_rating: string | null;
}

/**
 * A lista de números a mostrar. Uma resposta sem `numbers` (servidor de antes
 * desta mudança) vira a lista de um número só, montada dos campos de cima — a
 * tela de quem tem um número fica igual.
 */
function numerosDoEstado(estado: Estado | null): Numero[] {
  if (!estado) return [];
  if (Array.isArray(estado.numbers)) return estado.numbers;
  if (!estado.connected) return [];
  return [
    {
      channel_session_id: estado.channel_session_id ?? null,
      account_id: estado.account_id,
      phone_number: estado.phone_number,
      display_name: estado.display_name,
      status: estado.status,
      has_api_key: estado.has_api_key,
      webhook_url: estado.webhook_url,
    },
  ];
}

/** Campo somente-leitura com botão de copiar — o que o operador cola do outro lado. */
function ParaColar({ rotulo, valor }: { rotulo: string; valor: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {rotulo}
      </span>
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

export function CanalParceiroClient() {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  /**
   * O segredo recém-gerado e o número a que ele pertence: pelo id quando a rota
   * o devolve (a ordem da lista pode mudar ao trazer um número de volta), e pela
   * posição só como reserva.
   */
  const [recem, setRecem] = useState<{ indice: number; dados: Conectado } | null>(null);
  const recemDe = (numero: Numero | null, indice: number): Conectado | null => {
    if (!recem) return null;
    const id = recem.dados.channel_session_id ?? null;
    if (id && numero?.channel_session_id) return numero.channel_session_id === id ? recem.dados : null;
    return recem.indice === indice ? recem.dados : null;
  };
  const [adicionando, setAdicionando] = useState(false);

  const carregar = async () => {
    try {
      const r = await apiClient.get<{ data: Estado }>("/api/v1/channels/partner");
      setEstado(r.data);
    } catch {
      // Falha de leitura não deve travar a tela: o formulário continua servindo.
      setEstado(null);
    }
  };

  useEffect(() => {
    void carregar();
  }, []);

  const rotulo = estado?.label ?? t("provedor parceiro");
  const numeros = numerosDoEstado(estado);

  return (
    <div className="flex flex-col gap-4">
      {/* Sempre uma LISTA, com o formulário da primeira conexão no lugar do
          número 1 quando ainda não há nenhum: a mesma posição e a mesma chave
          fazem o React manter o bloco quando a leitura do estado volta, em vez
          de remontá-lo no meio do que a pessoa já digitou. */}
      {(numeros.length === 0 ? [null] : numeros).map((numero, indice) => (
        <BlocoDoNumero
          key={`numero-${indice}`}
          rotulo={rotulo}
          indice={indice}
          numero={numero}
          endpoint={estado?.endpoint ?? null}
          recem={recemDe(numero, indice)}
          onConectado={async (dados) => {
            setRecem({ indice, dados });
            await carregar();
          }}
          carregar={carregar}
        />
      ))}

      {numeros.length > 0 && estado?.can_add && (
        adicionando ? (
          <AdicionarNumero
            rotulo={rotulo}
            onCancelar={() => setAdicionando(false)}
            onAdicionado={async (dados) => {
              // O número novo é o mais recente, e a lista vem do mais antigo
              // para o mais novo: ele entra no fim.
              setRecem({ indice: numeros.length, dados });
              setAdicionando(false);
              await carregar();
            }}
          />
        ) : (
          <div>
            <Button variant="outline" onClick={() => setAdicionando(true)}>
              {t("Adicionar outro número")}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t(
                "Para um segundo número da mesma empresa — por exemplo, um para os anúncios e outro para a equipe.",
              )}
            </p>
          </div>
        )
      )}
    </div>
  );
}

/** O aviso do passo 2: a URL e o segredo que o operador cola no provedor. */
function CartaoFaltaLigarAVolta({ dados }: { dados: Conectado }) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-4 border-warning/40 bg-warning-bg p-4">
      <div>
        <h3 className="text-sm font-semibold">{t("Falta ligar a volta")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("Cole os dois valores abaixo no webhook do seu provedor. Sem isso o CRM")}{" "}
          <strong>{t("envia mas não recebe")}</strong>
          {t(
            ": a resposta do cliente não chega, e nada na tela avisa. O segredo aparece",
          )}{" "}
          <strong>{t("uma única vez")}</strong>
          {t(" — se sair desta tela sem copiá-lo, reconecte para gerar outro.")}
        </p>
      </div>
      <ParaColar rotulo={t("URL do webhook")} valor={dados.webhook_url} />
      <ParaColar rotulo={t("Segredo (assinatura)")} valor={dados.webhook_secret} />
      <p className="text-xs text-muted-foreground">{t("Na inscrição do webhook no provedor, preencha o filtro de contas (accountIds) com a Conta deste número: assim só chegam aqui os eventos dele.")}</p>
      {dados.quality_rating && (
        <p className="text-xs text-muted-foreground">
          {t("Qualidade do número segundo a plataforma:")} {dados.quality_rating}
        </p>
      )}
    </Card>
  );
}

/**
 * Um número: estado, ajustes, credencial, webhook e o painel de integrar.
 *
 * Com `numero` nulo é o formulário da PRIMEIRA conexão — a tela de quem ainda
 * não conectou nada, igual à de antes.
 */
function BlocoDoNumero({
  rotulo,
  indice,
  numero,
  endpoint,
  recem,
  onConectado,
  carregar,
}: {
  rotulo: string;
  indice: number;
  numero: Numero | null;
  endpoint: string | null;
  recem: Conectado | null;
  onConectado: (dados: Conectado) => Promise<void>;
  carregar: () => Promise<void>;
}) {
  const t = useT();
  const [accountId, setAccountId] = useState(numero?.account_id ?? "");
  // A conta gravada chega com a leitura do estado, depois do primeiro render:
  // quando ela muda, o campo passa a mostrá-la (ajuste de estado no render, sem efeito).
  const [contaVista, setContaVista] = useState(numero?.account_id ?? null);
  if ((numero?.account_id ?? null) !== contaVista) {
    setContaVista(numero?.account_id ?? null);
    if (numero?.account_id) setAccountId(numero.account_id);
  }
  const [apiKey, setApiKey] = useState("");
  const [salvando, setSalvando] = useState(false);
  const conectado = numero !== null;
  const canal = numero?.channel_session_id ?? null;
  // Nome do CANAL (channel_sessions), não de contato.
  const nomeDoCanal = numero ? numero.display_name : null;
  // Ids únicos por número: com dois formulários na tela, `htmlFor` repetido
  // ligaria o rótulo de um ao campo do outro.
  const sufixo = indice === 0 ? "" : `-${indice + 1}`;

  const conectar = async () => {
    setSalvando(true);
    try {
      const r = await apiClient.post<{ data: Conectado }>("/api/v1/channels/partner", {
        account_id: accountId,
        api_key: apiKey,
        // Reconectar diz QUAL número: com dois, a conta colada nunca troca o outro.
        ...(canal ? { channel_session_id: canal } : {}),
      });
      // A chave sai da memória da tela assim que é gravada: ela não volta num
      // GET, e deixá-la no input só cria uma cópia a mais de um segredo.
      setApiKey("");
      toast.success(t("Canal conectado."));
      await onConectado(r.data);
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <>
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {indice === 0 ? t("Conectar por") : t("Outro número por")} {rotulo}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "Um número oficial (WhatsApp Business) conectado através do seu provedor. As mensagens entram e saem pelo CRM, e os modelos aprovados são os mesmos da sua conta.",
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
            <p className="font-medium">{nomeDoCanal ?? t("Número conectado")}</p>
            <p className="text-xs text-muted-foreground">
              {numero?.phone_number ?? t("sem número informado")} · {numero?.status ?? "—"}
            </p>
          </div>
        )}

        {canal && <ChannelAiAccess channelId={canal} />}
        {canal && <FunilDoNumero channelId={canal} />}
        {canal && <ResponsavelDoNumero channelId={canal} />}
        {canal && (
          <div>
            <RenomearConexao
              channelId={canal}
              currentName={nomeDoCanal}
              onSaved={carregar}
            />
          </div>
        )}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`parceiro-conta${sufixo}`}>{t("Conta")}</Label>
            <Input
              id={`parceiro-conta${sufixo}`}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder={t("id da conta conectada no provedor")}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("É o identificador do número no painel do provedor — não o da Meta.")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`parceiro-chave${sufixo}`}>{t("Chave de API")}</Label>
            <Input
              id={`parceiro-chave${sufixo}`}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                numero?.has_api_key ? t("gravada — preencha para trocar") : t("cole a chave")
              }
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "Guardada cifrada. Depois de gravar ela não é mostrada de novo — para trocar, cole a nova.",
              )}
            </p>
          </div>

          <div>
            <Button onClick={conectar} disabled={salvando || !accountId || !apiKey}>
              {salvando ? t("Verificando…") : conectado ? t("Reconectar") : t("Conectar")}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("A credencial é testada contra o provedor antes de ser gravada.")}
            </p>
          </div>
        </div>
      </Card>

      {conectado && canal && <ImportarHistorico channelId={canal} />}

      {/* Só depois de conectar: antes disso não há URL nem segredo a mostrar, e
          um passo 2 vazio faz parecer que falta algo que ainda não podia existir. */}
      {recem && <CartaoFaltaLigarAVolta dados={recem} />}

      {conectado && !recem && numero?.webhook_url && (
        <Card className="flex flex-col gap-3 p-4">
          <div>
            <h3 className="text-sm font-semibold">Webhook</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "O endereço que o provedor usa para entregar as mensagens. O segredo não é mostrado de novo — para obter um novo, reconecte.",
              )}
            </p>
          </div>
          <ParaColar rotulo={t("URL do webhook")} valor={numero.webhook_url} />
          <p className="text-xs text-muted-foreground">{t("Na inscrição do webhook no provedor, preencha o filtro de contas (accountIds) com a Conta deste número: assim só chegam aqui os eventos dele.")}</p>
        </Card>
      )}

      {conectado ? (
        <ParaIntegrar
          campos={[
            { rotulo: t("Endpoint da API"), valor: endpoint },
            { rotulo: t("Conta"), valor: numero?.account_id ?? null },
          ]}
          ajuda={
            <div className="space-y-1.5">
              <p>
                {t(
                  "A chave de API está no painel do provedor, na conta conectada — este CRM não a exibe de volta.",
                )}
              </p>
              <p>
                {t(
                  "O webhook de um número aponta para um só destino. Para os dois CRMs receberem ao mesmo tempo, um deles precisa reencaminhar as mensagens ao outro.",
                )}
              </p>
            </div>
          }
          aviso={
            <>
              {t("Um número tem um único webhook.")}{" "}
              {t("Para operar em dois CRMs ao mesmo tempo, configure o reencaminhamento de mensagens.")}
            </>
          }
        />
      ) : null}
    </>
  );
}

/**
 * Acrescentar um número. Formulário próprio, fechado até o clique: com ele
 * aberto ao lado do primeiro, colar a conta no campo errado era um clique.
 */
function AdicionarNumero({
  rotulo,
  onCancelar,
  onAdicionado,
}: {
  rotulo: string;
  onCancelar: () => void;
  onAdicionado: (dados: Conectado) => Promise<void>;
}) {
  const t = useT();
  const [accountId, setAccountId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [salvando, setSalvando] = useState(false);

  const adicionar = async () => {
    setSalvando(true);
    try {
      const r = await apiClient.post<{ data: Conectado }>("/api/v1/channels/partner", {
        account_id: accountId,
        api_key: apiKey,
        novo: true,
      });
      setApiKey("");
      toast.success(t("Número adicionado."));
      await onAdicionado(r.data);
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h3 className="text-sm font-semibold">
          {t("Adicionar outro número por")} {rotulo}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Cada número tem a sua Conta no provedor, o seu webhook e o seu funil de entrada. O número novo começa com a IA fechada (só números de teste) até você abrir o acesso dele.",
          )}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="parceiro-conta-novo">{t("Conta")}</Label>
        <Input
          id="parceiro-conta-novo"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder={t("id da conta conectada no provedor")}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          {t("É o identificador do número no painel do provedor — não o da Meta.")}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="parceiro-chave-novo">{t("Chave de API")}</Label>
        <Input
          id="parceiro-chave-novo"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("cole a chave")}
          autoComplete="off"
        />
      </div>
      <div className="flex gap-2">
        <Button onClick={adicionar} disabled={salvando || !accountId || !apiKey}>
          {salvando ? t("Verificando…") : t("Adicionar número")}
        </Button>
        <Button variant="ghost" onClick={onCancelar} disabled={salvando}>
          {t("Cancelar")}
        </Button>
      </div>
    </Card>
  );
}

"use client";

import { useId, useState, useTransition } from "react";

import {
  definirModeloDoEventoDaAgenda,
  type ErroModeloDoEvento,
} from "@/app/actions/settings/definirModeloDoEventoDaAgenda";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  montarTitulo,
  TITULO_SUGERIDO,
  type ModeloDoEvento,
  type NivelDaDescricao,
} from "@/lib/agenda/modelo-do-evento";
import { useT } from "@/hooks/i18n/useT";

/**
 * "COMO O COMPROMISSO APARECE NA AGENDA" (PC-044) — irmã de `MeetComAcessoAberto`:
 * mesma tela, mesmo piso `manager`, mesma action pela SESSÃO.
 *
 * DESLIGADO (o padrão): nada muda — o compromisso nasce com o título de quem
 * marcou (ou o nome do tipo) e a descrição de quem marcou. LIGADO: título pelo
 * modelo e descrição no nível escolhido.
 *
 * O aviso de LGPD fica ao lado da opção "completa", que é a única que pode
 * levar o resumo da conversa (e com ele fato de saúde) para fora do CRM.
 *
 * ⚠️ A tela NÃO é a autorização: quem grava é
 * `fn_definir_modelo_do_evento_agenda`, no banco. `podeMudar` é cortesia.
 */

const EXEMPLO = {
  tipo: "Consulta inicial",
  nomeDoContato: "Maria da Silva Souza",
  telefone: "5531987654321",
  etapa: "Qualificado",
};

export function ModeloDoEventoNaAgenda({
  modeloInicial,
  podeMudar,
}: {
  /** `organizations.settings.modelo_do_evento_agenda` (migration 9035). */
  modeloInicial: ModeloDoEvento | null;
  /** Espelha o piso `manager` da RPC. Cortesia, não autorização. */
  podeMudar: boolean;
}) {
  const t = useT();
  const idDoRotulo = useId();
  const idDoTitulo = useId();
  const [ligado, setLigado] = useState(modeloInicial !== null);
  const [titulo, setTitulo] = useState(modeloInicial?.titulo ?? TITULO_SUGERIDO);
  const [descricao, setDescricao] = useState<NivelDaDescricao>(
    modeloInicial?.descricao ?? "basica",
  );
  // PC-052 — "agenda interna": o contato nunca é convidado e a descrição vai em todos.
  const [agendaInterna, setAgendaInterna] = useState(modeloInicial?.agenda_interna === true);
  const [erro, setErro] = useState<ErroModeloDoEvento | null>(null);
  const [salvo, setSalvo] = useState(false);
  const [salvando, iniciar] = useTransition();

  function textoDoErro(e: ErroModeloDoEvento): string {
    switch (e) {
      case "invalido":
        return t("O título precisa ter de 1 a 200 caracteres.");
      case "sessao":
        return t("Sua sessão expirou. Entre de novo.");
      case "somente_leitura":
        return t("Acompanhamento somente leitura ou encerrado.");
      case "sem_empresa":
        return t("Nenhuma empresa ativa.");
      case "sem_permissao":
        return t("Só um gerente ou administrador pode mudar essa regra.");
      case "mfa":
        return t("Confirme a verificação em duas etapas.");
      case "tente_de_novo":
        return t("Outra mudança estava em andamento. Tente de novo.");
      case "falha":
        return t("Não consegui salvar essa mudança agora.");
    }
  }

  function gravar(modelo: ModeloDoEvento | null) {
    setErro(null);
    setSalvo(false);
    iniciar(async () => {
      const r = await definirModeloDoEventoDaAgenda(modelo);
      if (!r.ok) {
        setErro(r.erro);
        return;
      }
      setLigado(r.modelo !== null);
      if (r.modelo) {
        setTitulo(r.modelo.titulo);
        setDescricao(r.modelo.descricao);
        setAgendaInterna(r.modelo.agenda_interna === true);
      }
      setSalvo(true);
    });
  }

  function alternar(novo: boolean) {
    if (!novo) {
      gravar(null);
      return;
    }
    gravar({
      titulo: titulo.trim() || TITULO_SUGERIDO,
      descricao,
      ...(agendaInterna ? { agenda_interna: true } : {}),
    });
  }

  const desabilitado = !podeMudar || salvando;

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="modelo-do-evento">
      <h2 className="font-semibold">{t("Como o compromisso aparece na agenda")}</h2>

      <div className="flex items-center gap-3">
        <Switch
          checked={ligado}
          onCheckedChange={alternar}
          disabled={desabilitado}
          aria-labelledby={idDoRotulo}
          data-testid="modelo-do-evento-interruptor"
        />
        <span id={idDoRotulo} className="text-sm font-medium">
          {t("Usar um modelo de título e de descrição")}
        </span>
      </div>

      <p className="text-sm text-text-muted">
        {t(
          "Desligado, o compromisso nasce com o título de quem marcou (ou o nome do tipo de atendimento), como sempre. Ligado, todo compromisso marcado pela IA ou pela equipe segue o modelo abaixo.",
        )}
      </p>

      {ligado && (
        <div className="space-y-3">
          <label htmlFor={idDoTitulo} className="block text-sm font-medium">
            {t("Título")}
          </label>
          <Input
            id={idDoTitulo}
            value={titulo}
            maxLength={200}
            onChange={(e) => setTitulo(e.target.value)}
            disabled={desabilitado}
            data-testid="modelo-do-evento-titulo"
          />
          <p className="text-xs text-text-muted">
            {t(
              "Campos: {tipo}, {primeiro_nome}, {dois_nomes} (primeiro e segundo nome), {nome_completo}, {telefone}, {final_telefone} (os 4 últimos dígitos) e {etapa}.",
            )}
          </p>
          <p className="text-xs text-text-muted" data-testid="modelo-do-evento-convidado">
            {t(
              "Com o modelo ligado, o título que alguém digitar ao marcar é trocado pelo modelo. Quando o cliente é convidado do evento (e-mail na ficha ou convidado digitado), ele recebe o convite por e-mail: nesse caso o título sai sem a etapa e a descrição fica só com o que foi escrito ao marcar.",
            )}
          </p>
          <p className="text-sm" data-testid="modelo-do-evento-exemplo">
            {t("Exemplo:")} <strong>{montarTitulo(titulo || TITULO_SUGERIDO, EXEMPLO)}</strong>
          </p>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Descrição do compromisso")}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="modelo-do-evento-descricao"
                checked={descricao === "nenhuma"}
                onChange={() => setDescricao("nenhuma")}
                disabled={desabilitado}
              />
              <span>{t("Só o que foi escrito ao marcar (como hoje)")}</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="modelo-do-evento-descricao"
                checked={descricao === "basica"}
                onChange={() => setDescricao("basica")}
                disabled={desabilitado}
              />
              <span>
                {t("Básica: tipo de atendimento, etapa do funil e a próxima ação anotada pela IA")}
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="modelo-do-evento-descricao"
                checked={descricao === "completa"}
                onChange={() => setDescricao("completa")}
                disabled={desabilitado}
                data-testid="modelo-do-evento-completa"
              />
              <span>{t("Completa: a básica mais o resumo da conversa e a observação de quem marcou")}</span>
            </label>
            {descricao === "completa" && (
              <p
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
                data-testid="modelo-do-evento-aviso-lgpd"
              >
                {t(
                  "⚠ O resumo da conversa pode ter dado de saúde ou outro dado sensível do cliente. A agenda costuma ser vista por mais gente que o CRM e às vezes fica no celular pessoal: use a completa só se a agenda for restrita a quem atende.",
                )}
              </p>
            )}
          </fieldset>

          <label className="flex items-start gap-2 text-sm" data-testid="modelo-do-evento-agenda-interna">
            <input
              type="checkbox"
              checked={agendaInterna}
              onChange={(e) => setAgendaInterna(e.target.checked)}
              disabled={desabilitado}
            />
            <span className="flex flex-col gap-1">
              {t("Agenda interna: nunca convidar o cliente")}
              <span className="text-xs text-text-muted">
                {t(
                  "O cliente não recebe convite do Google, mesmo com e-mail na ficha, e por isso a descrição vai em todos os compromissos.",
                )}
              </span>
              {modeloInicial?.agenda_interna === true && !agendaInterna ? (
                <span className="text-xs text-text-muted" data-testid="modelo-do-evento-agenda-interna-aviso">
                  {t(
                    "⚠ Ao desligar, o cliente com e-mail na ficha passa a ser convidado na próxima mudança do compromisso — e recebe por e-mail a descrição que já está no evento.",
                  )}
                </span>
              ) : null}
            </span>
          </label>

          <Button
            type="button"
            size="sm"
            onClick={() =>
              gravar({
                titulo: titulo.trim(),
                descricao,
                ...(agendaInterna ? { agenda_interna: true } : {}),
              })
            }
            disabled={desabilitado || titulo.trim().length === 0}
            data-testid="modelo-do-evento-salvar"
          >
            {t("Salvar modelo")}
          </Button>
        </div>
      )}

      {!podeMudar && (
        <p className="text-sm text-text-muted">
          {t("Só um gerente ou administrador pode mudar essa regra.")}
        </p>
      )}
      {salvo && !erro && (
        <p className="text-sm text-text-muted" role="status">
          {t("Salvo.")}
        </p>
      )}
      {erro && (
        <p role="alert" className="text-sm text-destructive" data-testid="modelo-do-evento-erro">
          {textoDoErro(erro)}
        </p>
      )}
    </section>
  );
}

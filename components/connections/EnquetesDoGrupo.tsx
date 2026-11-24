"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * PC-050 — Enquetes do grupo, no canal de atendimento externo.
 *
 * Quem vota numa enquete do grupo recebe, pelo diálogo da plataforma, a
 * mensagem de abertura pelo número oficial; o diálogo manda ao CRM um campo com
 * a enquete e a opção. Aqui o escritório liga a chave (desligada de fábrica),
 * escolhe de qual campo vem o voto (a lista mostra só os NOMES dos campos vistos
 * nos avisos, nunca os de conteúdo) e cadastra as enquetes: código, pergunta e, por opção,
 * o que ela quer dizer e se a IA chama no privado.
 */
const ROTA = "/api/v1/channels/atendimento-externo/enquetes";

interface Opcao {
  valor: string;
  significado: string;
  chamar: boolean;
}
interface Enquete {
  codigo: string;
  pergunta: string;
  opcoes: Opcao[];
  ativa: boolean;
  /** Só na tela: a linha já está gravada (código travado, remover pede confirmação). */
  gravada?: boolean;
}
interface Estado {
  ligada: boolean;
  campo_do_voto: string | null;
  campos_vistos: string[];
  enquetes: Enquete[];
}

const NOVA: Enquete = { codigo: "", pergunta: "", opcoes: [{ valor: "", significado: "", chamar: true }], ativa: true };

export function EnquetesDoGrupo() {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [salvando, setSalvando] = useState(false);
  // Leitura que falhou não pode virar "lista vazia" salvável: salvar apagaria as
  // enquetes cadastradas (e os votos delas).
  const [leituraFalhou, setLeituraFalhou] = useState(false);
  const [confirmar, setConfirmar] = useState<number | null>(null);

  useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ data: Estado }>(ROTA)
      .then(({ data }) => {
        if (!vivo) return;
        setEstado({ ...data, enquetes: data.enquetes.map((e) => ({ ...e, gravada: true })) });
      })
      .catch(() => {
        if (!vivo) return;
        setLeituraFalhou(true);
        setEstado({ ligada: false, campo_do_voto: null, campos_vistos: [], enquetes: [] });
      });
    return () => {
      vivo = false;
    };
  }, []);

  if (!estado) return null;

  const tirar = (i: number) => {
    setConfirmar(null);
    setEstado({ ...estado, enquetes: estado.enquetes.filter((_, j) => j !== i) });
  };
  const pedirRemocao = (i: number) => {
    // Remover enquete gravada apaga os votos dela ao salvar: pede confirmação.
    if (estado.enquetes[i]!.gravada) setConfirmar(i);
    else tirar(i);
  };

  const mudarEnquete = (i: number, parte: Partial<Enquete>) =>
    setEstado({ ...estado, enquetes: estado.enquetes.map((e, j) => (j === i ? { ...e, ...parte } : e)) });
  const mudarOpcao = (i: number, k: number, parte: Partial<Opcao>) =>
    mudarEnquete(i, { opcoes: estado.enquetes[i]!.opcoes.map((o, j) => (j === k ? { ...o, ...parte } : o)) });

  async function salvar() {
    if (!estado || leituraFalhou) return;
    setSalvando(true);
    try {
      const enquetes = estado.enquetes.map(({ gravada: _gravada, ...e }) => ({
        ...e,
        codigo: e.codigo.trim().toLowerCase(),
        opcoes: e.opcoes.filter((o) => o.valor.trim() !== ""),
      }));
      await apiClient.put(ROTA, { ligada: estado.ligada, campo_do_voto: estado.campo_do_voto, enquetes });
      setEstado({ ...estado, enquetes: enquetes.map((e) => ({ ...e, gravada: true })) });
      setConfirmar(null);
      toast.success(t("Enquetes salvas."));
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  const campos = Array.from(new Set([...(estado.campo_do_voto ? [estado.campo_do_voto] : []), ...estado.campos_vistos]));

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="enquetes-do-grupo">
      <div>
        <h3 className="text-sm font-semibold">{t("Enquetes do grupo")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("Quem vota na enquete recebe a mensagem de abertura pelo diálogo da plataforma, no número oficial. Aqui você diz ao CRM de qual campo vem o voto e o que cada opção quer dizer: a IA abre a conversa a partir do voto. Use só opções neutras: todo o grupo vê quem votou em quê.")}
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={estado.ligada} onChange={(e) => setEstado({ ...estado, ligada: e.target.checked })} />
        {t("Ligar enquetes do grupo nesta organização")}
      </label>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="enquete-campo">{t("Campo de onde vem o voto")}</Label>
        <select
          id="enquete-campo"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={estado.campo_do_voto ?? ""}
          onChange={(e) => setEstado({ ...estado, campo_do_voto: e.target.value === "" ? null : e.target.value })}
        >
          <option value="">{t("Escolha o campo")}</option>
          {campos.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {campos.length === 0
            ? t("Nenhum aviso recebido ainda. Dispare o diálogo da enquete uma vez num chat de teste e recarregue esta tela.")
            : t("Recomendado: o diálogo de cada opção grava no campo o valor enquete:<código>:<opção>.")}
        </p>
      </div>

      {estado.enquetes.map((e, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
            {/* Código de enquete gravada fica travado: trocá-lo apagaria a enquete e os votos ao salvar. */}
            <Input
              aria-label={t("Código da enquete")}
              placeholder={t("código (ex.: reparadora)")}
              value={e.codigo}
              readOnly={e.gravada === true}
              title={e.gravada ? t("O código de uma enquete gravada não muda: os votos dependem dele.") : undefined}
              onChange={(v) => mudarEnquete(i, { codigo: v.target.value })}
            />
            <Input aria-label={t("Pergunta da enquete")} placeholder={t("Pergunta da enquete")} value={e.pergunta} onChange={(v) => mudarEnquete(i, { pergunta: v.target.value })} />
            <Button variant="ghost" size="sm" onClick={() => pedirRemocao(i)}>
              {t("Remover")}
            </Button>
          </div>
          {confirmar === i && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted p-2 text-xs" role="alert">
              <span>{t("Remover apaga a enquete e os votos dela ao salvar. Para só parar de valer, desmarque \"Enquete ativa\".")}</span>
              <Button variant="outline" size="sm" onClick={() => tirar(i)}>
                {t("Remover mesmo")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmar(null)}>
                {t("Cancelar")}
              </Button>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={e.ativa} onChange={(v) => mudarEnquete(i, { ativa: v.target.checked })} />
            {t("Enquete ativa")}
          </label>
          {e.opcoes.map((o, k) => (
            <div key={k} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
              <Input aria-label={t("Opção")} placeholder={t("Opção")} value={o.valor} onChange={(v) => mudarOpcao(i, k, { valor: v.target.value })} />
              <Input aria-label={t("O que a opção quer dizer")} placeholder={t("O que a opção quer dizer (para a IA)")} value={o.significado} onChange={(v) => mudarOpcao(i, k, { significado: v.target.value })} />
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={o.chamar} onChange={(v) => mudarOpcao(i, k, { chamar: v.target.checked })} />
                {t("Quer contato")}
              </label>
            </div>
          ))}
          {e.opcoes.length < 12 && (
            <div>
              <Button variant="outline" size="sm" onClick={() => mudarEnquete(i, { opcoes: [...e.opcoes, { valor: "", significado: "", chamar: true }] })}>
                {t("Adicionar opção")}
              </Button>
            </div>
          )}
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setEstado({ ...estado, enquetes: [...estado.enquetes, { ...NOVA, opcoes: [...NOVA.opcoes] }] })}>
          {t("Adicionar enquete")}
        </Button>
        <Button size="sm" onClick={() => void salvar()} disabled={salvando || leituraFalhou}>
          {salvando ? t("Salvando…") : t("Salvar enquetes")}
        </Button>
      </div>
      {leituraFalhou && (
        <p className="text-xs text-destructive" role="alert">
          {t("Não foi possível ler as enquetes. Recarregue a tela antes de salvar.")}
        </p>
      )}
    </Card>
  );
}

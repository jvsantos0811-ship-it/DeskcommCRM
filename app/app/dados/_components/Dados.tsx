"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import { quandoFoiGerado } from "@/lib/dados/retrato";
import type { RespostaDaQualidade } from "@/lib/dados/resposta";
import { ArrowsClockwise, Clock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { AbaDinheiro } from "./AbaDinheiro";
import { AbaExplorar } from "./AbaExplorar";
import { AbaGestao } from "./AbaGestao";
import { AbaQualidade } from "./AbaQualidade";
import { DadosClient } from "./DadosClient";
import { useAtualizarAgora, useQualidade } from "./useQualidade";

const ABAS = ["qualidade", "dinheiro", "gestao", "explorar", "meus"] as const;
type Aba = (typeof ABAS)[number];

function horaNoFuso(iso: string, fuso: string, idioma = "pt-BR"): string {
  try {
    return new Intl.DateTimeFormat(idioma, { timeZone: fuso, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(11, 16);
  }
}

/**
 * DADOS (v3 §4 e §8): as quatro abas dos painéis de qualidade do lead e de
 * dinheiro em jogo, mais "Meus painéis" (o construtor de painéis que já existia,
 * migration 9004).
 *
 * As quatro abas leem o RETRATO do dia (às 06:00 no fuso da organização) e
 * comparam com ontem e com 7 dias atrás. Os links levam ao funil AO VIVO, com o
 * mesmo recorte do painel — a legenda avisa que o quadro pode ter mudado desde
 * a manhã. A aba fica na URL (`?aba=`), para o "voltar" do funil cair nela.
 */
export function Dados({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const pedida = params.get("aba");
  const aba: Aba = (ABAS as readonly string[]).includes(pedida ?? "") ? (pedida as Aba) : "qualidade";
  const q = useQualidade();
  const dados = q.data;

  const irPara = (a: Aba) => {
    const p = new URLSearchParams(params.toString());
    if (a === "qualidade") p.delete("aba");
    else p.set("aba", a);
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const rotulos: Record<Aba, string> = {
    qualidade: t("Qualidade do lead"),
    dinheiro: t("Dinheiro em jogo"),
    gestao: t("Gestão"),
    explorar: t("Explorar"),
    meus: t("Meus painéis"),
  };

  return (
    <div className="flex flex-col gap-5 p-6" data-dados>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Dados")}</h1>
        </div>
        {aba !== "meus" && dados && <Atualizacao dados={dados} />}
      </header>

      <nav aria-label={t("Painéis")} className="flex flex-wrap gap-1 border-b border-border">
        {ABAS.map((a) => (
          <button
            key={a}
            type="button"
            data-testid={`aba-de-dados-${a}`}
            aria-current={aba === a ? "page" : undefined}
            onClick={() => irPara(a)}
            className={cn(
              "-mb-px border-b-[3px] px-4 py-3 text-sm",
              aba === a ? "border-accent font-semibold text-accent" : "border-transparent font-medium text-text-muted hover:text-text",
            )}
          >
            {rotulos[a]}
          </button>
        ))}
      </nav>

      {aba === "meus" ? (
        <DadosClient podeEditar={podeEditar} />
      ) : q.isLoading ? (
        <p className="text-sm text-text-muted">{t("Carregando…")}</p>
      ) : q.isError || !dados ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-text-muted">
          {t("Não foi possível carregar os painéis agora. Recarregue a página.")}
        </p>
      ) : dados.modo === "sem_retrato" ? (
        <SemRetrato dados={dados} />
      ) : (
        <>
          <Legenda dados={dados} />
          {aba === "qualidade" && <AbaQualidade dados={dados} />}
          {aba === "dinheiro" && <AbaDinheiro dados={dados} />}
          {aba === "gestao" && <AbaGestao dados={dados} />}
          {aba === "explorar" && <AbaExplorar dados={dados} />}
        </>
      )}
    </div>
  );
}

/** "Atualizado hoje às 06:00" e o botão "Atualizar agora" (gerente e administrador). */
function Atualizacao({ dados }: { dados: RespostaDaQualidade }) {
  const t = useT();
  const atualizar = useAtualizarAgora();

  const quando = dados.retrato ? quandoFoiGerado(dados.retrato.gerado_em, new Date(dados.agora), dados.fuso) : null;
  const rotulo =
    dados.modo === "ao_vivo"
      ? t("Calculado agora, com os seus leads")
      : !quando
        ? t("Ainda sem retrato de hoje")
        : quando.tipo === "hoje"
          ? t("Atualizado hoje às {hora}").replace("{hora}", quando.hora)
          : quando.tipo === "ontem"
            ? t("Atualizado ontem às {hora}").replace("{hora}", quando.hora)
            : t("Atenção: dados de {data}").replace("{data}", quando.data);
  const velho = quando?.tipo === "velho";
  const proximo = dados.proximo_atualizar_em;

  const clicar = () =>
    atualizar.mutate(undefined, {
      onSuccess: (r) =>
        toast.success(t("Números atualizados às {hora}.").replace("{hora}", horaNoFuso(r.gerado_em, dados.fuso))),
      onError: (e) => {
        const quandoPode =
          e instanceof ApiError && typeof e.details?.proximo_em === "string" ? horaNoFuso(e.details.proximo_em, dados.fuso) : null;
        toast.error(
          quandoPode
            ? t("Os números foram atualizados há menos de 30 minutos. Dá para atualizar de novo às {hora}.").replace(
                "{hora}",
                quandoPode,
              )
            : t("Não foi possível atualizar os números agora."),
        );
      },
    });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        data-testid="dados-atualizado-em"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold",
          velho ? "bg-warning-bg text-warning-fg" : "bg-success-bg text-success-fg",
        )}
      >
        <Clock size={14} aria-hidden />
        {rotulo}
      </span>
      {dados.pode_atualizar && (
        <Button
          variant="outline"
          data-testid="dados-atualizar-agora"
          disabled={atualizar.isPending || Boolean(proximo)}
          onClick={clicar}
          title={
            proximo
              ? t("Dá para atualizar de novo às {hora}.").replace("{hora}", horaNoFuso(proximo, dados.fuso))
              : undefined
          }
        >
          <ArrowsClockwise size={16} aria-hidden className={atualizar.isPending ? "animate-spin" : undefined} />
          {atualizar.isPending ? t("Atualizando…") : t("Atualizar agora")}
        </Button>
      )}
      {dados.pode_atualizar && proximo && (
        <span className="text-xs text-text-muted" data-testid="dados-proximo-atualizar">
          {t("Dá para atualizar de novo às {hora}.").replace("{hora}", horaNoFuso(proximo, dados.fuso))}
        </span>
      )}
    </div>
  );
}

function Legenda({ dados }: { dados: RespostaDaQualidade }) {
  const t = useT();
  if (dados.modo === "ao_vivo") {
    return (
      <p className="text-sm text-text-muted" data-testid="dados-legenda">
        {t(
          "Os seus leads, calculados agora. O retrato da manhã, com a comparação com ontem e com 7 dias atrás, fica com quem vê todos os leads da empresa.",
        )}
      </p>
    );
  }
  const r = dados.retrato;
  const quando = r ? `${horaNoFuso(r.gerado_em, dados.fuso)} ${t("de")} ${r.dia.slice(8, 10)}/${r.dia.slice(5, 7)}` : "";
  const retratoDas = t("Retrato das {quando}.").replace("{quando}", quando);
  return (
    <p className="text-sm text-text-muted" data-testid="dados-legenda">
      {retratoDas}{" "}
      {t(
        "Cada número compara com ontem e com 7 dias atrás. Clicar num número abre o funil ao vivo, que pode ter mudado desde o retrato.",
      )}
    </p>
  );
}

function SemRetrato({ dados }: { dados: RespostaDaQualidade }) {
  const t = useT();
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center"
      data-testid="dados-sem-retrato"
    >
      <p className="text-sm font-semibold text-text">{t("Os painéis ainda não têm o retrato de hoje.")}</p>
      <p className="max-w-xl text-sm text-text-muted">
        {t(
          "O CRM monta os números uma vez por dia, às 06:00, e o primeiro retrato fica pronto em até uma hora depois disso.",
        )}{" "}
        {dados.pode_atualizar ? t("Para ver agora, use “Atualizar agora”.") : null}
      </p>
    </div>
  );
}

/**
 * Configurações → Distribuição de atendimento (issue #144).
 *
 * A TELA QUE FALTAVA. O rodízio entre atendentes (`settings.routing.mode =
 * round_robin`, worker em `lib/routing/`) e a restrição de visibilidade por
 * atendente (`settings.visibility_mode`, RLS em `fn_can_view_lead` /
 * `fn_can_view_conversation`) existem inteiros no backend desde a fase G4/G5 —
 * e não havia UMA tela no produto que os ligasse. Medido antes de escrever:
 * nenhum arquivo de `app/` ou `components/` consumia `/api/v1/settings/routing`,
 * e `visibility_mode` só aparecia sendo LIDO em `app/app/layout.tsx`.
 *
 * Num produto self-host isso equivale a a feature não existir: a única forma de
 * ligar era `UPDATE` à mão no Postgres. É o anti-exemplo literal de "toda
 * configuração tem superfície" (`docs/doctrine/restricao-de-canal.md`).
 *
 * Gate = manager+, que é o que a matriz da spec 13 §4 dá para
 * "atendimento/routing" — a mesma linha cobre as duas chaves.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { DEFAULT_VISIBILITY_MODE, ROLE_RANK, type VisibilityMode } from "@/lib/auth/types";
import { routingConfigSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { loadChannelRoutingSettings } from "@/lib/routing/channel-policies";
import { configAssinatura } from "@/lib/messaging/assinatura";
import { AssinaturaForm } from "./_assinatura-form";
import { fraseDaFilaDaOrg } from "@/lib/escalacao/aviso-ao-lead";
import { acaoDaIrritacao } from "@/lib/escalacao/irritacao";

import { FraseSeguraForm } from "./_frase-segura-form";
import { FilaEIrritacaoForm } from "./_fila-e-irritacao-form";
import { HorarioDaEquipeForm } from "./_horario-da-equipe-form";
import { NinguemRespondeuForm, type FunilDaTela } from "./_ninguem-respondeu-form";
import { alcanceDaOrg } from "@/lib/dados/alcance-do-leitor";
import { expedienteDaOrg } from "@/lib/dados/expediente";
import { configDoAviso } from "@/lib/escalacao/ninguem-respondeu";
import { horarioDaEquipeDaOrg } from "@/lib/escalacao/horario-da-equipe";
import { fraseSeguraConfigurada, fraseSeguraPadrao } from "@/lib/messaging/frase-segura";
import { ChannelRoutingForm } from "./_channels-form";
import { AtendimentoForm } from "./_form";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function AtendimentoSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("settings, locale")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const settings = ((data?.settings as Record<string, unknown> | null) ?? {}) as {
    routing?: unknown;
    visibility_mode?: VisibilityMode;
  };
  // `.catch(...)`: config antiga ou corrompida no jsonb não pode derrubar a
  // tela que serve justamente para consertá-la.
  const routing = routingConfigSchema.catch(routingConfigSchema.parse({})).parse(settings.routing ?? {});
  const idioma = user.idioma;
  const channels = await loadChannelRoutingSettings(supabase, activeOrg.orgId);
  const assinatura = configAssinatura(settings);
  const frasePadrao = fraseSeguraPadrao((data as { locale?: string | null } | null)?.locale ?? null);
  const fraseInicial = fraseSeguraConfigurada(settings) ?? "";
  const assinaturaInicial = { humanos: assinatura.humanos, ia: assinatura.ia, nome_ia: assinatura.nomeIa };
  // PM-025 §2 e §7: o aviso "Ninguém respondeu" e quem conta como lead com potencial.
  const { data: funisData } = await supabase
    .from("crm_pipelines")
    .select("id, name, is_client_pipeline")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  const funis = (funisData ?? []) as FunilDaTela[];
  const aviso = configDoAviso(settings);
  const alcance = alcanceDaOrg(settings);
  const ninguemRespondeuInicial = {
    ligado: aviso.ligado,
    ligadoEm: aviso.ligado_em,
    funis: alcance.funis,
    marcadores: alcance.marcadores_que_desqualificam,
    horarioPadrao: !expedienteDaOrg(settings).cadastrado,
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Distribuição de atendimento", idioma)}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Quem recebe cada cliente novo, e o que cada atendente enxerga. As duas decisões andam juntas: distribuir sem restringir deixa todo mundo vendo a carteira do colega; restringir sem distribuir deixa o funil de cada um vazio.",
            idioma,
          )}
        </p>
      </header>

      <AtendimentoForm
        initial={{ ...routing, visibility_mode: settings.visibility_mode ?? DEFAULT_VISIBILITY_MODE }}
      />
      <ChannelRoutingForm initial={channels} />
      <AssinaturaForm initial={assinaturaInicial} />
      <FraseSeguraForm inicial={fraseInicial} padrao={frasePadrao} />
      <HorarioDaEquipeForm inicial={horarioDaEquipeDaOrg(settings)} />
      <NinguemRespondeuForm inicial={ninguemRespondeuInicial} funis={funis} />
      <FilaEIrritacaoForm
        inicial={{ frase_da_fila: fraseDaFilaDaOrg(settings) ?? "", irritacao: acaoDaIrritacao(settings) }}
      />
    </div>
  );
}

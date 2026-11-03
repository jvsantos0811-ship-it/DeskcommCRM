/**
 * Configurações → IA (Pacote Conversa).
 *
 * As regras que o CRM garante antes de cada mensagem da IA sair, por
 * organização. O prompt orienta; só o CRM garante. Começa com a trava de
 * repetição (PC-018); as próximas regras do pacote entram aqui.
 *
 * Gate = manager+, o mesmo de Distribuição de atendimento.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  AJUSTES_PADRAO_DE_REPETICAO,
  ajustesParaGravar,
  lerAjustesDeRepeticao,
} from "@/lib/agent-engine/agent/repeticao-entre-respostas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { RepeticaoForm } from "./_repeticao-form";

export const dynamic = "force-dynamic";

export default async function IaSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase.from("organizations").select("settings").eq("id", activeOrg.orgId).maybeSingle();
  const settings = (data?.settings as Record<string, unknown> | null) ?? {};
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("IA", idioma)}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Regras que o sistema confere antes de cada mensagem da IA sair, em todos os agentes da empresa. O texto do agente orienta; estas regras garantem.",
            idioma,
          )}
        </p>
      </header>
      <RepeticaoForm
        inicial={ajustesParaGravar(lerAjustesDeRepeticao(settings))}
        padrao={ajustesParaGravar({ ...AJUSTES_PADRAO_DE_REPETICAO })}
      />
    </div>
  );
}

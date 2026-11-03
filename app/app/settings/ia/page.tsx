/**
 * Configurações → IA (Pacote Conversa).
 *
 * As regras que o CRM garante antes de cada mensagem da IA sair, por
 * organização. O prompt orienta; só o CRM garante: a trava de repetição
 * (PC-018) e as frases proibidas (PC-022).
 *
 * Gate = manager+, o mesmo de Distribuição de atendimento. A lista de frases
 * proibidas só o admin muda (o manager vê a lista e a contagem).
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, roleAtLeast } from "@/lib/auth/types";
import {
  AJUSTES_PADRAO_DE_REPETICAO,
  ajustesParaGravar,
  lerAjustesDeRepeticao,
} from "@/lib/agent-engine/agent/repeticao-entre-respostas";
import { FRASES_PADRAO, lerFrasesProibidas } from "@/lib/agent-engine/agent/frases-proibidas";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { FrasesProibidasForm, type ContagemDaFraseNaTela } from "./_frases-proibidas-form";
import { MidiasNaoEntendidas } from "./_midias-nao-entendidas";
import { contarPorDia } from "@/lib/messaging/media/nao-entendidas-por-dia";
import { PREFIXO_AUDIO_NAO_ENTENDIDO, PREFIXO_MIDIA_NAO_ENTENDIDA } from "@/lib/messaging/media/nao-entendida";
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
  const { data } = await supabase
    .from("organizations")
    .select("settings, timezone")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const settings = (data?.settings as Record<string, unknown> | null) ?? {};
  const fuso = (data as { timezone?: string | null } | null)?.timezone || "America/Sao_Paulo";
  const idioma = user.idioma;
  const desde = new Date(new Date().getTime() - 28 * 24 * 3600_000).toISOString().slice(0, 10);
  const { data: contagem } = await supabase
    .from("frases_proibidas_na_semana")
    .select("frase, semana, barradas, removidas, enviadas")
    .eq("organization_id", activeOrg.orgId)
    .gte("semana", desde)
    .order("semana", { ascending: false })
    .limit(400);
  // PC-021: as mídias não entendidas (o marcador no derivado), por dia, 14 dias.
  const desde14 = new Date(new Date().getTime() - 14 * 24 * 3600_000).toISOString();
  const [audiosNaoEntendidos, outrasNaoEntendidas] = await Promise.all([
    supabase
      .from("messages")
      .select("type, created_at")
      .eq("organization_id", activeOrg.orgId)
      .eq("direction", "inbound")
      .gte("created_at", desde14)
      .like("media_derived_text", `${PREFIXO_AUDIO_NAO_ENTENDIDO}%`)
      .limit(2000),
    supabase
      .from("messages")
      .select("type, created_at")
      .eq("organization_id", activeOrg.orgId)
      .eq("direction", "inbound")
      .gte("created_at", desde14)
      .like("media_derived_text", `${PREFIXO_MIDIA_NAO_ENTENDIDA}%`)
      .limit(2000),
  ]);
  const naoEntendidasPorDia = contarPorDia(
    [...(audiosNaoEntendidos.data ?? []), ...(outrasNaoEntendidas.data ?? [])] as { type: string; created_at: string }[],
    fuso,
    tagDeIdioma(idioma),
  );
  // A mesma régua da rota (PATCH /api/v1/settings/conversa): admin da empresa.
  const podeEditarFrases = roleAtLeast(activeOrg.role, "admin");

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
      <FrasesProibidasForm
        inicial={lerFrasesProibidas(settings)}
        padrao={[...FRASES_PADRAO]}
        contagem={(contagem ?? []) as ContagemDaFraseNaTela[]}
        podeEditar={podeEditarFrases}
      />
      <MidiasNaoEntendidas
        linhas={naoEntendidasPorDia}
        textos={{
          titulo: traduzir("Mídias não entendidas", idioma),
          explicacao: traduzir(
            "Áudios, fotos e documentos que o sistema não conseguiu entender (a IA pediu para repetir ou escrever), por dia, nos últimos 14 dias.",
            idioma,
          ),
          vazio: traduzir("Nenhuma mídia deixou de ser entendida nos últimos 14 dias.", idioma),
          dia: traduzir("Dia", idioma),
          audios: traduzir("Áudios", idioma),
          outras: traduzir("Fotos e documentos", idioma),
        }}
      />
    </div>
  );
}

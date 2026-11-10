/**
 * Configurações › Integrações › Assinatura eletrônica (PC-030).
 *
 * Duas partes numa tela: o SERVIÇO de assinatura da organização (qual, o
 * ambiente, a chave da API — guardada cifrada, nunca mostrada de volta —, a
 * aprovação da equipe antes do envio e o prazo para assinar) e os MODELOS DE
 * CONTRATO (texto com variáveis, campos obrigatórios, versão e a aprovação do
 * advogado). Gerente ou dono, como pede o PC-030.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { AssinaturaEletronicaClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assinatura eletrônica" };

export default async function AssinaturaEletronicaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const idioma = user.idioma;
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Assinatura eletrônica", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "O serviço que colhe a assinatura do cliente e os modelos de contrato do escritório. O contrato sai pelo WhatsApp com o link de assinatura, e o negócio fecha sozinho quando o cliente assina.",
            idioma,
          )}
        </p>
      </header>
      <AssinaturaEletronicaClient />
    </div>
  );
}

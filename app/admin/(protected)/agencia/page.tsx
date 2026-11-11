import { AgenciaClient } from "./_client";

export const metadata = { title: "Agência — Admin Plataforma" };

/**
 * O PAINEL DA AGÊNCIA (PC-028): quem paga, quanto, quem atrasou, quanto cada
 * cliente custa em IA e WhatsApp, a margem e o resultado do cliente. Só o dono
 * da instalação (o layout de /admin e as rotas cobram `requirePlatformAdmin`).
 */
export default function AgenciaPage() {
  return <AgenciaClient />;
}

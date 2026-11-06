import { BateriaDoLeitorClient } from "./_client";

/**
 * Bateria do Leitor da conversa (PM-027 §8–§9, migration 9023): carregar os casos
 * do Gestor, testar um modelo com o juiz e ver caso a caso. É da INSTALAÇÃO — a
 * aprovação de um modelo vale para todos os escritórios (decisão do dono, 06/11)
 * e as conversas congeladas não saem da organização de origem —, por isso mora em
 * /admin, com porta no `AdminSidebar`.
 */
export const metadata = { title: "Bateria do Leitor — Admin Plataforma" };
export const dynamic = "force-dynamic";

export default function BateriaDoLeitorPage() {
  return <BateriaDoLeitorClient />;
}

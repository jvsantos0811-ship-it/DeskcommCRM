/**
 * O período do painel da agência (PC-028): o MESMO seletor e as mesmas regras
 * do painel de Dados (PC-025, `lib/dados/periodo.ts`), no fuso da instalação.
 * Sem período escolhido, o mês atual — é a pergunta de quem gere a agência.
 */
import { FUSO_DA_AGENCIA } from "@/lib/agencia/ler";
import { periodoDosParametros, resolverPeriodo, type PeriodoResolvido } from "@/lib/dados/periodo";
import { diaNoFuso } from "@/lib/dados/retrato";

export function periodoDaAgencia(
  params: { get(nome: string): string | null },
  agora = new Date(),
): {
  periodo: PeriodoResolvido;
  hoje: string;
} {
  const hoje = diaNoFuso(agora, FUSO_DA_AGENCIA);
  const periodo = resolverPeriodo(periodoDosParametros(params) ?? { atalho: "mes" }, hoje)!;
  return { periodo, hoje };
}

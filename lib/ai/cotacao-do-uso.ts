import "server-only";

import { CONFIG_PADRAO, lerConfigDaAgencia } from "@/lib/agencia/ler";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A cotação do dólar com que a tela Uso de IA escreve o custo em reais.
 *
 * É a MESMA cotação do painel da agência (/admin › Agência), que o dono já
 * mantém para calcular a margem por cliente — uma fonte só, sem câmbio de fora
 * (o produto é self-host e não depende de serviço de cotação).
 *
 * `agencia_config` é da instalação, sem policy para `authenticated` (migration
 * 9030): a leitura vai pelo service role e devolve só este número, nenhum dado
 * de cliente. Sem a linha, ou com falha na leitura, vale o padrão do painel — a
 * tela escreve a cotação usada, então o número nunca aparece sem a sua régua.
 */
export async function cotacaoDoUsoDeIa(): Promise<number> {
  try {
    const config = await lerConfigDaAgencia(createAdminClient());
    return config.cotacao_usd_brl > 0 ? config.cotacao_usd_brl : CONFIG_PADRAO.cotacao_usd_brl;
  } catch {
    return CONFIG_PADRAO.cotacao_usd_brl;
  }
}

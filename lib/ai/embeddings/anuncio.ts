/**
 * O QUE O PAINEL DE PROVEDORES DIZ SOBRE OS DOIS PONTOS DE EMBEDDING
 * (fork, briefing do Operador item 8).
 *
 * ## O defeito
 *
 * `embedding_indexar` e `embedding_consultar` são `fixo` no registro, mas sem
 * `usa` nem `escada`. O resolvedor (`lib/ai/pontos/resolver.ts`) não tinha o que
 * responder por eles e descia a cadeia inteira até o padrão da organização: o
 * painel anunciava o MODELO DE CONVERSA (um `claude-…`) em "Indexar o seu
 * material" e "Buscar no seu material" — modelo que não gera vetor nenhum. O
 * mesmo defeito que a transcrição já teve (#2190), na outra ponta.
 *
 * ## O conserto
 *
 * O motor escolhe a chave por `resolverChaveDeEmbedding` (`chave.ts`), e o
 * modelo é consequência do provedor dessa chave. A tela passa a perguntar À
 * MESMA função, com o mesmo ponto: um lugar decide, os dois lados leem. Sem
 * chave, a resposta honesta é "—" com o motivo — e o motivo diz o que fazer.
 *
 * Isto é INFORMAÇÃO, não ação: a leitura da família que falha não derruba o
 * painel (falha aberta, como `estado.ts`), só vira aviso.
 */
import {
  EXPLICACAO_DA_ORIGEM,
  FamiliaDaBaseIlegivelError,
  familiaDaBase,
  modeloDeEmbedding,
  resolverChaveDeEmbedding,
  type ChaveDeEmbedding,
  type PontoDeEmbedding,
  type ProvedorDaBase,
} from "@/lib/ai/embeddings/chave";
import { AVISO_DA_FAMILIA_ILEGIVEL } from "@/lib/ai/embeddings/estado";

export interface AnuncioDoEmbedding {
  /** `"openai"`, `"openrouter"`, `"gateway"` ou `"google"`; vazio quando não há chave. */
  provider: string;
  /** O modelo que a chave escolhida de fato roda; `null` quando não há chave. */
  modelId: string | null;
  /** Por que é este — ou, sem chave, o que falta. Frase de dicionário. */
  motivo: string;
  avisos: string[];
}

export const SEM_CHAVE_NENHUMA =
  "Nenhuma chave para preparar o seu material. Cadastre uma chave da OpenAI ou do Google em Credenciais.";
export const SEM_CHAVE_DA_OPENAI =
  "A base é preparada com a OpenAI, e não há chave da OpenAI disponível. Cadastre uma em Credenciais ou troque o provedor na tela de Conhecimento.";
export const SEM_CHAVE_DO_GOOGLE =
  "A base é preparada com o Google, e não há chave do Google disponível. Cadastre uma em Credenciais ou troque o provedor na tela de Conhecimento.";

/** A parte pura: o que dizer, dada a chave que a escada escolheu. */
export function anuncioDaChave(
  chave: ChaveDeEmbedding | null,
  familia: ProvedorDaBase | null,
  avisosExtras: string[] = [],
): AnuncioDoEmbedding {
  if (chave) {
    return {
      provider: chave.provedor,
      modelId: modeloDeEmbedding(chave.provedor),
      motivo: EXPLICACAO_DA_ORIGEM[chave.origem],
      avisos: [...chave.avisos, ...avisosExtras],
    };
  }
  return {
    provider: "",
    modelId: null,
    motivo:
      familia === "openai" ? SEM_CHAVE_DA_OPENAI : familia === "google" ? SEM_CHAVE_DO_GOOGLE : SEM_CHAVE_NENHUMA,
    avisos: avisosExtras,
  };
}

/**
 * O anúncio de um ponto de embedding desta organização — pela MESMA escada que
 * o indexador e a busca usam.
 */
export async function anunciarEmbedding(
  organizationId: string,
  ponto: PontoDeEmbedding,
): Promise<AnuncioDoEmbedding> {
  let familia: ProvedorDaBase | null = null;
  const avisos: string[] = [];
  try {
    familia = (await familiaDaBase(organizationId))?.familia ?? null;
  } catch (err) {
    if (!(err instanceof FamiliaDaBaseIlegivelError)) throw err;
    avisos.push(AVISO_DA_FAMILIA_ILEGIVEL);
  }
  const chave = await resolverChaveDeEmbedding(organizationId, ponto, { familia });
  return anuncioDaChave(chave, familia, avisos);
}

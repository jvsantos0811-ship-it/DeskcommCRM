/**
 * UMA RODADA DA BATERIA DO LEITOR — PM-027 §8 ("Testar na bateria", uma rodada
 * só, sem tocar nos painéis) e §9 (o juiz nas divergências).
 *
 * O cron `bateria-do-leitor` passa a cada minuto: pega UMA rodada pendente (ou
 * parada há 3 minutos), lê caso a caso com o modelo testado, confere com o
 * gabarito (`conferirCaso`) e, na divergência, pergunta ao juiz. O que não couber
 * no orçamento fica para a passada seguinte. Quando o último caso termina, o
 * placar é gravado e a rodada fecha — aprovada só com 100% nos que bloqueiam.
 *
 * As chamadas vão para `llm_calls` na organização da chave usada, SEM contato:
 * a estimativa de custo mensal do Leitor conta só leituras de lead de verdade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { podeGastarComIa } from "@/lib/ai/budget/pode-gastar";
import { computeCost } from "@/lib/ai/cost";
import { registrarChamadaDeIa } from "@/lib/ai/usage/registrar-chamada";
import { fichaDoLeitorSchema, type FatosDoBanco, type FichaDoLeitor } from "@/lib/dados/ficha";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";

import {
  aplicarDecisao,
  CAMPOS_COMPARAVEIS,
  conferirCaso,
  placarDaBateria,
  type CasoDaBateria,
  type DecisaoDoJuiz,
  type Divergencia,
  type GabaritoDoCaso,
  type LadoDoGabarito,
} from "./bateria";
import { julgarComModelo, montarJulgamento, sortearLado, type Julgar } from "./juiz";
import { lerComModelo, type Classificar } from "./ler-lead";
import { montarModeloEscolhido, type ModeloMontado } from "./modelo-escolhido";
import { montarPromptDoLeitor, type VariaveisDoPrompt } from "./prompt";

/** Rodada "rodando" sem sinal de vida há mais disto é retomada. */
export const RODADA_PERDIDA_MS = 3 * 60_000;

interface RodadaRow {
  id: string;
  provider: string;
  model_id: string;
  juiz_provider: string;
  juiz_model_id: string;
  credencial_organization_id: string | null;
  status: string;
  casos: string[] | null;
  casos_total: number;
  casos_feitos: number;
}

export interface CasoRow {
  id: string;
  caso_id: string;
  versao: number;
  origem_organization_id: string | null;
  bloqueia: boolean;
  relogio: string;
  conversa: string;
  prompt_variaveis: unknown;
  gabarito: unknown;
}

export interface DepsDaBateria {
  agora: Date;
  ateMs: number;
  ler?: Classificar;
  julgar?: Julgar;
  montar?: typeof montarModeloEscolhido;
  aleatorio?: () => number;
}

export interface ResultadoDaPassadaDaBateria {
  rodada: string | null;
  feitos: number;
  terminou: boolean;
  parou: null | "sem_chave" | "teto" | "org_parada";
}

// ─── o gabarito no banco ───────────────────────────────────────────────────

export function gabaritoDoBanco(v: unknown): GabaritoDoCaso {
  const g = (v ?? {}) as Record<string, unknown>;
  const b = (g.banco ?? {}) as Record<string, unknown>;
  const banco: FatosDoBanco = {
    ultima_fala_do_lead: typeof b.ultima_fala_do_lead === "string" ? new Date(b.ultima_fala_do_lead) : null,
    duplicado: b.duplicado === true,
    nunca_respondido: b.nunca_respondido === true,
    midia_nao_entendida: b.midia_nao_entendida === true,
  };
  return {
    tipo: g.tipo === "regra_v2" ? "regra_v2" : "parcial",
    ficha: (g.ficha ?? {}) as Partial<FichaDoLeitor>,
    banco,
    ...(typeof g.situacao === "string" ? { situacao: g.situacao } : {}),
    ...(typeof g.temperatura === "string" ? { temperatura: g.temperatura } : {}),
    ...(typeof g.qualidade === "string" ? { qualidade: g.qualidade } : {}),
  };
}

export function gabaritoParaOBanco(g: GabaritoDoCaso): Record<string, unknown> {
  return { ...g, banco: { ...g.banco, ultima_fala_do_lead: g.banco.ultima_fala_do_lead?.toISOString() ?? null } };
}

export function casoDaLinha(c: CasoRow): CasoDaBateria {
  return { id: c.caso_id, bloqueia: c.bloqueia, relogio: new Date(c.relogio), gabarito: gabaritoDoBanco(c.gabarito) };
}

/** O gabarito com a resposta do modelo nos campos em que o juiz deu razão a ele. */
export function gabaritoCorrigido(g: GabaritoDoCaso, doModelo: FichaDoLeitor, divergencias: Divergencia[]): GabaritoDoCaso {
  if (g.tipo === "regra_v2") return { ...g, ficha: doModelo };
  const ficha = { ...g.ficha } as Record<string, unknown>;
  const novo: GabaritoDoCaso = { ...g };
  for (const d of divergencias) {
    if ((CAMPOS_COMPARAVEIS as readonly string[]).includes(d.campo)) ficha[d.campo] = d.obtido;
    if (d.campo === "situacao") novo.situacao = String(d.obtido);
    if (d.campo === "temperatura") novo.temperatura = String(d.obtido);
  }
  return { ...novo, ficha: ficha as Partial<FichaDoLeitor> };
}

// ─── a passada ─────────────────────────────────────────────────────────────

async function pegarRodada(admin: SupabaseClient, agora: Date): Promise<RodadaRow | null> {
  const perdida = new Date(agora.getTime() - RODADA_PERDIDA_MS).toISOString();
  const { data } = await admin
    .from("leitor_bateria_rodadas")
    .select("id")
    .in("status", ["pendente", "rodando"])
    .order("criada_em", { ascending: true })
    .limit(5);
  for (const c of (data ?? []) as Array<{ id: string }>) {
    const { data: pega } = await admin
      .from("leitor_bateria_rodadas")
      .update({ status: "rodando", atualizada_em: agora.toISOString() })
      .eq("id", c.id)
      .or(`status.eq.pendente,and(status.eq.rodando,atualizada_em.lt.${perdida})`)
      .select("id, provider, model_id, juiz_provider, juiz_model_id, credencial_organization_id, status, casos, casos_total, casos_feitos");
    const linha = ((pega ?? []) as RodadaRow[])[0];
    if (linha) return linha;
  }
  return null;
}

async function fechar(admin: SupabaseClient, id: string, campos: Record<string, unknown>): Promise<void> {
  await admin.from("leitor_bateria_rodadas").update({ ...campos, atualizada_em: new Date().toISOString() }).eq("id", id);
}

export async function passadaDaBateria(admin: SupabaseClient, deps: DepsDaBateria): Promise<ResultadoDaPassadaDaBateria> {
  const r: ResultadoDaPassadaDaBateria = { rodada: null, feitos: 0, terminou: false, parou: null };
  const rodada = await pegarRodada(admin, deps.agora);
  if (!rodada) return r;
  r.rodada = rodada.id;
  const ler = deps.ler ?? lerComModelo;
  const julgar = deps.julgar ?? julgarComModelo;
  const montar = deps.montar ?? montarModeloEscolhido;
  const org = rodada.credencial_organization_id;

  if (org && new Set(await idsDeOrgsParadas(admin)).has(org)) {
    await fechar(admin, rodada.id, { status: "falhou", erro: "a organização da chave está parada", terminada_em: new Date().toISOString() });
    r.parou = "org_parada";
    return r;
  }

  // 1. Os casos da rodada, fixados na primeira passada.
  let casosIds = rodada.casos ?? [];
  if (casosIds.length === 0) {
    const { data } = await admin.from("leitor_bateria_casos").select("id").eq("ativo", true).order("caso_id");
    casosIds = ((data ?? []) as Array<{ id: string }>).map((c) => c.id);
    await admin.from("leitor_bateria_rodadas").update({ casos: casosIds, casos_total: casosIds.length }).eq("id", rodada.id);
  }
  const { data: feitosData } = await admin.from("leitor_bateria_resultados").select("caso_uuid").eq("rodada_id", rodada.id);
  const feitos = new Set(((feitosData ?? []) as Array<{ caso_uuid: string }>).map((x) => x.caso_uuid));
  const { data: casosData } = casosIds.length
    ? await admin
        .from("leitor_bateria_casos")
        .select("id, caso_id, versao, origem_organization_id, bloqueia, relogio, conversa, prompt_variaveis, gabarito")
        .in("id", casosIds)
    : { data: [] };
  const casos = (casosData ?? []) as CasoRow[];
  const pendentes = casos.filter((c) => !feitos.has(c.id)).sort((a, b) => a.caso_id.localeCompare(b.caso_id));

  // 2. Os modelos.
  let testado: ModeloMontado | null = null;
  let juiz: ModeloMontado | null | undefined;
  if (pendentes.length > 0) {
    testado = await montar(admin, { provider: rodada.provider, model_id: rodada.model_id }, org);
    if (!testado) {
      await fechar(admin, rodada.id, { status: "falhou", erro: "sem chave para o modelo testado", terminada_em: new Date().toISOString() });
      r.parou = "sem_chave";
      return r;
    }
  }

  // 3. Caso a caso, dentro do orçamento.
  for (const c of pendentes) {
    if (Date.now() >= deps.ateMs) break;
    if (org) {
      const orcamento = await podeGastarComIa(org, "leitor_da_conversa");
      if (!orcamento.pode) {
        r.parou = "teto";
        break;
      }
    }
    const caso = casoDaLinha(c);
    const sistema = montarPromptDoLeitor(c.prompt_variaveis as VariaveisDoPrompt);
    const t0 = Date.now();
    let ficha: FichaDoLeitor | null = null;
    let erro: string | null = null;
    let custo = 0;
    try {
      const leitura = await ler(testado!.model, sistema, c.conversa);
      ficha = fichaDoLeitorSchema.parse(leitura.ficha);
      custo = await computeCost({ model: testado!.modelId, promptTokens: leitura.promptTokens, completionTokens: leitura.completionTokens });
      if (org) {
        await registrarChamadaDeIa(admin as never, {
          organization_id: org,
          contact_id: null,
          purpose: "leitor_da_conversa",
          model: testado!.modelId,
          input_tokens: leitura.promptTokens,
          output_tokens: leitura.completionTokens,
          cost_cents: custo,
          latency_ms: Date.now() - t0,
        });
      }
    } catch (e) {
      erro = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
    const latencia = Date.now() - t0;

    let passouSemJuiz = false;
    let acerto = false;
    let qualidadeIgual: boolean | null = null;
    let divergencias: Divergencia[] = [];
    let decisao: DecisaoDoJuiz | null = null;
    let lado: LadoDoGabarito | null = null;
    let motivo: string | null = null;
    let trecho: string | null = null;
    let revisar = false;

    if (ficha) {
      const conf = conferirCaso(caso, ficha);
      passouSemJuiz = conf.passou;
      acerto = conf.passou;
      qualidadeIgual = conf.qualidadeIgual;
      divergencias = conf.divergencias;
      if (!conf.passou) {
        if (juiz === undefined) juiz = await montar(admin, { provider: rodada.juiz_provider, model_id: rodada.juiz_model_id }, org);
        lado = sortearLado(deps.aleatorio);
        if (!juiz) {
          decisao = "duvida";
          motivo = "o juiz não tem chave nesta organização";
        } else {
          const t1 = Date.now();
          try {
            const j = montarJulgamento({ instrucoesDoLeitor: sistema, conversa: c.conversa, divergencias, ladoDoGabarito: lado });
            const v = await julgar(juiz.model, j.sistema, j.pergunta);
            decisao = v.decisao;
            motivo = v.motivo;
            trecho = v.trecho;
            const custoDoJuiz = await computeCost({ model: juiz.modelId, promptTokens: v.promptTokens, completionTokens: v.completionTokens });
            custo += custoDoJuiz;
            if (org) {
              await registrarChamadaDeIa(admin as never, {
                organization_id: org,
                contact_id: null,
                purpose: "juiz_da_bateria",
                model: juiz.modelId,
                input_tokens: v.promptTokens,
                output_tokens: v.completionTokens,
                cost_cents: custoDoJuiz,
                latency_ms: Date.now() - t1,
              });
            }
          } catch (e) {
            decisao = "duvida";
            motivo = `o juiz falhou: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
          }
        }
        const efeito = aplicarDecisao(decisao, lado);
        acerto = efeito.acerto;
        revisar = efeito.revisarGabarito;
        if (efeito.corrigirGabarito) await novaVersao(admin, c, gabaritoCorrigido(caso.gabarito, ficha, divergencias), rodada, motivo);
      }
    }

    const { error } = await admin.from("leitor_bateria_resultados").insert({
      rodada_id: rodada.id,
      caso_uuid: c.id,
      caso_id: c.caso_id,
      caso_versao: c.versao,
      passou_sem_juiz: passouSemJuiz,
      acerto,
      qualidade_igual: qualidadeIgual,
      divergencias,
      resposta: ficha,
      juiz_decisao: decisao,
      juiz_lado_do_gabarito: lado,
      juiz_motivo: motivo,
      juiz_trecho: trecho,
      revisar,
      latencia_ms: latencia,
      custo_cents: custo,
      erro,
    });
    if (error && error.code !== "23505") throw new Error(`resultado: ${error.message}`);
    feitos.add(c.id);
    r.feitos += 1;
    await admin
      .from("leitor_bateria_rodadas")
      .update({ casos_feitos: feitos.size, atualizada_em: new Date().toISOString() })
      .eq("id", rodada.id);
  }

  // 4. Fecha quando não há mais caso; senão solta a rodada para a próxima passada.
  if (casos.every((c) => feitos.has(c.id))) {
    await gravarPlacar(admin, rodada.id, casos);
    r.terminou = true;
  } else {
    await fechar(admin, rodada.id, { status: "pendente", ...(r.parou === "teto" ? { erro: "teto de gasto de IA atingido; continua quando liberar" } : {}) });
  }
  return r;
}

async function novaVersao(
  admin: SupabaseClient,
  c: CasoRow,
  gabarito: GabaritoDoCaso,
  rodada: RodadaRow,
  motivo: string | null,
): Promise<void> {
  const { data: ultima } = await admin
    .from("leitor_bateria_casos")
    .select("versao")
    .eq("caso_id", c.caso_id)
    .order("versao", { ascending: false })
    .limit(1)
    .maybeSingle();
  const versao = ((ultima as { versao?: number } | null)?.versao ?? c.versao) + 1;
  await admin.from("leitor_bateria_casos").update({ ativo: false }).eq("caso_id", c.caso_id).eq("ativo", true);
  const { data: original } = await admin
    .from("leitor_bateria_casos")
    .select("origem_contact_id, origem_lead_id")
    .eq("id", c.id)
    .maybeSingle();
  const o = (original ?? {}) as { origem_contact_id?: string | null; origem_lead_id?: string | null };
  await admin.from("leitor_bateria_casos").insert({
    caso_id: c.caso_id,
    versao,
    ativo: true,
    origem_organization_id: c.origem_organization_id,
    origem_contact_id: o.origem_contact_id ?? null,
    origem_lead_id: o.origem_lead_id ?? null,
    bloqueia: c.bloqueia,
    relogio: c.relogio,
    conversa: c.conversa,
    prompt_variaveis: c.prompt_variaveis,
    gabarito: gabaritoParaOBanco(gabarito),
    motivo_da_versao: `Corrigido pelo juiz (${rodada.juiz_provider}/${rodada.juiz_model_id}) na rodada de ${rodada.provider}/${rodada.model_id}: ${motivo ?? "sem motivo"}`,
  });
}

async function gravarPlacar(admin: SupabaseClient, rodadaId: string, casos: CasoRow[]): Promise<void> {
  const { data } = await admin
    .from("leitor_bateria_resultados")
    .select("caso_uuid, acerto, qualidade_igual, latencia_ms, custo_cents")
    .eq("rodada_id", rodadaId);
  const porId = new Map(casos.map((c) => [c.id, c]));
  const linhas = (data ?? []) as Array<{ caso_uuid: string; acerto: boolean; qualidade_igual: boolean | null; latencia_ms: number | null; custo_cents: number | null }>;
  const placar = placarDaBateria(
    linhas.filter((l) => porId.has(l.caso_uuid)).map((l) => ({ caso: casoDaLinha(porId.get(l.caso_uuid)!), acerto: l.acerto, qualidadeIgual: l.qualidade_igual })),
  );
  const tempos = linhas.map((l) => l.latencia_ms ?? 0).filter((x) => x > 0);
  await fechar(admin, rodadaId, {
    status: "terminada",
    terminada_em: new Date().toISOString(),
    acertos: placar.acertos,
    bloqueantes: placar.bloqueantes,
    bloqueantes_acertos: placar.bloqueantesAcertos,
    regra_v2: placar.regraV2,
    qualidade_acertos: placar.qualidadeAcertos,
    aprovado: placar.aprovado,
    tempo_medio_ms: tempos.length ? Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length) : null,
    custo_cents: linhas.reduce((a, l) => a + Number(l.custo_cents ?? 0), 0),
  });
}

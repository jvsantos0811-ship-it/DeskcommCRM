/**
 * O PAINEL DE PASSAGENS DA CENTRAL (PC-014, ampliação M7) — a conta, fora da tela.
 *
 * Por dia, no fuso da organização:
 *  - quantas passagens houve (as que de fato trocaram de agente);
 *  - de quem para quem;
 *  - quantas ficaram SEM RESPOSTA do destino em 2 minutos (só as que o destino
 *    deveria responder sozinho: pela ferramenta e pela regra do roteador; a
 *    devolução da equipe espera o cliente escrever);
 *  - quantas viraram laço (a 3ª passagem pela ferramenta em 1 hora, que não
 *    passa e abre caso para a equipe);
 *  - quantas foram pela regra do roteador × pela ferramenta (× pela equipe).
 *
 * Puro: recebe as linhas e o relógio, devolve o que a tela desenha.
 */
import { dataIsoNoFuso } from "@/lib/propostas/data-no-fuso";

export const PRAZO_DE_RESPOSTA_MS = 2 * 60_000;

export interface LinhaDaPassagem {
  de_agente_id: string | null;
  para_agente_id: string | null;
  origem: "ferramenta" | "roteador" | "equipe";
  desfecho: "passou" | "laco";
  created_at: string;
  destino_respondeu_em: string | null;
}

export interface ResumoDoDia {
  dia: string;
  passagens: number;
  semRespostaEm2Min: number;
  lacos: number;
  peloRoteador: number;
  pelaFerramenta: number;
  pelaEquipe: number;
}

export interface ParDePassagem {
  de: string;
  para: string;
  total: number;
}

export interface PainelDePassagens {
  dias: ResumoDoDia[];
  pares: ParDePassagem[];
  totais: Omit<ResumoDoDia, "dia">;
}

/** A passagem ficou sem resposta do destino em 2 min? (só quando já deu tempo de saber) */
export function ficouSemResposta(l: LinhaDaPassagem, agoraMs: number): boolean {
  if (l.desfecho !== "passou" || l.origem === "equipe") return false;
  const criada = Date.parse(l.created_at);
  if (!Number.isFinite(criada) || agoraMs - criada < PRAZO_DE_RESPOSTA_MS) return false;
  if (l.destino_respondeu_em === null) return true;
  const respondeu = Date.parse(l.destino_respondeu_em);
  return !Number.isFinite(respondeu) || respondeu - criada > PRAZO_DE_RESPOSTA_MS;
}

const vazio = (dia: string): ResumoDoDia => ({
  dia,
  passagens: 0,
  semRespostaEm2Min: 0,
  lacos: 0,
  peloRoteador: 0,
  pelaFerramenta: 0,
  pelaEquipe: 0,
});

/**
 * Monta o painel dos últimos `dias` dias (hoje incluído), no fuso da organização.
 * `nomes` traduz id de agente em nome; ausente vira "Agente removido"/"Equipe".
 */
export function montarPainelDePassagens(
  linhas: readonly LinhaDaPassagem[],
  opts: { agora: Date; fuso: string; dias: number; nomes: ReadonlyMap<string, string>; equipe: string; removido: string },
): PainelDePassagens {
  const agoraMs = opts.agora.getTime();
  const diasDoPeriodo: string[] = [];
  for (let i = opts.dias - 1; i >= 0; i -= 1) {
    diasDoPeriodo.push(dataIsoNoFuso(new Date(agoraMs - i * 86_400_000), opts.fuso));
  }
  const porDia = new Map(diasDoPeriodo.map((d) => [d, vazio(d)]));
  const pares = new Map<string, ParDePassagem>();

  for (const l of linhas) {
    const instante = new Date(l.created_at);
    if (Number.isNaN(instante.getTime())) continue;
    const resumo = porDia.get(dataIsoNoFuso(instante, opts.fuso));
    if (resumo === undefined) continue;
    if (l.desfecho === "laco") {
      resumo.lacos += 1;
      continue;
    }
    resumo.passagens += 1;
    if (l.origem === "roteador") resumo.peloRoteador += 1;
    else if (l.origem === "ferramenta") resumo.pelaFerramenta += 1;
    else resumo.pelaEquipe += 1;
    if (ficouSemResposta(l, agoraMs)) resumo.semRespostaEm2Min += 1;

    const de = l.origem === "equipe" ? opts.equipe : (opts.nomes.get(l.de_agente_id ?? "") ?? opts.removido);
    const para = opts.nomes.get(l.para_agente_id ?? "") ?? opts.removido;
    const chave = `${de}→${para}`;
    const par = pares.get(chave) ?? { de, para, total: 0 };
    par.total += 1;
    pares.set(chave, par);
  }

  const dias = diasDoPeriodo.map((d) => porDia.get(d)!);
  const totais = dias.reduce(
    (acc, d) => ({
      passagens: acc.passagens + d.passagens,
      semRespostaEm2Min: acc.semRespostaEm2Min + d.semRespostaEm2Min,
      lacos: acc.lacos + d.lacos,
      peloRoteador: acc.peloRoteador + d.peloRoteador,
      pelaFerramenta: acc.pelaFerramenta + d.pelaFerramenta,
      pelaEquipe: acc.pelaEquipe + d.pelaEquipe,
    }),
    { passagens: 0, semRespostaEm2Min: 0, lacos: 0, peloRoteador: 0, pelaFerramenta: 0, pelaEquipe: 0 },
  );
  return {
    dias,
    pares: [...pares.values()].sort((a, b) => b.total - a.total || a.de.localeCompare(b.de)),
    totais,
  };
}

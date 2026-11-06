/**
 * A BATERIA DA REGRA FIXA — Regra v2 §4 e PM-027 §9.
 *
 * As 48 fichas reais (sem identificação, `tests/fixtures/leitor/bateria-48.json`)
 * têm de dar o resultado esperado: Situação e Temperatura 48/48, Qualidade no
 * mínimo 46/48 (a regra do Gestor dá 48), Ação e Alertas. Nenhum cliente
 * classificado como lead.
 *
 * A ficha da bateria está no formato CURTO do Gestor (`contou`, `bola`, `fala`…);
 * `daBateria` traduz para a ficha do Leitor e os fatos do banco — se a tradução
 * errar um campo, a bateria acusa.
 *
 * SABOTAGEM:
 * - trocar a ordem de duas linhas de `situacaoDaFicha` (ex.: Recusou antes de
 *   Sem requisito): os casos B24/B26 acusam;
 * - trocar 72 por 48 em `temperaturaDaFicha`: o B10 (Contrato enviado, Quente) acusa;
 * - voltar o rótulo para "Já tem advogado": o caso CL2 acusa.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FatosDoBanco, FichaDoLeitor } from "./ficha";
import { classificarFicha, estadoSemFicha, type EntradaDaRegra, textoDaAcao, textoDoAlerta } from "./regra-da-ficha";

interface FichaCurta {
  contato: FichaDoLeitor["contato"];
  interesse?: string;
  contou?: FichaDoLeitor["contou_o_caso"];
  requisitos?: FichaDoLeitor["requisitos"];
  falta?: string;
  negociacao?: FichaDoLeitor["negociacao"];
  objecao?: FichaDoLeitor["objecao"];
  bola?: FichaDoLeitor["proximo_passo_com"];
  fala?: string;
  palavras?: boolean;
  risco?: boolean;
  confirmar?: boolean;
  duplicado?: boolean;
  espera?: string;
  fora_area?: boolean;
  sem_caso?: boolean;
  recusou?: boolean;
  outro_advogado_ativo?: boolean;
  ilegivel?: boolean;
  nunca_respondido?: boolean;
}
interface Caso {
  id: string;
  ficha: FichaCurta;
  esperado: { situacao: string; temperatura: string; qualidade: string; acao: string; alertas: string[] };
}
const bateria = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/leitor/bateria-48.json"), "utf-8"),
) as { relogio_da_regra: string; casos: Caso[] };

const AGORA = new Date(bateria.relogio_da_regra);

/** "29/10 10:15" (São Paulo, 2026) → instante. */
function instanteDaFala(fala: string | undefined): Date | null {
  if (!fala) return null;
  const m = /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(fala);
  if (!m) throw new Error(`fala fora do formato: ${fala}`);
  return new Date(`2026-${m[2]}-${m[1]}T${m[3]}:${m[4]}:00-03:00`);
}

function daBateria(f: FichaCurta): EntradaDaRegra {
  const ficha: FichaDoLeitor = {
    contato: f.contato,
    interesse: f.interesse ?? null,
    interesse_texto: null,
    contou_o_caso: f.contou ?? "nao",
    requisitos: f.requisitos ?? "a_confirmar",
    requisitos_faltando: f.falta ? [f.falta] : [],
    requisito_em_risco: f.risco ?? false,
    negociacao: f.negociacao ?? "nenhuma",
    objecao: f.objecao ?? "nenhuma",
    fora_da_area: f.fora_area ?? false,
    sem_caso: f.sem_caso ?? false,
    recusou: f.recusou ?? false,
    ja_atendido_por_outro: f.outro_advogado_ativo ?? false,
    confirmar_assinatura: f.confirmar ?? false,
    midia_nao_entendida: f.ilegivel ?? false,
    aguardando: f.espera ? { evento: f.espera, data: null } : null,
    proximo_passo_com: f.bola ?? "lead",
    palavras_proprias: f.palavras ?? false,
    esperando_a_equipe: null,
    provas: {},
  };
  const banco: FatosDoBanco = {
    ultima_fala_do_lead: instanteDaFala(f.fala),
    duplicado: f.duplicado ?? false,
    nunca_respondido: f.nunca_respondido ?? false,
    midia_nao_entendida: false,
  };
  return { ficha, banco };
}

const semTraducao = (s: string) => s;
// Na Bórbora o funil de quem já é cliente se chama "Operacional"; a regra não
// sabe nomes — quem chama passa o nome do funil da organização.
const FUNIL_DE_CLIENTES_DO_GABARITO = "Operacional";

function resultado(c: Caso) {
  const r = classificarFicha(daBateria(c.ficha), AGORA);
  return {
    situacao: r.situacao,
    temperatura: r.temperatura,
    qualidade: r.qualidade,
    acao: textoDaAcao(r.acao, semTraducao, FUNIL_DE_CLIENTES_DO_GABARITO),
    alertas: r.alertas.map((a) => textoDoAlerta(a, semTraducao)),
  };
}

describe("bateria da regra fixa (48 casos reais)", () => {
  it("tem os 48 casos", () => {
    expect(bateria.casos).toHaveLength(48);
  });

  for (const c of bateria.casos) {
    it(`${c.id}: ${c.esperado.situacao} · ${c.esperado.temperatura} · ${c.esperado.qualidade}`, () => {
      expect(resultado(c)).toEqual(c.esperado);
    });
  }

  it("placar: Situação e Temperatura 48/48, Qualidade ≥ 46/48", () => {
    let situacao = 0;
    let temperatura = 0;
    let qualidade = 0;
    for (const c of bateria.casos) {
      const r = resultado(c);
      if (r.situacao === c.esperado.situacao) situacao += 1;
      if (r.temperatura === c.esperado.temperatura) temperatura += 1;
      if (r.qualidade === c.esperado.qualidade) qualidade += 1;
    }
    expect({ situacao, temperatura }).toEqual({ situacao: 48, temperatura: 48 });
    expect(qualidade).toBeGreaterThanOrEqual(46);
  });

  it("nenhum cliente sai como lead de venda", () => {
    for (const c of bateria.casos.filter((x) => x.ficha.contato === "cliente")) {
      expect(resultado(c).situacao).toBe("Já é cliente");
    }
  });
});

describe("casos novos do Gestor que a regra decide sozinha", () => {
  const base = daBateria({ contato: "lead", contou: "parcial", fala: "05/11 10:00", palavras: true });

  it("CL2: já faz tratamento com outro profissional → 'Já atendido por outro'", () => {
    const e: EntradaDaRegra = { ...base, ficha: { ...base.ficha, ja_atendido_por_outro: true, interesse: "Clareamento" } };
    const r = classificarFicha(e, AGORA);
    expect(r.situacao).toBe("Já atendido por outro");
    expect(textoDaAcao(r.acao, semTraducao)).toBe("Responder com orientação e encerrar");
  });

  it("CL1: avaliação agendada → 'Aguardando evento' e 'Agendado'", () => {
    const e: EntradaDaRegra = {
      ...base,
      ficha: { ...base.ficha, interesse: "Implante", aguardando: { evento: "avaliação", data: "12/11 10h" } },
    };
    const r = classificarFicha(e, AGORA);
    expect([r.situacao, r.temperatura]).toEqual(["Aguardando evento", "Agendado"]);
    expect(textoDaAcao(r.acao, semTraducao)).toBe("Chamar depois: avaliação · 12/11 10h");
  });

  it("sem funil de clientes na organização, a ação não inventa nome", () => {
    const e: EntradaDaRegra = { ...base, ficha: { ...base.ficha, contato: "cliente" } };
    expect(textoDaAcao(classificarFicha(e, AGORA).acao, semTraducao)).toBe("Mover para o funil de clientes");
  });

  it("lead sem ficha: 'Sem leitura', ou 'Frio · sem leitura' depois de 3 dias úteis calado", () => {
    expect(estadoSemFicha(false)).toBe("sem_leitura");
    expect(estadoSemFicha(true)).toBe("frio_sem_leitura");
  });
});

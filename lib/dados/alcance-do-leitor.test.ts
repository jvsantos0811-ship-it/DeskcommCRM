import { describe, expect, it } from "vitest";

import {
  ALCANCE_PADRAO,
  alcanceDaOrg,
  funisLidos,
  posicaoNoAlcance,
  type FunilDaOrg,
  type LeadNoAlcance,
} from "./alcance-do-leitor";

// Nomes de propósito diferentes da Bórbora: o alcance não pode depender de nome (PM-027 §9.2).
const VENDAS = "11111111-1111-4111-8111-111111111111";
const POS_VENDA = "22222222-2222-4222-8222-222222222222";
const ARQUIVADO = "33333333-3333-4333-8333-333333333333";
const OUTRO = "44444444-4444-4444-8444-444444444444";

const funis: FunilDaOrg[] = [
  { id: VENDAS, is_archived: false, is_client_pipeline: false },
  { id: POS_VENDA, is_archived: false, is_client_pipeline: true },
  { id: ARQUIVADO, is_archived: true, is_client_pipeline: false },
  { id: OUTRO, is_archived: false, is_client_pipeline: false },
];

const aberta = { is_won: false, is_lost: false, is_archived: false };
const lead = (over: Partial<LeadNoAlcance> = {}): LeadNoAlcance => ({
  pipeline_id: VENDAS,
  tags: [],
  etapa: aberta,
  ...over,
});

describe("alcance do Leitor", () => {
  it("sem configuração: todos os funis não arquivados, menos o de clientes", () => {
    expect([...funisLidos(alcanceDaOrg({}), funis)].sort()).toEqual([VENDAS, OUTRO].sort());
  });

  it("funis escolhidos valem só se ainda existem e não estão arquivados", () => {
    const a = alcanceDaOrg({ leitor: { funis: [VENDAS, ARQUIVADO, POS_VENDA] } });
    expect([...funisLidos(a, funis)].sort()).toEqual([VENDAS, POS_VENDA].sort());
  });

  it("configuração inválida nunca lança: vira o padrão", () => {
    expect(alcanceDaOrg({ leitor: { funis: ["não é uuid"] } })).toEqual(ALCANCE_PADRAO);
    expect(alcanceDaOrg({ leitor: "lixo" })).toEqual(ALCANCE_PADRAO);
    expect(alcanceDaOrg(null)).toEqual(ALCANCE_PADRAO);
  });

  it("lead com potencial: funil lido, etapa aberta, sem marcador que desqualifica", () => {
    const a = alcanceDaOrg({ leitor: { funis: [VENDAS], marcadores_que_desqualificam: ["ja-cliente"] } });
    expect(posicaoNoAlcance(lead(), funisLidos(a, funis), a)).toBe("com_potencial");
  });

  it("perdido ou com marcador que desqualifica: fora, mas pode voltar", () => {
    const a = alcanceDaOrg({ leitor: { marcadores_que_desqualificam: ["Já-Cliente", "nao-e-lead"] } });
    const lidos = funisLidos(a, funis);
    expect(posicaoNoAlcance(lead({ etapa: { ...aberta, is_lost: true } }), lidos, a)).toBe("pode_voltar");
    // Sem maiúscula nem acento na comparação.
    expect(posicaoNoAlcance(lead({ tags: ["ja-cliente"] }), lidos, a)).toBe("pode_voltar");
    expect(posicaoNoAlcance(lead({ tags: ["NAO-E-LEAD"] }), lidos, a)).toBe("pode_voltar");
    // Outro marcador qualquer não desqualifica.
    expect(posicaoNoAlcance(lead({ tags: ["Meta_ads"] }), lidos, a)).toBe("com_potencial");
  });

  it("ganho, etapa arquivada e funil não lido: fora de vez", () => {
    const a = alcanceDaOrg({ leitor: { funis: [VENDAS] } });
    const lidos = funisLidos(a, funis);
    expect(posicaoNoAlcance(lead({ etapa: { ...aberta, is_won: true } }), lidos, a)).toBe("fora");
    expect(posicaoNoAlcance(lead({ etapa: { ...aberta, is_archived: true } }), lidos, a)).toBe("fora");
    expect(posicaoNoAlcance(lead({ pipeline_id: OUTRO }), lidos, a)).toBe("fora");
    expect(posicaoNoAlcance(lead({ pipeline_id: OUTRO, etapa: { ...aberta, is_lost: true } }), lidos, a)).toBe(
      "fora",
    );
  });
});

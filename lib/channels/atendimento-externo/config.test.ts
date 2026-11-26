import { describe, expect, it } from "vitest";

import {
  CONFIG_VAZIA,
  configDoAtendimentoExternoEntrada,
  configParaGravar,
  lerConfigDoAtendimentoExterno,
} from "./config";

describe("configuração do canal (PC-047)", () => {
  it("deriva chaves estáveis e únicas para as ações, na ordem da tela", () => {
    const entrada = configDoAtendimentoExternoEntrada.parse({
      dialogo_transferencia: "dlg_transfer_01",
      campo_da_ia: { nome: "IA_ATIVA", valor_ao_passar: "" },
      acoes: [
        { nome: "Etiquetar qualificado", dialogo_id: "dlg_tag_01", quando_usar: "quando o caso tem os requisitos" },
        { nome: "Etiquetar qualificado", dialogo_id: "dlg_tag_02", quando_usar: "segunda variação de teste" },
        { nome: "Mover para Análise", dialogo_id: "dlg_mov_01", quando_usar: "quando a equipe precisa olhar" },
      ],
    });
    const gravado = configParaGravar(entrada);
    const lido = lerConfigDoAtendimentoExterno(gravado);
    expect(lido.acoes.map((a) => a.chave)).toEqual([
      "etiquetar_qualificado",
      "etiquetar_qualificado_2",
      "mover_para_analise",
    ]);
    expect(lido.dialogoTransferencia).toBe("dlg_transfer_01");
    expect(lido.campoDaIa).toEqual({ nome: "IA_ATIVA", valorAoPassar: "" });
  });

  it("recusa id de diálogo com espaço ou caractere que viraria parâmetro extra", () => {
    const r = configDoAtendimentoExternoEntrada.safeParse({ dialogo_transferencia: "abc&action=x" });
    expect(r.success).toBe(false);
    const campo = configDoAtendimentoExternoEntrada.safeParse({ campo_da_ia: { nome: "campo com espaço" } });
    expect(campo.success).toBe(false);
  });

  it("no máximo quinze ações (PC-052)", () => {
    const acao = { nome: "Ação", dialogo_id: "dlg_0001", quando_usar: "sempre que for teste" };
    const quinze = configDoAtendimentoExternoEntrada.safeParse({
      acoes: Array.from({ length: 15 }, (_, i) => ({ ...acao, nome: `Ação ${String.fromCharCode(97 + i)}` })),
    });
    expect(quinze.success).toBe(true);
    const r = configDoAtendimentoExternoEntrada.safeParse({ acoes: Array.from({ length: 16 }, () => acao) });
    expect(r.success).toBe(false);
  });

  it("leitura nunca lança: lixo vira 'nada escolhido'", () => {
    expect(lerConfigDoAtendimentoExterno(null)).toEqual(CONFIG_VAZIA);
    expect(lerConfigDoAtendimentoExterno({ acoes: "não é lista" })).toEqual(CONFIG_VAZIA);
    expect(lerConfigDoAtendimentoExterno({})).toEqual(CONFIG_VAZIA);
  });
});

describe("equipe assumiu pela plataforma (PC-057)", () => {
  it("nasce desligada e é lida como booleano", () => {
    expect(CONFIG_VAZIA.equipeAssumiuPelaPlataforma).toBe(false);
    expect(lerConfigDoAtendimentoExterno({}).equipeAssumiuPelaPlataforma).toBe(false);
    expect(lerConfigDoAtendimentoExterno({ equipe_assumiu_pela_plataforma: true }).equipeAssumiuPelaPlataforma).toBe(true);
  });

  it("tela antiga (sem o campo) não desliga o que estava ligado", () => {
    const atual = lerConfigDoAtendimentoExterno({ equipe_assumiu_pela_plataforma: true });
    const entrada = configDoAtendimentoExternoEntrada.parse({ acoes: [] });
    expect(configParaGravar(entrada, atual).equipe_assumiu_pela_plataforma).toBe(true);
    const desligando = configDoAtendimentoExternoEntrada.parse({ acoes: [], equipe_assumiu_pela_plataforma: false });
    expect(configParaGravar(desligando, atual).equipe_assumiu_pela_plataforma).toBe(false);
  });
});

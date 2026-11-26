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

describe("valor de quando a equipe assume na plataforma (PC-058)", () => {
  it("nasce vazio (desligado) e é lido sem espaços", () => {
    expect(CONFIG_VAZIA.valorQuandoEquipeAssume).toBeNull();
    expect(lerConfigDoAtendimentoExterno({}).valorQuandoEquipeAssume).toBeNull();
    expect(lerConfigDoAtendimentoExterno({ valor_quando_equipe_assume: " assumido " }).valorQuandoEquipeAssume).toBe(
      "assumido",
    );
  });

  it("tela antiga (sem o campo) não apaga o valor gravado; vazio desliga", () => {
    const atual = lerConfigDoAtendimentoExterno({ valor_quando_equipe_assume: "assumido" });
    const antiga = configDoAtendimentoExternoEntrada.parse({ acoes: [] });
    expect(configParaGravar(antiga, atual).valor_quando_equipe_assume).toBe("assumido");
    const desligando = configDoAtendimentoExternoEntrada.parse({ acoes: [], valor_quando_equipe_assume: "" });
    expect(configParaGravar(desligando, atual).valor_quando_equipe_assume).toBeNull();
  });

  it("recusa o mesmo valor da passagem para a equipe", () => {
    const r = configDoAtendimentoExternoEntrada.safeParse({
      campo_da_ia: { nome: "LSIA", valor_ao_passar: "equipe" },
      valor_quando_equipe_assume: "Equipe",
    });
    expect(r.success).toBe(false);
  });
});

describe("a IA só responde no chat sem responsável na plataforma", () => {
  it("nasce desligada; só `true` liga", () => {
    expect(CONFIG_VAZIA.iaSoSemResponsavel).toBe(false);
    expect(lerConfigDoAtendimentoExterno({}).iaSoSemResponsavel).toBe(false);
    expect(lerConfigDoAtendimentoExterno({ ia_so_sem_responsavel: true }).iaSoSemResponsavel).toBe(true);
  });

  it("tela antiga (sem o campo) não desliga o que estava ligado; a tela nova liga e desliga", () => {
    const atual = lerConfigDoAtendimentoExterno({ ia_so_sem_responsavel: true });
    expect(configParaGravar(configDoAtendimentoExternoEntrada.parse({ acoes: [] }), atual).ia_so_sem_responsavel).toBe(true);
    const desliga = configDoAtendimentoExternoEntrada.parse({ acoes: [], ia_so_sem_responsavel: false });
    expect(configParaGravar(desliga, atual).ia_so_sem_responsavel).toBe(false);
    const liga = configDoAtendimentoExternoEntrada.parse({ acoes: [], ia_so_sem_responsavel: true });
    expect(configParaGravar(liga).ia_so_sem_responsavel).toBe(true);
  });
});

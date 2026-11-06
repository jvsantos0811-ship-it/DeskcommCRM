/**
 * O aviso "Um lead escreveu e ninguém respondeu" (PM-027 §7) — a regra pura.
 *
 * O caso de aceite (§9.6) está aqui com a forma das 9 conversas da Bórbora que
 * originaram a ordem (textos encurtados, sem nome nem telefone): com o aviso
 * ligado antes de 28/10, têm de dar 8 avisos — só a que termina em "Obg👍" não
 * avisa. A 2ª camada (leitura curta) entra como dublê que segue o "na dúvida,
 * avisa"; o que se prova aqui é que a regra manda para ela exatamente as 7
 * conversas indecisas e decide sozinha a do "Obg👍".
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Contar a resposta automática como resposta: o caso da saudação automática acusa.
 * - Tirar o filtro de "ligado em": o caso sem retroativo acusa.
 * - Contar relógio corrido em vez de expediente: o caso da madrugada acusa.
 */
import { describe, expect, it } from "vitest";

import { expedienteDaOrg } from "@/lib/dados/expediente";

import {
  avaliarConversa,
  configDoAviso,
  melhorPosicao,
  proximaConfig,
  textoDoAviso,
  type EntradaDaAvaliacao,
  type MensagemDaConversa,
} from "./ninguem-respondeu";

const SP = "America/Sao_Paulo";
const expediente = expedienteDaOrg({}, SP);
const ligadoEm = new Date("2026-10-27T00:00:00-03:00");
const agora = new Date("2026-11-06T09:00:00-03:00");

let seq = 0;
function msg(
  direction: "inbound" | "outbound",
  quando: string,
  over: Partial<MensagemDaConversa> = {},
): MensagemDaConversa {
  seq += 1;
  return {
    id: `m-${seq}`,
    direction,
    sent_via: direction === "inbound" ? "external_device" : "external_device",
    type: "text",
    body: null,
    media_derived_text: null,
    created_at: new Date(quando).toISOString(),
    ...over,
  };
}
const lead = (q: string, over: Partial<MensagemDaConversa> = {}) => msg("inbound", q, over);
const equipe = (q: string, over: Partial<MensagemDaConversa> = {}) => msg("outbound", q, over);
const ia = (q: string, body = "Resposta da assistente.") => msg("outbound", q, { sent_via: "ai", body });

function entrada(mensagens: MensagemDaConversa[], over: Partial<EntradaDaAvaliacao> = {}): EntradaDaAvaliacao {
  return {
    mensagens,
    posicao: "com_potencial",
    ehGrupo: false,
    contatoBloqueado: false,
    contatoInterno: false,
    ligadoEm,
    agora,
    expediente,
    ...over,
  };
}

describe("aceite §9.6 — as 9 conversas da Bórbora dão 8 avisos", () => {
  const conversas: Record<string, MensagemDaConversa[]> = {
    // Áudio de despedida depois de a equipe mandar outro número: a forma não decide.
    leny: [
      equipe("2026-10-28T09:47:04-03:00", { type: "audio", media_derived_text: "Bom dia, em que posso ajudar?" }),
      lead("2026-10-28T09:50:25-03:00", { body: "Bom dia" }),
      lead("2026-10-28T09:50:38-03:00", { type: "audio", media_derived_text: "Queria saber da solicitação." }),
      equipe("2026-10-28T09:54:27-03:00", { type: "audio", media_derived_text: "Estamos aguardando os hospitais." }),
      equipe("2026-10-28T09:55:13-03:00", { body: "👤 Escritório" }),
      lead("2026-10-28T10:05:38-03:00", { type: "audio", media_derived_text: "Bom dia. Tudo bem então, vou salvar aqui." }),
    ],
    // Cartão de contato enviado pelo lead.
    lucio: [
      equipe("2026-10-28T10:03:29-03:00", { type: "audio", media_derived_text: "Quando ele sofreu o acidente..." }),
      lead("2026-10-28T11:51:03-03:00", { body: "👤 Lúcio" }),
    ],
    // Resposta em áudio à pergunta da IA.
    caso135: [
      lead("2026-10-28T11:25:50-03:00", { type: "audio", media_derived_text: "Atualizei ontem no 135." }),
      ia("2026-10-28T11:27:23-03:00", "Esse caso é seu mesmo ou de alguém da família?"),
      lead("2026-10-28T11:51:43-03:00", { type: "audio", media_derived_text: "É meu esse caso, é meu, sim." }),
    ],
    // Áudio com transcrição ruim.
    audioRuim: [
      equipe("2026-10-30T15:41:26-03:00", { type: "audio", media_derived_text: "..." }),
      lead("2026-10-30T15:43:49-03:00", { type: "audio", media_derived_text: "Ну и вот, вуаля." }),
    ],
    // Leads de anúncio de madrugada, com a conta suspensa.
    n1a: [lead("2026-11-03T02:52:47-03:00", { body: "#N1 - Olá, meu benefício do INSS foi negado e preciso de ajuda." })],
    n1b: [lead("2026-11-03T03:14:18-03:00", { body: "#N1 - Olá, meu benefício do INSS foi negado e preciso de ajuda." })],
    // "Bom dia" + "Meu povo" dias depois da última fala nossa.
    meuPovo: [
      lead("2026-10-28T09:35:48-03:00", { type: "image", media_derived_text: "Pedido de prontuário médico." }),
      ia("2026-10-28T09:37:23-03:00"),
      equipe("2026-10-30T10:00:42-03:00", { body: "👤 Escritório" }),
      lead("2026-11-03T08:25:15-03:00", { body: "Bom dia" }),
      lead("2026-11-03T08:25:20-03:00", { body: "Meu povo" }),
    ],
    // Laudo em imagem.
    laudo: [
      ia("2026-11-03T10:43:12-03:00", "Posso te fazer umas perguntas?"),
      lead("2026-11-03T11:14:38-03:00", { type: "image", media_derived_text: "Laudo para solicitação de internação." }),
    ],
    // O único sem aviso.
    obg: [
      equipe("2026-10-29T15:20:48-03:00", { type: "audio", media_derived_text: "Precisamos verificar a qualidade de segurado." }),
      lead("2026-10-29T15:29:58-03:00", { body: "Ok" }),
      lead("2026-10-29T15:29:59-03:00", { body: "Vou verificar" }),
      lead("2026-10-29T15:30:09-03:00", { body: "Obg👍" }),
    ],
  };

  it("a regra decide o 'Obg👍' sozinha e manda as outras 8 para a leitura curta ou o aviso direto", () => {
    const resultado = Object.fromEntries(
      Object.entries(conversas).map(([nome, m]) => [nome, avaliarConversa(entrada(m)).tipo]),
    );
    expect(resultado.obg).toBe("encerrou");
    const avisam = Object.entries(resultado).filter(([, tipo]) => tipo === "avisar" || tipo === "conferir");
    expect(avisam.map(([n]) => n).sort()).toEqual(
      ["audioRuim", "caso135", "laudo", "leny", "lucio", "meuPovo", "n1a", "n1b"].sort(),
    );
  });

  it("com a leitura curta seguindo o 'na dúvida, avisa': 8 avisos", () => {
    const naDuvidaAvisa = () => false; // "terminou?" — não
    const avisos = Object.values(conversas)
      .map((m) => avaliarConversa(entrada(m)))
      .filter((a) => a.tipo === "avisar" || (a.tipo === "conferir" && !naDuvidaAvisa()));
    expect(avisos).toHaveLength(8);
  });

  it("'Bom dia' sozinho abrindo a conversa avisa sem precisar da leitura", () => {
    const a = avaliarConversa(entrada([lead("2026-11-05T08:00:00-03:00", { body: "Bom dia" })]));
    expect(a.tipo).toBe("avisar");
  });
});

describe("quando avisa", () => {
  it("1 hora de EXPEDIENTE: o lead da madrugada só avisa às 9h", () => {
    const m = [lead("2026-11-03T02:52:00-03:00", { body: "Preciso de ajuda" })];
    expect(avaliarConversa(entrada(m, { agora: new Date("2026-11-03T08:59:00-03:00") })).tipo).toBe("no_prazo");
    expect(avaliarConversa(entrada(m, { agora: new Date("2026-11-03T09:00:00-03:00") })).tipo).toBe("conferir");
  });

  it("o 'desde' é a primeira mensagem sem resposta, não a última", () => {
    const m = [
      lead("2026-11-05T10:00:00-03:00", { body: "Oi, preciso de ajuda" }),
      lead("2026-11-05T10:50:00-03:00", { body: "Alguém?" }),
    ];
    const a = avaliarConversa(entrada(m, { agora: new Date("2026-11-05T11:00:00-03:00") }));
    expect(a.tipo).toBe("conferir");
    if (a.tipo === "conferir") expect(a.desde.toISOString()).toBe(new Date("2026-11-05T10:00:00-03:00").toISOString());
  });

  it("qualquer resposta nossa depois da do lead cala o aviso — IA, CRM ou celular", () => {
    const base = [lead("2026-11-05T10:00:00-03:00", { body: "Oi, preciso de ajuda" })];
    expect(avaliarConversa(entrada([...base, ia("2026-11-05T10:05:00-03:00")])).tipo).toBe("respondida");
    expect(avaliarConversa(entrada([...base, equipe("2026-11-05T10:05:00-03:00", { body: "Oi!" })])).tipo).toBe(
      "respondida",
    );
    expect(
      avaliarConversa(entrada([...base, equipe("2026-11-05T10:05:00-03:00", { sent_via: "user", body: "Oi" })])).tipo,
    ).toBe("respondida");
  });

  it("a resposta automática do WhatsApp Business NÃO conta como resposta", () => {
    const entradaDoLead = lead("2026-11-05T10:00:00-03:00", { body: "Oi, preciso de ajuda" });
    const automatica = equipe("2026-11-05T10:00:05-03:00", {
      body: "Olá! Sou do escritório. Como posso te chamar?",
      automatica: true,
    });
    expect(avaliarConversa(entrada([entradaDoLead, automatica])).tipo).toBe("conferir");
  });

  it("sem retroativo: mensagem do lead de antes de ligar o aviso não conta", () => {
    const m = [lead("2026-10-20T10:00:00-03:00", { body: "Oi" })];
    expect(avaliarConversa(entrada(m)).tipo).toBe("antes_de_ligar");
    // A que chega depois de ligado conta, e o 'desde' é ela.
    const depois = [...m, lead("2026-11-05T10:00:00-03:00", { body: "Alguém aí?" })];
    const a = avaliarConversa(entrada(depois, { agora: new Date("2026-11-05T12:00:00-03:00") }));
    expect(a.tipo).toBe("conferir");
    if (a.tipo === "conferir") expect(a.desde.toISOString()).toBe(new Date("2026-11-05T10:00:00-03:00").toISOString());
  });

  it("fora: grupo, bloqueado, número interno, sem negócio e fora do alcance", () => {
    const m = [lead("2026-11-05T08:00:00-03:00", { body: "Bom dia" })];
    expect(avaliarConversa(entrada(m, { ehGrupo: true }))).toEqual({ tipo: "fora", motivo: "grupo" });
    expect(avaliarConversa(entrada(m, { contatoBloqueado: true }))).toEqual({ tipo: "fora", motivo: "bloqueado" });
    expect(avaliarConversa(entrada(m, { contatoInterno: true }))).toEqual({ tipo: "fora", motivo: "interno" });
    expect(avaliarConversa(entrada(m, { posicao: null }))).toEqual({ tipo: "fora", motivo: "sem_negocio" });
    expect(avaliarConversa(entrada(m, { posicao: "fora" }))).toEqual({ tipo: "fora", motivo: "fora_do_alcance" });
  });

  it("lead que voltou (perdido ou com marcador) avisa como o com potencial", () => {
    const m = [lead("2026-11-05T08:00:00-03:00", { body: "Bom dia" })];
    expect(avaliarConversa(entrada(m, { posicao: "pode_voltar" })).tipo).toBe("avisar");
  });

  it("a leitura curta recebe as últimas 6 mensagens", () => {
    const m = Array.from({ length: 10 }, (_, i) => {
      const quando = `2026-11-05T07:0${i}:00-03:00`;
      return i % 2 === 0 ? equipe(quando, { body: "msg da equipe" }) : lead(quando, { body: "pergunta" });
    });
    m.push(lead("2026-11-05T07:30:00-03:00", { body: "e então?" }));
    const a = avaliarConversa(entrada(m));
    expect(a.tipo).toBe("conferir");
    if (a.tipo === "conferir") expect(a.trecho).toHaveLength(6);
  });
});

describe("configuração", () => {
  it("desligado, inválido ou ligado sem data: desligado", () => {
    expect(configDoAviso({}).ligado).toBe(false);
    expect(configDoAviso({ ninguem_respondeu: { ligado: true } }).ligado).toBe(false);
    expect(configDoAviso({ ninguem_respondeu: "lixo" }).ligado).toBe(false);
  });

  it("ligar grava a data; religar mantém; desligar zera e religar recomeça (sem retroativo)", () => {
    const t1 = new Date("2026-11-06T10:00:00Z");
    const t2 = new Date("2026-11-07T10:00:00Z");
    const ligado = proximaConfig(configDoAviso({}), true, t1);
    expect(ligado).toEqual({ ligado: true, ligado_em: t1.toISOString() });
    expect(proximaConfig(ligado, true, t2)).toEqual(ligado);
    const desligado = proximaConfig(ligado, false, t2);
    expect(desligado).toEqual({ ligado: false, ligado_em: null });
    expect(proximaConfig(desligado, true, t2)).toEqual({ ligado: true, ligado_em: t2.toISOString() });
    expect(configDoAviso({ ninguem_respondeu: ligado })).toEqual(ligado);
  });

  it("a melhor posição entre os negócios do contato", () => {
    expect(melhorPosicao([])).toBeNull();
    expect(melhorPosicao(["fora", "pode_voltar"])).toBe("pode_voltar");
    expect(melhorPosicao(["pode_voltar", "com_potencial", "fora"])).toBe("com_potencial");
  });
});

describe("texto do aviso", () => {
  it("diz quando o lead escreveu, no fuso da empresa, e a etapa — sem nome do contato", () => {
    const t = (s: string) => s;
    const r = textoDoAviso(t, {
      desde: new Date("2026-11-03T05:52:47Z"),
      etapa: "Recepção",
      fuso: SP,
      idioma: "pt-BR",
    });
    expect(r.title).toBe("Um lead escreveu e ninguém respondeu");
    expect(r.body).toBe("O lead escreveu em 03/11 às 02:52 e ninguém respondeu. Etapa: Recepção.");
  });
});

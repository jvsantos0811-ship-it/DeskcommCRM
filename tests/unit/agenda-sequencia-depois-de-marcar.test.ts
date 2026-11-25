/**
 * PC-052 parte 3 — a SEQUÊNCIA DEPOIS DE MARCAR e o diálogo fora da janela.
 *
 * O que este arquivo vigia, e por que cada caso existe:
 *  - a conta de QUANDO (pura): aquecimento na noite da marcação, confirmação na
 *    véspera ou no dia pelo corte, véspera de domingo recuando para o sábado, e a
 *    ocasião que já tinha passado quando a reunião foi marcada não sai;
 *  - a configuração ilegível volta ao padrão campo a campo e o `ativo` ilegível
 *    é DESLIGADO; os textos do escritório vão com as quebras de linha dele;
 *  - a escolha do remetente aceita a conexão com diálogo para o uso, e só ela;
 *  - o cron: um passo por compromisso, carimbo condicional ANTES do envio (perdeu
 *    a troca = não envia), uma vez por horário, diálogo fora da janela, e nada
 *    para contato bloqueado nem para organização parada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enviar: vi.fn(),
  abrirConversa: vi.fn(),
  remetente: vi.fn(),
  roteiro: vi.fn(),
  audit: vi.fn(),
  janelaAberta: true,
  compromissos: [] as Array<Record<string, unknown>>,
  contato: {} as Record<string, unknown>,
  organizacao: {} as Record<string, unknown>,
  reivindica: true,
  atualizacoes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.enviar }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: mocks.abrirConversa }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: async () => {} }));
vi.mock("@/lib/automation/janela-do-canal", () => ({
  knobsDoCanal: async () => ({ allowSunday: false, timezone: "America/Sao_Paulo" }),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({ janelaDeEnvioAberta: () => mocks.janelaAberta }));
vi.mock("@/lib/agenda/remetente-do-lembrete", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolverRemetenteDoLembrete: (...a: unknown[]) => mocks.remetente(...a),
}));
vi.mock("@/lib/channels/roteiro-fora-da-janela", () => ({
  enviarRoteiroForaDaJanela: (...a: unknown[]) => mocks.roteiro(...a),
}));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: async () => new Map([["dono-1", "Maria Vitória"]]),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async (caminho: string) => ({
          data: { signedUrl: `https://projeto.supabase.co/storage/v1/object/sign/agenda-media/${caminho}?token=t` },
        }),
      }),
    },
    from: (tabela: string) => {
      let atualizando: Record<string, unknown> | null = null;
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "gt", "gte", "lte", "order", "limit", "or", "is", "in", "neq"]) c[m] = () => c;
      c.update = (v: Record<string, unknown>) => {
        atualizando = v;
        mocks.atualizacoes.push(v);
        return c;
      };
      c.maybeSingle = async () => ({
        data: tabela === "contacts" ? mocks.contato : tabela === "organizations" ? mocks.organizacao : null,
        error: null,
      });
      c.then = (r: (v: unknown) => unknown) =>
        Promise.resolve(
          atualizando
            ? { data: mocks.reivindica ? [{ id: "x" }] : [], error: null }
            : { data: tabela === "calendar_appointments" ? mocks.compromissos : [], error: null },
        ).then(r);
      return c;
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/agenda-sequencia/route";
import { decidirRemetenteDoLembrete, type CanalDoLembrete } from "@/lib/agenda/remetente-do-lembrete";
import {
  configParaGravar,
  configDoAtendimentoExternoEntrada,
  lerConfigDoAtendimentoExterno,
} from "@/lib/channels/atendimento-externo/config";
import {
  farejarMidiaDoAquecimento,
  lerMidiaDoAquecimento,
} from "@/lib/agenda/midia-do-aquecimento";
import {
  aquecimentoLigadoEm,
  lerSequencia,
  ocasiaoDaConfirmacao,
  ocasiaoDoAquecimento,
  passoAberto,
  pecasDaSequencia,
  sequenciaEntrada,
  sequenciaParaGravar,
  type ConfigDaSequencia,
} from "@/lib/agenda/sequencia";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

const FUSO = "America/Sao_Paulo"; // -03:00 o ano todo desde 2019
const ORG = "00000000-0000-4000-8000-000000000001";
const local = (iso: string) => new Date(`${iso}-03:00`);
const todoDia = () => true;
const semDomingo = (dow: number) => dow !== 0;

describe("quando sai o aquecimento", () => {
  it("na hora fixa da noite do dia em que marcou", () => {
    const o = ocasiaoDoAquecimento({
      marcadoEm: local("2026-12-07T10:00:00"),
      comeca: local("2026-12-09T15:00:00"),
      fuso: FUSO,
      hora: "19:00",
    });
    expect(o?.alvo).toEqual(local("2026-12-07T19:00:00"));
    expect(o?.validaAte).toEqual(local("2026-12-09T14:30:00"));
  });

  it("marcado depois da hora fixa: logo depois de marcar", () => {
    const marcadoEm = local("2026-12-07T19:30:00");
    expect(ocasiaoDoAquecimento({ marcadoEm, comeca: local("2026-12-09T15:00:00"), fuso: FUSO, hora: "19:00" })?.alvo).toEqual(
      marcadoEm,
    );
  });

  it("reunião no mesmo dia: logo depois de marcar", () => {
    const marcadoEm = local("2026-12-07T09:00:00");
    expect(ocasiaoDoAquecimento({ marcadoEm, comeca: local("2026-12-07T15:00:00"), fuso: FUSO, hora: "19:00" })?.alvo).toEqual(
      marcadoEm,
    );
  });

  it("reunião a menos de 30 minutos: não há ocasião", () => {
    expect(
      ocasiaoDoAquecimento({
        marcadoEm: local("2026-12-07T09:00:00"),
        comeca: local("2026-12-07T09:20:00"),
        fuso: FUSO,
        hora: "19:00",
      }),
    ).toBeNull();
  });
});

describe("quando sai a confirmação", () => {
  const base = { fuso: FUSO, corte: "12:00", horaVespera: "17:00", horaDoDia: "08:30" };

  it("reunião antes do corte: na véspera, e vale só até a meia-noite dela", () => {
    const o = ocasiaoDaConfirmacao({
      ...base,
      marcadoEm: local("2026-12-07T10:00:00"),
      comeca: local("2026-12-09T10:00:00"),
      diaTemEnvio: todoDia,
    });
    expect(o?.passo).toBe("confirmacao_vespera");
    expect(o?.alvo).toEqual(local("2026-12-08T17:00:00"));
    expect(o?.validaAte).toEqual(local("2026-12-09T00:00:00"));
  });

  it("reunião no corte ou depois: no mesmo dia, até 30 minutos antes", () => {
    const o = ocasiaoDaConfirmacao({
      ...base,
      marcadoEm: local("2026-12-07T10:00:00"),
      comeca: local("2026-12-09T14:00:00"),
      diaTemEnvio: todoDia,
    });
    expect(o?.passo).toBe("confirmacao_do_dia");
    expect(o?.alvo).toEqual(local("2026-12-09T08:30:00"));
    expect(o?.validaAte).toEqual(local("2026-12-09T13:30:00"));
  });

  it("véspera num domingo sem envio: recua para o sábado", () => {
    const o = ocasiaoDaConfirmacao({
      ...base,
      marcadoEm: local("2026-12-02T10:00:00"),
      comeca: local("2026-12-07T10:00:00"),
      diaTemEnvio: semDomingo,
    });
    expect(o?.alvo).toEqual(local("2026-12-05T17:00:00"));
  });

  it("com envio no domingo: a véspera é o domingo", () => {
    const o = ocasiaoDaConfirmacao({
      ...base,
      marcadoEm: local("2026-12-02T10:00:00"),
      comeca: local("2026-12-07T10:00:00"),
      diaTemEnvio: todoDia,
    });
    expect(o?.alvo).toEqual(local("2026-12-06T17:00:00"));
  });

  it("a hora da véspera já tinha passado quando marcou: não sai", () => {
    expect(
      ocasiaoDaConfirmacao({
        ...base,
        marcadoEm: local("2026-12-08T18:00:00"),
        comeca: local("2026-12-09T10:00:00"),
        diaTemEnvio: todoDia,
      }),
    ).toBeNull();
  });
});

describe("o passo aberto agora", () => {
  const config: ConfigDaSequencia = {
    aquecimento: { ativo: true, hora: "19:00", texto: null, ligadoEm: null },
    confirmacao: { ativo: true, corte: "12:00", horaVespera: "17:00", horaDoDia: "08:30", textoVespera: null, textoDoDia: null },
  };
  const linha = {
    starts_at: local("2026-12-09T10:00:00").toISOString(),
    created_at: local("2026-12-08T10:00:00").toISOString(),
    starts_at_marked_at: null,
    warmup_sent_at: null,
    confirmation_sent_for: null,
  };

  it("com os dois abertos, o aquecimento vai primeiro (um passo por rodada)", () => {
    const agora = local("2026-12-08T19:05:00");
    expect(passoAberto({ linha, config, fuso: FUSO, agora, diaTemEnvio: todoDia })?.passo).toBe("aquecimento");
    expect(
      passoAberto({ linha: { ...linha, warmup_sent_at: agora.toISOString() }, config, fuso: FUSO, agora, diaTemEnvio: todoDia })
        ?.passo,
    ).toBe("confirmacao_vespera");
  });

  it("a confirmação sai uma vez por HORÁRIO: remarcar arma de novo", () => {
    const agora = local("2026-12-08T17:05:00");
    const jaSaiu = { ...linha, warmup_sent_at: agora.toISOString(), confirmation_sent_for: linha.starts_at };
    expect(passoAberto({ linha: jaSaiu, config, fuso: FUSO, agora, diaTemEnvio: todoDia })).toBeNull();
    const remarcada = {
      ...jaSaiu,
      starts_at: local("2026-12-09T11:00:00").toISOString(),
      starts_at_marked_at: local("2026-12-08T12:00:00").toISOString(),
    };
    expect(passoAberto({ linha: remarcada, config, fuso: FUSO, agora, diaTemEnvio: todoDia })?.passo).toBe(
      "confirmacao_vespera",
    );
  });

  it("ligar o aquecimento agora não manda vídeo para quem marcou antes", () => {
    const agora = local("2026-12-08T19:05:00");
    const ligadoDepois = { ...config, aquecimento: { ...config.aquecimento, ligadoEm: local("2026-12-08T12:00:00").toISOString() } };
    expect(passoAberto({ linha, config: ligadoDepois, fuso: FUSO, agora, diaTemEnvio: todoDia })?.passo).not.toBe("aquecimento");
    const ligadoAntes = { ...config, aquecimento: { ...config.aquecimento, ligadoEm: local("2026-12-08T09:00:00").toISOString() } };
    expect(passoAberto({ linha, config: ligadoAntes, fuso: FUSO, agora, diaTemEnvio: todoDia })?.passo).toBe("aquecimento");
  });

  it("o instante em que o aquecimento passou a valer: novo ao ligar, mantido enquanto ligado, nulo ao desligar", () => {
    const agora = new Date("2026-12-08T15:00:00.000Z");
    const antes = lerSequencia({ aquecimento: { ativo: true, ligado_em: "2026-12-01T10:00:00.000Z" } });
    expect(aquecimentoLigadoEm({ ligadaAntes: false, antes, ligadaAgora: true, aquecimentoAtivoAgora: true, agora })).toBe(agora.toISOString());
    expect(aquecimentoLigadoEm({ ligadaAntes: true, antes, ligadaAgora: true, aquecimentoAtivoAgora: true, agora })).toBe(
      "2026-12-01T10:00:00.000Z",
    );
    expect(aquecimentoLigadoEm({ ligadaAntes: true, antes, ligadaAgora: true, aquecimentoAtivoAgora: false, agora })).toBeNull();
  });

  it("sequência desligada: nada", () => {
    const desligada = { ...config, aquecimento: { ...config.aquecimento, ativo: false }, confirmacao: { ...config.confirmacao, ativo: false } };
    expect(passoAberto({ linha, config: desligada, fuso: FUSO, agora: local("2026-12-08T19:05:00"), diaTemEnvio: todoDia })).toBeNull();
  });
});

describe("a configuração", () => {
  it("ilegível volta ao padrão campo a campo, e o ativo ilegível é desligado", () => {
    const c = lerSequencia({ aquecimento: { ativo: "true", hora: "25:00" }, confirmacao: { ativo: true, corte: "11:00", hora_vespera: "x" } });
    expect(c.aquecimento).toEqual({ ativo: false, hora: "19:00", texto: null, ligadoEm: null });
    expect(c.confirmacao).toMatchObject({ ativo: true, corte: "11:00", horaVespera: "17:00", horaDoDia: "08:30" });
    expect(lerSequencia(null).confirmacao.ativo).toBe(false);
  });

  it("o texto do escritório vai com as quebras de linha dele; só espaço vira vazio", () => {
    const entrada = sequenciaEntrada.parse({
      aquecimento: { ativo: true, hora: "19:00", texto: "  " },
      confirmacao: {
        ativo: true,
        corte: "12:00",
        hora_vespera: "17:00",
        hora_do_dia: "08:30",
        texto_vespera: "Amanhã é o grande dia!\n\n  Está confirmada?",
        texto_do_dia: null,
      },
    });
    const gravado = sequenciaParaGravar(entrada) as { aquecimento: { texto: unknown }; confirmacao: { texto_vespera: unknown } };
    expect(gravado.aquecimento.texto).toBeNull();
    expect(gravado.confirmacao.texto_vespera).toBe("Amanhã é o grande dia!\n\n  Está confirmada?");
  });

  it("dia_relativo: amanhã, hoje ou o dia da semana", () => {
    const pecas = (envio: string) =>
      pecasDaSequencia({
        nomeDoContato: "Ana Souza",
        especialista: "Maria Vitória",
        comeca: local("2026-12-07T10:00:00"),
        envio: local(envio),
        fuso: FUSO,
        etiquetaDeIdioma: "pt-BR",
        palavras: { amanha: "amanhã", hoje: "hoje", as: "às" },
      });
    expect(pecas("2026-12-06T17:00:00").dia_relativo).toBe("amanhã");
    expect(pecas("2026-12-07T08:30:00").dia_relativo).toBe("hoje");
    expect(pecas("2026-12-05T17:00:00").dia_relativo).toContain("segunda");
    expect(pecas("2026-12-05T17:00:00")).toMatchObject({ primeiro_nome: "Ana", especialista: "Maria", hora: "10:00" });
  });
});

describe("o diálogo da conexão fora da janela", () => {
  it("salvar por uma tela antiga (sem o campo) não apaga os diálogos", () => {
    const atual = lerConfigDoAtendimentoExterno({ roteiros_fora_da_janela: { lembrete: "dlg_lembrete" } });
    const entrada = configDoAtendimentoExternoEntrada.parse({ acoes: [] });
    // A 3b acrescentou os usos do follow-up (followup_1 a followup_5): o que a
    // tela antiga não mandou continua como estava, e o que nunca existiu fica nulo.
    expect(configParaGravar(entrada, atual).roteiros_fora_da_janela).toEqual({
      confirmacao_vespera: null,
      confirmacao_do_dia: null,
      lembrete: "dlg_lembrete",
      followup_1: null,
      followup_2: null,
      followup_3: null,
      followup_4: null,
      followup_5: null,
    });
  });

  it("um id ilegível derruba só o seu uso, nunca as ações", () => {
    const lido = lerConfigDoAtendimentoExterno({
      acoes: [{ chave: "etiquetar", nome: "Etiquetar", dialogo_id: "dlg_tag1", quando_usar: "sempre que…" }],
      roteiros_fora_da_janela: { lembrete: "id com espaço", confirmacao_vespera: "dlg_vespera" },
    });
    expect(lido.acoes).toHaveLength(1);
    expect(lido.roteirosForaDaJanela).toEqual({ confirmacao_vespera: "dlg_vespera" });
  });

  const canal = (id: string, provider: string): CanalDoLembrete => ({
    id,
    provider,
    status: "WORKING",
    archived_at: null,
    metadata: null,
    lastInboundAt: "2026-11-01T12:00:00.000Z",
  });

  it("janela fechada: a conexão com diálogo para o uso serve, e sai por roteiro", () => {
    const agora = new Date("2026-12-08T20:00:00.000Z");
    const escolha = decidirRemetenteDoLembrete([canal("cg", "chatguru")], null, agora, false, new Set(["cg"]));
    expect(escolha).toMatchObject({ canal: { id: "cg" }, foraDaJanela: true, via: "roteiro" });
  });

  it("janela fechada e sem diálogo: não sai", () => {
    const agora = new Date("2026-12-08T20:00:00.000Z");
    expect(decidirRemetenteDoLembrete([canal("cg", "chatguru")], null, agora, false, new Set())).toMatchObject({
      canal: null,
      motivo: "canal_fora_da_janela_24h",
    });
  });
});

describe("a mídia do aquecimento", () => {
  it("fareja MP4, JPEG e PNG pelos bytes", () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(farejarMidiaDoAquecimento(mp4)).toBe("video/mp4");
    expect(farejarMidiaDoAquecimento(jpg)).toBe("image/jpeg");
    expect(farejarMidiaDoAquecimento(png)).toBe("image/png");
    expect(farejarMidiaDoAquecimento(new Uint8Array(12))).toBeNull();
  });

  it("só aceita caminho desta organização, sem '..', e até três imagens", () => {
    const img = (caminho: string) => ({ caminho, mime: "image/png", bytes: 10 });
    const m = lerMidiaDoAquecimento(
      {
        midia_do_aquecimento: {
          video: { caminho: "outra-org/video.mp4", mime: "video/mp4", bytes: 10 },
          imagens: [img(`${ORG}/a.png`), img(`${ORG}/../x.png`), img(`${ORG}/b.png`), img(`${ORG}/c.png`), img(`${ORG}/d.png`)],
        },
      },
      ORG,
    );
    expect(m.video).toBeNull();
    expect(m.imagens.map((i) => i.caminho)).toEqual([`${ORG}/a.png`, `${ORG}/b.png`, `${ORG}/c.png`]);
  });
});

// ─── O cron ──────────────────────────────────────────────────────────────────

const pedido = () => new Request("http://localhost/api/v1/cron/agenda-sequencia") as never;
const configLigada = {
  aquecimento: { ativo: true, hora: "19:00", texto: null },
  confirmacao: { ativo: true, corte: "12:00", hora_vespera: "17:00", hora_do_dia: "08:30", texto_vespera: null, texto_do_dia: null },
};
const compromisso = (extra: Record<string, unknown> = {}) => ({
  id: "comp-1",
  organization_id: ORG,
  contact_id: "contato-1",
  conversation_id: "conversa-1",
  owner_user_id: "dono-1",
  starts_at: local("2026-12-09T10:00:00").toISOString(),
  created_at: local("2026-12-07T10:00:00").toISOString(),
  starts_at_marked_at: null,
  warmup_sent_at: local("2026-12-07T19:00:00").toISOString(),
  confirmation_sent_for: null,
  lead_presence: "aguardando",
  calendar_event_types: {
    reminder_channel_session_id: null,
    post_booking_sequence_enabled: true,
    post_booking_sequence: configLigada,
  },
  organizations: { status: "active" },
  ...extra,
});

describe("cron agenda-sequencia", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local("2026-12-08T17:05:00"));
    for (const m of [mocks.enviar, mocks.abrirConversa, mocks.remetente, mocks.roteiro, mocks.audit]) m.mockReset();
    mocks.abrirConversa.mockResolvedValue("conversa-1");
    mocks.enviar.mockResolvedValue({ id: "msg-1" });
    mocks.remetente.mockResolvedValue({ canal: { id: "canal-1", provider: "waha" }, motivo: null });
    mocks.roteiro.mockResolvedValue({ ok: true });
    mocks.janelaAberta = true;
    mocks.reivindica = true;
    mocks.atualizacoes = [];
    mocks.compromissos = [compromisso()];
    mocks.contato = { id: "contato-1", name: "Ana Souza", display_name: null, phone_number: "+5531999998888", is_blocked: false, consent: null };
    mocks.organizacao = { timezone: FUSO, locale: "pt-BR", settings: {} };
  });

  it("véspera às 17h: carimba o horário ANTES e manda o texto padrão com a hora", async () => {
    const res = await GET(pedido());
    const { data } = await res.json();
    expect(data).toMatchObject({ enviados: 1, passos: { confirmacao_vespera: 1 } });
    expect(mocks.atualizacoes).toEqual([{ confirmation_sent_for: compromisso().starts_at }]);
    const corpo = (mocks.enviar.mock.calls[0]?.[2] as { body: string }).body;
    expect(corpo).toContain("Ana");
    expect(corpo).toContain("amanhã");
    expect(corpo).toContain("10:00");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "agenda.sequencia_enviada" }));
  });

  it("⭐ reunião de segunda de manhã, número sem domingo: a confirmação sai no SÁBADO às 17h", async () => {
    vi.setSystemTime(local("2026-12-05T17:05:00"));
    mocks.compromissos = [
      compromisso({
        starts_at: local("2026-12-07T09:00:00").toISOString(),
        created_at: local("2026-12-02T10:00:00").toISOString(),
      }),
    ];
    const { data } = await (await GET(pedido())).json();
    expect(data).toMatchObject({ enviados: 1, passos: { confirmacao_vespera: 1 } });
    const corpo = (mocks.enviar.mock.calls[0]?.[2] as { body: string }).body;
    // Saiu dois dias antes: o texto diz o dia, não "amanhã".
    expect(corpo).not.toContain("amanhã");
    expect(corpo).toContain("segunda");
  });

  it("perdeu a troca do carimbo (outra rodada levou): não envia", async () => {
    mocks.reivindica = false;
    const { data } = await (await GET(pedido())).json();
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(data.motivos).toMatchObject({ ja_reivindicado: 1 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("já saiu para este horário: nada", async () => {
    mocks.compromissos = [compromisso({ confirmation_sent_for: compromisso().starts_at })];
    await GET(pedido());
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(mocks.atualizacoes).toHaveLength(0);
  });

  it("janela de 24 h fechada: sai o diálogo do uso, não o texto", async () => {
    mocks.remetente.mockResolvedValue({ canal: { id: "canal-1", provider: "chatguru" }, motivo: null, foraDaJanela: true, via: "roteiro" });
    await GET(pedido());
    expect(mocks.roteiro).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uso: "confirmacao_vespera", organizationId: ORG }));
    expect(mocks.enviar).not.toHaveBeenCalled();
    // O remetente foi pedido JÁ com o uso: é ele que deixa a conexão com diálogo servir.
    expect(mocks.remetente.mock.calls[0]?.[5]).toBe("confirmacao_vespera");
  });

  it("fora da janela de envio do número: não carimba (a próxima rodada tenta)", async () => {
    mocks.janelaAberta = false;
    const { data } = await (await GET(pedido())).json();
    expect(mocks.atualizacoes).toHaveLength(0);
    expect(data.motivos).toMatchObject({ fora_da_janela: 1 });
  });

  it("contato bloqueado (opt-out): nada", async () => {
    mocks.contato = { ...mocks.contato, is_blocked: true };
    await GET(pedido());
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(mocks.atualizacoes).toHaveLength(0);
  });

  it("organização parada: nada; e a suspensão no meio do envio vira pulado, não erro", async () => {
    mocks.compromissos = [compromisso({ organizations: { status: "suspended" } })];
    await GET(pedido());
    expect(mocks.abrirConversa).not.toHaveBeenCalled();

    mocks.compromissos = [compromisso()];
    mocks.enviar.mockRejectedValueOnce(new OrgNaoOperanteError(ORG, "suspended"));
    const { data } = await (await GET(pedido())).json();
    expect(data.motivos).toMatchObject({ org_nao_operante: 1 });
    expect(data.motivos.erro_no_envio).toBeUndefined();
  });

  it("aquecimento às 19h: o vídeo e as imagens da organização, nessa ordem", async () => {
    vi.setSystemTime(local("2026-12-07T19:05:00"));
    mocks.compromissos = [compromisso({ warmup_sent_at: null })];
    mocks.organizacao = {
      timezone: FUSO,
      locale: "pt-BR",
      settings: {
        midia_do_aquecimento: {
          video: { caminho: `${ORG}/video-1.mp4`, mime: "video/mp4", bytes: 1000 },
          imagens: [{ caminho: `${ORG}/imagem-1.png`, mime: "image/png", bytes: 100 }],
        },
      },
    };
    const { data } = await (await GET(pedido())).json();
    expect(data).toMatchObject({ enviados: 1, passos: { aquecimento: 1 } });
    expect(mocks.atualizacoes[0]).toHaveProperty("warmup_sent_at");
    const tipos = mocks.enviar.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(tipos).toEqual(["video", "image"]);
    // O remetente do aquecimento é pedido SEM uso de diálogo: vídeo não sai fora da janela.
    expect(mocks.remetente.mock.calls[0]?.[5]).toBeNull();
  });

  it("aquecimento para quem recusou marketing: não sai", async () => {
    vi.setSystemTime(local("2026-12-07T19:05:00"));
    mocks.compromissos = [compromisso({ warmup_sent_at: null })];
    mocks.contato = { ...mocks.contato, consent: { marketing: { declined_at: "2026-11-01T00:00:00Z" } } };
    mocks.organizacao = {
      timezone: FUSO,
      locale: "pt-BR",
      settings: { midia_do_aquecimento: { video: { caminho: `${ORG}/v.mp4`, mime: "video/mp4", bytes: 1 }, imagens: [] } },
    };
    const { data } = await (await GET(pedido())).json();
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(data.motivos).toMatchObject({ recusou_marketing: 1 });
  });
});

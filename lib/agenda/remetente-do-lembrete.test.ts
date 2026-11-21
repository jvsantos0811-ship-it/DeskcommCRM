import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNEL_PROVIDER,
  CHANNEL_PROVIDER_META,
  CHANNEL_PROVIDER_WACALLS,
} from "@/lib/channels/capabilities";
import { decidirRemetenteDoLembrete, type CanalDoLembrete } from "./remetente-do-lembrete";

const agora = new Date("2026-10-09T15:00:00Z");
const canal = (id: string, patch: Partial<CanalDoLembrete> = {}): CanalDoLembrete => ({
  id,
  provider: DEFAULT_CHANNEL_PROVIDER,
  status: "WORKING",
  archived_at: null,
  lastInboundAt: null,
  ...patch,
});
const clinica = canal("clinica");
const cursos = canal("cursos");
describe("remetente da reserva, sem depender da ordem do banco", () => {
  it.each([
    [clinica, cursos],
    [cursos, clinica],
  ])("canal indicado ganha com lista %j", (...canais) => {
    expect(decidirRemetenteDoLembrete(canais, "clinica", agora).canal?.id).toBe("clinica");
  });
  it("dois canais sem vínculo impedem envio", () => {
    expect(decidirRemetenteDoLembrete([cursos, clinica], null, agora)).toEqual({
      canal: null,
      motivo: "remetente_ambiguo",
    });
  });
  it.each([
    { status: "STOPPED" },
    { archived_at: "2026-10-01T00:00:00Z" },
    { metadata: { disabled: true } },
    { provider: CHANNEL_PROVIDER_WACALLS },
    { provider: "desconhecido" },
  ])("canal indicado indisponível %j nunca troca pelo outro", (patch) => {
    expect(decidirRemetenteDoLembrete([canal("clinica", patch), cursos], "clinica", agora)).toEqual(
      { canal: null, motivo: "canal_indicado_indisponivel" },
    );
  });
  it("canal indicado desaparecido nunca troca", () => {
    expect(decidirRemetenteDoLembrete([cursos], "clinica", agora).motivo).toBe(
      "canal_indicado_indisponivel",
    );
  });
  it("único automático elegível preserva organizações com um número", () => {
    expect(
      decidirRemetenteDoLembrete(
        [clinica, canal("voz", { provider: CHANNEL_PROVIDER_WACALLS })],
        null,
        agora,
      ).canal?.id,
    ).toBe("clinica");
  });
  it("janela fechada no indicado não autoriza canal de outro setor", () => {
    const fechado = canal("clinica", { provider: CHANNEL_PROVIDER_META });
    expect(decidirRemetenteDoLembrete([fechado, cursos], "clinica", agora).motivo).toBe(
      "canal_fora_da_janela_24h",
    );
    expect(decidirRemetenteDoLembrete([fechado, cursos], null, agora).canal?.id).toBe("cursos");
  });
  it("janela aberta e limite de 24h usam a régua nativa", () => {
    const aberto = canal("clinica", {
      provider: CHANNEL_PROVIDER_META,
      lastInboundAt: "2026-10-08T15:00:01Z",
    });
    expect(decidirRemetenteDoLembrete([aberto], "clinica", agora).canal?.id).toBe("clinica");
    expect(
      decidirRemetenteDoLembrete(
        [{ ...aberto, lastInboundAt: "2026-10-08T15:00:00Z" }],
        "clinica",
        agora,
      ).motivo,
    ).toBe("canal_fora_da_janela_24h");
  });
  it("zero canais falha de maneira explícita", () => {
    expect(decidirRemetenteDoLembrete([], null, agora).motivo).toBe("sem_canal");
  });
});

describe("PC-045 — fora da janela com modelo da Meta", () => {
  const oficial = canal("oficial", { provider: CHANNEL_PROVIDER_META });

  it("sem modelo, o canal oficial fora da janela continua recusado (comportamento de sempre)", () => {
    expect(decidirRemetenteDoLembrete([oficial], null, agora)).toEqual({
      canal: null,
      motivo: "canal_fora_da_janela_24h",
    });
  });

  it("com modelo, o canal oficial serve e sai marcado fora da janela", () => {
    const r = decidirRemetenteDoLembrete([oficial], null, agora, true);
    expect(r.canal?.id).toBe("oficial");
    expect(r.motivo).toBeNull();
    expect("foraDaJanela" in r && r.foraDaJanela).toBe(true);
  });

  it("dentro da janela não muda nada: texto livre, sem marca", () => {
    const aberto = canal("oficial", {
      provider: CHANNEL_PROVIDER_META,
      lastInboundAt: new Date(agora.getTime() - 60 * 60_000).toISOString(),
    });
    const r = decidirRemetenteDoLembrete([aberto], null, agora, true);
    expect(r.canal?.id).toBe("oficial");
    expect("foraDaJanela" in r ? r.foraDaJanela : undefined).toBeUndefined();
  });

  it("indicado fora da janela não libera outro número", () => {
    const outro = canal("outro", { provider: CHANNEL_PROVIDER_META });
    const parado = canal("parado", { provider: CHANNEL_PROVIDER_META, status: "STOPPED" });
    expect(decidirRemetenteDoLembrete([parado, outro], "parado", agora, true).canal).toBeNull();
  });

  it("dois oficiais fora da janela no automático é ambíguo", () => {
    const b = canal("b", { provider: CHANNEL_PROVIDER_META });
    expect(decidirRemetenteDoLembrete([oficial, b], null, agora, true)).toEqual({
      canal: null,
      motivo: "remetente_ambiguo",
    });
  });
});

import { valoresDoModeloDoLembrete } from "@/app/api/v1/cron/agenda-reminder/route";

describe("PC-045 — valores do modelo do lembrete", () => {
  it("primeiro nome, dia, hora e local no fuso da organização", () => {
    const v = valoresDoModeloDoLembrete({
      nomeDoContato: "Maria da Silva",
      quando: new Date("2026-11-24T17:30:00Z"),
      timezone: "America/Sao_Paulo",
      local: "Rua A, 10",
    });
    expect(v["1"]).toBe("Maria");
    expect(v["3"]).toBe("14:30");
    expect(v["2"]).toContain("24/11");
    expect(v["4"]).toBe("Rua A, 10");
  });

  it("quebra de linha e espaços viram um espaço só (a Meta recusa, erro 132018)", () => {
    const v = valoresDoModeloDoLembrete({
      nomeDoContato: "  Maria\n da Silva",
      quando: new Date("2026-11-24T17:30:00Z"),
      timezone: "America/Sao_Paulo",
      local: "Rua A, 10\n\tSala     3",
    });
    expect(v["1"]).toBe("Maria");
    expect(v["4"]).toBe("Rua A, 10 Sala 3");
  });

  it("nada vazio: a Meta recusa variável vazia", () => {
    const v = valoresDoModeloDoLembrete({
      nomeDoContato: null,
      quando: new Date("2026-11-24T17:30:00Z"),
      timezone: "America/Sao_Paulo",
      local: null,
    });
    expect(Object.values(v).every((x) => x.length > 0)).toBe(true);
  });
});

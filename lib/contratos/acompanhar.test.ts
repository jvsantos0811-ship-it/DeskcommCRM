/**
 * ACOMPANHAR A ASSINATURA (PC-030, item 5) — o que cada situação do serviço
 * faz com o contrato, sem banco e sem rede: o cliente admin é um registrador, e
 * o caminho de ganho, a linha do tempo e o caso são espiões.
 *
 * O que se mede:
 *  - ⭐ assinado: status, via assinada guardada no card, ganho pelo caminho de
 *    sempre (`confirmarAssinatura`, origem `provedor`) e o caso "Conferir
 *    processo e advogado pelo CPF antes de dar entrada";
 *  - ⭐ o mesmo aviso repetido não faz nada (estado final não volta);
 *  - visualizado grava só a data; recusado guarda o motivo do cliente e abre
 *    caso; expirado abre caso; nenhum dos dois reenvia;
 *  - o PDF que falha ao baixar não impede o contrato de ficar assinado;
 *  - o negócio que não fecha sozinho (trava de ganho) não derruba o resto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

const confirmarAssinatura = vi.fn(async (..._a: unknown[]) => ({}));
const emitLeadActivity = vi.fn(async (..._a: unknown[]) => undefined);
const abrirCasoDoContrato = vi.fn(async (..._a: unknown[]) => undefined);
const audit = vi.fn((..._a: unknown[]) => undefined);

vi.mock("@/lib/leads/assinatura-confirmada", () => ({ confirmarAssinatura: (...a: unknown[]) => confirmarAssinatura(...a) }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: (...a: unknown[]) => emitLeadActivity(...a) }));
vi.mock("@/lib/contratos/caso-do-contrato", () => ({ abrirCasoDoContrato: (...a: unknown[]) => abrirCasoDoContrato(...a) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/propostas/data-no-fuso", () => ({
  fusoDaOrganizacao: async () => "America/Sao_Paulo",
  dataIsoNoFuso: (d: Date) => d.toISOString().slice(0, 10),
}));

import { aplicarSituacao, CASO_CONFERIR_PELO_CPF } from "./acompanhar";
import type { ServicoDeAssinatura, SituacaoNoServico } from "./assinatura/servico";
import type { LinhaDoContrato } from "./servidor";

const ORG = "11111111-1111-4111-8111-111111111111";

interface Registro {
  updates: Array<Record<string, unknown>>;
  uploads: Array<{ bucket: string; caminho: string }>;
}

function fakeAdmin(r: Registro, uploadFalha = false): SupabaseClient {
  const update = (patch: Record<string, unknown>) => {
    r.updates.push(patch);
    const filtro = { eq: () => filtro, then: (ok: (v: { error: null }) => void) => ok({ error: null }) };
    return filtro;
  };
  return {
    from: (tabela: string) => {
      if (tabela !== "crm_contracts") throw new Error(`tabela inesperada: ${tabela}`);
      return { update };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (caminho: string) => {
          r.uploads.push({ bucket, caminho });
          return { error: uploadFalha ? { message: "falhou" } : null };
        },
      }),
    },
  } as unknown as SupabaseClient;
}

function contrato(campos: Partial<LinhaDoContrato> = {}): LinhaDoContrato {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    organization_id: ORG,
    lead_id: "33333333-3333-4333-8333-333333333333",
    contact_id: "44444444-4444-4444-8444-444444444444",
    conversation_id: "55555555-5555-4555-8555-555555555555",
    titulo: "Contrato BPC/LOAS",
    arquivo_path: `${ORG}/22222222-2222-4222-8222-222222222222.pdf`,
    arquivo_nome: "contrato.pdf",
    arquivo_bytes: 1000,
    status: "enviado",
    provedor_assinatura: "zapsign",
    provedor_documento_id: "doc-123",
    link_assinatura: "https://exemplo.invalid/assinar",
    assinado_path: null,
    message_id: null,
    ultima_falha_envio: null,
    motivo: null,
    enviado_em: "2026-11-10T12:00:00Z",
    enviado_por_user_id: null,
    decidido_em: null,
    decidido_por_user_id: null,
    created_at: "2026-11-10T11:00:00Z",
    visualizado_em: null,
    modelo_id: null,
    modelo_versao: null,
    origem_envio: "pessoa",
    ...campos,
  };
}

function situacao(campos: Partial<SituacaoNoServico>): SituacaoNoServico {
  return { estado: "enviado", visualizadoEm: null, assinadoEm: null, motivoRecusa: null, arquivoAssinadoUrl: null, ...campos };
}

function servico(baixar: () => Promise<Buffer> = async () => Buffer.from("%PDF-1.7 assinado")): ServicoDeAssinatura {
  return {
    id: "zapsign",
    testarConexao: vi.fn(),
    criarPedido: vi.fn(),
    consultar: vi.fn(),
    cancelar: vi.fn(),
    baixarAssinado: vi.fn(baixar),
    registrarAviso: vi.fn(),
    removerAviso: vi.fn(),
  } as unknown as ServicoDeAssinatura;
}

let reg: Registro;
beforeEach(() => {
  reg = { updates: [], uploads: [] };
  confirmarAssinatura.mockReset();
  confirmarAssinatura.mockImplementation(async () => ({}));
  emitLeadActivity.mockClear();
  abrirCasoDoContrato.mockClear();
  audit.mockClear();
});

describe("aplicarSituacao", () => {
  it("⭐ assinado: guarda a via assinada, ganha pelo caminho de sempre e abre o caso de conferir pelo CPF", async () => {
    const r = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato(),
      situacao: situacao({
        estado: "assinado",
        assinadoEm: "2026-11-11T15:00:00Z",
        visualizadoEm: "2026-11-11T14:00:00Z",
        arquivoAssinadoUrl: "https://arquivos.exemplo.invalid/assinado.pdf",
      }),
      servico: servico(),
      requestId: "req-1",
    });
    expect(r).toEqual({ aplicado: true, estado: "assinado" });
    expect(reg.uploads).toEqual([{ bucket: "contratos", caminho: `${ORG}/22222222-2222-4222-8222-222222222222-assinado.pdf` }]);
    expect(reg.updates).toHaveLength(1);
    expect(reg.updates[0]).toMatchObject({
      status: "assinado",
      decidido_em: "2026-11-11T15:00:00Z",
      assinado_path: `${ORG}/22222222-2222-4222-8222-222222222222-assinado.pdf`,
      visualizado_em: "2026-11-11T14:00:00Z",
    });
    expect(confirmarAssinatura).toHaveBeenCalledTimes(1);
    expect(confirmarAssinatura.mock.calls[0]![2]).toMatchObject({
      leadId: "33333333-3333-4333-8333-333333333333",
      dataAssinatura: "2026-11-11",
      origem: "provedor",
      provedor: "zapsign",
      documentoId: "doc-123",
    });
    expect(abrirCasoDoContrato).toHaveBeenCalledTimes(1);
    expect(abrirCasoDoContrato.mock.calls[0]![1]).toMatchObject({ titulo: CASO_CONFERIR_PELO_CPF });
    expect(audit.mock.calls[0]![0]).toMatchObject({ action: "contract.signature_status_changed", metadata: { estado: "assinado" } });
  });

  it("⭐ o mesmo aviso de novo (contrato já assinado) não faz nada", async () => {
    const r = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato({ status: "assinado", decidido_em: "2026-11-11T15:00:00Z" }),
      situacao: situacao({ estado: "assinado", arquivoAssinadoUrl: "https://arquivos.exemplo.invalid/assinado.pdf" }),
      servico: servico(),
      requestId: "req-2",
    });
    expect(r).toEqual({ aplicado: false, motivo: "ja_encerrado" });
    expect(reg.updates).toEqual([]);
    expect(reg.uploads).toEqual([]);
    expect(confirmarAssinatura).not.toHaveBeenCalled();
    expect(abrirCasoDoContrato).not.toHaveBeenCalled();
  });

  it("o PDF que não baixa não impede o contrato de ficar assinado (fica para a próxima consulta)", async () => {
    const r = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato(),
      situacao: situacao({ estado: "assinado", arquivoAssinadoUrl: "https://arquivos.exemplo.invalid/assinado.pdf" }),
      servico: servico(async () => {
        throw new Error("rede");
      }),
      requestId: "req-3",
    });
    expect(r).toEqual({ aplicado: true, estado: "assinado" });
    expect(reg.updates[0]).toMatchObject({ status: "assinado" });
    expect(reg.updates[0]).not.toHaveProperty("assinado_path");
    expect(abrirCasoDoContrato).toHaveBeenCalledTimes(1);
  });

  it("o negócio que não fecha sozinho (trava de ganho) não derruba o contrato nem o caso", async () => {
    confirmarAssinatura.mockRejectedValueOnce(new Error("campo obrigatório no ganho"));
    const r = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato(),
      situacao: situacao({ estado: "assinado" }),
      servico: servico(),
      requestId: "req-4",
    });
    expect(r).toEqual({ aplicado: true, estado: "assinado" });
    expect(abrirCasoDoContrato).toHaveBeenCalledTimes(1);
  });

  it("visualizado: grava só a data em que o cliente abriu; o status não muda; repetido não grava de novo", async () => {
    const r = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato(),
      situacao: situacao({ estado: "visualizado", visualizadoEm: "2026-11-10T13:00:00Z" }),
      servico: servico(),
      requestId: "req-5",
    });
    expect(r).toEqual({ aplicado: true, estado: "visualizado" });
    expect(reg.updates).toEqual([{ visualizado_em: "2026-11-10T13:00:00Z" }]);
    expect(emitLeadActivity).toHaveBeenCalledTimes(1);

    const de_novo = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato({ visualizado_em: "2026-11-10T13:00:00Z" }),
      situacao: situacao({ estado: "visualizado", visualizadoEm: "2026-11-10T13:00:00Z" }),
      servico: servico(),
      requestId: "req-6",
    });
    expect(de_novo).toEqual({ aplicado: false, motivo: "sem_mudanca" });
    expect(reg.updates).toHaveLength(1);
  });

  it("recusado: guarda o motivo do cliente e abre caso para a equipe; nada é reenviado", async () => {
    const s = servico();
    const r = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato(),
      situacao: situacao({ estado: "recusado", motivoRecusa: "Quero falar com a advogada antes" }),
      servico: s,
      requestId: "req-7",
    });
    expect(r).toEqual({ aplicado: true, estado: "recusado" });
    expect(reg.updates[0]).toMatchObject({ status: "recusado", motivo: "Quero falar com a advogada antes" });
    expect(abrirCasoDoContrato.mock.calls[0]![1]).toMatchObject({ titulo: "Cliente recusou o contrato" });
    expect(s.criarPedido).not.toHaveBeenCalled();
    expect(confirmarAssinatura).not.toHaveBeenCalled();
  });

  it("expirado: o prazo venceu — contrato expirado e caso para a equipe", async () => {
    const r = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato(),
      situacao: situacao({ estado: "expirado" }),
      servico: servico(),
      requestId: "req-8",
    });
    expect(r).toEqual({ aplicado: true, estado: "expirado" });
    expect(reg.updates[0]).toMatchObject({ status: "expirado" });
    expect(abrirCasoDoContrato.mock.calls[0]![1]).toMatchObject({ titulo: "Prazo do contrato venceu sem assinatura" });
  });

  it("cancelado no serviço: o contrato fica cancelado, sem caso", async () => {
    const r = await aplicarSituacao(fakeAdmin(reg), {
      orgId: ORG,
      contrato: contrato(),
      situacao: situacao({ estado: "cancelado" }),
      servico: servico(),
      requestId: "req-9",
    });
    expect(r).toEqual({ aplicado: true, estado: "cancelado" });
    expect(reg.updates[0]).toMatchObject({ status: "cancelado" });
    expect(abrirCasoDoContrato).not.toHaveBeenCalled();
  });
});

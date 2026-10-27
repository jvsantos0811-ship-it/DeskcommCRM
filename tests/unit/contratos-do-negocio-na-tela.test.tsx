/**
 * A SEÇÃO "CONTRATOS" DO CARD, PELA TELA (fork, migration 9008).
 *
 * Monta o componente REAL com o hook de dados substituído — o caminho pelo
 * servidor está em `tests/e2e/contratos-do-negocio.spec.ts`. Aqui fica o que a
 * tela decide sozinha:
 *
 *   1. ⭐ a entrega vem da MENSAGEM: "na fila" quando o WhatsApp está fora, e a
 *      falha com o motivo e o pedido de reenviar;
 *   2. ⭐ o motivo de um envio que não saiu fica escrito no contrato;
 *   3. o rascunho oferece "Enviar ao cliente"; o enviado, assinar/recusar e
 *      enviar de novo; o encerrado, nada;
 *   4. ⭐ quem só lê não vê botão nenhum;
 *   5. confirmar o envio manda a mensagem que a pessoa deixou na caixa;
 *   6. arquivo que não é PDF é recusado antes de subir.
 */
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { ContratoDoNegocio } from "@/lib/contratos/tipos";

const enviar = vi.fn(async () => ({}));
const decidir = vi.fn(async () => ({}));
const anexar = vi.fn(async () => ({}));
let contratos: ContratoDoNegocio[] = [];

vi.mock("@/hooks/kanban/useContratosDoLead", () => ({
  useContratosDoLead: () => ({
    lista: { data: contratos, isLoading: false, isError: false },
    anexar: { mutateAsync: anexar, isPending: false },
    enviar: { mutateAsync: enviar, isPending: false },
    decidir: { mutateAsync: decidir, isPending: false },
  }),
}));

import { ContratosDoNegocio } from "@/components/kanban/ContratosDoNegocio";

function contrato(campos: Partial<ContratoDoNegocio>): ContratoDoNegocio {
  return {
    id: "c1",
    lead_id: "l1",
    titulo: "Contrato de honorários",
    status: "rascunho",
    arquivo_nome: "contrato.pdf",
    arquivo_bytes: 1000,
    tem_arquivo: true,
    tem_assinado: false,
    provedor_assinatura: "manual",
    desfecho_por_pessoa: true,
    link_assinatura: null,
    enviado_em: null,
    decidido_em: null,
    motivo: null,
    ultima_falha_envio: null,
    created_at: "2026-10-27T12:00:00Z",
    entrega: null,
    ...campos,
  };
}

function montar(podeEditar = true) {
  render(<ContratosDoNegocio leadId="l1" podeEditar={podeEditar} aberto />);
  return screen.getByTestId("contratos-do-negocio");
}

beforeEach(() => {
  enviar.mockClear();
  decidir.mockClear();
  anexar.mockClear();
  contratos = [];
});

describe("Contratos no card do negócio", () => {
  it("vazio: diz o que fazer, e só quem pode agir vê o botão de anexar", () => {
    const secao = montar();
    expect(secao).toHaveTextContent("Nenhum contrato neste negócio.");
    expect(within(secao).getByRole("button", { name: "Anexar contrato" })).toBeInTheDocument();
  });

  it("⭐ enviado com o WhatsApp fora do ar: a tela diz que está na fila", () => {
    contratos = [contrato({ status: "enviado", enviado_em: "2026-10-27T12:05:00Z", entrega: { status: "queued", erro: null } })];
    const secao = montar();
    expect(secao).toHaveTextContent("Aguardando assinatura");
    expect(secao).toHaveTextContent("Na fila: sai assim que a conexão do WhatsApp voltar.");
    expect(within(secao).getByRole("button", { name: "Marcar como assinado" })).toBeInTheDocument();
    expect(within(secao).getByRole("button", { name: "Marcar como recusado" })).toBeInTheDocument();
    expect(within(secao).getByRole("button", { name: "Enviar de novo" })).toBeInTheDocument();
  });

  it("⭐ a mensagem falhou depois: o motivo aparece e a tela pede para enviar de novo", () => {
    contratos = [contrato({ status: "enviado", entrega: { status: "failed", erro: "Número inexistente" } })];
    expect(montar()).toHaveTextContent("O WhatsApp não entregou: Número inexistente. Envie de novo.");
  });

  it("⭐ o envio que não saiu deixa o motivo escrito no contrato, que segue em rascunho", () => {
    contratos = [contrato({ ultima_falha_envio: "Este canal está desativado." })];
    const secao = montar();
    expect(secao).toHaveTextContent("O último envio não saiu: Este canal está desativado.");
    expect(within(secao).getByRole("button", { name: "Enviar ao cliente" })).toBeInTheDocument();
  });

  it("encerrado não tem botão, e o recusado mostra o motivo", () => {
    contratos = [contrato({ status: "recusado", decidido_em: "2026-10-27T13:00:00Z", motivo: "Vai pensar" })];
    const secao = montar();
    expect(secao).toHaveTextContent("Recusado");
    expect(secao).toHaveTextContent("Motivo: Vai pensar");
    expect(within(secao.querySelector("li")!).queryAllByRole("button")).toHaveLength(0);
  });

  it("⭐ quem só lê vê o contrato e o PDF, mas nenhum botão", () => {
    contratos = [contrato({ status: "enviado", entrega: { status: "read", erro: null } })];
    const secao = montar(false);
    expect(secao).toHaveTextContent("Lido pelo cliente.");
    expect(within(secao).getByRole("link", { name: "Abrir PDF" })).toHaveAttribute("href", "/api/v1/contracts/c1/arquivo");
    expect(within(secao).queryAllByRole("button")).toHaveLength(0);
  });

  it("confirmar o envio manda a mensagem que a pessoa deixou na caixa", async () => {
    contratos = [contrato({})];
    const secao = montar();
    fireEvent.click(within(secao).getByRole("button", { name: "Enviar ao cliente" }));
    const caixa = within(secao).getByLabelText("Mensagem que vai junto com o arquivo (opcional)");
    expect(caixa).toHaveValue("Segue o contrato para sua assinatura. Qualquer dúvida, é só me chamar.");
    fireEvent.change(caixa, { target: { value: "Dra. Ana: segue o contrato." } });
    fireEvent.click(within(secao).getByRole("button", { name: "Enviar pelo WhatsApp" }));
    await vi.waitFor(() => expect(enviar).toHaveBeenCalledWith({ contratoId: "c1", mensagem: "Dra. Ana: segue o contrato." }));
  });

  it("arquivo que não é PDF é recusado antes de subir", () => {
    const secao = montar();
    fireEvent.click(within(secao).getByRole("button", { name: "Anexar contrato" }));
    const campo = within(secao).getByLabelText("Arquivo do contrato (PDF, até 20 MB)");
    fireEvent.change(campo, { target: { files: [new File(["oi"], "contrato.docx", { type: "application/msword" })] } });
    expect(secao).toHaveTextContent("O contrato precisa ser um arquivo PDF.");
    expect(within(secao).getByRole("button", { name: "Anexar" })).toBeDisabled();
    expect(anexar).not.toHaveBeenCalled();
  });
});

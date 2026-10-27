/**
 * O contrato do negócio como a TELA o recebe (fork, migration 9008).
 *
 * Sem caminho de Storage: a tela abre o arquivo pela rota
 * `/api/v1/contracts/<id>/arquivo`, que confere a organização e assina a URL.
 * O status de entrega vem da MENSAGEM do envio, lido a cada leitura — nunca
 * copiado para a linha do contrato (DIRC: calcular).
 */
import type { ProvedorDeAssinaturaId, StatusDoContrato } from "@/lib/contratos/vocabulario";

/** Os estados de `messages.status` que importam para quem enviou. */
export type EntregaDoContrato = "queued" | "sending" | "sent" | "delivered" | "read" | "failed";

export interface ContratoDoNegocio {
  id: string;
  lead_id: string | null;
  titulo: string;
  status: StatusDoContrato;
  arquivo_nome: string | null;
  arquivo_bytes: number | null;
  tem_arquivo: boolean;
  tem_assinado: boolean;
  provedor_assinatura: ProvedorDeAssinaturaId;
  /** `true`: uma pessoa marca assinado/recusado. `false`: chega pelo serviço de assinatura. */
  desfecho_por_pessoa: boolean;
  link_assinatura: string | null;
  enviado_em: string | null;
  decidido_em: string | null;
  motivo: string | null;
  ultima_falha_envio: string | null;
  created_at: string;
  entrega: { status: EntregaDoContrato; erro: string | null } | null;
}

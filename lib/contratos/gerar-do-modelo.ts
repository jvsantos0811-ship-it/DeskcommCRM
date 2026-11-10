/**
 * GERAR O CONTRATO PELO MODELO (PC-030, itens 2 e 3) — o serviço com banco.
 *
 * Lê o negócio (campos e status), escolhe o modelo do interesse do negócio (ou
 * o pedido pelo id), confere a aprovação do advogado, preenche, gera o PDF,
 * guarda no bucket de contratos e cria o contrato do negócio em `rascunho` — o
 * mesmo contrato que uma pessoa anexaria à mão, agora com o modelo e a versão
 * que o geraram. Quem envia é outro passo (`POST /contracts/:id/send`, ou a
 * ferramenta da IA).
 *
 * Nunca gera com dado faltando: a resposta lista o que perguntar, com o rótulo
 * de cada campo do funil. Nunca lança por regra de negócio; só por banco fora.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { BUCKET_DOS_CONTRATOS, caminhoDoOriginal } from "@/lib/contratos/arquivo";
import { lerLinhaDaConta } from "@/lib/contratos/assinatura/conta";
import { pdfDoContrato } from "@/lib/contratos/pdf-do-contrato";
import { COLUNAS_DO_CONTRATO, type LinhaDoContrato } from "@/lib/contratos/servidor";
import { ehProvedorEletronico, type ProvedorDeAssinaturaId } from "@/lib/contratos/vocabulario";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { statusDosCampos } from "@/lib/leads/status-dos-campos";
import { logger } from "@/lib/logger";
import { dataIsoNoFuso, fusoDaOrganizacao } from "@/lib/propostas/data-no-fuso";

import { fraseDaFalta, preencherContrato, VARIAVEIS_DO_SISTEMA, type FaltaNoContrato } from "./modelo-do-contrato";

export interface LinhaDoModelo {
  id: string;
  nome: string;
  interesse: string | null;
  corpo: string;
  campos_obrigatorios: string[];
  versao: number;
  aprovado_em: string | null;
  aprovado_por_nome: string | null;
  ativo: boolean;
}

export const COLUNAS_DO_MODELO =
  "id, nome, interesse, corpo, campos_obrigatorios, versao, aprovado_em, aprovado_por_nome, ativo";

export interface FaltaComRotulo extends FaltaNoContrato {
  rotulo: string;
  frase: string;
}

export type ResultadoDaGeracao =
  | { ok: true; contrato: LinhaDoContrato; modelo: LinhaDoModelo; cpf: string | null }
  | { ok: false; codigo: "negocio_nao_encontrado" | "sem_modelo" | "modelo_sem_aprovacao"; mensagem: string }
  | { ok: false; codigo: "faltam_dados"; mensagem: string; faltas: FaltaComRotulo[] };

const normal = (s: unknown) =>
  typeof s === "string" ? s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase() : "";

/** O modelo do interesse do negócio; sem um específico, o que vale para qualquer interesse. Pura. */
export function modeloDoInteresse(modelos: readonly LinhaDoModelo[], interesse: unknown): LinhaDoModelo | null {
  const ativos = modelos.filter((m) => m.ativo);
  const alvo = normal(interesse);
  return (
    (alvo ? ativos.find((m) => m.interesse && normal(m.interesse) === alvo) : undefined) ??
    ativos.find((m) => !m.interesse) ??
    null
  );
}

/** O serviço que colhe a assinatura nesta organização: o eletrônico ligado, ou o manual. */
export async function provedorDaOrganizacao(admin: SupabaseClient, orgId: string): Promise<ProvedorDeAssinaturaId> {
  const conta = await lerLinhaDaConta(admin, orgId).catch(() => null);
  return conta && conta.ativo && conta.chave_encrypted && ehProvedorEletronico(conta.provedor) ? conta.provedor : "manual";
}

export async function gerarContratoDoModelo(
  admin: SupabaseClient,
  a: { orgId: string; leadId: string; modeloId?: string | null; origem: "pessoa" | "ia"; actor: Actor; userId: string | null },
): Promise<ResultadoDaGeracao> {
  const { data: leadData } = await admin
    .from("crm_leads")
    .select("id, contact_id, pipeline_id, custom_fields, status_dos_campos")
    .eq("organization_id", a.orgId)
    .eq("id", a.leadId)
    .maybeSingle();
  const lead = leadData as {
    id: string;
    contact_id: string | null;
    pipeline_id: string;
    custom_fields: Record<string, unknown> | null;
    status_dos_campos: unknown;
  } | null;
  if (!lead) return { ok: false, codigo: "negocio_nao_encontrado", mensagem: "Negócio não encontrado." };
  const campos = lead.custom_fields ?? {};

  let consulta = admin.from("contrato_modelos").select(COLUNAS_DO_MODELO).eq("organization_id", a.orgId);
  if (a.modeloId) consulta = consulta.eq("id", a.modeloId);
  const { data: modelosData } = await consulta;
  const modelos = (modelosData ?? []) as LinhaDoModelo[];
  const modelo = a.modeloId ? (modelos.find((m) => m.ativo) ?? null) : modeloDoInteresse(modelos, campos.servico);
  if (!modelo) {
    return { ok: false, codigo: "sem_modelo", mensagem: "Não há modelo de contrato ativo para este interesse." };
  }
  if (!modelo.aprovado_em) {
    return {
      ok: false,
      codigo: "modelo_sem_aprovacao",
      mensagem: "O modelo de contrato ainda não foi aprovado pelo advogado.",
    };
  }

  const [{ data: contato }, { data: organizacao }, { data: funil }, fuso] = await Promise.all([
    lead.contact_id
      ? admin
          .from("contacts")
          .select("display_name, name, phone_number")
          .eq("organization_id", a.orgId)
          .eq("id", lead.contact_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("organizations").select("display_name, legal_name").eq("id", a.orgId).maybeSingle(),
    admin.from("crm_pipelines").select("settings").eq("organization_id", a.orgId).eq("id", lead.pipeline_id).maybeSingle(),
    fusoDaOrganizacao(admin, a.orgId),
  ]);
  const c = contato as { display_name?: string | null; name?: string | null; phone_number?: string | null } | null;
  const dadosDaOrganizacao = organizacao as { display_name?: string | null; legal_name?: string | null } | null;
  const hojeIso = dataIsoNoFuso(new Date(), fuso);

  const preenchido = preencherContrato(modelo, {
    contato: { nome: nomeDoContato(c), telefone: c?.phone_number ?? null },
    campos,
    status: statusDosCampos(lead.status_dos_campos),
    hoje: hojeIso.split("-").reverse().join("/"),
    escritorio: dadosDaOrganizacao?.legal_name ?? dadosDaOrganizacao?.display_name ?? "",
  });
  if (!preenchido.ok) {
    const rotulos = new Map(
      camposDoFunil((funil as { settings?: Record<string, unknown> } | null)?.settings).map((f) => [f.key, f.label]),
    );
    const faltas = preenchido.faltas.map((f) => {
      const rotulo =
        rotulos.get(f.campo) ?? (VARIAVEIS_DO_SISTEMA as Record<string, string>)[f.campo] ?? f.campo.replace(/_/g, " ");
      return { ...f, rotulo, frase: fraseDaFalta(f, rotulo) };
    });
    return { ok: false, codigo: "faltam_dados", mensagem: "Faltam dados para gerar o contrato.", faltas };
  }

  const pdf = await pdfDoContrato({
    titulo: modelo.nome,
    texto: preenchido.texto,
    origem: `${modelo.nome} · versão ${modelo.versao} · gerado em ${hojeIso.split("-").reverse().join("/")}`,
  });

  const contratoId = randomUUID();
  const caminho = caminhoDoOriginal(a.orgId, contratoId);
  const { error: upErr } = await admin.storage
    .from(BUCKET_DOS_CONTRATOS)
    .upload(caminho, pdf, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new Error(`contrato do modelo: upload: ${upErr.message}`);

  const provedor = await provedorDaOrganizacao(admin, a.orgId);
  const nomeDoArquivo = `${modelo.nome}.pdf`.slice(0, 200);
  const { data: criado, error: insErr } = await admin
    .from("crm_contracts")
    .insert({
      id: contratoId,
      organization_id: a.orgId,
      lead_id: lead.id,
      contact_id: lead.contact_id,
      titulo: modelo.nome.slice(0, 120),
      arquivo_path: caminho,
      arquivo_nome: nomeDoArquivo,
      arquivo_bytes: pdf.length,
      provedor_assinatura: provedor,
      modelo_id: modelo.id,
      modelo_versao: modelo.versao,
      origem_envio: a.origem,
      criado_por_user_id: a.userId,
    })
    .select(COLUNAS_DO_CONTRATO)
    .single();
  if (insErr || !criado) {
    await admin.storage.from(BUCKET_DOS_CONTRATOS).remove([caminho]);
    throw new Error(`contrato do modelo: insert: ${insErr?.message ?? "sem linha"}`);
  }

  const atividade = await emitLeadActivity(admin, {
    organizationId: a.orgId,
    leadId: lead.id,
    contactId: lead.contact_id,
    type: "contract_uploaded",
    sourceModule: "contracts",
    sourceId: contratoId,
    actor: a.actor,
    reason: `Contrato gerado pelo modelo "${modelo.nome}" (versão ${modelo.versao})`,
  });
  if (!atividade.ok) {
    logger.warn("contracts.modelo_atividade_falhou", { organizationId: a.orgId, contratoId });
  }
  return { ok: true, contrato: criado as unknown as LinhaDoContrato, modelo, cpf: preenchido.cpf };
}

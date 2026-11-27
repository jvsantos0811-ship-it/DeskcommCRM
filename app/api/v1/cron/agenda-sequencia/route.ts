/**
 * A SEQUÊNCIA DEPOIS DE MARCAR (PC-052 parte 3) — o aquecimento e a confirmação
 * em hora fixa. A conta de QUANDO mora em `lib/agenda/sequencia.ts`; esta rota
 * escolhe o remetente, carimba e envia.
 *
 * ═══ O QUE ESTA ROTA DECIDE, E POR QUÊ ═══
 *
 * **Nasce desligada.** Só tipo de atendimento com
 * `post_booking_sequence_enabled = true` entra na varredura, e cada passo tem a
 * sua chave dentro da configuração. Mandar mensagem a cliente é irreversível.
 *
 * **Um passo por compromisso por rodada.** O aquecimento (vídeo e imagens) vai
 * antes; a confirmação, se também estiver aberta, sai na rodada seguinte. Rajada
 * de mensagens para o mesmo número é o que faz o número ser denunciado.
 *
 * **O reforço (PC-064) é a 2ª pergunta, e só para quem não confirmou.** Sai no
 * dia da reunião (de manhã numa janela curta, ou a partir de uma hora da manhã
 * para reunião à tarde), uma vez por horário (`confirmation_retry_sent_for`),
 * nunca a menos de uma hora da 1ª. Não sai se a presença está `confirmada` ou
 * `nao_vai`, nem se o cliente mandou QUALQUER mensagem depois da 1ª — aí a
 * conversa está viva e quem cuida é a IA ou a equipe. A 1ª passa a gravar quando
 * saiu (`confirmation_sent_at`), que é o piso dessas duas contas.
 *
 * **O carimbo vai ANTES do envio, e é uma troca condicional.** A mesma régua do
 * lembrete (#2223): envio em dobro é pior que não-envio. O aquecimento só é
 * reivindicado se `warmup_sent_at` ainda é nulo; a confirmação, se o
 * `confirmation_sent_for` é o mesmo que esta rodada leu E o `starts_at` não
 * mudou. Duas rodadas ao mesmo tempo: só uma ganha a troca. Se o carimbo não
 * grava, a rodada não envia.
 *
 * **Para sozinha quando o compromisso mudou.** Só compromisso `confirmed`, com
 * presença diferente de "não vai" (PC-052 parte 2). Cancelado ou remarcado sai da
 * varredura ou muda a conta: a confirmação guarda o HORÁRIO para o qual saiu, e a
 * remarcação para outro horário arma a do horário novo.
 *
 * **Quem não recebe:** contato bloqueado (é onde o opt-out mora) ou sem telefone.
 * O aquecimento também não sai para quem recusou mensagem de marketing
 * (`consent.marketing.declined_at`): vídeo de apresentação não é aviso do
 * compromisso. A confirmação sai — é transacional, como o lembrete.
 *
 * **Janela de envio e janela de 24 h.** Fora da janela de envio do canal (ex.:
 * 8h–20h de segunda a sábado), a rodada não carimba e a próxima tenta de novo,
 * até o passo vencer (`ocasiaoAberta`). Fora da janela de 24 h do cliente, texto
 * livre não sai: a confirmação só sai pela conexão que tem DIÁLOGO escolhido
 * para aquele uso (`lib/channels/roteiro-fora-da-janela.ts`); o aquecimento não
 * sai (vídeo é mensagem livre).
 *
 * ⚠️ **organization_id SEMPRE da linha do compromisso** — contato, conversa e
 * canal são lidos dentro dela, como no lembrete.
 *
 * Rodada que não fez nada não audita (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { janelaDeEnvioAberta } from "@/lib/agent-engine/pacing/engine";
import { BUCKET_DA_MIDIA_DA_AGENDA, lerMidiaDoAquecimento } from "@/lib/agenda/midia-do-aquecimento";
import { resolverRemetenteDoLembrete } from "@/lib/agenda/remetente-do-lembrete";
import {
  aplicarTextoDaSequencia,
  lerSequencia,
  passoAberto,
  pecasDaSequencia,
  quandoSaiuAPrimeira,
  textoPadraoDaVespera,
  textoPadraoDoDia,
  textoPadraoDoReforco,
} from "@/lib/agenda/sequencia";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { espacarEnvio } from "@/lib/automation/throttle";
import { enviarRoteiroForaDaJanela } from "@/lib/channels/roteiro-fora-da-janela";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import {
  OrgNaoOperanteError,
  STATUS_OPERANTE,
  ehOperante,
  statusDaOrgEmbutida,
} from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

const LIMITE_DA_VARREDURA = 200;
/** Compromissos com envio por rodada: o resto sai na rodada seguinte (5 min). */
const TETO_DE_ENVIOS_POR_RODADA = 20;
/** O aquecimento só olha marcação recente: ele sai no dia em que marcou. */
const AQUECIMENTO_OLHA_MARCACOES_DE_MS = 2 * 24 * 60 * 60_000;
/** A véspera recua no máximo uma semana. */
const CONFIRMACAO_OLHA_ATE_MS = 8 * 24 * 60 * 60_000;
const VALIDADE_DA_URL_S = 3_600;
const FUSO_PADRAO = "America/Sao_Paulo";

interface TipoDaSequencia {
  reminder_channel_session_id: string | null;
  post_booking_sequence_enabled: boolean;
  post_booking_sequence: unknown;
}

interface CompromissoDaSequencia {
  id: string;
  organization_id: string;
  contact_id: string;
  conversation_id: string | null;
  owner_user_id: string | null;
  starts_at: string;
  created_at: string | null;
  starts_at_marked_at: string | null;
  warmup_sent_at: string | null;
  confirmation_sent_for: string | null;
  confirmation_sent_at: string | null;
  confirmation_retry_sent_for: string | null;
  lead_presence: string | null;
  calendar_event_types: TipoDaSequencia | TipoDaSequencia[] | null;
  organizations?: { status?: string | null } | Array<{ status?: string | null }> | null;
}

const COLUNAS =
  "id, organization_id, contact_id, conversation_id, owner_user_id, starts_at, created_at, starts_at_marked_at, warmup_sent_at, confirmation_sent_for, confirmation_sent_at, confirmation_retry_sent_for, lead_presence, " +
  "calendar_event_types!inner(reminder_channel_session_id, post_booking_sequence_enabled, post_booking_sequence), organizations:organization_id!inner(status)";

function tipoDe(linha: CompromissoDaSequencia): TipoDaSequencia | null {
  const t = linha.calendar_event_types;
  if (!t) return null;
  return Array.isArray(t) ? (t[0] ?? null) : t;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();
  const base = () =>
    admin
      .from("calendar_appointments")
      .select(COLUNAS)
      .eq("status", "confirmed")
      // Org parada sai no banco, ANTES do `limit` — o `ehOperante` abaixo é cinto.
      .eq("organizations.status", STATUS_OPERANTE)
      .eq("calendar_event_types.post_booking_sequence_enabled", true)
      .not("contact_id", "is", null)
      // PC-052 parte 2: quem disse que não vai não recebe sequência.
      .or("lead_presence.is.null,lead_presence.neq.nao_vai")
      .gt("starts_at", agora.toISOString());

  const [aquecimento, confirmacao] = await Promise.all([
    base()
      .is("warmup_sent_at", null)
      .gte("created_at", new Date(agora.getTime() - AQUECIMENTO_OLHA_MARCACOES_DE_MS).toISOString())
      // Mais nova primeiro: a marcação que não vai receber aquecimento (passo
      // desligado, sem conteúdo, recusou marketing) nunca carimba, e em ordem
      // crescente ficaria na frente das novas por dois dias.
      .order("created_at", { ascending: false })
      .limit(LIMITE_DA_VARREDURA),
    base()
      .lte("starts_at", new Date(agora.getTime() + CONFIRMACAO_OLHA_ATE_MS).toISOString())
      .order("starts_at", { ascending: true })
      .limit(LIMITE_DA_VARREDURA),
  ]);
  const erro = aquecimento.error ?? confirmacao.error;
  if (erro) {
    logger.error("[agenda-sequencia] consulta falhou", { error: erro.message, requestId });
    return fail("internal_error", "Falha ao buscar compromissos.", 500, { requestId });
  }
  const linhas = new Map<string, CompromissoDaSequencia>();
  for (const l of [...(aquecimento.data ?? []), ...(confirmacao.data ?? [])] as unknown as CompromissoDaSequencia[]) {
    linhas.set(l.id, l);
  }

  let enviados = 0;
  let pulados = 0;
  const motivos: Record<string, number> = {};
  const passos: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados += 1;
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
  };

  const organizacoes = new Map<string, { timezone: string | null; locale: string | null; settings: unknown } | null>();
  const organizacaoDe = async (id: string) => {
    if (!organizacoes.has(id)) {
      const { data: o } = await admin
        .from("organizations")
        .select("timezone, locale, settings")
        .eq("id", id)
        .maybeSingle();
      organizacoes.set(id, (o as { timezone: string | null; locale: string | null; settings: unknown } | null) ?? null);
    }
    return organizacoes.get(id) ?? null;
  };

  let comEnvio = 0;
  for (const linha of linhas.values()) {
    if (comEnvio >= TETO_DE_ENVIOS_POR_RODADA) {
      pular("teto_da_rodada");
      continue;
    }
    const tipo = tipoDe(linha);
    if (!tipo) {
      pular("sem_tipo");
      continue;
    }
    const org = linha.organization_id;
    if (!ehOperante(statusDaOrgEmbutida(linha.organizations))) {
      pular("org_nao_operante");
      continue;
    }
    const config = lerSequencia(tipo.post_booking_sequence);
    const organizacao = await organizacaoDe(org);
    const fuso = organizacao?.timezone || FUSO_PADRAO;

    // Antes de saber o canal, as duas suposições do dia de envio: todo dia, ou
    // sem domingo. Sem a segunda, a véspera de uma reunião de segunda (que recua
    // para o sábado quando o número não manda no domingo) nunca passaria daqui.
    // Se nenhuma das duas abre um passo, não vale ler contato e canal.
    const provavel =
      passoAberto({ linha, config, fuso, agora, diaTemEnvio: () => true }) ??
      passoAberto({ linha, config, fuso, agora, diaTemEnvio: (dow) => dow !== 0 });
    if (!provavel) {
      pular("ainda_nao");
      continue;
    }

    const { data: contato } = await admin
      .from("contacts")
      .select("id, name, display_name, phone_number, is_blocked, consent")
      .eq("id", linha.contact_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (!contato) {
      pular("contato_fora_da_org");
      continue;
    }
    if (contato.is_blocked) {
      pular("contato_bloqueado");
      continue;
    }
    if (!contato.phone_number) {
      pular("sem_telefone");
      continue;
    }

    // O reforço (PC-064) sai no dia da reunião: fora da janela de 24 h, pelo
    // diálogo da confirmação do dia.
    const usoDoRoteiro =
      provavel.passo === "aquecimento"
        ? null
        : provavel.passo === "confirmacao_reforco"
          ? "confirmacao_do_dia"
          : provavel.passo;
    const escolha = await resolverRemetenteDoLembrete(
      admin,
      linha,
      tipo.reminder_channel_session_id ?? null,
      agora,
      false,
      usoDoRoteiro,
    );
    if (!escolha.canal) {
      pular(escolha.motivo);
      continue;
    }
    const canal = escolha.canal;
    const knobs = await knobsDoCanal(admin, org, canal.id);
    if (!janelaDeEnvioAberta(agora, knobs)) {
      pular("fora_da_janela");
      continue;
    }
    // Agora com o dia de envio de verdade: a véspera de domingo recua para o
    // sábado quando o canal não manda no domingo.
    const passo = passoAberto({
      linha,
      config,
      fuso,
      agora,
      diaTemEnvio: (dow) => dow !== 0 || knobs.allowSunday,
    });
    if (!passo || passo.passo !== provavel.passo) {
      pular("ainda_nao");
      continue;
    }

    if (passo.passo === "aquecimento") {
      const consent = (contato as { consent?: { marketing?: { declined_at?: string | null } } | null }).consent;
      if (consent?.marketing?.declined_at) {
        pular("recusou_marketing");
        continue;
      }
      const midia = lerMidiaDoAquecimento(organizacao?.settings, org);
      if (!midia.video && midia.imagens.length === 0 && !config.aquecimento.texto) {
        pular("aquecimento_sem_conteudo");
        continue;
      }
      if (escolha.foraDaJanela) {
        // Vídeo e imagem são mensagem livre: fora da janela de 24 h não saem.
        pular("aquecimento_fora_da_janela_24h");
        continue;
      }
      const { data: reivindicado, error: erroCarimbo } = await admin
        .from("calendar_appointments")
        .update({ warmup_sent_at: new Date().toISOString() })
        .eq("id", linha.id)
        .eq("organization_id", org)
        .is("warmup_sent_at", null)
        // A troca confere de novo o que a leitura viu: ainda de pé.
        .eq("status", "confirmed")
        .or("lead_presence.is.null,lead_presence.neq.nao_vai")
        .select("id");
      if (erroCarimbo || !reivindicado?.length) {
        pular(erroCarimbo ? "carimbo_falhou" : "ja_reivindicado");
        continue;
      }
      comEnvio += 1;
      try {
        const conversaId = await ensureConversation(admin, org, contato.id, canal.id);
        const envios: Array<Parameters<typeof sendMessageHandler>[2]> = [];
        if (config.aquecimento.texto) {
          envios.push({ conversation_id: conversaId, type: "text", body: config.aquecimento.texto } as Parameters<
            typeof sendMessageHandler
          >[2]);
        }
        for (const arquivo of [...(midia.video ? [midia.video] : []), ...midia.imagens]) {
          const { data: assinada } = await admin.storage
            .from(BUCKET_DA_MIDIA_DA_AGENDA)
            .createSignedUrl(arquivo.caminho, VALIDADE_DA_URL_S);
          if (!assinada?.signedUrl) continue;
          envios.push({
            conversation_id: conversaId,
            type: arquivo.mime === "video/mp4" ? "video" : "image",
            media_url: assinada.signedUrl,
            media_mime: arquivo.mime,
          } as Parameters<typeof sendMessageHandler>[2]);
        }
        let i = 0;
        for (const envio of envios) {
          await espacarEnvio(canal.id);
          await sendMessageHandler(
            admin,
            {
              organization_id: org,
              actor: { type: "webhook_source", id: linha.id },
              requestId: `agenda-sequencia:${linha.id}:aquecimento:${i}`,
            },
            envio,
          );
          i += 1;
        }
        enviados += 1;
        passos.aquecimento = (passos.aquecimento ?? 0) + 1;
      } catch (err) {
        if (err instanceof OrgNaoOperanteError) {
          pular("org_nao_operante");
          continue;
        }
        logger.error("[agenda-sequencia] aquecimento falhou", {
          appointmentId: linha.id,
          error: err instanceof Error ? err.message : String(err),
          requestId,
        });
        pular("erro_no_envio");
      }
      continue;
    }

    // ─── O reforço: só para quem não respondeu depois da 1ª (PC-064) ─────────
    // A presença confirmada já ficou de fora em `passoAberto`. Aqui, a outra
    // metade de "confirmou": qualquer mensagem do cliente depois da 1ª. Quem
    // respondeu está conversando — a IA ou a equipe cuidam, e perguntar de novo
    // por cima da conversa é o que soa robô. Na dúvida (leitura falhou), não manda.
    if (passo.passo === "confirmacao_reforco") {
      const primeiraEm = quandoSaiuAPrimeira(linha, config, fuso, (dow) => dow !== 0 || knobs.allowSunday);
      if (!primeiraEm) {
        pular("reforco_sem_a_primeira");
        continue;
      }
      const { data: respostas, error: erroRespostas } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", org)
        .eq("contact_id", contato.id)
        .eq("direction", "inbound")
        .gt("created_at", primeiraEm.toISOString())
        .limit(1);
      if (erroRespostas) {
        pular("reforco_leitura_falhou");
        continue;
      }
      if ((respostas ?? []).length > 0) {
        pular("reforco_cliente_respondeu");
        continue;
      }
    }

    // ─── A confirmação ──────────────────────────────────────────────────────
    let troca;
    if (passo.passo === "confirmacao_reforco") {
      troca = admin
        .from("calendar_appointments")
        .update({ confirmation_retry_sent_for: linha.starts_at })
        .eq("id", linha.id)
        .eq("organization_id", org)
        .eq("starts_at", linha.starts_at)
        .eq("status", "confirmed")
        // A 1ª é deste horário, e ninguém confirmou nem disse que não vai
        // entre a leitura e a troca.
        .eq("confirmation_sent_for", linha.starts_at)
        .or("lead_presence.is.null,lead_presence.eq.aguardando");
      troca = linha.confirmation_retry_sent_for
        ? troca.eq("confirmation_retry_sent_for", linha.confirmation_retry_sent_for)
        : troca.is("confirmation_retry_sent_for", null);
    } else {
      troca = admin
        .from("calendar_appointments")
        .update({ confirmation_sent_for: linha.starts_at, confirmation_sent_at: new Date().toISOString() })
        .eq("id", linha.id)
        .eq("organization_id", org)
        .eq("starts_at", linha.starts_at)
        .eq("status", "confirmed")
        .or("lead_presence.is.null,lead_presence.neq.nao_vai");
      troca = linha.confirmation_sent_for
        ? troca.eq("confirmation_sent_for", linha.confirmation_sent_for)
        : troca.is("confirmation_sent_for", null);
    }
    const { data: reivindicada, error: erroTroca } = await troca.select("id");
    if (erroTroca || !reivindicada?.length) {
      pular(erroTroca ? "carimbo_falhou" : "ja_reivindicado");
      continue;
    }
    comEnvio += 1;

    try {
      await espacarEnvio(canal.id);
      const conversaId = await ensureConversation(admin, org, contato.id, canal.id);
      if (escolha.foraDaJanela) {
        const roteiro = await enviarRoteiroForaDaJanela(admin, {
          organizationId: org,
          channelSessionId: canal.id,
          conversationId: conversaId,
          uso: passo.passo === "confirmacao_reforco" ? "confirmacao_do_dia" : passo.passo,
        });
        if (!roteiro.ok) {
          logger.warn("[agenda-sequencia] diálogo fora da janela não saiu", {
            appointmentId: linha.id,
            motivo: roteiro.motivo,
            requestId,
          });
          pular(`roteiro_${roteiro.motivo}`);
          continue;
        }
      } else {
        const idioma = normalizarIdioma(organizacao?.locale);
        const t = (texto: string) => traduzir(texto, idioma);
        const especialista = linha.owner_user_id
          ? ((await nomesDosAtendentes([linha.owner_user_id])).get(linha.owner_user_id) ?? null)
          : null;
        const molde =
          passo.passo === "confirmacao_vespera"
            ? (config.confirmacao.textoVespera ?? textoPadraoDaVespera(t))
            : passo.passo === "confirmacao_reforco"
              ? (config.reforco.texto ?? textoPadraoDoReforco(t))
              : (config.confirmacao.textoDoDia ?? textoPadraoDoDia(t));
        const corpo = aplicarTextoDaSequencia(
          molde,
          pecasDaSequencia({
            nomeDoContato: nomeDoContato(contato),
            especialista,
            comeca: new Date(linha.starts_at),
            envio: agora,
            fuso,
            etiquetaDeIdioma: tagDeIdioma(idioma),
            palavras: { amanha: t("amanhã"), hoje: t("hoje"), as: t("às") },
          }),
        );
        await sendMessageHandler(
          admin,
          {
            organization_id: org,
            actor: { type: "webhook_source", id: linha.id },
            requestId: `agenda-sequencia:${linha.id}:${passo.passo}`,
          },
          { conversation_id: conversaId, type: "text", body: corpo } as Parameters<typeof sendMessageHandler>[2],
        );
      }
      enviados += 1;
      passos[passo.passo] = (passos[passo.passo] ?? 0) + 1;
    } catch (err) {
      if (err instanceof OrgNaoOperanteError) {
        pular("org_nao_operante");
        continue;
      }
      logger.error("[agenda-sequencia] confirmação falhou", {
        appointmentId: linha.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      pular("erro_no_envio");
    }
  }

  if (enviados > 0) {
    await audit({
      action: "agenda.sequencia_enviada",
      resourceType: "calendar_appointment",
      requestId,
      metadata: { enviados, pulados, passos, motivos },
    });
  }

  return ok({ examinados: linhas.size, enviados, pulados, passos, motivos }, { requestId });
}

export const GET = handle;
export const POST = handle;

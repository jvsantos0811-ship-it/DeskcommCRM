import type { QueryClient } from "@tanstack/react-query";

/**
 * A RECARGA QUE O REALTIME PEDE, AGRUPADA — e sem cancelar a busca em voo.
 *
 * Uma única mensagem que chega gera uma RAJADA de eventos (o INSERT em
 * `messages` e várias escritas em `conversations`), e cada evento invalidava
 * `["conversations"]` na hora. `invalidateQueries` cancela a busca em curso
 * (`cancelRefetch` é o padrão), então a rajada virava várias buscas da lista,
 * cada uma cancelando a anterior — no trace do CI, 5 GET em 5ms.
 *
 * O que isto NÃO é: a causa da falha intermitente do e2e
 * `encerramento-atendimento`. O controle aprovado (run 37329560310) tem a
 * MESMA rajada de 5 GET cancelados e passou; o que separou a falha (run
 * 37320609105) foi o servidor respondendo em ~4s pedidos que nunca são
 * cancelados. O ganho aqui é menos carga, não o conserto daquela asserção.
 *
 * Duas regras, e as duas importam:
 *  - a rajada vira UMA busca, que começa depois da janela;
 *  - se já há busca da lista em voo, ESPERA ela terminar e só então recarrega.
 *    Cancelar perde a resposta; não recarregar perde a escrita que chegou
 *    depois de ela começar.
 *
 * Também recarrega `["conversation", id]` — a conversa aberta que NÃO está na
 * aba atual (fechada, de outro filtro) vem só dessa busca, e nenhum evento a
 * alcançava: ela ficava velha até um F5.
 *
 * Por QueryClient, e não por hook: os dois canais do inbox (lista e mensagens)
 * pedem a mesma recarga, e agrupar só um deles deixaria o outro cancelando.
 *
 * ─── Rajada que não acaba (PC-042) ──────────────────────────────────────────
 *
 * A janela de 150 ms junta os eventos de UMA mensagem. Ela não segura uma
 * rajada que dura minutos: uma importação de histórico escreve em
 * `conversations` sem parar, e cada aba com o inbox aberto recarregava a lista
 * a cada ~150 ms + a duração da busca. Medido numa instalação real: ~2.000
 * recargas a cada 5 min (contra 140–310 no normal), e a lista conta com RLS —
 * o banco não aguentou e a IA de todas as organizações ficou minutos sem
 * responder.
 *
 * Por isso, além da janela, um limite por fichas: cada aba tem até
 * `FICHAS_MAX` recargas imediatas, e ganha uma ficha a cada `INTERVALO_MS`.
 * No uso normal as fichas nunca acabam e nada muda (a recarga sai em 150 ms).
 * Numa rajada contínua, depois das duas primeiras, sai no máximo uma recarga a
 * cada ~5 s. E a última escrita SEMPRE aparece: todo evento ou agenda uma
 * recarga, ou cai numa que ainda vai sair depois dele.
 *
 * Só a LISTA (e o cabeçalho da conversa aberta) espera. As mensagens da
 * conversa aberta têm o próprio canal e recarregam na hora
 * (`useMessagesRealtime`); ações da própria pessoa invalidam direto, sem
 * passar por aqui.
 */
const JANELA_MS = 150;
const INTERVALO_MS = 5_000;
const FICHAS_MAX = 2;

interface Estado {
  timer: ReturnType<typeof setTimeout> | null;
  /** Fichas no instante `em` (pode ficar um pouco abaixo de zero). */
  fichas: number;
  em: number;
}

const estados = new WeakMap<QueryClient, Estado>();

function fichasEm(e: Estado, agora: number): number {
  // Relógio que volta (ajuste do sistema) não gera dívida de fichas.
  return Math.min(FICHAS_MAX, e.fichas + Math.max(0, agora - e.em) / INTERVALO_MS);
}

export function agendarRecargaDasConversas(qc: QueryClient): void {
  const agora = Date.now();
  let e = estados.get(qc);
  if (!e) {
    e = { timer: null, fichas: FICHAS_MAX, em: agora };
    estados.set(qc, e);
  }
  if (agora < e.em) e.em = agora;
  // Já há recarga marcada: ela sai depois deste evento e o leva junto.
  if (e.timer) return;
  const faltam = 1 - fichasEm(e, agora);
  const espera = faltam > 0 ? Math.max(JANELA_MS, Math.ceil(faltam * INTERVALO_MS)) : JANELA_MS;
  const estado = e;
  e.timer = setTimeout(() => descarregar(qc, estado), espera);
}

function descarregar(qc: QueryClient, e: Estado): void {
  // ponytail: espera por polling na janela; sem teto — uma busca que nunca
  // termina adia a recarga até ela falhar, que é o que o cancelamento fazia pior.
  if (qc.isFetching({ queryKey: ["conversations"] }) > 0) {
    e.timer = setTimeout(() => descarregar(qc, e), JANELA_MS);
    return;
  }
  const agora = Date.now();
  e.fichas = fichasEm(e, agora) - 1;
  e.em = agora;
  e.timer = null;
  void qc.invalidateQueries({ queryKey: ["conversations"] });
  void qc.invalidateQueries({ queryKey: ["conversation"] });
}

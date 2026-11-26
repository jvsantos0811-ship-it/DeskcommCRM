import { toast } from "sonner";

import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";
import { emitNotification } from "./emit";
import type { NotifyKind } from "./kinds";
import { canalLigado, gravarCanal, lerPrefs, type NotifyCategory } from "./prefs";

export interface EntregarAvisoInput {
  category: NotifyCategory;
  kind: NotifyKind;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  icon?: string;
}

/**
 * Desliga, NESTE navegador, os dois canais do aviso de mensagem nova: o
 * cartão no canto (in-app) e o aviso na bandeja do sistema (push). É a mesma
 * gravação do interruptor de Configurações › Notificações — a tela de lá
 * mostra o estado novo sem recarregar, porque lê a mesma loja.
 *
 * O cartão de confirmação diz onde religar e oferece "Desfazer", que devolve
 * exatamente o que estava antes (quem tinha só o in-app ligado não ganha o
 * push de presente). Desfazer não pede permissão ao navegador: só religa o
 * push se ele já estava ligado, e portanto já permitido.
 */
export function silenciarAvisosDeMensagem(): void {
  const idioma = idiomaAtual();
  const antes = lerPrefs().message;
  gravarCanal("message", "in_app", false);
  gravarCanal("message", "push", false);
  toast(traduzir("Avisos de nova mensagem desligados neste navegador.", idioma), {
    description: traduzir("Para ligar de novo: Configurações › Notificações.", idioma),
    action: {
      label: traduzir("Desfazer", idioma),
      onClick: () => {
        gravarCanal("message", "in_app", antes.in_app);
        gravarCanal("message", "push", antes.push);
      },
    },
  });
}

export function entregarAviso(input: EntregarAvisoInput): void {
  // Mesmo padrão de showApiError: a chave do dicionário é o PT; sem `t()` o
  // toast da esquina fica em português mesmo com idioma=es (e as chaves de CRM
  // já existiam — o bug era não passar por traduzir).
  const idioma = idiomaAtual();
  const title = traduzir(input.title, idioma);
  const body = traduzir(input.body, idioma);
  const href = input.href;

  if (canalLigado(input.category, "in_app")) {
    // O aviso já carrega o destino (`href`); sem ação, o toast dizia "nova
    // mensagem" e deixava a pessoa procurando a conversa na mão. Com ação, ele
    // leva direto para lá. Sem destino, não inventa botão: um botão morto é
    // pior que nenhum.
    toast(title, {
      description: body,
      action: href
        ? {
            label: traduzir("Abrir conversa", idioma),
            onClick: () => {
              window.location.assign(href);
            },
          }
        : undefined,
      // O desligar mora NO aviso, e só no de mensagem (relato de cliente,
      // 25/11/2026: "não consigo desativar as notificações de conversa").
      // A escolha já existia em Configurações › Notificações, mas quem é
      // interrompido o dia inteiro não vai procurá-la lá: o lugar de calar o
      // aviso é o próprio aviso. Os outros tipos (lead atribuído a você,
      // menção) são pessoais e raros — não ganham o botão.
      cancel:
        input.category === "message"
          ? {
              label: traduzir("Silenciar", idioma),
              onClick: () => silenciarAvisosDeMensagem(),
            }
          : undefined,
    });
  }
  if (canalLigado(input.category, "push")) {
    emitNotification({
      kind: input.kind,
      title,
      body,
      tag: input.tag,
      href: input.href,
      icon: input.icon,
      force: true,
    });
  }
}

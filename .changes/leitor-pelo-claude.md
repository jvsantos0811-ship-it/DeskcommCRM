---
impacto: capacidade_nova
secao: adicionado
titulo: Leitor da conversa feito pelo Claude, sem o CRM chamar modelo (escolha do dono da instalação, por empresa)
---
O cartão do Leitor da conversa (IA › Provedores) ganha uma quarta escolha, só para o dono da instalação: "Ler pelo Claude (tarefa da agência)". Com ela, quem lê as conversas e preenche a ficha do lead é uma tarefa agendada do Claude, pela nova porta Ficha da agência (`/api/mcp/agencia/ficha`, chave `gestor-ficha`, criada em Admin › Chaves da agência). O CRM não chama modelo nenhum para ler nessa empresa: ele entrega a mesma seleção de leads, as mesmas instruções e a mesma conversa transcrita que o Leitor dele usaria, valida a ficha pelo mesmo formato, guarda a anterior no histórico, calcula a regra fixa e abre o aviso de lead que voltou. A porta grava só a ficha: não move card, não muda etapa, não mexe em marcador e não fala com ninguém. A ficha passa a dizer quem leu (o Leitor do CRM, a tarefa do Claude ou a correção do Gestor), o cartão mostra a última rodada do Claude, e a porta Leitura ganha `crm_ler_fichas` para conferir as fichas de uma janela. Quem não escolher nada continua exatamente como antes.

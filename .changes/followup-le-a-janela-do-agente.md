---
impacto: nada_mudou
secao: corrigido
titulo: O fluxo de follow-up lê a conversa com o tamanho de histórico configurado no agente
---
Nos fluxos de follow-up, os passos "Classificar (IA)" e o planejamento das esperas adaptativas passam a ler a conversa com o mesmo tamanho de histórico que a tela do agente define (número de mensagens e tamanho máximo do histórico), e não mais com o valor fixo da instalação (20 mensagens e cerca de 1.000 tokens). Com isso, uma resposta longa ou um áudio transcrito do cliente não empurra mais o envio do fluxo para fora da leitura, e o passo deixa de concluir "sem resposta" com a resposta ali. A mensagem escrita pela IA no follow-up já usava o histórico do agente e não muda. Nada a fazer na atualização.

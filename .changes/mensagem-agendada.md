---
impacto: capacidade_nova
secao: adicionado
titulo: Agendar mensagem numa conversa, no Inbox e no pop-up do negócio
---
Acima do campo de texto da conversa (no Inbox e no pop-up do negócio no funil) há o botão "Agendar mensagem": escreva o texto, escolha a data e a hora e ele sai sozinho no horário, em nome de quem agendou e pelo mesmo canal da conversa, com as mesmas regras do envio normal (contato bloqueado, janela de 24 horas, empresa suspensa). As mensagens pendentes aparecem na própria conversa com o botão Cancelar; se uma não puder sair, o motivo aparece ali e numa nota interna no fio. Nesta versão o agendamento é só de texto, com até 60 dias de antecedência. A atualização cria a tabela `scheduled_messages` e passa a rodar o envio a cada minuto; nada a fazer à mão.

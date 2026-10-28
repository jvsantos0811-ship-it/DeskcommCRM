---
impacto: capacidade_nova
secao: corrigido
titulo: A IA não deixa mais o cliente sem resposta quando uma trava barra a mensagem
---
Quando a IA abria um caso para a equipe e, na mesma resposta, avisava o cliente que a equipe iria assumir, a trava que impede "prometer um humano que não existe" às vezes não enxergava o caso recém-aberto e barrava a mensagem inteira — e o cliente ficava sem resposta. Agora o caso aberto no mesmo turno conta como humano a caminho e a mensagem sai. E, se qualquer trava de conteúdo barrar a resposta inteira e nada sair, o cliente recebe uma frase segura (padrão: "Recebi sua mensagem e já estou cuidando disso, um instante.", configurável em Configurações › Distribuição de atendimento), a equipe recebe um caso com o texto barrado e o motivo, e o bloqueio aparece na aba Execuções do agente, na nova seção "Recusas e bloqueios". Travas de opt-out, LGPD, janela e ritmo continuam calando, como antes. O botão Testar do agente agora guarda a conversa da sessão (vários turnos em sequência), aceita um dia e hora simulados e mostra as ferramentas chamadas e as travas acionadas. A atualização cria uma tabela no banco; nada a fazer à mão.

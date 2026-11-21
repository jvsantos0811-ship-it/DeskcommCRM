---
impacto: nada_mudou
secao: corrigido
titulo: Importar o histórico não deixa mais o CRM lento para todo mundo
---
Quando as conversas mudam sem parar (por exemplo, enquanto o histórico de um número é importado, ou num horário muito cheio), a lista de conversas de quem está com a Inbox aberta passa a se atualizar no máximo a cada ~5 segundos, em vez de várias vezes por segundo. As mensagens da conversa aberta continuam chegando na hora, e com movimento comum a lista segue atualizando em menos de um segundo. A importação também passa a trabalhar uma rodada por vez de verdade: com o banco lento, duas rodadas não pegam mais a mesma conversa ao mesmo tempo, uma importação cancelada não volta sozinha, e os números da tela (conversas lidas, mensagens gravadas) não voltam para trás. Uma conversa que recebe mensagem nova enquanto a página dela está sendo importada não fica de fora, e um número em uso durante a importação não faz a importação andar em círculos. O instalador, as imagens e a busca de versões passam a apontar para github.com/leadsalesia/DeskcommCRM; quem já instalou recebe o endereço novo na próxima atualização, sem editar nada.

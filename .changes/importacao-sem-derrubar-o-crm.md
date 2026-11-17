---
impacto: nada_mudou
secao: corrigido
titulo: Importar o histórico não deixa mais o CRM lento para todo mundo
---
Enquanto o histórico de um número é importado, a lista de conversas de quem está com a Inbox aberta passa a se atualizar no máximo a cada ~5 segundos (antes, várias vezes por segundo). As mensagens da conversa aberta continuam chegando na hora, e no uso normal nada muda. A importação também passa a trabalhar uma rodada por vez de verdade: com o banco lento, duas rodadas não pegam mais a mesma página ao mesmo tempo, uma importação cancelada não volta sozinha, e os números da tela (conversas lidas, mensagens gravadas) não voltam para trás. O instalador, as imagens e a busca de versões passam a apontar para github.com/leadsalesia/DeskcommCRM; quem já instalou recebe o endereço novo na próxima atualização, sem editar nada.

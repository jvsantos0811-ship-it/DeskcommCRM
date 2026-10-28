---
impacto: capacidade_nova
secao: melhorado
titulo: A IA lê todas as mensagens novas do cliente antes de responder, espera o cliente terminar de escrever e para no meio quando ele escreve de novo
---
Quando o cliente manda várias mensagens seguidas ("Meu neto sofreu o acidente de moto" e, logo depois, "e ficou machucado"), o turno da IA agora recebe todas elas, em ordem, com hora e tipo (texto, áudio transcrito, imagem, documento), e é instruído a responder ao conjunto — antes recebia só uma e podia responder à metade da conversa.

A espera antes de responder passou a deslizar: cada mensagem nova do mesmo contato reinicia o relógio. Texto espera 5 segundos (ou o valor do campo "esperar antes de responder" do agente), foto, vídeo e documento esperam 20 segundos, o áudio espera a transcrição terminar e depois o tempo de texto, e nada passa de 30 segundos desde a primeira mensagem — cliente que escreve sem parar recebe resposta, nunca silêncio. Os três valores são ajustáveis pela instalação (`INBOUND_DEBOUNCE_MS`, `INBOUND_DEBOUNCE_MIDIA_MS`, `INBOUND_DEBOUNCE_TETO_MS`).

Se o cliente escreve enquanto a resposta sai em várias bolhas, as bolhas que ainda não saíram ficam retidas; o turno seguinte sabe o que já foi dito (não repete) e o que ficou retido.

Uma ferramenta do agente que falha (erro, ou sem resposta em 20 segundos — `AGENT_TOOL_TIMEOUT_MS`) não é tentada de novo no mesmo turno: o erro é registrado e a resposta segue sem ela. O envio de mensagem e a passagem para a equipe ficam fora dessa regra.

O tempo de cada turno (da última mensagem do cliente até a primeira bolha), quantas mensagens ele respondeu, as bolhas retidas e as ferramentas que falharam ficam registrados, sem conteúdo de mensagem, e podem ser consultados por agente ou por conversa em `/api/v1/ai/tempos-de-resposta` (com `?formato=csv` para baixar a planilha). Nada a fazer na atualização: a tabela nova entra com o próprio update.

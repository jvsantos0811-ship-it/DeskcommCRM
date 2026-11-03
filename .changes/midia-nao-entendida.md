---
impacto: capacidade_nova
secao: adicionado
titulo: Áudio ou imagem que não deu para entender — a IA pede para repetir em vez de adivinhar
---
A transcrição de áudio passa a ir sempre com o idioma da empresa (pt-BR). Quando o áudio não é entendido — transcrição vazia, só ruído (as frases que o transcritor inventa no silêncio, como "Legendas pela comunidade Amara.org"), curta demais para a duração (menos de 3 palavras em mais de 5 segundos) ou leitura que falhou —, o agente recebe "ÁUDIO NÃO ENTENDIDO (duração Ns)" e pede, com naturalidade, que a pessoa repita ou escreva, sem responder como se tivesse entendido. Foto borrada ou PDF sem texto viram "MÍDIA NÃO ENTENDIDA" com a mesma conduta (pede outra foto ou que escreva). O atendimento espera a transcrição até 30 segundos (ajustável em INBOUND_ESPERA_TRANSCRICAO_MS); passado isso, a IA responde ao resto, diz que já vai ouvir o áudio, e responde ao áudio assim que a transcrição chega. Áudio longo (mais de 3 minutos) é transcrito inteiro, em partes. No Inbox, o balão do áudio não entendido diz isso em vez de mostrar uma transcrição; em Configurações › IA aparece quantos áudios e fotos não foram entendidos por dia.

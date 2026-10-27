---
impacto: nada_mudou
secao: corrigido
titulo: O painel de Provedores mostra o modelo que de fato prepara e busca o seu material
---
Em IA › Provedores, os cartões "Indexar o seu material" e "Buscar no seu material" mostravam o modelo de conversa da organização, que não é o que prepara nem busca os documentos. Agora eles mostram o modelo de embedding que a base de conhecimento realmente usa (o da OpenAI ou o do Google, conforme a chave) e de onde vem a chave; sem chave, o cartão mostra "—" e diz o que cadastrar. As variáveis RAG_EMBEDDING_API_KEY, RAG_EMBEDDING_MODEL e RAG_EMBEDDING_TIMEOUT_MS deixaram de existir: nenhuma parte do sistema as lia, e quem ainda as tiver no .env não precisa mexer em nada. A chave do material continua vindo de Credenciais ou da instalação, como antes. Nada a fazer na atualização.

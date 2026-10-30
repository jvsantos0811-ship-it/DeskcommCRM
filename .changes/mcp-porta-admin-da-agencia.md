---
impacto: capacidade_nova
secao: adicionado
titulo: Porta MCP Admin da agência — muda a configuração de qualquer empresa, sem ler conversas nem falar com cliente
---
A chave da agência ganhou a segunda porta, Admin (`/api/mcp/agencia/admin`), criada na mesma tela Administração › Chaves da agência. Por ela dá para mudar a configuração de qualquer empresa da instalação: etapas do funil (criar, renomear, reordenar, arquivar), entradas automáticas, regras automáticas (ligar e desligar), regras da empresa e etiquetas, além de mover, atualizar e retomar um negócio pelo id. Ela não lê conversas, mensagens nem dados de contato: nas listas de negócios e de conversas só saem ids, etapa, situação, datas, valores e etiquetas. E ela nunca envia mensagem, inicia conversa nem cria rascunho para o cliente. Toda alteração fica na auditoria com o antes e o depois, aparece na lista "Últimas alterações pela porta Admin" da mesma tela e, quando é numa empresa cliente e o e-mail da instalação está configurado, gera um e-mail para quem criou a chave (sem dado de cliente). O limite de alterações por minuto continua valendo. Nada a fazer à mão na atualização.

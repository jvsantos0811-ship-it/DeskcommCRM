---
impacto: capacidade_nova
secao: adicionado
titulo: Etapa "só atendimento humano": com o negócio nela, a IA não responde o cliente e chama a equipe
---
Em Configurações › Funis › Etapas, cada etapa ganhou a chave "Só atendimento humano". Com um negócio aberto numa etapa marcada (por exemplo, "Análise humana" ou "Aguardando assinatura"), o agente de IA não responde o cliente nem envia os follow-ups do fluxo: a conversa vai para a fila humana e a Central recebe um aviso com o nome da etapa. Para a IA voltar a atender, basta mover o negócio para outra etapa (ou ganhar ou perder o negócio). A mesma marca pode ser ligada pela ferramenta `crm_update_stage` do MCP, com o campo `requires_human`. A atualização ajusta uma regra do banco para registrar essa passagem; nada a fazer à mão.

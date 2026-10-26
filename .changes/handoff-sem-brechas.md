---
impacto: nada_mudou
secao: alterado
titulo: Conversa com uma pessoa da equipe não recebe mensagem de integração nem de agente externo
---
Quando uma conversa está em atendimento humano, mensagens enviadas por integração (a API com chave `dsk_…`) ou por um agente externo pelo MCP (`crm_send_whatsapp_message` e `crm_start_conversation_and_send`) passam a ser recusadas com o código `conversa_com_humano` (HTTP 409), e nada é enviado ao cliente. Quem atende pela tela continua enviando normalmente, assim como as mensagens agendadas por uma pessoa e os avisos automáticos do próprio sistema. A passagem para humano pedida pelo MCP (`crm_request_human_handoff`) agora também trava o contato inteiro, como a passagem feita pelo próprio agente do CRM: a IA só volta quando alguém devolve a conversa. Nada a fazer na atualização.

/**
 * PC-052 parte 3b — o `seq` do RECIBO, no `send_ledger`, de um diálogo executado
 * na plataforma de atendimento (o passo de follow-up fora da janela). Fica fora
 * da faixa das mensagens do turno, e quem conta "a IA já falou com este
 * contato?" o exclui: o diálogo é o modelo do escritório, não uma fala da IA.
 *
 * Módulo próprio de propósito: `send-ledger` é substituído inteiro nos dublês
 * dos testes do turno, e a constante sumiria junto.
 */
export const SEQ_DO_DIALOGO_DA_PLATAFORMA = 101;

/**
 * Aviso, dentro da página, de que um negócio do contato mudou fora do painel do
 * CRM (PC-024: "Marcar como perdido" no "⋯" do cabeçalho do Inbox). O painel não
 * usa react-query — `invalidateQueries` não o alcança —, então ele escuta este
 * evento e relê o resumo pelo mesmo caminho do "Tentar de novo".
 */
export const EVENTO_NEGOCIO_MUDOU = "crm:negocio-do-contato-mudou";

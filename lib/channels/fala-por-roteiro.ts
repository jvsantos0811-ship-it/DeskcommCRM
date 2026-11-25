/**
 * PC-052 parte 3b — esta conexão fala FORA da janela de 24 h por DIÁLOGO da
 * plataforma (o canal que atende dentro de outra plataforma de atendimento), e
 * não por modelo da Meta? Puro, sem banco: a validação do fluxo (que roda também
 * no navegador) e o turno do follow-up perguntam aqui, sem citar o provedor.
 */
import { CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO } from "./capabilities";

export function falaPorRoteiro(provider: string | null | undefined): boolean {
  return provider === CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO;
}

/**
 * Cargos da equipe (migration 9003) — a forma e a régua, sem I/O.
 *
 * Um cargo é um NOME de função que junta duas coisas que já existiam soltas:
 * - `papel` (viewer/agent/manager): o que AUTORIZA — toda rota cobra o papel;
 * - `interface_settings`: as telas que aparecem — apresentação, como sempre foi.
 *
 * `admin` não é cargo (ver o cabeçalho da migration): quem administra a
 * organização continua sendo escolhido um a um, na troca de papel.
 */
import { z } from "zod";

import type { Role } from "@/lib/auth/types";
import { interfaceSettingsSchema, interfaceTemDestino, type InterfaceSettings } from "@/lib/navigation/interface";

export const PAPEIS_DE_CARGO = ["viewer", "agent", "manager"] as const;
export type PapelDeCargo = (typeof PAPEIS_DE_CARGO)[number];

export interface Cargo {
  id: string;
  organization_id: string;
  nome: string;
  descricao: string | null;
  papel: PapelDeCargo;
  interface_settings: InterfaceSettings;
  created_at: string;
  updated_at: string;
}

export const COLUNAS_DO_CARGO = "id, organization_id, nome, descricao, papel, interface_settings, created_at, updated_at";

export const cargoSchema = z
  .object({
    nome: z.string().trim().min(1).max(60),
    descricao: z.string().trim().max(300).nullable().optional(),
    papel: z.enum(PAPEIS_DE_CARGO),
    interface_settings: interfaceSettingsSchema,
  })
  .strict();
export type CargoInput = z.infer<typeof cargoSchema>;

/**
 * O que impede este cargo de existir — ou `null`. A seleção de telas precisa
 * deixar ao menos UMA tela de trabalho que o papel alcance: um cargo que só
 * mostra "Meu perfil" deixaria a pessoa olhando para uma tela vazia.
 */
export function motivoParaRecusarCargo(
  input: CargoInput,
  t: (frase: string) => string = (frase) => frase,
): string | null {
  if (!interfaceTemDestino(input.interface_settings, input.papel as Role)) {
    return t("Selecione ao menos uma tela que este papel possa usar.");
  }
  return null;
}

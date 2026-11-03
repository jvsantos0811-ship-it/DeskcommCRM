"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import type { AgenteParaDevolver } from "@/hooks/inbox/useAgentesParaDevolver";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agentes: readonly AgenteParaDevolver[];
  enviando: boolean;
  onConfirmar: (escolha: { agente_id: string; nota: string }) => void;
}

/**
 * PC-014: devolver para a IA num número com vários agentes. A pessoa escolhe
 * para qual agente a conversa volta e escreve em uma linha o que fez — essa
 * linha é o que o agente lê ao chegar (bloco de chegada), para não perguntar de
 * novo o que a pessoa já resolveu.
 */
export function DevolverParaAgenteDialog({ open, onOpenChange, agentes, enviando, onConfirmar }: Props) {
  const t = useT();
  const [agenteId, setAgenteId] = useState<string>("");
  const [nota, setNota] = useState("");
  const notaValida = nota.trim().length >= 3;
  const podeConfirmar = agenteId !== "" && notaValida && !enviando;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setAgenteId("");
          setNota("");
        }
        onOpenChange(v);
      }}
    >
      <DialogContent data-testid="devolver-para-agente-dialogo">
        <DialogHeader>
          <DialogTitle>{t("Devolver para a IA")}</DialogTitle>
          <DialogDescription>
            {t("Escolha o agente que continua o atendimento e conte em uma linha o que você fez.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="devolver-agente" className="block">
              {t("Agente")}
            </Label>
            <Select value={agenteId} onValueChange={setAgenteId}>
              <SelectTrigger id="devolver-agente" data-testid="devolver-agente">
                <SelectValue placeholder={t("Escolha o agente")} />
              </SelectTrigger>
              <SelectContent>
                {agentes.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="devolver-nota" className="block">
              {t("O que você fez")}
            </Label>
            <Input
              id="devolver-nota"
              data-testid="devolver-nota"
              maxLength={200}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder={t("Ex.: confirmei os documentos e expliquei o próximo passo")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancelar")}
          </Button>
          <Button
            data-testid="devolver-para-agente-confirmar"
            disabled={!podeConfirmar}
            onClick={() => onConfirmar({ agente_id: agenteId, nota: nota.trim() })}
          >
            {enviando ? t("Devolvendo...") : t("Devolver para a IA")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

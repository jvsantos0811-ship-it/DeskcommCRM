"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { waitConfigSchema } from "@/lib/followup/graph-schema";
import { MODOS_DE_ESPERA, opcoes } from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import { msToMin, minToMs, type ConfigOf } from "./shared";

/**
 * A UNIDADE da espera (fork, briefing do Operador item 5).
 *
 * A tela só aceitava minutos: um retorno de 30 dias era "43200", e quem monta a
 * régua de uma gestante (um toque por mês) errava a conta. O config continua em
 * milissegundos, como sempre — a unidade é só da tela, e nasce da maior que
 * divide os valores gravados sem resto (43200 min abre como "30 dias").
 */
const UNIDADES = { minutos: 1, horas: 60, dias: 1440 } as const;
type Unidade = keyof typeof UNIDADES;

function unidadeQueCabe(...minutos: number[]): Unidade {
  if (minutos.every((m) => m > 0 && m % UNIDADES.dias === 0)) return "dias";
  if (minutos.every((m) => m > 0 && m % UNIDADES.horas === 0)) return "horas";
  return "minutos";
}

/** 24 h: o piso da espera imune (`immune_wait_too_short` em validate-publish.ts). */
const PISO_DA_IMUNE_MIN = 24 * 60;

export function WaitForm({
  config,
  onChange,
}: {
  config: ConfigOf<"wait">;
  onChange: (c: ConfigOf<"wait">) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"fixed" | "smart">(config.mode);
  const [unidade, setUnidade] = useState<Unidade>(() =>
    config.mode === "fixed"
      ? unidadeQueCabe(msToMin(config.duration_ms))
      : unidadeQueCabe(msToMin(config.min_ms), msToMin(config.max_ms)),
  );
  // Os valores moram em MINUTOS no estado; a unidade só muda o que a tela mostra.
  const [durationMin, setDurationMin] = useState(
    config.mode === "fixed" ? msToMin(config.duration_ms) : 10,
  );
  const [minMin, setMinMin] = useState(config.mode === "smart" ? msToMin(config.min_ms) : 5);
  const [maxMin, setMaxMin] = useState(config.mode === "smart" ? msToMin(config.max_ms) : 60);
  const [guidance, setGuidance] = useState(config.mode === "smart" ? (config.guidance ?? "") : "");
  const [imune, setImune] = useState(config.mode === "fixed" && config.immune_to_reply === true);
  const [error, setError] = useState<string | null>(null);

  const fator = UNIDADES[unidade];
  const naTela = (minutos: number) => Math.round((minutos / fator) * 100) / 100;
  const daTela = (valor: number) => Math.round(valor * fator);

  const commit = (next: {
    mode: "fixed" | "smart";
    durationMin: number;
    minMin: number;
    maxMin: number;
    guidance: string;
    imune: boolean;
  }) => {
    const candidate =
      next.mode === "fixed"
        ? {
            mode: "fixed" as const,
            duration_ms: minToMs(next.durationMin),
            // Desligada, a chave NÃO vai: o fluxo que nunca usou a imunidade
            // segue byte a byte igual.
            ...(next.imune ? { immune_to_reply: true } : {}),
          }
        : {
            mode: "smart" as const,
            min_ms: minToMs(next.minMin),
            max_ms: minToMs(next.maxMin),
            ...(next.guidance.trim() ? { guidance: next.guidance } : {}),
          };
    const parsed = waitConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const estado = { mode, durationMin, minMin, maxMin, guidance, imune };

  const rotulos = {
    duracao: { minutos: t("Duração (minutos)"), horas: t("Duração (horas)"), dias: t("Duração (dias)") }[unidade],
    minimo: { minutos: t("Mínimo (min)"), horas: t("Mínimo (horas)"), dias: t("Mínimo (dias)") }[unidade],
    maximo: { minutos: t("Máximo (min)"), horas: t("Máximo (horas)"), dias: t("Máximo (dias)") }[unidade],
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="wait-mode">{t("Como calcular a espera")}</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as "fixed" | "smart";
            setMode(next);
            commit({ ...estado, mode: next });
          }}
        >
          <SelectTrigger id="wait-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(MODOS_DE_ESPERA).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="wait-unidade">{t("Unidade")}</Label>
        <Select value={unidade} onValueChange={(v) => setUnidade(v as Unidade)}>
          <SelectTrigger id="wait-unidade" data-testid="wait-unidade">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutos">{t("minutos")}</SelectItem>
            <SelectItem value="horas">{t("horas")}</SelectItem>
            <SelectItem value="dias">{t("dias")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "fixed" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="wait-duration">{rotulos.duracao}</Label>
            <Input
              id="wait-duration"
              type="number"
              min={unidade === "minutos" ? 5 : 1}
              step="any"
              value={naTela(durationMin)}
              onChange={(e) => {
                const v = daTela(Number(e.target.value));
                setDurationMin(v);
                commit({ ...estado, durationMin: v });
              }}
            />
          </div>
          {/* A espera imune existe no motor e no publicar (`immune_to_reply`),
              mas só entrava por `.fluxo.json`. É a cadência longa: o cliente
              falar hoje não antecipa o toque de daqui a um mês. */}
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={imune}
                onCheckedChange={(v) => {
                  setImune(v);
                  commit({ ...estado, imune: v });
                }}
                aria-label={t("Continuar esperando mesmo se o cliente responder")}
                data-testid="wait-imune"
              />
              {t("Continuar esperando mesmo se o cliente responder")}
            </label>
            <p className="text-xs text-text-muted">
              {t(
                "Para cadência longa, como um retorno mensal: a resposta do cliente não encurta nem cancela esta espera. Precisa de pelo menos 24 horas.",
              )}
            </p>
            {imune && durationMin < PISO_DA_IMUNE_MIN && (
              <p className="text-xs text-warning-fg" data-testid="wait-imune-curta">
                {t("Com menos de 24 horas de espera, o fluxo não publica com esta opção ligada.")}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wait-min">{rotulos.minimo}</Label>
              <Input
                id="wait-min"
                type="number"
                min={unidade === "minutos" ? 5 : 1}
                step="any"
                value={naTela(minMin)}
                onChange={(e) => {
                  const v = daTela(Number(e.target.value));
                  setMinMin(v);
                  commit({ ...estado, minMin: v });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wait-max">{rotulos.maximo}</Label>
              <Input
                id="wait-max"
                type="number"
                min={unidade === "minutos" ? 5 : 1}
                step="any"
                value={naTela(maxMin)}
                onChange={(e) => {
                  const v = daTela(Number(e.target.value));
                  setMaxMin(v);
                  commit({ ...estado, maxMin: v });
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wait-guidance">{t("Orientação (opcional)")}</Label>
            <Textarea
              id="wait-guidance"
              maxLength={500}
              value={guidance}
              onChange={(e) => {
                setGuidance(e.target.value);
                commit({ ...estado, guidance: e.target.value });
              }}
            />
          </div>
        </>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

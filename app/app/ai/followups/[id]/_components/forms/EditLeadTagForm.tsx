"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { editLeadTagConfigSchema } from "@/lib/followup/graph-schema";

import type { ConfigOf } from "./shared";

/**
 * O nó `edit_lead_tag` (#2065) — as tags que a caixa grava no lead e, desde a
 * 9006 do fork, as que ela TIRA antes de gravar.
 *
 * Duas listas, e não um seletor de modo: preencher as duas é TROCAR (tira
 * `1o-trimestre`, põe `2o-trimestre`); só a de cima, gravar; só a de baixo,
 * remover. Um fluxo antigo abre com a de baixo vazia e continua igual.
 *
 * O texto digitado fica NO CAMPO (vírgula no fim não some enquanto a pessoa
 * escreve) e o config só recebe o que passou no `editLeadTagConfigSchema` — os
 * MESMOS limites das ações `add_tag`/`remove_tag` (até 10 tags de até 60
 * caracteres).
 */
function separar(bruto: string): string[] {
  return bruto
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function EditLeadTagForm({
  config,
  onChange,
}: {
  config: ConfigOf<"edit_lead_tag">;
  onChange: (c: ConfigOf<"edit_lead_tag">) => void;
}) {
  const t = useT();
  const [texto, setTexto] = useState(() => config.tags.join(", "));
  const [textoRemover, setTextoRemover] = useState(() => (config.remover ?? []).join(", "));
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (tags: string[], remover: string[]) => {
    // `remover` vazio NÃO vira chave: o fluxo antigo segue byte a byte igual.
    const candidato = remover.length ? { tags, remover } : { tags };
    const parsed = editLeadTagConfigSchema.safeParse(candidato);
    if (!parsed.success) {
      setErro(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setErro(null);
    const igual =
      parsed.data.tags.join("\u0000") === config.tags.join("\u0000") &&
      (parsed.data.remover ?? []).join("\u0000") === (config.remover ?? []).join("\u0000");
    if (!igual) onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="edit-lead-tag">{t("Tags para gravar no lead")}</Label>
        <Input
          id="edit-lead-tag"
          value={texto}
          placeholder={t("ex.: vip, orcamento-aberto")}
          onChange={(e) => {
            setTexto(e.target.value);
            gravar(separar(e.target.value), separar(textoRemover));
          }}
          aria-invalid={erro !== null}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-lead-tag-remover">{t("Tags para tirar do lead (opcional)")}</Label>
        <Input
          id="edit-lead-tag-remover"
          value={textoRemover}
          placeholder={t("ex.: 1o-trimestre")}
          onChange={(e) => {
            setTextoRemover(e.target.value);
            gravar(separar(texto), separar(e.target.value));
          }}
          aria-invalid={erro !== null}
        />
      </div>
      {erro && <p className="text-xs text-error-fg">{erro}</p>}
      <p className="text-xs text-text-muted">
        {t(
          "Separe por vírgula. As tags de baixo saem primeiro e as de cima entram depois: preencher as duas troca uma tag pela outra. Tags que o lead já tem são mantidas.",
        )}
      </p>
    </div>
  );
}

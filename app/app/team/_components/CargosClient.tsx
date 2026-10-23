"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { InterfaceEditor } from "@/components/team/InterfaceEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { useCargos } from "@/hooks/team/useCargos";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { rotuloDoPapel, type Role } from "@/lib/auth/types";
import { interfaceSettingsSchema, interfaceTemDestino, INTERFACE_COMPLETA } from "@/lib/navigation/interface";
import { PAPEIS_DE_CARGO, type Cargo, type CargoInput, type PapelDeCargo } from "@/lib/team/cargos";

const SEM_CARGO = "__sem__";

/**
 * A aba Cargos da Equipe: os cargos da organização e a quem cada um se aplica.
 *
 * Um cargo junta o papel (o que a pessoa PODE fazer — quem recusa é a rota) e
 * as telas que ela VÊ. Editar um cargo muda todos que o têm; apagar não tira
 * acesso de ninguém. `manager` vê; só `admin` cria, edita e aplica.
 */
export function CargosClient({ canManage }: { canManage: boolean }) {
  const t = useT();
  const router = useRouter();
  const { lista, salvar, apagar, aplicar } = useCargos();
  const membros = useTeamMembers();
  const [editando, setEditando] = useState<Cargo | "novo" | null>(null);

  const cargos = lista.data ?? [];
  const ativos = (membros.data?.data ?? []).filter((m) => !m.revoked_at && m.accepted_at);
  const nomeDoCargo = (id: string | null | undefined) => cargos.find((c) => c.id === id)?.nome ?? null;

  return (
    <div className="flex flex-col gap-8" data-cargos>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-text">{t("Cargos")}</h2>
            <p className="text-sm text-muted-foreground">
              {t(
                "Um cargo junta o papel (o que a pessoa pode fazer) e as telas que ela vê. Editar um cargo atualiza todos que o têm.",
              )}
            </p>
          </div>
          {canManage && <Button onClick={() => setEditando("novo")}>{t("Novo cargo")}</Button>}
        </div>
        {lista.isLoading && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}
        {!lista.isLoading && cargos.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
            {t("Nenhum cargo ainda. Crie, por exemplo, “SDR” com Inbox e Kanban, ou “Recepção” só com a Agenda.")}
          </p>
        )}
        <ul className="grid gap-3 md:grid-cols-2">
          {cargos.map((c) => {
            const quantos = ativos.filter((m) => m.cargo_id === c.id).length;
            return (
              <li key={c.id} className="flex flex-col gap-2 rounded-lg border border-border p-4" data-cargo={c.nome}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text">{c.nome}</p>
                    {c.descricao && <p className="text-xs text-text-muted">{c.descricao}</p>}
                  </div>
                  <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-text">
                    {t(rotuloDoPapel(c.papel))}
                  </span>
                </div>
                <p className="text-xs text-text-muted">
                  {c.interface_settings.destinos
                    ? t("{n} telas selecionadas").replace("{n}", String(c.interface_settings.destinos.length))
                    : t("Todas as telas do papel")}
                  {" · "}
                  {quantos === 1 ? t("1 pessoa") : t("{n} pessoas").replace("{n}", String(quantos))}
                </p>
                {canManage && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditando(c)}>
                      {t("Editar")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={apagar.isPending}
                      onClick={() =>
                        apagar.mutate(c.id, {
                          onSuccess: () => toast.success(t("Cargo apagado. Quem tinha o cargo manteve o acesso que tinha.")),
                        })
                      }
                    >
                      {t("Apagar")}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {cargos.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-text">{t("Cargo de cada pessoa")}</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {ativos.map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-text">{m.full_name ?? m.email ?? m.user_id}</span>
                <span className="text-xs text-text-muted">{t(rotuloDoPapel(m.role as Role))}</span>
                {canManage ? (
                  <select
                    aria-label={`${t("Cargo de")} ${m.full_name ?? m.email ?? ""}`}
                    value={m.cargo_id ?? SEM_CARGO}
                    disabled={aplicar.isPending}
                    onChange={(e) => {
                      const cargoId = e.target.value === SEM_CARGO ? null : e.target.value;
                      aplicar.mutate(
                        { userId: m.user_id, cargoId },
                        {
                          onSuccess: () => {
                            router.refresh();
                            toast.success(
                              cargoId
                                ? t("Cargo aplicado: papel e telas atualizados.")
                                : t("Cargo removido. A pessoa manteve o papel e as telas que tinha."),
                            );
                          },
                        },
                      );
                    }}
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs text-text"
                  >
                    <option value={SEM_CARGO}>{t("Sem cargo")}</option>
                    {cargos.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xs text-text">{nomeDoCargo(m.cargo_id) ?? t("Sem cargo")}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">
            {t("Trocar o papel ou as telas de alguém à mão, na aba Membros, solta a pessoa do cargo.")}
          </p>
        </section>
      )}

      {editando && (
        <EditorDeCargo
          cargo={editando === "novo" ? null : editando}
          salvando={salvar.isPending}
          onCancelar={() => setEditando(null)}
          onSalvar={(input) =>
            salvar.mutate(
              { id: editando === "novo" ? undefined : editando.id, input },
              {
                onSuccess: () => {
                  setEditando(null);
                  router.refresh();
                  toast.success(t("Cargo salvo."));
                },
              },
            )
          }
        />
      )}
    </div>
  );
}

function EditorDeCargo({
  cargo,
  salvando,
  onCancelar,
  onSalvar,
}: {
  cargo: Cargo | null;
  salvando: boolean;
  onCancelar: () => void;
  onSalvar: (input: CargoInput) => void;
}) {
  const t = useT();
  const [nome, setNome] = useState(cargo?.nome ?? "");
  const [descricao, setDescricao] = useState(cargo?.descricao ?? "");
  const [papel, setPapel] = useState<PapelDeCargo>(cargo?.papel ?? "agent");
  const [telas, setTelas] = useState(cargo?.interface_settings ?? INTERFACE_COMPLETA);
  const valido =
    nome.trim().length > 0 && interfaceSettingsSchema.safeParse(telas).success && interfaceTemDestino(telas, papel);

  return (
    <Dialog open onOpenChange={(open) => !open && !salvando && onCancelar()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{cargo ? t("Editar cargo") : t("Novo cargo")}</DialogTitle>
          <DialogDescription>
            {cargo
              ? t("Ao salvar, todos que têm este cargo recebem o papel e as telas novos.")
              : t("Depois de criar, aplique o cargo às pessoas na lista abaixo.")}
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1 text-sm">
          {t("Nome do cargo")}
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            maxLength={60}
            placeholder={t("Ex.: SDR, Closer, Recepção")}
            className="h-9 rounded-md border border-border bg-background px-2.5 text-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("Descrição (opcional)")}
          <input
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            maxLength={300}
            className="h-9 rounded-md border border-border bg-background px-2.5 text-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("O que este cargo pode fazer")}
          <select
            value={papel}
            onChange={(e) => setPapel(e.target.value as PapelDeCargo)}
            className="h-9 rounded-md border border-border bg-background px-2 text-text"
          >
            {PAPEIS_DE_CARGO.map((p) => (
              <option key={p} value={p}>
                {t(rotuloDoPapel(p))}
              </option>
            ))}
          </select>
          <span className="text-xs text-text-muted">
            {t("Administrador não é cargo: escolha quem administra um por um, na aba Membros.")}
          </span>
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span>{t("Telas que este cargo vê")}</span>
          <InterfaceEditor value={telas} onChange={setTelas} role={papel} disabled={salvando} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancelar} disabled={salvando}>
            {t("Cancelar")}
          </Button>
          <Button
            disabled={!valido || salvando}
            onClick={() =>
              onSalvar({
                nome: nome.trim(),
                descricao: descricao.trim() || null,
                papel,
                interface_settings: telas,
              })
            }
          >
            {salvando ? t("Salvando…") : t("Salvar cargo")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

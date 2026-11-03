/**
 * PC-021, item 6: quantas mídias o sistema NÃO entendeu por dia (áudio só de
 * ruído, curto demais, foto borrada, PDF sem texto, leitura que falhou) — nas
 * quais a IA pediu para a pessoa repetir ou escrever. Calculado na hora a
 * partir das próprias mensagens (o marcador gravado no derivado), sem tabela.
 */
import { Card } from "@/components/ui/card";
import type { MidiasNaoEntendidasPorDia } from "@/lib/messaging/media/nao-entendidas-por-dia";

interface Textos {
  titulo: string;
  explicacao: string;
  vazio: string;
  dia: string;
  audios: string;
  outras: string;
}

export function MidiasNaoEntendidas({ linhas, textos }: { linhas: MidiasNaoEntendidasPorDia[]; textos: Textos }) {
  return (
    <Card className="max-w-3xl space-y-2 p-4" data-testid="midias-nao-entendidas">
      <h2 className="text-sm font-semibold">{textos.titulo}</h2>
      <p className="text-xs text-muted-foreground">{textos.explicacao}</p>
      {linhas.length === 0 ? (
        <p className="text-xs text-muted-foreground">{textos.vazio}</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              <th className="py-1 font-medium">{textos.dia}</th>
              <th className="py-1 font-medium">{textos.audios}</th>
              <th className="py-1 font-medium">{textos.outras}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.dia} className="border-t border-border">
                <td className="py-1">{l.dia}</td>
                <td className="py-1 tabular-nums">{l.audios}</td>
                <td className="py-1 tabular-nums">{l.outras}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * CONTRATO É COISA DE PESSOA (fork, migration 9008 — item 7 do briefing).
 *
 * Decisão do dono: "por enquanto vamos deixar um humano enviar o contrato" e
 * "qualquer atendente" pode. Três portas que, abertas, desmentiriam isso sem
 * nenhum teste de tela perceber:
 *
 *   1. ⭐ as rotas de contrato não estão em `lib/auth/public-paths.ts` — fora
 *      dali o proxy só aceita cookie de sessão, então token de integração (e a
 *      IA que fala por MCP) recebe 401 antes do handler;
 *   2. ⭐ nenhum código de IA (agente, MCP, motor, workers) toca a tabela ou as
 *      rotas de contrato;
 *   3. toda rota que escreve declara o suporte só-leitura E o papel `agent`; a
 *      que lê, `viewer`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

const ID = "33333333-3333-4333-8333-333333333333";
const ROTAS = {
  "app/api/v1/leads/[id]/contracts/route.ts": { url: `/api/v1/leads/${ID}/contracts`, escreve: true, le: true },
  "app/api/v1/contracts/[id]/send/route.ts": { url: `/api/v1/contracts/${ID}/send`, escreve: true, le: false },
  "app/api/v1/contracts/[id]/decide/route.ts": { url: `/api/v1/contracts/${ID}/decide`, escreve: true, le: false },
  "app/api/v1/contracts/[id]/arquivo/route.ts": { url: `/api/v1/contracts/${ID}/arquivo`, escreve: false, le: true },
} as const;

function arquivos(dir: string): string[] {
  const raiz = path.join(process.cwd(), dir);
  if (!fs.existsSync(raiz)) return [];
  const saida: string[] = [];
  for (const e of fs.readdirSync(raiz, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
    saida.push(path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
  }
  return saida;
}

describe("contrato: só uma pessoa da equipe envia", () => {
  it("⭐ nenhuma rota de contrato é pública para o proxy (token de integração não chega)", () => {
    for (const { url } of Object.values(ROTAS)) expect(isPublicPath(url), url).toBe(false);
    // controle positivo: o instrumento enxerga uma rota que de fato aceita token.
    expect(isPublicPath("/api/v1/contacts")).toBe(true);
  });

  it("⭐ nenhum código de IA toca a tabela ou as rotas de contrato", () => {
    const dirs = ["lib/mcp", "lib/ai", "lib/agent-engine", "workers"];
    const lidos = dirs.flatMap(arquivos);
    expect(lidos.length, "a varredura precisa ler alguma coisa").toBeGreaterThan(100);
    const tocam = lidos.filter((f) => /crm_contracts|\/api\/v1\/contracts|\/contracts["'`]/.test(fs.readFileSync(f, "utf8")));
    expect(tocam).toEqual([]);
  });

  it("toda rota que escreve declara o suporte só-leitura e `agent`; a que lê, `viewer`", () => {
    for (const [arquivo, r] of Object.entries(ROTAS)) {
      const fonte = fs.readFileSync(path.join(process.cwd(), arquivo), "utf8");
      if (r.escreve) {
        expect(fonte, arquivo).toContain("requireSupportWrite()");
        expect(fonte, arquivo).toContain('requireRole("agent"');
      }
      if (r.le) expect(fonte, arquivo).toContain('requireRole("viewer"');
      // service role ignora RLS: toda consulta filtra a organização da sessão.
      expect(fonte, arquivo).not.toMatch(/organization_id[^\n]*(body|corpo\.data|form\?\.get)/);
    }
  });
});

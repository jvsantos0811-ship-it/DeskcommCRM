import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * VÍDEO DE AQUECIMENTO NO POSTGRES DE VERDADE (PC-045 parte 2, migration 9042).
 * Só do servidor (com a linha da própria organização existindo, o admin dela
 * por JWT e o anon recebem `permission denied`), e a forma: caminho só na pasta
 * do aquecimento da organização, mp4/3gp, até 16 MB, texto até 500.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90420000-0000-4000-8000-0000000000a1";
const ADMIN_DA_ORG = "90420000-0000-4000-8000-0000000000e5";
const CAMINHO = `${ORG}/aquecimento/video-1.mp4`;

async function como(papel: "anon" | "authenticated", sql: string): Promise<unknown> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${papel}`);
    if (papel === "authenticated") {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN_DA_ORG, role: "authenticated" })]);
    }
    return (await c.query(sql)).rows;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, 'inv-video-aquecimento', 'Video LTDA', 'Video', '{}'::jsonb) on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into agenda_video_aquecimento (organization_id, storage_path, mime, bytes) values ($1, $2, 'video/mp4', 1000)
     on conflict (organization_id) do nothing`,
    [ORG, CAMINHO],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("vídeo de aquecimento (9042)", () => {
  it("⭐ só o service_role: anon e o admin da organização não leem nem escrevem", async () => {
    for (const papel of ["anon", "authenticated"] as const) {
      await expect(como(papel, `select * from agenda_video_aquecimento`)).rejects.toThrow(/permission denied/);
      await expect(como(papel, `delete from agenda_video_aquecimento`)).rejects.toThrow(/permission denied/);
      await expect(como(papel, `update agenda_video_aquecimento set texto = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(
        como(papel, `insert into agenda_video_aquecimento (organization_id, storage_path, mime, bytes) values ('${ORG}', '${CAMINHO}', 'video/mp4', 1)`),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("a forma: caminho da pasta do aquecimento, formato, tamanho e texto", async () => {
    await expect(pool.query(`update agenda_video_aquecimento set storage_path = 'outra/pasta/x.mp4' where organization_id = $1`, [ORG])).rejects.toThrow(
      /agenda_video_aquecimento_storage_path_check/,
    );
    await expect(pool.query(`update agenda_video_aquecimento set mime = 'video/quicktime' where organization_id = $1`, [ORG])).rejects.toThrow(
      /agenda_video_aquecimento_mime_check/,
    );
    await expect(pool.query(`update agenda_video_aquecimento set bytes = 16777217 where organization_id = $1`, [ORG])).rejects.toThrow(
      /agenda_video_aquecimento_bytes_check/,
    );
    await expect(pool.query(`update agenda_video_aquecimento set texto = repeat('x', 501) where organization_id = $1`, [ORG])).rejects.toThrow(
      /agenda_video_aquecimento_texto_check/,
    );
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPool } from "./config";
import { logger } from "./logger";
import type { Pool } from "pg";

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(48170413)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const file of readdirSync(join(process.cwd(), "migrations"))
      .filter((x) => /^\d+.*\.sql$/.test(x))
      .sort()) {
      if (
        (
          await client.query(
            "SELECT 1 FROM schema_migrations WHERE version=$1",
            [file],
          )
        ).rowCount
      )
        continue;
      await client.query("BEGIN");
      try {
        await client.query(
          readFileSync(join(process.cwd(), "migrations", file), "utf8"),
        );
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(48170413)").catch(() => {});
    client.release();
  }
}
if (require.main === module) {
  const pool = createPool();
  migrate(pool)
    .then(() => logger.info("Migrations applied"))
    .catch(() => {
      logger.error("Migration failed");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

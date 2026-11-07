import "dotenv/config";
import { readFileSync } from "node:fs";
import { Pool, type PoolConfig } from "pg";
import { logger } from "./logger";

export function integer(
  name: string,
  fallback: number,
  min = 1,
  max = 65535,
): number {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`Invalid ${name}`);
  return n;
}

export function databaseConfig(url = process.env.DATABASE_URL): PoolConfig {
  if (!url) throw new Error("DATABASE_URL is required");
  const parsed = new URL(url);
  const mode = parsed.searchParams.get("sslmode");
  const tls =
    process.env.DATABASE_SSL === "true" || (!!mode && mode !== "disable");
  // Avoid pg URL options overriding certificate verification. Configure CA explicitly.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    parsed.searchParams.delete(key);
  if (
    process.env.DATABASE_SSL &&
    !["true", "false"].includes(process.env.DATABASE_SSL)
  )
    throw new Error("Invalid DATABASE_SSL");
  return {
    connectionString: parsed.toString(),
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    ssl: tls
      ? {
          rejectUnauthorized: true,
          ...(process.env.DATABASE_CA_FILE
            ? { ca: readFileSync(process.env.DATABASE_CA_FILE, "utf8") }
            : {}),
        }
      : false,
  };
}
export function createPool(url?: string): Pool {
  const pool = new Pool(databaseConfig(url));
  pool.on("error", () => logger.error("Database idle connection failed"));
  return pool;
}

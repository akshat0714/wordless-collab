import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";

import { loadDatabaseUrl } from "./config.js";
import { JsonLogger, safeErrorCode } from "./logger.js";

const { Client } = pg;
const MIGRATION_LOCK = 7_311_937_049;

async function migrate(): Promise<void> {
  const logger = new JsonLogger();
  const connectionString = loadDatabaseUrl(process.env, true) as string;
  const client = new Client({ connectionString, application_name: "wordless-zendesk-gateway-migrate" });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS wordless_gateway_migrations (
         name text PRIMARY KEY,
         sha256 char(64) NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const directory = new URL("../migrations/", import.meta.url);
    const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name)).sort();
    for (const name of names) {
      const bytes = await readFile(new URL(name, directory));
      if (bytes.byteLength > 1_048_576) throw new Error(`Migration ${name} exceeds the size limit.`);
      const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const existing = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM wordless_gateway_migrations WHERE name = $1",
        [name],
      );
      if (existing.rows[0] !== undefined) {
        if (existing.rows[0].sha256 !== sha256) throw new Error(`Applied migration ${name} has changed.`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO wordless_gateway_migrations (name, sha256) VALUES ($1, $2)",
          [name, sha256],
        );
        await client.query("COMMIT");
        logger.log("info", "migration_applied", { count: 1 });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    await client.end();
  }
}

migrate().catch((error) => {
  new JsonLogger().log("error", "migration_failed", { error_code: safeErrorCode(error) });
  process.exitCode = 1;
});

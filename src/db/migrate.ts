/**
 * Minimal migration runner.
 * Reads .sql files from /migrations in order and applies any that have not run yet.
 * Tracks applied migrations in the `schema_migrations` table.
 */
import fs from "fs";
import path from "path";
import { sql } from "./client.js";

export async function runMigrations() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const migrationsDir = path.resolve(process.cwd(), "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = await sql<{ name: string }[]>`
    SELECT name FROM schema_migrations
  `;
  const appliedSet = new Set(applied.map((r) => r.name));

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    console.log(`Applying migration: ${file}`);
    const content = fs.readFileSync(path.join(migrationsDir, file), "utf8");

    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx.unsafe(`INSERT INTO schema_migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
    });

    console.log(`  ✓ ${file}`);
  }

  console.log("Migrations complete.");
}

// Allow running directly: node dist/db/migrate.js
if (process.argv[1]?.endsWith("migrate.js") || process.argv[1]?.endsWith("migrate.ts")) {
  runMigrations()
    .then(() => sql.end())
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

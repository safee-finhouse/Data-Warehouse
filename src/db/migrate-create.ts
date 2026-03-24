/**
 * Creates a new blank migration file.
 * Usage: npm run migrate:create -- <name>
 * Example: npm run migrate:create -- add_xero_tokens
 * Produces: migrations/002_add_xero_tokens.sql
 */
import fs from "fs";
import path from "path";

const name = process.argv[2];

if (!name) {
  console.error("Usage: npm run migrate:create -- <name>");
  console.error("Example: npm run migrate:create -- add_xero_tokens");
  process.exit(1);
}

const migrationsDir = path.resolve(process.cwd(), "migrations");

const existing = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const next = existing.length + 1;
const padded = String(next).padStart(3, "0");
const filename = `${padded}_${name}.sql`;
const filepath = path.join(migrationsDir, filename);

fs.writeFileSync(
  filepath,
  `-- Migration: ${filename}\n-- Created: ${new Date().toISOString()}\n\n`
);

console.log(`Created: migrations/${filename}`);

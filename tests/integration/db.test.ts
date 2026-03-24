/**
 * Database integrity and sync flow tests.
 * Runs against the real local database — requires postgres to be running.
 */
import { describe, test, expect, afterAll } from "vitest";
import { sql } from "../../src/db/client.js";

afterAll(async () => {
  await sql.end();
});

// ─── Schema integrity ─────────────────────────────────────────────────────────

describe("core schema", () => {
  test("core.tenants has at least one tenant", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM core.tenants
    `;
    expect(Number(count)).toBeGreaterThan(0);
  });

  test("core.xero_connections has at least one active connection", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM core.xero_connections WHERE is_active = true
    `;
    expect(Number(count)).toBeGreaterThan(0);
  });

  test("every xero_connection has a valid tenant", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM core.xero_connections c
      LEFT JOIN core.tenants t ON t.id = c.tenant_id
      WHERE t.id IS NULL
    `;
    expect(Number(count)).toBe(0);
  });

  test("every xero_connection has a valid token", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM core.xero_connections c
      LEFT JOIN xero_tokens t ON t.id = c.token_id
      WHERE t.id IS NULL
    `;
    expect(Number(count)).toBe(0);
  });
});

describe("xero_invoices", () => {
  test("has 2600 invoices", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM xero_invoices
    `;
    expect(Number(count)).toBe(2600);
  });

  test("all invoices reference a valid core.xero_connection", async () => {
    const [{ orphans }] = await sql<{ orphans: string }[]>`
      SELECT COUNT(*) AS orphans
      FROM xero_invoices i
      LEFT JOIN core.xero_connections c ON c.id = i.connection_id
      WHERE c.id IS NULL
    `;
    expect(Number(orphans)).toBe(0);
  });

  test("raw JSONB column is populated", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM xero_invoices WHERE raw IS NULL
    `;
    expect(Number(count)).toBe(0);
  });

  test("has both ACCREC and ACCPAY invoice types", async () => {
    const rows = await sql<{ type: string }[]>`
      SELECT DISTINCT type FROM xero_invoices ORDER BY type
    `;
    const types = rows.map((r) => r.type);
    expect(types).toContain("ACCREC");
    expect(types).toContain("ACCPAY");
  });
});

describe("ops schema", () => {
  test("ops.sync_runs has at least one completed run", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM ops.sync_runs WHERE status = 'completed'
    `;
    expect(Number(count)).toBeGreaterThan(0);
  });

  test("all completed runs have a duration_ms", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM ops.sync_runs
      WHERE status = 'completed' AND duration_ms IS NULL
    `;
    expect(Number(count)).toBe(0);
  });

  test("ops.sync_run_steps has completed invoice steps", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM ops.sync_run_steps
      WHERE entity = 'invoices' AND status = 'completed'
    `;
    expect(Number(count)).toBeGreaterThan(0);
  });

  test("completed invoice steps have records_synced > 0", async () => {
    const [{ min_synced }] = await sql<{ min_synced: string }[]>`
      SELECT MIN(records_synced) AS min_synced
      FROM ops.sync_run_steps
      WHERE entity = 'invoices' AND status = 'completed'
    `;
    expect(Number(min_synced)).toBeGreaterThan(0);
  });

  test("ops.sync_checkpoints has invoice checkpoint", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM ops.sync_checkpoints
      WHERE entity = 'invoices' AND last_modified_at IS NOT NULL
    `;
    expect(Number(count)).toBeGreaterThan(0);
  });

  test("no orphaned sync_run_steps (all reference valid runs)", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM ops.sync_run_steps s
      LEFT JOIN ops.sync_runs r ON r.id = s.sync_run_id
      WHERE r.id IS NULL
    `;
    expect(Number(count)).toBe(0);
  });
});

describe("incremental sync checkpoint", () => {
  test("checkpoint last_modified_at is in the past", async () => {
    const [row] = await sql<{ last_modified_at: Date }[]>`
      SELECT last_modified_at FROM ops.sync_checkpoints WHERE entity = 'invoices'
    `;
    expect(row.last_modified_at.getTime()).toBeLessThan(Date.now());
  });

  test("checkpoint last_modified_at is recent (within last 24 hours)", async () => {
    const [row] = await sql<{ last_modified_at: Date }[]>`
      SELECT last_modified_at FROM ops.sync_checkpoints WHERE entity = 'invoices'
    `;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    expect(row.last_modified_at.getTime()).toBeGreaterThan(oneDayAgo);
  });
});

/**
 * Sync orchestrator.
 * Creates an ops.sync_run record, runs all entity syncs, updates final status.
 * Add new entity syncs inside the try block as they are built.
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { syncInvoices } from "./invoices.js";

export interface SyncResult {
  runId: string;
  connectionId: string;
  tenantName: string;
  invoices: { synced: number };
  durationMs: number;
}

export async function syncConnection(
  connectionId: string,
  triggeredBy: "manual" | "scheduled" | "webhook" = "manual"
): Promise<SyncResult> {
  const [connection] = await sql<{
    tenant_id: string;
    xero_tenant_id: string;
    xero_tenant_name: string;
  }[]>`
    SELECT tenant_id, xero_tenant_id, xero_tenant_name
    FROM core.xero_connections
    WHERE id = ${connectionId} AND is_active = true
  `;

  if (!connection) throw new Error(`Active connection not found: ${connectionId}`);

  // Create the run record
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO ops.sync_runs (connection_id, tenant_id, status, triggered_by, started_at)
    VALUES (${connectionId}, ${connection.tenant_id}, 'running', ${triggeredBy}, now())
    RETURNING id
  `;

  const start = Date.now();
  logger.info("Sync started", { runId: run.id, tenant: connection.xero_tenant_name });

  try {
    const invoices = await syncInvoices(connectionId, connection.xero_tenant_id, run.id);
    const durationMs = Date.now() - start;

    await sql`
      UPDATE ops.sync_runs
      SET status = 'completed', completed_at = now(), duration_ms = ${durationMs}
      WHERE id = ${run.id}
    `;

    logger.info("Sync completed", { runId: run.id, durationMs, ...invoices });

    return {
      runId: run.id,
      connectionId,
      tenantName: connection.xero_tenant_name,
      invoices,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);

    await sql`
      UPDATE ops.sync_runs
      SET status = 'failed', completed_at = now(), duration_ms = ${durationMs}, error = ${errorMsg}
      WHERE id = ${run.id}
    `;

    logger.error("Sync failed", { runId: run.id, error: errorMsg });
    throw err;
  }
}

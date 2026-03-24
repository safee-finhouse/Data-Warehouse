/**
 * Multi-tenant sync runner.
 *
 * Queries all active Xero connections and runs a full sync for each one.
 * Connections are processed sequentially to avoid Xero rate-limit pressure.
 *
 * Each connection gets its own ops.sync_run record.
 * Failures on one connection are logged and recorded but do not abort the others.
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { syncConnection, type SyncResult } from "./sync.service.js";

export interface ConnectionSummary {
  connectionId: string;
  tenantName: string;
  result: SyncResult | null;
  error: string | null;
}

export interface RunnerResult {
  totalConnections: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  connections: ConnectionSummary[];
}

export async function syncAllConnections(
  triggeredBy: "manual" | "scheduled" | "webhook" = "scheduled",
): Promise<RunnerResult> {
  const connections = await sql<{
    id: string;
    xero_tenant_name: string;
  }[]>`
    SELECT id, xero_tenant_name
    FROM core.xero_connections
    WHERE is_active = true
    ORDER BY created_at
  `;

  logger.info("Runner: starting full sync", {
    triggeredBy,
    connections: connections.length,
  });

  const start = Date.now();
  const summaries: ConnectionSummary[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const conn of connections) {
    logger.info("Runner: syncing connection", {
      connectionId: conn.id,
      tenant: conn.xero_tenant_name,
    });

    try {
      const result = await syncConnection(conn.id, triggeredBy);
      succeeded++;
      summaries.push({
        connectionId: conn.id,
        tenantName: conn.xero_tenant_name,
        result,
        error: null,
      });
    } catch (err) {
      failed++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("Runner: connection sync failed", {
        connectionId: conn.id,
        tenant: conn.xero_tenant_name,
        error: errorMsg,
      });
      summaries.push({
        connectionId: conn.id,
        tenantName: conn.xero_tenant_name,
        result: null,
        error: errorMsg,
      });
    }
  }

  const durationMs = Date.now() - start;

  logger.info("Runner: full sync complete", {
    triggeredBy,
    totalConnections: connections.length,
    succeeded,
    failed,
    durationMs,
  });

  return {
    totalConnections: connections.length,
    succeeded,
    failed,
    durationMs,
    connections: summaries,
  };
}

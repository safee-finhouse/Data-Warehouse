/**
 * Sync trigger and history routes.
 *
 * POST /sync/connections/:id/run  → trigger sync for one connection
 * GET  /sync/connections          → list connections with last run stats
 * GET  /sync/runs                 → list recent sync runs (all connections)
 * GET  /sync/runs/:id             → get one run with its steps
 */
import { FastifyInstance } from "fastify";
import { sql } from "../../db/client.js";
import { syncConnection } from "./sync.service.js";

export async function syncRoutes(app: FastifyInstance) {
  // ── POST /sync/connections/:id/run ───────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/connections/:id/run",
    async (req, reply) => {
      const result = await syncConnection(req.params.id);
      return reply.send(result);
    }
  );

  // ── GET /sync/connections ────────────────────────────────────────────────────
  app.get("/connections", async (_req, reply) => {
    const rows = await sql`
      SELECT
        c.id,
        t.name                    AS tenant_name,
        c.xero_tenant_name,
        c.is_active,
        r.id                      AS last_run_id,
        r.status                  AS last_run_status,
        r.completed_at            AS last_run_at,
        r.duration_ms             AS last_run_duration_ms,
        chk.last_modified_at      AS last_synced_at,
        COUNT(i.id)               AS invoice_count
      FROM core.xero_connections c
      JOIN core.tenants t ON t.id = c.tenant_id
      LEFT JOIN ops.sync_runs r ON r.id = (
        SELECT id FROM ops.sync_runs
        WHERE connection_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      )
      LEFT JOIN ops.sync_checkpoints chk
        ON chk.connection_id = c.id AND chk.entity = 'invoices'
      LEFT JOIN xero_invoices i ON i.connection_id = c.id
      GROUP BY c.id, t.name, c.xero_tenant_name, c.is_active,
               r.id, r.status, r.completed_at, r.duration_ms, chk.last_modified_at
      ORDER BY c.created_at DESC
    `;
    return reply.send(rows);
  });

  // ── GET /sync/runs ────────────────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: string } }>("/runs", async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);
    const rows = await sql`
      SELECT
        r.id,
        r.status,
        r.triggered_by,
        r.started_at,
        r.completed_at,
        r.duration_ms,
        r.error,
        c.xero_tenant_name,
        t.name AS tenant_name
      FROM ops.sync_runs r
      JOIN core.xero_connections c ON c.id = r.connection_id
      JOIN core.tenants t ON t.id = r.tenant_id
      ORDER BY r.created_at DESC
      LIMIT ${limit}
    `;
    return reply.send(rows);
  });

  // ── GET /sync/runs/:id ────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const [run] = await sql`
      SELECT
        r.*,
        c.xero_tenant_name,
        t.name AS tenant_name
      FROM ops.sync_runs r
      JOIN core.xero_connections c ON c.id = r.connection_id
      JOIN core.tenants t ON t.id = r.tenant_id
      WHERE r.id = ${req.params.id}
    `;
    if (!run) return reply.code(404).send({ error: "Run not found" });

    const steps = await sql`
      SELECT id, entity, status, records_synced, records_failed,
             started_at, completed_at, error
      FROM ops.sync_run_steps
      WHERE sync_run_id = ${req.params.id}
      ORDER BY created_at
    `;

    return reply.send({ ...run, steps });
  });
}

/**
 * Admin dashboard backend routes.
 *
 * All routes are prefixed /admin (registered in index.ts).
 * All queries target views or indexed columns — no sequential scans on large tables.
 *
 * Route map:
 *   GET /admin/metrics              → system-wide overview (vw_dashboard_metrics)
 *   GET /admin/tenants              → tenant + connection status with freshness summary
 *   GET /admin/sync/history         → paginated sync run history (vw_sync_run_summary)
 *   GET /admin/sync/history/:id     → single run detail with per-entity steps
 *   GET /admin/freshness            → per-connection, per-entity data freshness
 *   GET /admin/uploads              → manual CSV upload batches + stats
 *   GET /admin/errors               → recent failures across syncs and uploads
 */
import type { FastifyInstance } from "fastify";
import { sql } from "../../db/client.js";

export async function adminRoutes(app: FastifyInstance) {

  // ── GET /admin/metrics ────────────────────────────────────────────────────────
  // System-wide health snapshot. Single-row from vw_dashboard_metrics.
  app.get("/metrics", async (_req, reply) => {
    const [metrics] = await sql`
      SELECT * FROM ops.vw_dashboard_metrics
    `;
    return reply.send(metrics);
  });

  // ── GET /admin/tenants ────────────────────────────────────────────────────────
  // One row per active connection showing: last sync time, freshness status,
  // warehouse record counts. Aggregates freshness across all entities to give a
  // single worst-case status per connection.
  app.get("/tenants", async (_req, reply) => {
    const rows = await sql`
      SELECT
        f.tenant_id,
        f.tenant_name,
        f.tenant_is_active,
        f.connection_id,
        f.xero_tenant_name,
        f.connection_is_active,
        -- worst freshness across all entities for this connection
        CASE
          WHEN bool_or(f.freshness_status = 'never_synced') THEN 'never_synced'
          WHEN bool_or(f.freshness_status = 'stale')        THEN 'stale'
          WHEN bool_or(f.freshness_status = 'recent')       THEN 'recent'
          ELSE                                                    'fresh'
        END                                        AS freshness_status,
        MAX(f.last_modified_at)                    AS last_synced_at,
        MIN(f.hours_since_sync)                    AS min_hours_since_sync,
        MAX(f.hours_since_sync)                    AS max_hours_since_sync,
        f.last_run_status,
        f.last_run_started_at,
        f.last_run_completed_at,
        f.last_run_duration_ms,
        f.last_run_error,
        -- warehouse record counts
        COUNT(DISTINCT fi.id)                      AS invoice_count,
        COUNT(DISTINCT fp.id)                      AS payment_count,
        COUNT(DISTINCT dc.id)                      AS contact_count
      FROM ops.vw_tenant_freshness f
      LEFT JOIN warehouse.fact_invoice fi
        ON fi.tenant_id = f.tenant_id
      LEFT JOIN warehouse.fact_payment fp
        ON fp.tenant_id = f.tenant_id
      LEFT JOIN warehouse.dim_contact dc
        ON dc.tenant_id = f.tenant_id
      GROUP BY
        f.tenant_id, f.tenant_name, f.tenant_is_active,
        f.connection_id, f.xero_tenant_name, f.connection_is_active,
        f.last_run_status, f.last_run_started_at,
        f.last_run_completed_at, f.last_run_duration_ms, f.last_run_error
      ORDER BY f.tenant_name
    `;
    return reply.send(rows);
  });

  // ── GET /admin/sync/history ───────────────────────────────────────────────────
  // Paginated list of sync runs with step-level aggregates.
  // Query params:
  //   limit    (default 50, max 200)
  //   status   filter by status ('completed' | 'failed' | 'running')
  //   tenantId filter to one tenant
  app.get<{
    Querystring: { limit?: string; status?: string; tenantId?: string };
  }>("/sync/history", async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);
    const { status, tenantId } = req.query;

    const rows = await sql`
      SELECT
        id,
        tenant_id,
        tenant_name,
        connection_id,
        xero_tenant_name,
        status,
        triggered_by,
        started_at,
        completed_at,
        duration_ms,
        error,
        created_at,
        total_steps,
        completed_steps,
        failed_steps,
        skipped_steps,
        total_records_synced,
        total_records_failed
      FROM ops.vw_sync_run_summary
      WHERE
        (${status ?? null} IS NULL OR status = ${status ?? null})
        AND (${tenantId ?? null} IS NULL OR tenant_id = ${tenantId ?? null}::uuid)
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return reply.send(rows);
  });

  // ── GET /admin/sync/history/:id ───────────────────────────────────────────────
  // Single run with full per-entity step breakdown.
  app.get<{ Params: { id: string } }>("/sync/history/:id", async (req, reply) => {
    const [run] = await sql`
      SELECT * FROM ops.vw_sync_run_summary
      WHERE id = ${req.params.id}::uuid
    `;
    if (!run) return reply.code(404).send({ error: "Sync run not found" });

    const steps = await sql`
      SELECT
        id,
        entity,
        status,
        records_synced,
        records_failed,
        started_at,
        completed_at,
        EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS duration_ms,
        error
      FROM ops.sync_run_steps
      WHERE sync_run_id = ${req.params.id}::uuid
      ORDER BY created_at
    `;

    return reply.send({ ...run, steps });
  });

  // ── GET /admin/freshness ──────────────────────────────────────────────────────
  // Per-entity freshness for every connection (or filtered to one tenant).
  // Query params:
  //   tenantId    filter to one tenant
  //   staleOnly   'true' to show only stale/never_synced entities
  app.get<{
    Querystring: { tenantId?: string; staleOnly?: string };
  }>("/freshness", async (req, reply) => {
    const { tenantId, staleOnly } = req.query;
    const onlyStale = staleOnly === "true";

    const rows = await sql`
      SELECT
        tenant_id,
        tenant_name,
        connection_id,
        xero_tenant_name,
        entity,
        last_modified_at,
        hours_since_sync,
        freshness_status,
        last_run_status,
        last_run_completed_at,
        last_run_error
      FROM ops.vw_tenant_freshness
      WHERE
        (${tenantId ?? null} IS NULL OR tenant_id = ${tenantId ?? null}::uuid)
        AND (${onlyStale} = false OR freshness_status IN ('stale', 'never_synced'))
      ORDER BY tenant_name, entity
    `;
    return reply.send(rows);
  });

  // ── GET /admin/uploads ────────────────────────────────────────────────────────
  // Recent manual CSV upload batches with per-batch line stats.
  // Query params:
  //   tenantId  filter to one tenant
  //   status    filter by status
  //   limit     (default 50, max 200)
  app.get<{
    Querystring: { tenantId?: string; status?: string; limit?: string };
  }>("/uploads", async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);
    const { tenantId, status } = req.query;

    const rows = await sql`
      SELECT
        ub.id,
        ub.tenant_id,
        t.name                                     AS tenant_name,
        ub.filename,
        ub.file_size_bytes,
        ub.row_count,
        ub.status,
        ub.error,
        ub.created_at,
        ub.completed_at,
        EXTRACT(EPOCH FROM (ub.completed_at - ub.created_at)) * 1000
                                                   AS duration_ms,
        -- counts from the normalised lines table
        COUNT(l.id)                                AS total_lines,
        COUNT(l.id) FILTER (WHERE l.approved)      AS approved_lines,
        COUNT(l.id) FILTER (WHERE NOT l.approved)  AS pending_lines
      FROM manual_inputs.upload_batches ub
      JOIN core.tenants t ON t.id = ub.tenant_id
      LEFT JOIN manual_inputs.uncoded_statement_lines l ON l.batch_id = ub.id
      WHERE
        (${tenantId ?? null} IS NULL OR ub.tenant_id = ${tenantId ?? null}::uuid)
        AND (${status ?? null} IS NULL OR ub.status = ${status ?? null})
      GROUP BY ub.id, t.name
      ORDER BY ub.created_at DESC
      LIMIT ${limit}
    `;
    return reply.send(rows);
  });

  // ── GET /admin/errors ─────────────────────────────────────────────────────────
  // Recent failures from both sync runs and manual uploads, unified and sorted
  // by time so the dashboard shows a single "problems" list.
  // Query params:
  //   limit  (default 50, max 200)
  //   hours  look-back window in hours (default 24, max 168 / 7 days)
  app.get<{
    Querystring: { limit?: string; hours?: string };
  }>("/errors", async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);
    const hours = Math.min(parseInt(req.query.hours ?? "24", 10), 168);

    const rows = await sql`
      SELECT
        'sync_run'          AS source,
        r.id,
        t.name              AS tenant_name,
        c.xero_tenant_name,
        r.status,
        r.error,
        r.triggered_by      AS context,
        r.created_at
      FROM ops.sync_runs r
      JOIN core.xero_connections c ON c.id = r.connection_id
      JOIN core.tenants t          ON t.id = r.tenant_id
      WHERE r.status = 'failed'
        AND r.created_at > now() - (${hours} || ' hours')::interval

      UNION ALL

      SELECT
        'sync_step'         AS source,
        s.id,
        t.name              AS tenant_name,
        c.xero_tenant_name,
        s.status,
        s.error,
        s.entity            AS context,
        s.created_at
      FROM ops.sync_run_steps s
      JOIN ops.sync_runs r         ON r.id = s.sync_run_id
      JOIN core.xero_connections c ON c.id = r.connection_id
      JOIN core.tenants t          ON t.id = r.tenant_id
      WHERE s.status = 'failed'
        AND s.created_at > now() - (${hours} || ' hours')::interval

      UNION ALL

      SELECT
        'upload'            AS source,
        ub.id,
        t.name              AS tenant_name,
        NULL                AS xero_tenant_name,
        ub.status,
        ub.error,
        ub.filename         AS context,
        ub.created_at
      FROM manual_inputs.upload_batches ub
      JOIN core.tenants t ON t.id = ub.tenant_id
      WHERE ub.status = 'failed'
        AND ub.created_at > now() - (${hours} || ' hours')::interval

      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return reply.send({ hours, rows });
  });
}

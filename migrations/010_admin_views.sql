-- Migration: 010_admin_views.sql
-- Operational views that power the admin dashboard backend.
--
-- All views live in the ops schema — they're about operations, not warehouse data.
--
-- View map:
--   ops.vw_tenant_freshness    → per-connection, per-entity freshness status
--   ops.vw_sync_run_summary    → sync runs enriched with step counts + record totals
--   ops.vw_dashboard_metrics   → single-row overview (counts, health indicators)

-- ─── ops.vw_tenant_freshness ──────────────────────────────────────────────────
-- One row per (connection × entity) showing how fresh each data type is.
-- Used by: /admin/freshness, /admin/tenants (aggregated)
-- Query: WHERE tenant_id = $1  or  WHERE connection_id = $1
-- Freshness buckets: fresh (<1h), recent (<25h), stale (≥25h), never_synced

CREATE VIEW ops.vw_tenant_freshness AS
SELECT
  t.id                                                    AS tenant_id,
  t.name                                                  AS tenant_name,
  t.is_active                                             AS tenant_is_active,
  c.id                                                    AS connection_id,
  c.xero_tenant_name,
  c.is_active                                             AS connection_is_active,
  chk.entity,
  chk.last_modified_at,
  ROUND(
    EXTRACT(EPOCH FROM (now() - chk.last_modified_at)) / 3600.0
  , 1)                                                    AS hours_since_sync,
  CASE
    WHEN chk.last_modified_at IS NULL                          THEN 'never_synced'
    WHEN now() - chk.last_modified_at < INTERVAL '1 hour'     THEN 'fresh'
    WHEN now() - chk.last_modified_at < INTERVAL '25 hours'   THEN 'recent'
    ELSE                                                            'stale'
  END                                                     AS freshness_status,
  r.status                                                AS last_run_status,
  r.started_at                                            AS last_run_started_at,
  r.completed_at                                          AS last_run_completed_at,
  r.duration_ms                                           AS last_run_duration_ms,
  r.error                                                 AS last_run_error
FROM core.tenants t
JOIN  core.xero_connections c    ON c.tenant_id = t.id
LEFT JOIN ops.sync_checkpoints chk ON chk.connection_id = c.id
LEFT JOIN ops.sync_runs r          ON r.id = chk.last_run_id;

-- ─── ops.vw_sync_run_summary ──────────────────────────────────────────────────
-- Sync runs enriched with per-step aggregate counts.
-- Used by: /admin/sync/history, /admin/errors
-- Query: ORDER BY created_at DESC LIMIT $1  /  WHERE status = 'failed'

CREATE VIEW ops.vw_sync_run_summary AS
SELECT
  r.id,
  r.tenant_id,
  t.name                                                  AS tenant_name,
  c.id                                                    AS connection_id,
  c.xero_tenant_name,
  r.status,
  r.triggered_by,
  r.started_at,
  r.completed_at,
  r.duration_ms,
  r.error,
  r.created_at,
  COUNT(s.id)                                             AS total_steps,
  COUNT(s.id) FILTER (WHERE s.status = 'completed')      AS completed_steps,
  COUNT(s.id) FILTER (WHERE s.status = 'failed')         AS failed_steps,
  COUNT(s.id) FILTER (WHERE s.status = 'skipped')        AS skipped_steps,
  COALESCE(SUM(s.records_synced), 0)                     AS total_records_synced,
  COALESCE(SUM(s.records_failed), 0)                     AS total_records_failed
FROM ops.sync_runs r
JOIN  core.xero_connections c  ON c.id = r.connection_id
JOIN  core.tenants t           ON t.id = r.tenant_id
LEFT JOIN ops.sync_run_steps s ON s.sync_run_id = r.id
GROUP BY r.id, t.name, c.id, c.xero_tenant_name;

-- ─── ops.vw_dashboard_metrics ─────────────────────────────────────────────────
-- Single-row view with system-wide health and volume counters.
-- Used by: /admin/metrics
-- Query: SELECT * FROM ops.vw_dashboard_metrics  (always returns exactly 1 row)

CREATE VIEW ops.vw_dashboard_metrics AS
WITH
  tenants_agg AS (
    SELECT
      COUNT(*)                               AS total_tenants,
      COUNT(*) FILTER (WHERE is_active)      AS active_tenants
    FROM core.tenants
  ),
  connections_agg AS (
    SELECT
      COUNT(*)                               AS total_connections,
      COUNT(*) FILTER (WHERE is_active)      AS active_connections,
      -- stale = active connection with no completed sync in the last 25 hours
      COUNT(*) FILTER (
        WHERE is_active
          AND id NOT IN (
            SELECT DISTINCT connection_id
            FROM ops.sync_runs
            WHERE status = 'completed'
              AND completed_at > now() - INTERVAL '25 hours'
          )
      )                                      AS stale_connections
    FROM core.xero_connections
  ),
  runs_agg AS (
    SELECT
      COUNT(*) FILTER (
        WHERE created_at > now() - INTERVAL '24 hours'
      )                                      AS syncs_last_24h,
      COUNT(*) FILTER (
        WHERE status = 'failed'
          AND created_at > now() - INTERVAL '24 hours'
      )                                      AS failed_syncs_last_24h,
      COUNT(*) FILTER (
        WHERE status = 'running'
      )                                      AS syncs_currently_running
    FROM ops.sync_runs
  ),
  warehouse_agg AS (
    SELECT
      (SELECT COUNT(*) FROM warehouse.fact_invoice)          AS total_invoices,
      (SELECT COUNT(*) FROM warehouse.fact_payment)          AS total_payments,
      (SELECT COUNT(*) FROM warehouse.fact_bank_transaction) AS total_bank_transactions,
      (SELECT COUNT(*) FROM warehouse.dim_contact)           AS total_contacts
  ),
  uploads_agg AS (
    SELECT
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'processing')
      )                                      AS pending_uploads,
      COUNT(*) FILTER (
        WHERE status = 'failed'
          AND created_at > now() - INTERVAL '24 hours'
      )                                      AS failed_uploads_last_24h,
      COUNT(*) FILTER (
        WHERE status = 'completed'
          AND created_at > now() - INTERVAL '7 days'
      )                                      AS completed_uploads_last_7d
    FROM manual_inputs.upload_batches
  )
SELECT
  t.total_tenants,
  t.active_tenants,
  c.total_connections,
  c.active_connections,
  c.stale_connections,
  r.syncs_last_24h,
  r.failed_syncs_last_24h,
  r.syncs_currently_running,
  w.total_invoices,
  w.total_payments,
  w.total_bank_transactions,
  w.total_contacts,
  u.pending_uploads,
  u.failed_uploads_last_24h,
  u.completed_uploads_last_7d,
  now()                                      AS generated_at
FROM tenants_agg      t
CROSS JOIN connections_agg c
CROSS JOIN runs_agg        r
CROSS JOIN warehouse_agg   w
CROSS JOIN uploads_agg     u;

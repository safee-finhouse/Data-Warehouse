/**
 * Cron-based scheduler for automatic sync runs.
 *
 * Two jobs run independently:
 *
 *   Full sync    — runs all entities + reports for every active connection.
 *                  Default: nightly at 2 AM UTC (SYNC_FULL_CRON).
 *                  Each entity fetches everything with no If-Modified-Since filter.
 *
 *   Incremental  — runs the same pipeline but each entity uses its stored
 *                  checkpoint (If-Modified-Since) to fetch only changes since
 *                  the last sync. Much faster; keeps data fresh between fulls.
 *                  Default: every 20 minutes (SYNC_INCREMENTAL_CRON).
 *
 * Configuration (env vars):
 *   SYNC_FULL_CRON          cron expression, default "0 2 * * *"
 *   SYNC_INCREMENTAL_CRON   cron expression, default "every-20-min" (0/20 * * * *)
 *   SCHEDULER_ENABLED       set to "false" to disable both jobs (e.g. in test envs)
 *
 * Concurrency guard:
 *   A simple in-memory flag (`running`) prevents a second job from starting
 *   while the previous one is still in progress. If a job is skipped, a warning
 *   is logged. This is sufficient for single-instance deployments (Railway).
 *
 * Both jobs are triggered with triggeredBy = "scheduled" so sync_run records
 * are correctly labelled in the ops schema.
 */
import cron from "node-cron";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { syncAllConnections } from "./modules/sync/sync.runner.js";

let fullRunning = false;
let incrementalRunning = false;

async function runFullSync(): Promise<void> {
  if (fullRunning) {
    logger.warn("Scheduler: full sync skipped — previous run still in progress");
    return;
  }
  fullRunning = true;
  logger.info("Scheduler: full sync triggered");
  try {
    const result = await syncAllConnections("scheduled");
    logger.info("Scheduler: full sync finished", {
      succeeded: result.succeeded,
      failed: result.failed,
      durationMs: result.durationMs,
    });
  } catch (err) {
    logger.error("Scheduler: full sync threw unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    fullRunning = false;
  }
}

async function runIncrementalSync(): Promise<void> {
  if (incrementalRunning) {
    logger.warn("Scheduler: incremental sync skipped — previous run still in progress");
    return;
  }
  // Skip incremental if full sync is currently running to avoid checkpoint conflicts
  if (fullRunning) {
    logger.warn("Scheduler: incremental sync skipped — full sync in progress");
    return;
  }
  incrementalRunning = true;
  logger.info("Scheduler: incremental sync triggered");
  try {
    const result = await syncAllConnections("scheduled");
    logger.info("Scheduler: incremental sync finished", {
      succeeded: result.succeeded,
      failed: result.failed,
      durationMs: result.durationMs,
    });
  } catch (err) {
    logger.error("Scheduler: incremental sync threw unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    incrementalRunning = false;
  }
}

export function startScheduler(): void {
  if (!env.SCHEDULER_ENABLED) {
    logger.info("Scheduler: disabled via SCHEDULER_ENABLED=false");
    return;
  }

  if (!cron.validate(env.SYNC_FULL_CRON)) {
    logger.error("Scheduler: invalid SYNC_FULL_CRON expression", {
      value: env.SYNC_FULL_CRON,
    });
    process.exit(1);
  }

  if (!cron.validate(env.SYNC_INCREMENTAL_CRON)) {
    logger.error("Scheduler: invalid SYNC_INCREMENTAL_CRON expression", {
      value: env.SYNC_INCREMENTAL_CRON,
    });
    process.exit(1);
  }

  cron.schedule(env.SYNC_FULL_CRON, () => {
    void runFullSync();
  }, { timezone: "UTC" });

  cron.schedule(env.SYNC_INCREMENTAL_CRON, () => {
    void runIncrementalSync();
  }, { timezone: "UTC" });

  logger.info("Scheduler: started", {
    fullCron: env.SYNC_FULL_CRON,
    incrementalCron: env.SYNC_INCREMENTAL_CRON,
  });
}

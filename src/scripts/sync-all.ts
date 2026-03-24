/**
 * Manual sync trigger script.
 *
 * Usage:
 *   npx tsx src/scripts/sync-all.ts
 *   npm run sync:all
 *
 * Runs a full sync for all active connections, exactly as the nightly cron
 * does, and exits when complete. Useful for one-off refreshes and testing.
 */
import "../config/env.js"; // ensure env is validated before DB connects
import { syncAllConnections } from "../modules/sync/sync.runner.js";
import { logger } from "../lib/logger.js";

async function main() {
  logger.info("Manual sync: starting");
  const result = await syncAllConnections("manual");
  logger.info("Manual sync: complete", {
    totalConnections: result.totalConnections,
    succeeded: result.succeeded,
    failed: result.failed,
    durationMs: result.durationMs,
  });
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error("Manual sync: fatal error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

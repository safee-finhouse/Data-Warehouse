/**
 * Manual journals sync — writes to raw_xero.manual_journals.
 *
 * Idempotency: ON CONFLICT (connection_id, xero_id) DO UPDATE
 * Incremental:  reads/writes ops.sync_checkpoints for If-Modified-Since support
 */
import { sql } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { parseXeroDate } from "../../xero/xero.api.js";
import { listManualJournals } from "../../xero/xero.client.js";
import { runStep, type StepResult } from "../run-step.js";

export async function syncManualJournals(
  connectionId: string,
  xeroTenantId: string,
  syncRunId: string,
  tenantId: string,
): Promise<StepResult> {
  return runStep(syncRunId, "manual_journals", async () => {
    const [cp] = await sql<{ last_modified_at: Date | null }[]>`
      SELECT last_modified_at FROM ops.sync_checkpoints
      WHERE connection_id = ${connectionId} AND entity = 'manual_journals'
    `;
    const modifiedAfter = cp?.last_modified_at ?? undefined;
    const syncStartedAt = new Date();

    logger.info("manual_journals: starting sync", {
      connectionId,
      since: modifiedAfter?.toISOString() ?? "beginning",
    });

    let total = 0;

    for await (const page of listManualJournals(
      { connectionId, xeroTenantId },
      { modifiedAfter },
    )) {
      for (const j of page) {
        const date      = parseXeroDate(j.DateString ?? j.Date);
        const updatedAt = parseXeroDate(j.UpdatedDateUTC);

        await sql`
          INSERT INTO raw_xero.manual_journals (
            connection_id, tenant_id, xero_id,
            narration, date, status,
            updated_date_utc, raw
          ) VALUES (
            ${connectionId}, ${tenantId}, ${j.ManualJournalID},
            ${j.Narration}, ${date}, ${j.Status},
            ${updatedAt}, ${JSON.stringify(j)}
          )
          ON CONFLICT (connection_id, xero_id) DO UPDATE SET
            narration        = EXCLUDED.narration,
            date             = EXCLUDED.date,
            status           = EXCLUDED.status,
            updated_date_utc = EXCLUDED.updated_date_utc,
            raw              = EXCLUDED.raw,
            synced_at        = now()
        `;
      }

      total += page.length;
      logger.info("manual_journals: page upserted", { count: page.length, total });
    }

    await sql`
      INSERT INTO ops.sync_checkpoints (connection_id, entity, last_modified_at, last_run_id)
      VALUES (${connectionId}, 'manual_journals', ${syncStartedAt}, ${syncRunId})
      ON CONFLICT (connection_id, entity) DO UPDATE
        SET last_modified_at = EXCLUDED.last_modified_at,
            last_run_id      = EXCLUDED.last_run_id,
            updated_at       = now()
    `;

    return total;
  });
}

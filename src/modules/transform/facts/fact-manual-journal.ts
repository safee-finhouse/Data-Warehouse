/**
 * fact_manual_journal transform.
 * Bulk upsert from raw_xero.manual_journals → warehouse.fact_manual_journal.
 */
import { sql } from "../../../db/client.js";
import type { TransformResult } from "../transform.types.js";

export async function transformFactManualJournal(
  connectionId: string,
  _tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const [{ count }] = await sql<{ count: string }[]>`
    WITH upserted AS (
      INSERT INTO warehouse.fact_manual_journal (
        tenant_id, xero_id,
        narration, date, status,
        xero_updated_at, warehouse_updated_at
      )
      SELECT
        tenant_id, xero_id,
        narration, date, status,
        updated_date_utc, now()
      FROM raw_xero.manual_journals
      WHERE connection_id = ${connectionId}
      ON CONFLICT (tenant_id, xero_id) DO UPDATE SET
        narration            = EXCLUDED.narration,
        date                 = EXCLUDED.date,
        status               = EXCLUDED.status,
        xero_updated_at      = EXCLUDED.xero_updated_at,
        warehouse_updated_at = now()
      RETURNING id
    )
    SELECT COUNT(*) AS count FROM upserted
  `;

  return { entity: "fact_manual_journal", upserted: Number(count), durationMs: Date.now() - start };
}

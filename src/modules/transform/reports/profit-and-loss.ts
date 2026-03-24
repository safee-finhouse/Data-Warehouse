/**
 * Profit & Loss snapshot transform.
 * Reads raw_xero.report_snapshots → parses rows → upserts warehouse.fact_profit_and_loss_snapshot.
 */
import { sql } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { flattenProfitAndLoss } from "./parse-report.js";
import type { XeroReport } from "../../../types/xero.js";
import type { TransformResult } from "../transform.types.js";

export async function transformProfitAndLoss(
  connectionId: string,
  tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const snapshots = await sql<{
    id: string;
    period_date: Date;
    period_from: Date | null;
    raw: XeroReport;
  }[]>`
    SELECT id, period_date, period_from, raw
    FROM raw_xero.report_snapshots
    WHERE connection_id = ${connectionId} AND report_type = 'profit_and_loss'
  `;

  let upserted = 0;

  for (const snap of snapshots) {
    const rows = flattenProfitAndLoss(snap.raw.Rows ?? []);
    logger.info("transform: profit_and_loss rows parsed", {
      snapshotId: snap.id,
      rowCount: rows.length,
    });

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await sql`
        INSERT INTO warehouse.fact_profit_and_loss_snapshot
          (snapshot_id, tenant_id, period_from, period_to, row_order,
           section, account_xero_id, account_name, value, row_type)
        VALUES
          (${snap.id}, ${tenantId}, ${snap.period_from}, ${snap.period_date}, ${i},
           ${r.section}, ${r.accountXeroId}, ${r.accountName}, ${r.value}, ${r.rowType})
        ON CONFLICT (snapshot_id, row_order) DO UPDATE SET
          section         = EXCLUDED.section,
          account_xero_id = EXCLUDED.account_xero_id,
          account_name    = EXCLUDED.account_name,
          value           = EXCLUDED.value,
          row_type        = EXCLUDED.row_type
      `;
      upserted++;
    }
  }

  return { entity: "fact_profit_and_loss_snapshot", upserted, durationMs: Date.now() - start };
}

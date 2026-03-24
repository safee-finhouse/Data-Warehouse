/**
 * Trial Balance snapshot transform.
 * Reads raw_xero.report_snapshots → parses rows → upserts warehouse.fact_trial_balance_snapshot.
 */
import { sql } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { flattenTrialBalance } from "./parse-report.js";
import type { XeroReport } from "../../../types/xero.js";
import type { TransformResult } from "../transform.types.js";

export async function transformTrialBalance(
  connectionId: string,
  tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const snapshots = await sql<{
    id: string;
    period_date: Date;
    raw: XeroReport;
  }[]>`
    SELECT id, period_date, raw
    FROM raw_xero.report_snapshots
    WHERE connection_id = ${connectionId} AND report_type = 'trial_balance'
  `;

  let upserted = 0;

  for (const snap of snapshots) {
    const rows = flattenTrialBalance(snap.raw.Rows ?? []);
    logger.info("transform: trial_balance rows parsed", {
      snapshotId: snap.id,
      rowCount: rows.length,
    });

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await sql`
        INSERT INTO warehouse.fact_trial_balance_snapshot
          (snapshot_id, tenant_id, period_date, row_order,
           account_xero_id, account_name,
           debit, credit, ytd_debit, ytd_credit, row_type)
        VALUES
          (${snap.id}, ${tenantId}, ${snap.period_date}, ${i},
           ${r.accountXeroId}, ${r.accountName},
           ${r.debit}, ${r.credit}, ${r.ytdDebit}, ${r.ytdCredit}, ${r.rowType})
        ON CONFLICT (snapshot_id, row_order) DO UPDATE SET
          account_xero_id = EXCLUDED.account_xero_id,
          account_name    = EXCLUDED.account_name,
          debit           = EXCLUDED.debit,
          credit          = EXCLUDED.credit,
          ytd_debit       = EXCLUDED.ytd_debit,
          ytd_credit      = EXCLUDED.ytd_credit,
          row_type        = EXCLUDED.row_type
      `;
      upserted++;
    }
  }

  return { entity: "fact_trial_balance_snapshot", upserted, durationMs: Date.now() - start };
}

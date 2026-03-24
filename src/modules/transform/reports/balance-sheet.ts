/**
 * Balance Sheet snapshot transform.
 * Reads raw_xero.report_snapshots → parses rows → upserts warehouse.fact_balance_sheet_snapshot.
 *
 * Balance Sheet has nested sections (e.g. Assets → Current Assets → rows).
 * The parser recurses through the tree and assigns section + sub_section labels.
 */
import { sql } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { flattenBalanceSheet } from "./parse-report.js";
import type { XeroReport } from "../../../types/xero.js";
import type { TransformResult } from "../transform.types.js";

export async function transformBalanceSheet(
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
    WHERE connection_id = ${connectionId} AND report_type = 'balance_sheet'
  `;

  let upserted = 0;

  for (const snap of snapshots) {
    const rows = flattenBalanceSheet(snap.raw.Rows ?? []);
    logger.info("transform: balance_sheet rows parsed", {
      snapshotId: snap.id,
      rowCount: rows.length,
    });

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await sql`
        INSERT INTO warehouse.fact_balance_sheet_snapshot
          (snapshot_id, tenant_id, period_date, row_order,
           section, sub_section, account_xero_id, account_name, value, row_type)
        VALUES
          (${snap.id}, ${tenantId}, ${snap.period_date}, ${i},
           ${r.section}, ${r.subSection}, ${r.accountXeroId}, ${r.accountName},
           ${r.value}, ${r.rowType})
        ON CONFLICT (snapshot_id, row_order) DO UPDATE SET
          section         = EXCLUDED.section,
          sub_section     = EXCLUDED.sub_section,
          account_xero_id = EXCLUDED.account_xero_id,
          account_name    = EXCLUDED.account_name,
          value           = EXCLUDED.value,
          row_type        = EXCLUDED.row_type
      `;
      upserted++;
    }
  }

  return { entity: "fact_balance_sheet_snapshot", upserted, durationMs: Date.now() - start };
}

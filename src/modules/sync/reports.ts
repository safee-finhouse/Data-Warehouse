/**
 * Report snapshot sync.
 *
 * Fetches three Xero financial reports for the current period and stores them
 * in raw_xero.report_snapshots. Each row is a full point-in-time snapshot.
 *
 * Periods fetched on each run:
 *   Trial Balance  — as at today
 *   Profit & Loss  — first day of current month → today
 *   Balance Sheet  — as at today
 *
 * UNIQUE (connection_id, report_type, period_date) means re-running overwrites
 * the current-period snapshot rather than creating a duplicate. Historical
 * snapshots for past periods are preserved because period_date differs.
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { getTrialBalance, getProfitAndLoss, getBalanceSheet } from "../xero/xero.client.js";
import { runStep, type StepResult } from "./run-step.js";

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function firstDayOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export async function syncReports(
  connectionId: string,
  xeroTenantId: string,
  syncRunId: string,
  tenantId: string,
): Promise<StepResult> {
  return runStep(syncRunId, "reports", async () => {
    const today = new Date();
    const todayStr = toISODate(today);
    const monthStartStr = toISODate(firstDayOfMonth(today));
    const ctx = { connectionId, xeroTenantId };

    // ── Trial Balance ─────────────────────────────────────────────────────────
    logger.info("reports: fetching trial balance", { date: todayStr });
    const tb = await getTrialBalance(ctx, todayStr);
    await upsertSnapshot(connectionId, tenantId, "trial_balance", todayStr, null, tb.ReportName, tb);

    // ── Profit & Loss ─────────────────────────────────────────────────────────
    logger.info("reports: fetching profit & loss", { from: monthStartStr, to: todayStr });
    const pl = await getProfitAndLoss(ctx, monthStartStr, todayStr);
    await upsertSnapshot(connectionId, tenantId, "profit_and_loss", todayStr, monthStartStr, pl.ReportName, pl);

    // ── Balance Sheet ─────────────────────────────────────────────────────────
    logger.info("reports: fetching balance sheet", { date: todayStr });
    const bs = await getBalanceSheet(ctx, todayStr);
    await upsertSnapshot(connectionId, tenantId, "balance_sheet", todayStr, null, bs.ReportName, bs);

    logger.info("reports: all snapshots stored", { connectionId, periodDate: todayStr });
    return 3; // three reports fetched
  });
}

async function upsertSnapshot(
  connectionId: string,
  tenantId: string,
  reportType: string,
  periodDate: string,
  periodFrom: string | null,
  reportName: string,
  report: object,
): Promise<void> {
  await sql`
    INSERT INTO raw_xero.report_snapshots
      (connection_id, tenant_id, report_type, period_date, period_from, report_name, raw, captured_at)
    VALUES
      (${connectionId}, ${tenantId}, ${reportType}, ${periodDate}, ${periodFrom},
       ${reportName}, ${JSON.stringify(report)}, now())
    ON CONFLICT (connection_id, report_type, period_date) DO UPDATE SET
      period_from  = EXCLUDED.period_from,
      report_name  = EXCLUDED.report_name,
      raw          = EXCLUDED.raw,
      captured_at  = now()
  `;
}

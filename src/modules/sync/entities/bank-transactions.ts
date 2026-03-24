/**
 * Bank transactions sync — writes to raw_xero.bank_transactions.
 *
 * Idempotency: ON CONFLICT (connection_id, xero_id) DO UPDATE
 * Incremental:  reads/writes ops.sync_checkpoints for If-Modified-Since support
 */
import { sql } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { parseXeroDate } from "../../xero/xero.api.js";
import { listBankTransactions } from "../../xero/xero.client.js";
import { runStep, type StepResult } from "../run-step.js";

export async function syncBankTransactions(
  connectionId: string,
  xeroTenantId: string,
  syncRunId: string,
  tenantId: string,
): Promise<StepResult> {
  return runStep(syncRunId, "bank_transactions", async () => {
    const [cp] = await sql<{ last_modified_at: Date | null }[]>`
      SELECT last_modified_at FROM ops.sync_checkpoints
      WHERE connection_id = ${connectionId} AND entity = 'bank_transactions'
    `;
    const modifiedAfter = cp?.last_modified_at ?? undefined;
    const syncStartedAt = new Date();

    logger.info("bank_transactions: starting sync", {
      connectionId,
      since: modifiedAfter?.toISOString() ?? "beginning",
    });

    let total = 0;

    for await (const page of listBankTransactions(
      { connectionId, xeroTenantId },
      { modifiedAfter },
    )) {
      for (const t of page) {
        const date      = parseXeroDate(t.DateString ?? t.Date);
        const updatedAt = parseXeroDate(t.UpdatedDateUTC);

        await sql`
          INSERT INTO raw_xero.bank_transactions (
            connection_id, tenant_id, xero_id,
            type, status, reference, is_reconciled, date,
            subtotal, total_tax, total,
            currency_code, currency_rate,
            bank_account_id, bank_account_code, bank_account_name,
            contact_id, contact_name,
            updated_date_utc, raw
          ) VALUES (
            ${connectionId}, ${tenantId}, ${t.BankTransactionID ?? null},
            ${t.Type ?? null}, ${t.Status ?? null}, ${t.Reference ?? null}, ${t.IsReconciled ?? null}, ${date},
            ${t.SubTotal ?? null}, ${t.TotalTax ?? null}, ${t.Total ?? null},
            ${t.CurrencyCode ?? null}, ${t.CurrencyRate ?? null},
            ${t.BankAccount?.AccountID ?? null}, ${t.BankAccount?.Code ?? null}, ${t.BankAccount?.Name ?? null},
            ${t.Contact?.ContactID ?? null}, ${t.Contact?.Name ?? null},
            ${updatedAt}, ${JSON.stringify(t)}
          )
          ON CONFLICT (connection_id, xero_id) DO UPDATE SET
            type              = EXCLUDED.type,
            status            = EXCLUDED.status,
            reference         = EXCLUDED.reference,
            is_reconciled     = EXCLUDED.is_reconciled,
            date              = EXCLUDED.date,
            subtotal          = EXCLUDED.subtotal,
            total_tax         = EXCLUDED.total_tax,
            total             = EXCLUDED.total,
            currency_code     = EXCLUDED.currency_code,
            currency_rate     = EXCLUDED.currency_rate,
            bank_account_id   = EXCLUDED.bank_account_id,
            bank_account_code = EXCLUDED.bank_account_code,
            bank_account_name = EXCLUDED.bank_account_name,
            contact_id        = EXCLUDED.contact_id,
            contact_name      = EXCLUDED.contact_name,
            updated_date_utc  = EXCLUDED.updated_date_utc,
            raw               = EXCLUDED.raw,
            synced_at         = now()
        `;
      }

      total += page.length;
      logger.info("bank_transactions: page upserted", { count: page.length, total });
    }

    await sql`
      INSERT INTO ops.sync_checkpoints (connection_id, entity, last_modified_at, last_run_id)
      VALUES (${connectionId}, 'bank_transactions', ${syncStartedAt}, ${syncRunId})
      ON CONFLICT (connection_id, entity) DO UPDATE
        SET last_modified_at = EXCLUDED.last_modified_at,
            last_run_id      = EXCLUDED.last_run_id,
            updated_at       = now()
    `;

    return total;
  });
}

/**
 * Payments sync — writes to raw_xero.payments.
 *
 * Idempotency: ON CONFLICT (connection_id, xero_id) DO UPDATE
 * Incremental:  reads/writes ops.sync_checkpoints for If-Modified-Since support
 */
import { sql } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { parseXeroDate } from "../../xero/xero.api.js";
import { listPayments } from "../../xero/xero.client.js";
import { runStep, type StepResult } from "../run-step.js";

export async function syncPayments(
  connectionId: string,
  xeroTenantId: string,
  syncRunId: string,
  tenantId: string,
): Promise<StepResult> {
  return runStep(syncRunId, "payments", async () => {
    const [cp] = await sql<{ last_modified_at: Date | null }[]>`
      SELECT last_modified_at FROM ops.sync_checkpoints
      WHERE connection_id = ${connectionId} AND entity = 'payments'
    `;
    const modifiedAfter = cp?.last_modified_at ?? undefined;
    const syncStartedAt = new Date();

    logger.info("payments: starting sync", {
      connectionId,
      since: modifiedAfter?.toISOString() ?? "beginning",
    });

    let total = 0;

    for await (const page of listPayments(
      { connectionId, xeroTenantId },
      { modifiedAfter },
    )) {
      for (const p of page) {
        const date      = parseXeroDate(p.DateString ?? p.Date);
        const updatedAt = parseXeroDate(p.UpdatedDateUTC);

        await sql`
          INSERT INTO raw_xero.payments (
            connection_id, tenant_id, xero_id,
            date, amount, reference, is_reconciled,
            status, payment_type, currency_rate,
            invoice_id, invoice_number,
            account_id, account_code,
            updated_date_utc, raw
          ) VALUES (
            ${connectionId}, ${tenantId}, ${p.PaymentID},
            ${date}, ${p.Amount}, ${p.Reference ?? null}, ${p.IsReconciled},
            ${p.Status}, ${p.PaymentType}, ${p.CurrencyRate ?? null},
            ${p.Invoice?.InvoiceID ?? null}, ${p.Invoice?.InvoiceNumber ?? null},
            ${p.Account?.AccountID ?? null}, ${p.Account?.Code ?? null},
            ${updatedAt}, ${JSON.stringify(p)}
          )
          ON CONFLICT (connection_id, xero_id) DO UPDATE SET
            date             = EXCLUDED.date,
            amount           = EXCLUDED.amount,
            reference        = EXCLUDED.reference,
            is_reconciled    = EXCLUDED.is_reconciled,
            status           = EXCLUDED.status,
            payment_type     = EXCLUDED.payment_type,
            currency_rate    = EXCLUDED.currency_rate,
            invoice_id       = EXCLUDED.invoice_id,
            invoice_number   = EXCLUDED.invoice_number,
            account_id       = EXCLUDED.account_id,
            account_code     = EXCLUDED.account_code,
            updated_date_utc = EXCLUDED.updated_date_utc,
            raw              = EXCLUDED.raw,
            synced_at        = now()
        `;
      }

      total += page.length;
      logger.info("payments: page upserted", { count: page.length, total });
    }

    await sql`
      INSERT INTO ops.sync_checkpoints (connection_id, entity, last_modified_at, last_run_id)
      VALUES (${connectionId}, 'payments', ${syncStartedAt}, ${syncRunId})
      ON CONFLICT (connection_id, entity) DO UPDATE
        SET last_modified_at = EXCLUDED.last_modified_at,
            last_run_id      = EXCLUDED.last_run_id,
            updated_at       = now()
    `;

    return total;
  });
}

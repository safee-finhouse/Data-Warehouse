/**
 * Invoices sync.
 *
 * Writes to two tables in one pass:
 *   • public.xero_invoices      — original flat table (Stage 3, preserved for compat)
 *   • raw_xero.invoices         — raw ingestion layer with full JSONB payload
 *   • raw_xero.invoice_lines    — one row per line item, extracted from the invoice
 *
 * Idempotency:
 *   Both tables use ON CONFLICT (connection_id, xero_invoice_id/xero_id) DO UPDATE,
 *   so re-running a sync never creates duplicates — it updates in place.
 *
 * Incremental sync:
 *   Reads cursor from ops.sync_checkpoints (If-Modified-Since). On success, advances
 *   the cursor to the sync start time (not the max updated date — avoids clock skew gaps).
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { xeroGet, parseXeroDate } from "../xero/xero.api.js";
import type { XeroInvoicesResponse } from "../../types/xero.js";

const PAGE_SIZE = 1000; // Xero allows up to 1000 per page

export async function syncInvoices(
  connectionId: string,
  xeroTenantId: string,
  syncRunId: string,
  tenantId: string,
): Promise<{ synced: number }> {
  const [step] = await sql<{ id: string }[]>`
    INSERT INTO ops.sync_run_steps (sync_run_id, entity, status, started_at)
    VALUES (${syncRunId}, 'invoices', 'running', now())
    RETURNING id
  `;

  try {
    const [checkpoint] = await sql<{ last_modified_at: Date | null }[]>`
      SELECT last_modified_at
      FROM ops.sync_checkpoints
      WHERE connection_id = ${connectionId} AND entity = 'invoices'
    `;
    const sinceDate = checkpoint?.last_modified_at ?? null;
    const syncStartedAt = new Date();

    logger.info("invoices: starting sync", {
      connectionId,
      since: sinceDate?.toISOString() ?? "beginning",
    });

    let page = 1;
    let totalSynced = 0;

    while (true) {
      const ifModifiedSinceHeader = sinceDate
        ? { "If-Modified-Since": sinceDate.toUTCString() }
        : undefined;

      const data = await xeroGet<XeroInvoicesResponse>(
        connectionId,
        xeroTenantId,
        "Invoices",
        { page: String(page), pageSize: String(PAGE_SIZE) },
        ifModifiedSinceHeader,
      );

      const invoices = data.Invoices ?? [];
      if (invoices.length === 0) break;

      for (const inv of invoices) {
        const date      = parseXeroDate(inv.DateString ?? inv.Date);
        const dueDate   = parseXeroDate(inv.DueDateString ?? inv.DueDate);
        const updatedAt = parseXeroDate(inv.UpdatedDateUTC);

        // ── public.xero_invoices (original table, preserved) ─────────────────
        await sql`
          INSERT INTO xero_invoices (
            connection_id, xero_invoice_id, invoice_number, type, status,
            contact_id, contact_name, date, due_date,
            amount_due, amount_paid, subtotal, total_tax, total,
            currency_code, updated_date_utc, raw, synced_at
          ) VALUES (
            ${connectionId}, ${inv.InvoiceID ?? null}, ${inv.InvoiceNumber ?? null},
            ${inv.Type ?? null}, ${inv.Status ?? null},
            ${inv.Contact?.ContactID ?? null}, ${inv.Contact?.Name ?? null},
            ${date}, ${dueDate},
            ${inv.AmountDue ?? null}, ${inv.AmountPaid ?? null}, ${inv.SubTotal ?? null}, ${inv.TotalTax ?? null}, ${inv.Total ?? null},
            ${inv.CurrencyCode ?? null}, ${updatedAt}, ${JSON.stringify(inv)}, now()
          )
          ON CONFLICT (connection_id, xero_invoice_id) DO UPDATE SET
            invoice_number   = EXCLUDED.invoice_number,
            type             = EXCLUDED.type,
            status           = EXCLUDED.status,
            contact_id       = EXCLUDED.contact_id,
            contact_name     = EXCLUDED.contact_name,
            date             = EXCLUDED.date,
            due_date         = EXCLUDED.due_date,
            amount_due       = EXCLUDED.amount_due,
            amount_paid      = EXCLUDED.amount_paid,
            subtotal         = EXCLUDED.subtotal,
            total_tax        = EXCLUDED.total_tax,
            total            = EXCLUDED.total,
            currency_code    = EXCLUDED.currency_code,
            updated_date_utc = EXCLUDED.updated_date_utc,
            raw              = EXCLUDED.raw,
            synced_at        = now()
        `;

        // ── raw_xero.invoices ─────────────────────────────────────────────────
        await sql`
          INSERT INTO raw_xero.invoices (
            connection_id, tenant_id, xero_id, invoice_number, type, status,
            contact_id, contact_name, date, due_date,
            amount_due, amount_paid, amount_credited,
            subtotal, total_tax, total,
            currency_code, currency_rate, reference,
            updated_date_utc, raw
          ) VALUES (
            ${connectionId}, ${tenantId}, ${inv.InvoiceID ?? null},
            ${inv.InvoiceNumber ?? null}, ${inv.Type ?? null}, ${inv.Status ?? null},
            ${inv.Contact?.ContactID ?? null}, ${inv.Contact?.Name ?? null},
            ${date}, ${dueDate},
            ${inv.AmountDue ?? null}, ${inv.AmountPaid ?? null}, ${inv.AmountCredited ?? null},
            ${inv.SubTotal ?? null}, ${inv.TotalTax ?? null}, ${inv.Total ?? null},
            ${inv.CurrencyCode ?? null}, ${inv.CurrencyRate ?? null}, ${inv.Reference ?? null},
            ${updatedAt}, ${JSON.stringify(inv)}
          )
          ON CONFLICT (connection_id, xero_id) DO UPDATE SET
            invoice_number   = EXCLUDED.invoice_number,
            status           = EXCLUDED.status,
            contact_id       = EXCLUDED.contact_id,
            contact_name     = EXCLUDED.contact_name,
            date             = EXCLUDED.date,
            due_date         = EXCLUDED.due_date,
            amount_due       = EXCLUDED.amount_due,
            amount_paid      = EXCLUDED.amount_paid,
            amount_credited  = EXCLUDED.amount_credited,
            subtotal         = EXCLUDED.subtotal,
            total_tax        = EXCLUDED.total_tax,
            total            = EXCLUDED.total,
            currency_code    = EXCLUDED.currency_code,
            currency_rate    = EXCLUDED.currency_rate,
            reference        = EXCLUDED.reference,
            updated_date_utc = EXCLUDED.updated_date_utc,
            raw              = EXCLUDED.raw,
            synced_at        = now()
        `;

        // ── raw_xero.invoice_lines ────────────────────────────────────────────
        for (const line of (inv.LineItems ?? [])) {
          await sql`
            INSERT INTO raw_xero.invoice_lines (
              connection_id, tenant_id, xero_invoice_id, xero_id,
              description, quantity, unit_amount, line_amount,
              account_code, tax_type, tax_amount, item_code, raw
            ) VALUES (
              ${connectionId}, ${tenantId}, ${inv.InvoiceID ?? null}, ${line.LineItemID ?? null},
              ${line.Description ?? null},
              ${line.Quantity ?? null}, ${line.UnitAmount ?? null}, ${line.LineAmount ?? null},
              ${line.AccountCode ?? null}, ${line.TaxType ?? null},
              ${line.TaxAmount ?? null}, ${line.ItemCode ?? null},
              ${JSON.stringify(line)}
            )
            ON CONFLICT (connection_id, xero_invoice_id, xero_id) DO UPDATE SET
              description  = EXCLUDED.description,
              quantity     = EXCLUDED.quantity,
              unit_amount  = EXCLUDED.unit_amount,
              line_amount  = EXCLUDED.line_amount,
              account_code = EXCLUDED.account_code,
              tax_type     = EXCLUDED.tax_type,
              tax_amount   = EXCLUDED.tax_amount,
              item_code    = EXCLUDED.item_code,
              raw          = EXCLUDED.raw,
              synced_at    = now()
          `;
        }
      }

      totalSynced += invoices.length;
      logger.info(`invoices: page ${page} done`, { count: invoices.length, total: totalSynced });

      if (invoices.length < PAGE_SIZE) break;
      page++;
    }

    // Advance checkpoint to sync start (not max updated date — avoids clock skew gaps)
    await sql`
      INSERT INTO ops.sync_checkpoints (connection_id, entity, last_modified_at, last_run_id)
      VALUES (${connectionId}, 'invoices', ${syncStartedAt}, ${syncRunId})
      ON CONFLICT (connection_id, entity) DO UPDATE
        SET last_modified_at = EXCLUDED.last_modified_at,
            last_run_id      = EXCLUDED.last_run_id,
            updated_at       = now()
    `;

    await sql`
      UPDATE ops.sync_run_steps
      SET status = 'completed', records_synced = ${totalSynced}, completed_at = now()
      WHERE id = ${step.id}
    `;

    logger.info("invoices: sync complete", { connectionId, total: totalSynced });
    return { synced: totalSynced };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE ops.sync_run_steps
      SET status = 'failed', error = ${errorMsg}, completed_at = now()
      WHERE id = ${step.id}
    `;
    throw err;
  }
}

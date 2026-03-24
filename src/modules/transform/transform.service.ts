/**
 * Transform orchestrator.
 *
 * Reads from raw_xero.* and writes to warehouse.* in dependency order:
 *
 *   1. dim_tenant          (core.tenants — no raw dependency)
 *   2. dim_contact         (raw_xero.contacts)
 *   3. dim_account         (raw_xero.accounts)
 *   ── dims must exist before facts reference them ──
 *   4. fact_invoice        (raw_xero.invoices        → dim_contact)
 *   5. fact_invoice_line   (raw_xero.invoice_lines   → fact_invoice, dim_account)
 *   6. fact_payment        (raw_xero.payments        → fact_invoice, dim_account)
 *   7. fact_bank_transaction (raw_xero.bank_transactions → dim_contact, dim_account)
 *   8. fact_manual_journal (raw_xero.manual_journals)
 *
 * All transforms are idempotent — re-running never creates duplicates.
 * Each step is a single bulk INSERT...SELECT with ON CONFLICT DO UPDATE.
 */
import { logger } from "../../lib/logger.js";
import { transformDimTenant } from "./dims/dim-tenant.js";
import { transformDimContact } from "./dims/dim-contact.js";
import { transformDimAccount } from "./dims/dim-account.js";
import { transformFactInvoice } from "./facts/fact-invoice.js";
import { transformFactInvoiceLine } from "./facts/fact-invoice-line.js";
import { transformFactPayment } from "./facts/fact-payment.js";
import { transformFactBankTransaction } from "./facts/fact-bank-transaction.js";
import { transformFactManualJournal } from "./facts/fact-manual-journal.js";
import type { TransformSummary } from "./transform.types.js";

export async function transformConnection(
  connectionId: string,
  tenantId: string,
): Promise<TransformSummary> {
  const start = Date.now();

  logger.info("Transform started", { connectionId, tenantId });

  const steps = [
    () => transformDimTenant(tenantId),
    () => transformDimContact(connectionId, tenantId),
    () => transformDimAccount(connectionId, tenantId),
    () => transformFactInvoice(connectionId, tenantId),
    () => transformFactInvoiceLine(connectionId, tenantId),
    () => transformFactPayment(connectionId, tenantId),
    () => transformFactBankTransaction(connectionId, tenantId),
    () => transformFactManualJournal(connectionId, tenantId),
  ];

  const results = [];

  for (const step of steps) {
    const result = await step();
    logger.info(`Transform: ${result.entity}`, {
      upserted: result.upserted,
      durationMs: result.durationMs,
    });
    results.push(result);
  }

  const durationMs = Date.now() - start;

  logger.info("Transform completed", {
    connectionId,
    tenantId,
    durationMs,
    total: results.reduce((s, r) => s + r.upserted, 0),
  });

  return { connectionId, tenantId, durationMs, results };
}

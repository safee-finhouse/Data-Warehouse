/**
 * Sync orchestrator for a single connection.
 *
 * Creates an ops.sync_run record, runs all entity syncs in sequence,
 * then marks the run completed or failed.
 *
 * Entity order matters — run invoices first since payments/lines reference them.
 *
 * Raw ingestion targets:
 *   invoices         → public.xero_invoices  +  raw_xero.invoices  +  raw_xero.invoice_lines
 *   contacts         → raw_xero.contacts
 *   payments         → raw_xero.payments
 *   bank_transactions → raw_xero.bank_transactions
 *   accounts         → raw_xero.accounts
 *   manual_journals  → raw_xero.manual_journals
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { syncInvoices } from "./invoices.js";
import { syncContacts } from "./entities/contacts.js";
import { syncPayments } from "./entities/payments.js";
import { syncBankTransactions } from "./entities/bank-transactions.js";
import { syncAccounts } from "./entities/accounts.js";
import { syncManualJournals } from "./entities/manual-journals.js";

export interface EntityResult {
  synced: number;
  durationMs: number;
}

export interface SyncResult {
  runId: string;
  connectionId: string;
  tenantName: string;
  durationMs: number;
  entities: {
    invoices:         EntityResult;
    contacts:         EntityResult;
    payments:         EntityResult;
    bankTransactions: EntityResult;
    accounts:         EntityResult;
    manualJournals:   EntityResult;
  };
}

export async function syncConnection(
  connectionId: string,
  triggeredBy: "manual" | "scheduled" | "webhook" = "manual",
): Promise<SyncResult> {
  const [connection] = await sql<{
    tenant_id: string;
    xero_tenant_id: string;
    xero_tenant_name: string;
  }[]>`
    SELECT tenant_id, xero_tenant_id, xero_tenant_name
    FROM core.xero_connections
    WHERE id = ${connectionId} AND is_active = true
  `;

  if (!connection) throw new Error(`Active connection not found: ${connectionId}`);

  const [run] = await sql<{ id: string }[]>`
    INSERT INTO ops.sync_runs (connection_id, tenant_id, status, triggered_by, started_at)
    VALUES (${connectionId}, ${connection.tenant_id}, 'running', ${triggeredBy}, now())
    RETURNING id
  `;

  const start = Date.now();
  logger.info("Sync started", {
    runId: run.id,
    tenant: connection.xero_tenant_name,
    triggeredBy,
  });

  try {
    const invoicesStart = Date.now();
    const { synced: invoicesSynced } = await syncInvoices(
      connectionId,
      connection.xero_tenant_id,
      run.id,
      connection.tenant_id,
    );
    const invoices: EntityResult = { synced: invoicesSynced, durationMs: Date.now() - invoicesStart };

    const contacts = await syncContacts(
      connectionId, connection.xero_tenant_id, run.id, connection.tenant_id,
    );

    const payments = await syncPayments(
      connectionId, connection.xero_tenant_id, run.id, connection.tenant_id,
    );

    const bankTransactions = await syncBankTransactions(
      connectionId, connection.xero_tenant_id, run.id, connection.tenant_id,
    );

    const accounts = await syncAccounts(
      connectionId, connection.xero_tenant_id, run.id, connection.tenant_id,
    );

    const manualJournals = await syncManualJournals(
      connectionId, connection.xero_tenant_id, run.id, connection.tenant_id,
    );

    const durationMs = Date.now() - start;

    await sql`
      UPDATE ops.sync_runs
      SET status = 'completed', completed_at = now(), duration_ms = ${durationMs}
      WHERE id = ${run.id}
    `;

    logger.info("Sync completed", {
      runId: run.id,
      tenant: connection.xero_tenant_name,
      durationMs,
      invoices: invoices.synced,
      contacts: contacts.synced,
      payments: payments.synced,
      bankTransactions: bankTransactions.synced,
      accounts: accounts.synced,
      manualJournals: manualJournals.synced,
    });

    return {
      runId: run.id,
      connectionId,
      tenantName: connection.xero_tenant_name,
      durationMs,
      entities: { invoices, contacts, payments, bankTransactions, accounts, manualJournals },
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);

    await sql`
      UPDATE ops.sync_runs
      SET status = 'failed', completed_at = now(), duration_ms = ${durationMs}, error = ${errorMsg}
      WHERE id = ${run.id}
    `;

    logger.error("Sync failed", {
      runId: run.id,
      tenant: connection.xero_tenant_name,
      error: errorMsg,
    });
    throw err;
  }
}

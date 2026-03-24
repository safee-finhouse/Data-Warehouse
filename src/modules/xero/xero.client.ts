/**
 * Typed Xero API client.
 *
 * Each function is an async generator that yields one page of results at a time.
 * Callers iterate with `for await (const page of listInvoices(ctx)) { ... }`.
 *
 * All list functions accept an optional `modifiedAfter` date which maps to
 * Xero's `If-Modified-Since` header for incremental syncs.
 */
import { xeroGet } from "./xero.api.js";
import type {
  XeroInvoice,
  XeroInvoicesResponse,
  XeroContact,
  XeroContactsResponse,
  XeroPayment,
  XeroPaymentsResponse,
  XeroBankTransaction,
  XeroBankTransactionsResponse,
  XeroAccount,
  XeroAccountsResponse,
  XeroManualJournal,
  XeroManualJournalsResponse,
  XeroReport,
  XeroReportsResponse,
} from "../../types/xero.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface XeroClientContext {
  connectionId: string;
  xeroTenantId: string;
}

export interface ListOptions {
  modifiedAfter?: Date;
}

const PAGE_SIZE = 1000; // Xero max — reduces API calls by 10x vs default of 100

function modifiedSinceHeader(opts?: ListOptions): Record<string, string> {
  if (!opts?.modifiedAfter) return {};
  // Xero If-Modified-Since only has date precision — strip the time component
  return { "If-Modified-Since": opts.modifiedAfter.toUTCString() };
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

export async function* listInvoices(
  ctx: XeroClientContext,
  opts?: ListOptions,
): AsyncGenerator<XeroInvoice[]> {
  const headers = modifiedSinceHeader(opts);
  let page = 1;

  while (true) {
    const data = await xeroGet<XeroInvoicesResponse>(
      ctx.connectionId,
      ctx.xeroTenantId,
      "Invoices",
      { page: String(page), pageSize: String(PAGE_SIZE) },
      headers,
    );

    const invoices = data.Invoices ?? [];
    if (invoices.length === 0) break;

    yield invoices;

    if (invoices.length < PAGE_SIZE) break;
    page++;
  }
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export async function* listContacts(
  ctx: XeroClientContext,
  opts?: ListOptions,
): AsyncGenerator<XeroContact[]> {
  const headers = modifiedSinceHeader(opts);
  let page = 1;

  while (true) {
    const data = await xeroGet<XeroContactsResponse>(
      ctx.connectionId,
      ctx.xeroTenantId,
      "Contacts",
      { page: String(page), pageSize: String(PAGE_SIZE) },
      headers,
    );

    const contacts = data.Contacts ?? [];
    if (contacts.length === 0) break;

    yield contacts;

    if (contacts.length < PAGE_SIZE) break;
    page++;
  }
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export async function* listPayments(
  ctx: XeroClientContext,
  opts?: ListOptions,
): AsyncGenerator<XeroPayment[]> {
  const headers = modifiedSinceHeader(opts);
  let page = 1;

  while (true) {
    const data = await xeroGet<XeroPaymentsResponse>(
      ctx.connectionId,
      ctx.xeroTenantId,
      "Payments",
      { page: String(page), pageSize: String(PAGE_SIZE) },
      headers,
    );

    const payments = data.Payments ?? [];
    if (payments.length === 0) break;

    yield payments;

    if (payments.length < PAGE_SIZE) break;
    page++;
  }
}

// ─── Bank Transactions ────────────────────────────────────────────────────────

export async function* listBankTransactions(
  ctx: XeroClientContext,
  opts?: ListOptions,
): AsyncGenerator<XeroBankTransaction[]> {
  const headers = modifiedSinceHeader(opts);
  let page = 1;

  while (true) {
    const data = await xeroGet<XeroBankTransactionsResponse>(
      ctx.connectionId,
      ctx.xeroTenantId,
      "BankTransactions",
      { page: String(page), pageSize: String(PAGE_SIZE) },
      headers,
    );

    const txns = data.BankTransactions ?? [];
    if (txns.length === 0) break;

    yield txns;

    if (txns.length < PAGE_SIZE) break;
    page++;
  }
}

// ─── Manual Journals ──────────────────────────────────────────────────────────

export async function* listManualJournals(
  ctx: XeroClientContext,
  opts?: ListOptions,
): AsyncGenerator<XeroManualJournal[]> {
  const headers = modifiedSinceHeader(opts);
  let page = 1;

  while (true) {
    const data = await xeroGet<XeroManualJournalsResponse>(
      ctx.connectionId,
      ctx.xeroTenantId,
      "ManualJournals",
      { page: String(page), pageSize: String(PAGE_SIZE) },
      headers,
    );

    const journals = data.ManualJournals ?? [];
    if (journals.length === 0) break;

    yield journals;

    if (journals.length < PAGE_SIZE) break;
    page++;
  }
}

// ─── Reports ──────────────────────────────────────────────────────────────────
// Reports are single non-paginated responses. Date params are YYYY-MM-DD strings.

async function fetchReport(
  ctx: XeroClientContext,
  reportType: string,
  params: Record<string, string>,
): Promise<XeroReport> {
  const data = await xeroGet<XeroReportsResponse>(
    ctx.connectionId,
    ctx.xeroTenantId,
    `Reports/${reportType}`,
    params,
  );
  const report = data.Reports?.[0];
  if (!report) throw new Error(`Xero returned no report for ${reportType}`);
  return report;
}

export function getTrialBalance(ctx: XeroClientContext, date: string): Promise<XeroReport> {
  return fetchReport(ctx, "TrialBalance", { date });
}

export function getProfitAndLoss(
  ctx: XeroClientContext,
  fromDate: string,
  toDate: string,
): Promise<XeroReport> {
  return fetchReport(ctx, "ProfitAndLoss", { fromDate, toDate });
}

export function getBalanceSheet(ctx: XeroClientContext, date: string): Promise<XeroReport> {
  return fetchReport(ctx, "BalanceSheet", { date });
}

// ─── Accounts ─────────────────────────────────────────────────────────────────
// Accounts don't support pagination or ModifiedAfter — single response

export async function* listAccounts(
  ctx: XeroClientContext,
): AsyncGenerator<XeroAccount[]> {
  const data = await xeroGet<XeroAccountsResponse>(
    ctx.connectionId,
    ctx.xeroTenantId,
    "Accounts",
  );

  const accounts = data.Accounts ?? [];
  if (accounts.length > 0) yield accounts;
}

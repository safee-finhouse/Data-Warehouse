/**
 * Xero report row parsing utilities.
 *
 * Xero reports use a tree structure: Report → Rows → (Section → Rows → Row/SummaryRow).
 * These helpers walk that tree and produce flat arrays of typed rows for each
 * report type, ready to insert into warehouse fact tables.
 */
import type { XeroReportRow, XeroReportCell } from "../../../types/xero.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

export function parseAmount(value?: string): number | null {
  if (!value || value.trim() === "") return null;
  const n = parseFloat(value.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

function accountId(cells?: XeroReportCell[]): string | null {
  return cells?.[0]?.Attributes?.find((a) => a.Id === "account")?.Value ?? null;
}

// ─── Trial Balance ────────────────────────────────────────────────────────────

export interface TBRow {
  accountXeroId: string | null;
  accountName:   string;
  debit:         number | null;
  credit:        number | null;
  ytdDebit:      number | null;
  ytdCredit:     number | null;
  rowType:       "row" | "summary";
}

export function flattenTrialBalance(rows: XeroReportRow[]): TBRow[] {
  const out: TBRow[] = [];

  for (const row of rows) {
    if (row.RowType === "Header") continue;

    if (row.RowType === "Section") {
      for (const inner of row.Rows ?? []) {
        if (inner.RowType === "Row") {
          out.push({
            accountXeroId: accountId(inner.Cells),
            accountName:   inner.Cells?.[0]?.Value ?? "",
            debit:         parseAmount(inner.Cells?.[1]?.Value),
            credit:        parseAmount(inner.Cells?.[2]?.Value),
            ytdDebit:      parseAmount(inner.Cells?.[3]?.Value),
            ytdCredit:     parseAmount(inner.Cells?.[4]?.Value),
            rowType:       "row",
          });
        } else if (inner.RowType === "SummaryRow") {
          out.push({
            accountXeroId: null,
            accountName:   inner.Cells?.[0]?.Value ?? "Total",
            debit:         parseAmount(inner.Cells?.[1]?.Value),
            credit:        parseAmount(inner.Cells?.[2]?.Value),
            ytdDebit:      parseAmount(inner.Cells?.[3]?.Value),
            ytdCredit:     parseAmount(inner.Cells?.[4]?.Value),
            rowType:       "summary",
          });
        }
      }
    }
  }

  return out;
}

// ─── Profit & Loss ────────────────────────────────────────────────────────────

export interface PLRow {
  section:        string | null;
  accountXeroId:  string | null;
  accountName:    string;
  value:          number | null;
  rowType:        "row" | "summary";
}

export function flattenProfitAndLoss(rows: XeroReportRow[]): PLRow[] {
  const out: PLRow[] = [];

  for (const row of rows) {
    if (row.RowType === "Header") continue;

    if (row.RowType === "Section") {
      const section = row.Title ?? null;
      for (const inner of row.Rows ?? []) {
        if (inner.RowType === "Row") {
          out.push({
            section,
            accountXeroId: accountId(inner.Cells),
            accountName:   inner.Cells?.[0]?.Value ?? "",
            value:         parseAmount(inner.Cells?.[1]?.Value),
            rowType:       "row",
          });
        } else if (inner.RowType === "SummaryRow") {
          out.push({
            section,
            accountXeroId: null,
            accountName:   inner.Cells?.[0]?.Value ?? "Total",
            value:         parseAmount(inner.Cells?.[1]?.Value),
            rowType:       "summary",
          });
        }
      }
    } else if (row.RowType === "SummaryRow") {
      // Top-level summary (e.g. "Net Profit")
      out.push({
        section:       null,
        accountXeroId: null,
        accountName:   row.Cells?.[0]?.Value ?? "Net Profit",
        value:         parseAmount(row.Cells?.[1]?.Value),
        rowType:       "summary",
      });
    }
  }

  return out;
}

// ─── Balance Sheet ────────────────────────────────────────────────────────────

export interface BSRow {
  section:        string | null;
  subSection:     string | null;
  accountXeroId:  string | null;
  accountName:    string;
  value:          number | null;
  rowType:        "row" | "summary";
}

export function flattenBalanceSheet(rows: XeroReportRow[]): BSRow[] {
  const out: BSRow[] = [];

  for (const row of rows) {
    if (row.RowType === "Header") continue;
    walkBSSection(row, null, null, out);
  }

  return out;
}

function walkBSSection(
  row: XeroReportRow,
  section: string | null,
  subSection: string | null,
  out: BSRow[],
): void {
  if (row.RowType === "Section") {
    // Top-level section (Assets, Liabilities, Equity) or sub-section
    const isTopLevel = section === null;
    const nextSection    = isTopLevel ? (row.Title ?? null) : section;
    const nextSubSection = isTopLevel ? null : (row.Title ?? null);

    for (const inner of row.Rows ?? []) {
      walkBSSection(inner, nextSection, nextSubSection, out);
    }
  } else if (row.RowType === "Row") {
    out.push({
      section,
      subSection,
      accountXeroId: accountId(row.Cells),
      accountName:   row.Cells?.[0]?.Value ?? "",
      value:         parseAmount(row.Cells?.[1]?.Value),
      rowType:       "row",
    });
  } else if (row.RowType === "SummaryRow") {
    out.push({
      section,
      subSection,
      accountXeroId: null,
      accountName:   row.Cells?.[0]?.Value ?? "Total",
      value:         parseAmount(row.Cells?.[1]?.Value),
      rowType:       "summary",
    });
  }
}

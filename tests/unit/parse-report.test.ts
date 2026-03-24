/**
 * Unit tests for Xero report row parsers.
 * Pure functions — no DB or network required.
 */
import { describe, test, expect } from "vitest";
import {
  parseAmount,
  flattenTrialBalance,
  flattenProfitAndLoss,
  flattenBalanceSheet,
} from "../../src/modules/transform/reports/parse-report.js";
import type { XeroReportRow } from "../../src/types/xero.js";

// ─── parseAmount ─────────────────────────────────────────────────────────────

describe("parseAmount", () => {
  test("parses positive number", () => expect(parseAmount("1234.56")).toBe(1234.56));
  test("parses negative number", () => expect(parseAmount("-99.00")).toBe(-99));
  test("strips commas", () => expect(parseAmount("1,234,567.89")).toBe(1234567.89));
  test("returns null for empty string", () => expect(parseAmount("")).toBeNull());
  test("returns null for whitespace", () => expect(parseAmount("  ")).toBeNull());
  test("returns null for undefined", () => expect(parseAmount(undefined)).toBeNull());
  test("returns null for non-numeric", () => expect(parseAmount("N/A")).toBeNull());
  test("parses zero", () => expect(parseAmount("0.00")).toBe(0));
});

// ─── flattenTrialBalance ──────────────────────────────────────────────────────

const tbRows: XeroReportRow[] = [
  { RowType: "Header", Cells: [{ Value: "Account" }, { Value: "Debit" }] },
  {
    RowType: "Section",
    Title: "Assets",
    Rows: [
      {
        RowType: "Row",
        Cells: [
          { Value: "Cash", Attributes: [{ Id: "account", Value: "acc-001" }] },
          { Value: "5000.00" }, { Value: "" }, { Value: "5000.00" }, { Value: "" },
        ],
      },
      {
        RowType: "SummaryRow",
        Cells: [
          { Value: "Total Assets" },
          { Value: "5000.00" }, { Value: "" }, { Value: "5000.00" }, { Value: "" },
        ],
      },
    ],
  },
];

describe("flattenTrialBalance", () => {
  test("skips Header rows", () => {
    const out = flattenTrialBalance(tbRows);
    expect(out.every((r) => r.accountName !== "Account")).toBe(true);
  });

  test("extracts Row entries", () => {
    const out = flattenTrialBalance(tbRows);
    const row = out.find((r) => r.accountName === "Cash");
    expect(row).toBeDefined();
    expect(row?.debit).toBe(5000);
    expect(row?.credit).toBeNull();
    expect(row?.rowType).toBe("row");
  });

  test("extracts account xero id from cell attributes", () => {
    const out = flattenTrialBalance(tbRows);
    expect(out[0].accountXeroId).toBe("acc-001");
  });

  test("extracts SummaryRow entries", () => {
    const out = flattenTrialBalance(tbRows);
    const summary = out.find((r) => r.accountName === "Total Assets");
    expect(summary).toBeDefined();
    expect(summary?.rowType).toBe("summary");
    expect(summary?.accountXeroId).toBeNull();
  });

  test("returns empty array for empty input", () => {
    expect(flattenTrialBalance([])).toEqual([]);
  });
});

// ─── flattenProfitAndLoss ─────────────────────────────────────────────────────

const plRows: XeroReportRow[] = [
  { RowType: "Header" },
  {
    RowType: "Section",
    Title: "Income",
    Rows: [
      {
        RowType: "Row",
        Cells: [
          { Value: "Sales", Attributes: [{ Id: "account", Value: "acc-200" }] },
          { Value: "12000.00" },
        ],
      },
      {
        RowType: "SummaryRow",
        Cells: [{ Value: "Total Income" }, { Value: "12000.00" }],
      },
    ],
  },
  {
    RowType: "SummaryRow",
    Cells: [{ Value: "Net Profit" }, { Value: "8000.00" }],
  },
];

describe("flattenProfitAndLoss", () => {
  test("assigns section name from parent Section title", () => {
    const out = flattenProfitAndLoss(plRows);
    const sales = out.find((r) => r.accountName === "Sales");
    expect(sales?.section).toBe("Income");
  });

  test("parses account value", () => {
    const out = flattenProfitAndLoss(plRows);
    const sales = out.find((r) => r.accountName === "Sales");
    expect(sales?.value).toBe(12000);
  });

  test("handles top-level SummaryRow (Net Profit)", () => {
    const out = flattenProfitAndLoss(plRows);
    const net = out.find((r) => r.accountName === "Net Profit");
    expect(net).toBeDefined();
    expect(net?.section).toBeNull();
    expect(net?.rowType).toBe("summary");
    expect(net?.value).toBe(8000);
  });

  test("returns empty array for empty input", () => {
    expect(flattenProfitAndLoss([])).toEqual([]);
  });
});

// ─── flattenBalanceSheet ──────────────────────────────────────────────────────

const bsRows: XeroReportRow[] = [
  { RowType: "Header" },
  {
    RowType: "Section",
    Title: "Assets",
    Rows: [
      {
        RowType: "Section",
        Title: "Current Assets",
        Rows: [
          {
            RowType: "Row",
            Cells: [
              { Value: "Bank Account", Attributes: [{ Id: "account", Value: "acc-bank" }] },
              { Value: "10000.00" },
            ],
          },
          {
            RowType: "SummaryRow",
            Cells: [{ Value: "Total Current Assets" }, { Value: "10000.00" }],
          },
        ],
      },
    ],
  },
];

describe("flattenBalanceSheet", () => {
  test("assigns top-level section (Assets)", () => {
    const out = flattenBalanceSheet(bsRows);
    expect(out.every((r) => r.section === "Assets")).toBe(true);
  });

  test("assigns sub-section (Current Assets)", () => {
    const out = flattenBalanceSheet(bsRows);
    expect(out.every((r) => r.subSection === "Current Assets")).toBe(true);
  });

  test("extracts Row with account id", () => {
    const out = flattenBalanceSheet(bsRows);
    const bank = out.find((r) => r.accountName === "Bank Account");
    expect(bank).toBeDefined();
    expect(bank?.accountXeroId).toBe("acc-bank");
    expect(bank?.value).toBe(10000);
    expect(bank?.rowType).toBe("row");
  });

  test("extracts SummaryRow", () => {
    const out = flattenBalanceSheet(bsRows);
    const summary = out.find((r) => r.accountName === "Total Current Assets");
    expect(summary).toBeDefined();
    expect(summary?.rowType).toBe("summary");
    expect(summary?.accountXeroId).toBeNull();
  });

  test("returns empty array for empty input", () => {
    expect(flattenBalanceSheet([])).toEqual([]);
  });
});

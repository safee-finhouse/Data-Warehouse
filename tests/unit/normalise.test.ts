/**
 * Unit tests for the CSV row normaliser.
 * Pure functions — no DB or network required.
 */
import { describe, test, expect } from "vitest";
import { normaliseRow } from "../../src/modules/manual-inputs/normalise.js";

const TENANT = "00000000-0000-0000-0000-000000000001";

describe("normaliseRow — date parsing", () => {
  test("parses ISO date", () => {
    const row = { Date: "2025-03-15", Description: "Invoice", Amount: "100" };
    expect(normaliseRow(TENANT, row).date).toBe("2025-03-15");
  });

  test("parses DD/MM/YYYY date", () => {
    const row = { Date: "15/03/2025", Description: "Invoice", Amount: "100" };
    expect(normaliseRow(TENANT, row).date).toBe("2025-03-15");
  });

  test("parses DD-MM-YYYY date", () => {
    const row = { Date: "15-03-2025", Description: "Invoice", Amount: "100" };
    expect(normaliseRow(TENANT, row).date).toBe("2025-03-15");
  });

  test("parses named date (01 Jan 2025)", () => {
    const row = { Date: "01 Jan 2025", Description: "Invoice", Amount: "100" };
    expect(normaliseRow(TENANT, row).date).toBe("2025-01-01");
  });

  test("accepts 'Transaction Date' column name", () => {
    const row = { "Transaction Date": "2025-03-15", Description: "Invoice", Amount: "50" };
    expect(normaliseRow(TENANT, row).date).toBe("2025-03-15");
  });

  test("throws when no date column is present", () => {
    const row = { Description: "Invoice", Amount: "100" };
    expect(() => normaliseRow(TENANT, row)).toThrow("Missing date");
  });
});

describe("normaliseRow — amount parsing", () => {
  test("parses positive amount as credit", () => {
    const row = { Date: "2025-01-01", Description: "Deposit", Amount: "500.00" };
    expect(normaliseRow(TENANT, row).amount).toBe(500);
  });

  test("parses negative amount as debit", () => {
    const row = { Date: "2025-01-01", Description: "Payment", Amount: "-42.50" };
    expect(normaliseRow(TENANT, row).amount).toBe(-42.5);
  });

  test("strips currency symbols (£)", () => {
    const row = { Date: "2025-01-01", Description: "Fee", Amount: "£9.99" };
    expect(normaliseRow(TENANT, row).amount).toBe(9.99);
  });

  test("strips comma separators", () => {
    const row = { Date: "2025-01-01", Description: "Revenue", Amount: "1,234.56" };
    expect(normaliseRow(TENANT, row).amount).toBe(1234.56);
  });

  test("parses split Debit/Credit columns (debit)", () => {
    const row = { Date: "2025-01-01", Description: "Expense", Debit: "100.00", Credit: "" };
    expect(normaliseRow(TENANT, row).amount).toBe(-100);
  });

  test("parses split Debit/Credit columns (credit)", () => {
    const row = { Date: "2025-01-01", Description: "Income", Debit: "", Credit: "200.00" };
    expect(normaliseRow(TENANT, row).amount).toBe(200);
  });
});

describe("normaliseRow — description and reference", () => {
  test("parses Description column", () => {
    const row = { Date: "2025-01-01", Description: "ACME Ltd invoice", Amount: "100" };
    expect(normaliseRow(TENANT, row).description).toBe("ACME Ltd invoice");
  });

  test("accepts 'Narrative' column name", () => {
    const row = { Date: "2025-01-01", Narrative: "Staff salary", Amount: "-3000" };
    expect(normaliseRow(TENANT, row).description).toBe("Staff salary");
  });

  test("parses Reference when present", () => {
    const row = { Date: "2025-01-01", Description: "Transfer", Amount: "500", Reference: "REF-001" };
    expect(normaliseRow(TENANT, row).reference).toBe("REF-001");
  });

  test("returns null reference when column is absent", () => {
    const row = { Date: "2025-01-01", Description: "Transfer", Amount: "500" };
    expect(normaliseRow(TENANT, row).reference).toBeNull();
  });

  test("throws when no description column is present", () => {
    const row = { Date: "2025-01-01", Amount: "100" };
    expect(() => normaliseRow(TENANT, row)).toThrow("Missing description");
  });
});

describe("normaliseRow — dedup hash", () => {
  test("hash is a 32-char hex string", () => {
    const row = { Date: "2025-01-01", Description: "Test", Amount: "100" };
    const { dedupHash } = normaliseRow(TENANT, row);
    expect(dedupHash).toMatch(/^[a-f0-9]{32}$/);
  });

  test("same input produces same hash", () => {
    const row = { Date: "2025-01-01", Description: "Test", Amount: "100" };
    expect(normaliseRow(TENANT, row).dedupHash).toBe(normaliseRow(TENANT, row).dedupHash);
  });

  test("different amounts produce different hashes", () => {
    const a = normaliseRow(TENANT, { Date: "2025-01-01", Description: "Test", Amount: "100" });
    const b = normaliseRow(TENANT, { Date: "2025-01-01", Description: "Test", Amount: "200" });
    expect(a.dedupHash).not.toBe(b.dedupHash);
  });

  test("different tenants produce different hashes for same row", () => {
    const row = { Date: "2025-01-01", Description: "Test", Amount: "100" };
    const TENANT2 = "00000000-0000-0000-0000-000000000002";
    expect(normaliseRow(TENANT, row).dedupHash).not.toBe(normaliseRow(TENANT2, row).dedupHash);
  });
});

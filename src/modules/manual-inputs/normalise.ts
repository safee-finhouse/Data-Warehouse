/**
 * Normalises raw CSV row objects into typed statement line records.
 *
 * CSV column names vary by bank export format. We accept the most common
 * variants (case-insensitive) for each field:
 *
 *   date        → Date, Transaction Date, TransactionDate, Posting Date
 *   description → Description, Details, Narrative, Memo, Particulars
 *   amount      → Amount, Credit/Debit, Debit, Credit (split columns)
 *   reference   → Reference, Ref, Cheque No
 *
 * Amount handling:
 *   - Single "Amount" column: negative = debit, positive = credit
 *   - Split "Debit" / "Credit" columns: debit as negative, credit as positive
 *
 * dedupHash: MD5 of (tenantId | date | description | amount) — prevents
 * duplicate rows if the same CSV is uploaded twice.
 */
import { createHash } from "crypto";
import type { RawCsvRow, NormalisedLine } from "./manual-inputs.types.js";

function pick(row: RawCsvRow, ...candidates: string[]): string | undefined {
  for (const key of candidates) {
    const val = Object.entries(row).find(
      ([k]) => k.trim().toLowerCase() === key.toLowerCase(),
    )?.[1];
    if (val !== undefined && val.trim() !== "") return val.trim();
  }
  return undefined;
}

function parseDate(raw: string): string {
  // Try ISO first, then DD/MM/YYYY, DD-MM-YYYY, "01 Jan 2025"
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;

  const named = new Date(raw);
  if (!isNaN(named.getTime())) {
    return named.toISOString().slice(0, 10);
  }

  throw new Error(`Cannot parse date: "${raw}"`);
}

function parseAmount(row: RawCsvRow): number {
  const single = pick(row, "Amount", "amount");
  if (single !== undefined) {
    const n = parseFloat(single.replace(/[,£$€\s]/g, ""));
    if (!isNaN(n)) return n;
  }

  const debit = pick(row, "Debit", "debit");
  const credit = pick(row, "Credit", "credit");

  const d = debit ? parseFloat(debit.replace(/[,£$€\s]/g, "")) : 0;
  const c = credit ? parseFloat(credit.replace(/[,£$€\s]/g, "")) : 0;

  if (!isNaN(d) && d !== 0) return -Math.abs(d);
  if (!isNaN(c) && c !== 0) return Math.abs(c);

  throw new Error(`Cannot parse amount from row: ${JSON.stringify(row)}`);
}

export function normaliseRow(
  tenantId: string,
  row: RawCsvRow,
  currencyCode = "GBP",
): NormalisedLine {
  const rawDate = pick(
    row,
    "Date", "Transaction Date", "TransactionDate", "Posting Date", "PostingDate",
  );
  if (!rawDate) throw new Error(`Missing date in row: ${JSON.stringify(row)}`);

  const description = pick(
    row,
    "Description", "Details", "Narrative", "Memo", "Particulars", "Transaction Description",
  );
  if (!description) throw new Error(`Missing description in row: ${JSON.stringify(row)}`);

  const date = parseDate(rawDate);
  const amount = parseAmount(row);
  const reference = pick(row, "Reference", "Ref", "Cheque No", "ChequeNo") ?? null;

  const dedupHash = createHash("md5")
    .update(`${tenantId}|${date}|${description}|${amount}`)
    .digest("hex");

  return { date, description, amount, reference, currencyCode, dedupHash };
}

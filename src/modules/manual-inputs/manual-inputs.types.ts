export interface UploadBatch {
  id: string;
  tenantId: string;
  filename: string;
  rowCount: number | null;
  status: "pending" | "processing" | "completed" | "failed";
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface RawCsvRow {
  [key: string]: string;
}

export interface NormalisedLine {
  date: string;          // ISO date string
  description: string;
  amount: number;        // negative = debit
  reference: string | null;
  currencyCode: string;
  dedupHash: string;
}

export interface TransformResult {
  entity: string;
  upserted: number;
  durationMs: number;
}

export interface TransformSummary {
  connectionId: string;
  tenantId: string;
  durationMs: number;
  results: TransformResult[];
}

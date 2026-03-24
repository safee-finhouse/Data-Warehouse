/** ISO 8601 date string */
export type ISODate = string;

/** ISO 8601 datetime string */
export type ISODateTime = string;

/** Decimal amount as string to avoid floating point issues */
export type DecimalString = string;

/** Xero organisation UUID */
export type XeroTenantId = string;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

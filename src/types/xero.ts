/**
 * TypeScript types for Xero API v2 response shapes.
 *
 * Date fields that come back as /Date(timestamp+offset)/ are typed as `XeroDate`.
 * Use parseXeroDate() from xero.api.ts to convert them to JS Date objects.
 *
 * Fields marked optional (?) are present in some statuses/types but not all.
 */

/** Xero's .NET JSON date format: /Date(1609459200000+0000)/ */
export type XeroDate = string;

// ─── Shared ───────────────────────────────────────────────────────────────────

export interface XeroLineItem {
  LineItemID:  string;
  Description: string;
  Quantity:    number;
  UnitAmount:  number;
  AccountCode?: string;
  TaxType?:    string;
  TaxAmount?:  number;
  LineAmount:  number;
  ItemCode?:   string;
  Tracking?:   XeroTrackingCategory[];
}

export interface XeroTrackingCategory {
  TrackingCategoryID: string;
  TrackingOptionID:   string;
  Name:               string;
  Option:             string;
}

export interface XeroAddress {
  AddressType:   string;
  AddressLine1?: string;
  AddressLine2?: string;
  City?:         string;
  Region?:       string;
  PostalCode?:   string;
  Country?:      string;
}

export interface XeroPhone {
  PhoneType:   string;
  PhoneNumber: string;
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export interface XeroContact {
  ContactID:              string;
  Name:                   string;
  FirstName?:             string;
  LastName?:              string;
  EmailAddress?:          string;
  ContactStatus:          "ACTIVE" | "ARCHIVED" | "GDPRREQUEST";
  IsSupplier:             boolean;
  IsCustomer:             boolean;
  Addresses?:             XeroAddress[];
  Phones?:                XeroPhone[];
  TaxNumber?:             string;
  AccountsReceivableTaxType?: string;
  AccountsPayableTaxType?:    string;
  DefaultCurrency?:       string;
  UpdatedDateUTC:         XeroDate;
}

export interface XeroContactsResponse {
  Contacts: XeroContact[];
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

export type XeroInvoiceType   = "ACCREC" | "ACCPAY";
export type XeroInvoiceStatus = "DRAFT" | "SUBMITTED" | "DELETED" | "AUTHORISED" | "PAID" | "VOIDED";

export interface XeroInvoiceContact {
  ContactID: string;
  Name:      string;
}

export interface XeroInvoice {
  InvoiceID:       string;
  InvoiceNumber:   string;
  Type:            XeroInvoiceType;
  Status:          XeroInvoiceStatus;
  Contact?:        XeroInvoiceContact;
  LineItems?:      XeroLineItem[];
  // Date comes in two forms — always prefer *String variants
  Date?:           XeroDate;
  DateString?:     string;
  DueDate?:        XeroDate;
  DueDateString?:  string;
  AmountDue:       number;
  AmountPaid:      number;
  AmountCredited?: number;
  SubTotal:        number;
  TotalTax:        number;
  Total:           number;
  CurrencyCode?:   string;
  CurrencyRate?:   number;
  Reference?:      string;
  Url?:            string;
  SentToContact?:  boolean;
  UpdatedDateUTC:  XeroDate;
}

export interface XeroInvoicesResponse {
  Invoices: XeroInvoice[];
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export type XeroPaymentStatus = "AUTHORISED" | "DELETED";
export type XeroPaymentType   =
  | "ACCRECPAYMENT"
  | "ACCPAYPAYMENT"
  | "ARCREDITPAYMENT"
  | "APCREDITPAYMENT"
  | "AROVERPAYMENTPAYMENT"
  | "ARPREPAYMENTPAYMENT"
  | "APPREPAYMENTPAYMENT"
  | "APOVERPAYMENTPAYMENT";

export interface XeroPayment {
  PaymentID:     string;
  Date?:         XeroDate;
  DateString?:   string;
  Amount:        number;
  Reference?:    string;
  IsReconciled:  boolean;
  Status:        XeroPaymentStatus;
  PaymentType:   XeroPaymentType;
  CurrencyRate?: number;
  Invoice?: {
    InvoiceID:     string;
    InvoiceNumber: string;
    Type:          XeroInvoiceType;
  };
  Account?: {
    AccountID: string;
    Code:      string;
    Name:      string;
  };
  UpdatedDateUTC: XeroDate;
}

export interface XeroPaymentsResponse {
  Payments: XeroPayment[];
}

// ─── Bank Transactions ────────────────────────────────────────────────────────

export type XeroBankTransactionType =
  | "RECEIVE"
  | "RECEIVE-OVERPAYMENT"
  | "RECEIVE-PREPAYMENT"
  | "SPEND"
  | "SPEND-OVERPAYMENT"
  | "SPEND-PREPAYMENT"
  | "RECEIVE-TRANSFER"
  | "SPEND-TRANSFER";

export type XeroBankTransactionStatus = "AUTHORISED" | "DELETED";

export interface XeroBankTransaction {
  BankTransactionID: string;
  Type:              XeroBankTransactionType;
  Status:            XeroBankTransactionStatus;
  Reference?:        string;
  IsReconciled:      boolean;
  Date?:             XeroDate;
  DateString?:       string;
  SubTotal:          number;
  TotalTax:          number;
  Total:             number;
  CurrencyCode?:     string;
  CurrencyRate?:     number;
  LineItems?:        XeroLineItem[];
  BankAccount: {
    AccountID: string;
    Code:      string;
    Name:      string;
  };
  Contact?: {
    ContactID: string;
    Name:      string;
  };
  UpdatedDateUTC: XeroDate;
}

export interface XeroBankTransactionsResponse {
  BankTransactions: XeroBankTransaction[];
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export type XeroAccountType =
  | "BANK" | "CURRENT" | "CURRLIAB" | "DEPRECIATN"
  | "DIRECTCOSTS" | "EQUITY" | "EXPENSE" | "FIXED"
  | "LIABILITY" | "NONCURRENT" | "OTHERINCOME" | "OVERHEADS"
  | "PREPAYMENT" | "REVENUE" | "SALES" | "TERMLIAB" | "PAYGLIABILITY"
  | "SUPERANNUATIONEXPENSE" | "SUPERANNUATIONLIABILITY" | "WAGESEXPENSE";

export type XeroAccountClass  = "ASSET" | "EQUITY" | "EXPENSE" | "LIABILITY" | "REVENUE";
export type XeroAccountStatus = "ACTIVE" | "ARCHIVED";

export interface XeroAccount {
  AccountID:                  string;
  Code:                       string;
  Name:                       string;
  Type:                       XeroAccountType;
  Status:                     XeroAccountStatus;
  Class:                      XeroAccountClass;
  Description?:               string;
  TaxType?:                   string;
  SystemAccount?:             string;
  EnablePaymentsToAccount:    boolean;
  ShowInExpenseClaims:        boolean;
  CurrencyCode?:              string;
  ReportingCode?:             string;
  ReportingCodeName?:         string;
  UpdatedDateUTC:             XeroDate;
}

export interface XeroAccountsResponse {
  Accounts: XeroAccount[];
}

import "server-only";
import { GatewayError } from "@/lib/errors";
import { getConnection } from "./index";
import { vendorFetch } from "./keys";
import { accessToken } from "./tokens";

/**
 * Supplier bills in the owner's accounting system. Xero bills are created as
 * DRAFT (nothing is approved or paid). QuickBooks has no draft state for
 * bills, so they're created unpaid with a memo saying AgentGig added them.
 */

export interface BillInput {
  supplier: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate?: string | null;
  currency: string;
  lines: { description: string; quantity: number; unitPrice: number }[];
  taxAmount: number | null;
  note: string;
}

export interface BillResult {
  system: "xero" | "quickbooks";
  id: string;
  url: string;
}

export async function connectedAccounting(userId: string): Promise<"xero" | "quickbooks" | null> {
  if (await getConnection(userId, "xero")) return "xero";
  if (await getConnection(userId, "quickbooks")) return "quickbooks";
  return null;
}

export async function createBill(userId: string, bill: BillInput): Promise<BillResult | null> {
  const xero = await getConnection(userId, "xero");
  if (xero) return xeroBill(xero, bill);
  const qbo = await getConnection(userId, "quickbooks");
  if (qbo) return quickbooksBill(qbo, bill);
  return null;
}

type Conn = NonNullable<Awaited<ReturnType<typeof getConnection>>>;

async function xeroBill(conn: Conn, b: BillInput): Promise<BillResult> {
  const token = await accessToken(conn);
  const headers = { authorization: `Bearer ${token}`, "xero-tenant-id": String(conn.meta?.tenantId), "content-type": "application/json", accept: "application/json" };
  const res = await vendorFetch<{ Invoices: { InvoiceID: string }[] }>("Xero", "https://api.xero.com/api.xro/2.0/Invoices", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      Invoices: [
        {
          Type: "ACCPAY",
          Status: "DRAFT",
          Contact: { Name: b.supplier },
          InvoiceNumber: b.invoiceNumber ?? undefined,
          Reference: b.note.slice(0, 255),
          Date: b.issueDate ?? undefined,
          DueDate: b.dueDate ?? b.issueDate ?? undefined,
          CurrencyCode: b.currency.toUpperCase(),
          LineAmountTypes: b.taxAmount ? "Exclusive" : "NoTax",
          LineItems: b.lines.map((l) => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unitPrice })),
        },
      ],
    }),
  });
  const id = res.Invoices[0]?.InvoiceID;
  if (!id) throw new GatewayError("AGENT_FAILED", "Xero didn't return the new bill.");
  return { system: "xero", id, url: `https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${id}` };
}

async function quickbooksBill(conn: Conn, b: BillInput): Promise<BillResult> {
  const token = await accessToken(conn);
  const realm = String(conn.meta?.realmId);
  const host = conn.meta?.sandbox ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
  const headers = { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" };
  const q = encodeURIComponent(`select * from Vendor where DisplayName = '${b.supplier.replace(/'/g, "\\'")}'`);
  const found = await vendorFetch<{ QueryResponse: { Vendor?: { Id: string }[] } }>("QuickBooks", `${host}/v3/company/${realm}/query?query=${q}&minorversion=73`, { headers });
  const vendorId =
    found.QueryResponse.Vendor?.[0]?.Id ??
    (await vendorFetch<{ Vendor: { Id: string } }>("QuickBooks", `${host}/v3/company/${realm}/vendor?minorversion=73`, { method: "POST", headers, body: JSON.stringify({ DisplayName: b.supplier }) })).Vendor.Id;
  // An expense account is required per line; use the first Cost of Goods Sold / Expense account.
  const acct = encodeURIComponent("select Id from Account where AccountType in ('Cost of Goods Sold','Expense') maxresults 1");
  const accounts = await vendorFetch<{ QueryResponse: { Account?: { Id: string }[] } }>("QuickBooks", `${host}/v3/company/${realm}/query?query=${acct}&minorversion=73`, { headers });
  const accountId = accounts.QueryResponse.Account?.[0]?.Id;
  if (!accountId) throw new GatewayError("AGENT_FAILED", "QuickBooks has no expense account to put the bill against.");
  const res = await vendorFetch<{ Bill: { Id: string } }>("QuickBooks", `${host}/v3/company/${realm}/bill?minorversion=73`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      VendorRef: { value: vendorId },
      DocNumber: b.invoiceNumber?.slice(0, 21) ?? undefined,
      TxnDate: b.issueDate ?? undefined,
      DueDate: b.dueDate ?? undefined,
      PrivateNote: b.note.slice(0, 4000),
      Line: b.lines.map((l) => ({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: Math.round(l.quantity * l.unitPrice * 100) / 100,
        Description: l.description,
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
      })),
    }),
  });
  const app = conn.meta?.sandbox ? "https://app.sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com";
  return { system: "quickbooks", id: res.Bill.Id, url: `${app}/app/bill?txnId=${res.Bill.Id}` };
}

/* ------------------------------------------------------------------ */
/* Reading what's owed (sales invoices) and what's due (bills)         */
/* ------------------------------------------------------------------ */

export interface OpenItem {
  id: string;
  number: string | null;
  contact: string;
  email: string | null;
  issueDate: string | null;
  dueDate: string | null;
  total: number;
  amountDue: number;
  currency: string;
  url: string;
}

export interface OpenItems {
  system: "xero" | "quickbooks";
  /** Customer invoices not yet fully paid. */
  receivable: OpenItem[];
  /** Supplier bills not yet fully paid. */
  payable: OpenItem[];
}

/** Unpaid sales invoices and bills from Xero or QuickBooks. Null if neither is connected. */
export async function openItems(userId: string): Promise<OpenItems | null> {
  const xero = await getConnection(userId, "xero");
  if (xero) return xeroOpenItems(xero);
  const qbo = await getConnection(userId, "quickbooks");
  if (qbo) return quickbooksOpenItems(qbo);
  return null;
}

const day = (s: string | undefined | null) => (s ? s.slice(0, 10) : null);

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type: "ACCREC" | "ACCPAY";
  Contact: { ContactID: string; Name: string };
  DateString?: string;
  DueDateString?: string;
  Total: number;
  AmountDue: number;
  CurrencyCode: string;
}

async function xeroOpenItems(conn: Conn): Promise<OpenItems> {
  const token = await accessToken(conn);
  const headers = { authorization: `Bearer ${token}`, "xero-tenant-id": String(conn.meta?.tenantId), accept: "application/json" };
  const invoices: XeroInvoice[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await vendorFetch<{ Invoices: XeroInvoice[] }>("Xero", `https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED&page=${page}`, { headers });
    invoices.push(...res.Invoices);
    if (res.Invoices.length < 100) break;
  }
  const open = invoices.filter((i) => i.AmountDue > 0);
  // Invoice lists only carry the contact's name; emails come from Contacts.
  const ids = [...new Set(open.filter((i) => i.Type === "ACCREC").map((i) => i.Contact.ContactID))];
  const emails = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const res = await vendorFetch<{ Contacts: { ContactID: string; EmailAddress?: string }[] }>("Xero", `https://api.xero.com/api.xro/2.0/Contacts?IDs=${ids.slice(i, i + 50).join(",")}`, { headers });
    for (const c of res.Contacts) if (c.EmailAddress) emails.set(c.ContactID, c.EmailAddress);
  }
  const item = (i: XeroInvoice): OpenItem => ({
    id: i.InvoiceID,
    number: i.InvoiceNumber || null,
    contact: i.Contact.Name,
    email: emails.get(i.Contact.ContactID) ?? null,
    issueDate: day(i.DateString),
    dueDate: day(i.DueDateString),
    total: i.Total,
    amountDue: i.AmountDue,
    currency: i.CurrencyCode,
    url: `https://go.xero.com/${i.Type === "ACCREC" ? "AccountsReceivable" : "AccountsPayable"}/View.aspx?InvoiceID=${i.InvoiceID}`,
  });
  return { system: "xero", receivable: open.filter((i) => i.Type === "ACCREC").map(item), payable: open.filter((i) => i.Type === "ACCPAY").map(item) };
}

interface QboTxn {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt: number;
  Balance: number;
  CurrencyRef?: { value: string };
  CustomerRef?: { name?: string };
  VendorRef?: { name?: string };
  BillEmail?: { Address?: string };
}

async function quickbooksOpenItems(conn: Conn): Promise<OpenItems> {
  const token = await accessToken(conn);
  const realm = String(conn.meta?.realmId);
  const host = conn.meta?.sandbox ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
  const app = conn.meta?.sandbox ? "https://app.sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com";
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const query = async (entity: "Invoice" | "Bill") => {
    const q = encodeURIComponent(`select * from ${entity} where Balance > '0' maxresults 500`);
    const res = await vendorFetch<{ QueryResponse: Record<string, QboTxn[] | undefined> }>("QuickBooks", `${host}/v3/company/${realm}/query?query=${q}&minorversion=73`, { headers });
    return res.QueryResponse[entity] ?? [];
  };
  const item = (t: QboTxn, kind: "invoice" | "bill"): OpenItem => ({
    id: t.Id,
    number: t.DocNumber ?? null,
    contact: (kind === "invoice" ? t.CustomerRef?.name : t.VendorRef?.name) ?? "Unknown",
    email: kind === "invoice" ? (t.BillEmail?.Address ?? null) : null,
    issueDate: day(t.TxnDate),
    dueDate: day(t.DueDate),
    total: t.TotalAmt,
    amountDue: t.Balance,
    currency: t.CurrencyRef?.value ?? "USD",
    url: `${app}/app/${kind}?txnId=${t.Id}`,
  });
  const [invoices, bills] = await Promise.all([query("Invoice"), query("Bill")]);
  return { system: "quickbooks", receivable: invoices.map((t) => item(t, "invoice")), payable: bills.map((t) => item(t, "bill")) };
}

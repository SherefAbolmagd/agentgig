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

export type AccountingSystem = "xero" | "quickbooks" | "freshbooks" | "sage";
export const ACCOUNTING_NAMES: Record<AccountingSystem, string> = { xero: "Xero", quickbooks: "QuickBooks", freshbooks: "FreshBooks", sage: "Sage" };

export interface BillResult {
  system: AccountingSystem;
  id: string;
  url: string;
}

export async function connectedAccounting(userId: string): Promise<AccountingSystem | null> {
  for (const p of ["xero", "quickbooks", "freshbooks", "sage"] as const) if (await getConnection(userId, p)) return p;
  return null;
}

export async function createBill(userId: string, bill: BillInput): Promise<BillResult | null> {
  const xero = await getConnection(userId, "xero");
  if (xero) return xeroBill(xero, bill);
  const qbo = await getConnection(userId, "quickbooks");
  if (qbo) return quickbooksBill(qbo, bill);
  const fb = await getConnection(userId, "freshbooks");
  if (fb) return freshbooksBill(fb, bill);
  const sg = await getConnection(userId, "sage");
  if (sg) return sageBill(sg, bill);
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
  system: AccountingSystem;
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
  const fb = await getConnection(userId, "freshbooks");
  if (fb) return freshbooksOpenItems(fb);
  const sg = await getConnection(userId, "sage");
  if (sg) return sageOpenItems(sg);
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

/* ------------------------------------------------------------------ */
/* FreshBooks                                                          */
/* ------------------------------------------------------------------ */

async function freshbooks(conn: Conn) {
  const token = await accessToken(conn);
  const base = `https://api.freshbooks.com/accounting/account/${conn.meta?.accountId}`;
  return <T>(path: string, init: RequestInit = {}) =>
    vendorFetch<{ response: { result: T } }>("FreshBooks", `${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "api-version": "alpha", ...(init.headers ?? {}) },
    }).then((r) => r.response.result);
}

interface FbMoney {
  amount: string;
  code: string;
}

async function freshbooksOpenItems(conn: Conn): Promise<OpenItems> {
  const fb = await freshbooks(conn);
  type Inv = { invoiceid: number; invoice_number: string; customerid: number; organization: string; fname: string; lname: string; create_date: string; due_date: string; amount: FbMoney; outstanding: FbMoney; payment_status: string; v3_status: string };
  const invoices: Inv[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fb<{ invoices: Inv[]; pages: number }>(`/invoices/invoices?per_page=100&page=${page}`);
    invoices.push(...r.invoices);
    if (page >= r.pages) break;
  }
  const open = invoices.filter((i) => ["unpaid", "partial"].includes(i.payment_status) && i.v3_status !== "draft");
  const ids = [...new Set(open.map((i) => i.customerid))];
  const emails = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const q = ids.slice(i, i + 50).map((id) => `search[userids][]=${id}`).join("&");
    const r = await fb<{ clients: { userid: number; email: string }[] }>(`/users/clients?${q}&per_page=50`);
    for (const c of r.clients) if (c.email) emails.set(c.userid, c.email);
  }
  type Bill = { id: number; bill_number: string | null; vendor?: { vendor_name: string }; issue_date: string; due_date: string; amount: FbMoney; outstanding: FbMoney };
  const bills = (await fb<{ bills: Bill[] }>("/bills/bills?per_page=100")).bills.filter((b) => Number(b.outstanding?.amount ?? 0) > 0);
  return {
    system: "freshbooks",
    receivable: open.map((i) => ({
      id: String(i.invoiceid),
      number: i.invoice_number || null,
      contact: i.organization || `${i.fname} ${i.lname}`.trim(),
      email: emails.get(i.customerid) ?? null,
      issueDate: day(i.create_date),
      dueDate: day(i.due_date),
      total: Number(i.amount.amount),
      amountDue: Number(i.outstanding.amount),
      currency: i.amount.code,
      url: `https://my.freshbooks.com/#/invoice/${i.invoiceid}`,
    })),
    payable: bills.map((b) => ({
      id: String(b.id),
      number: b.bill_number,
      contact: b.vendor?.vendor_name ?? "Supplier",
      email: null,
      issueDate: day(b.issue_date),
      dueDate: day(b.due_date),
      total: Number(b.amount.amount),
      amountDue: Number(b.outstanding.amount),
      currency: b.amount.code,
      url: `https://my.freshbooks.com/#/bill/${b.id}`,
    })),
  };
}

async function freshbooksBill(conn: Conn, b: BillInput): Promise<BillResult> {
  const fb = await freshbooks(conn);
  const code = b.currency.toUpperCase();
  const found = await fb<{ bill_vendors: { vendorid: number; vendor_name: string }[] }>(`/bill_vendors/bill_vendors?search[vendor_name]=${encodeURIComponent(b.supplier)}`);
  const vendorid =
    found.bill_vendors.find((v) => v.vendor_name.toLowerCase() === b.supplier.toLowerCase())?.vendorid ??
    (await fb<{ bill_vendor: { vendorid: number } }>("/bill_vendors/bill_vendors", { method: "POST", body: JSON.stringify({ bill_vendor: { vendor_name: b.supplier, currency_code: code, language: "en" } }) })).bill_vendor.vendorid;
  const cats = await fb<{ categories: { categoryid: number; category: string; parentid: number | null }[] }>("/expenses/categories?per_page=100");
  const category = cats.categories.find((c) => /office|supplies|general/i.test(c.category)) ?? cats.categories.find((c) => c.parentid !== null) ?? cats.categories[0];
  if (!category) throw new GatewayError("AGENT_FAILED", "FreshBooks has no expense category to put the bill against.");
  const issue = b.issueDate ?? new Date().toISOString().slice(0, 10);
  const offset = b.dueDate ? Math.max(0, Math.round((Date.parse(b.dueDate) - Date.parse(issue)) / 86_400_000)) : 30;
  const res = await fb<{ bill: { id: number } }>("/bills/bills", {
    method: "POST",
    body: JSON.stringify({
      bill: {
        vendorid,
        issue_date: issue,
        due_offset_days: offset,
        currency_code: code,
        language: "en",
        bill_number: b.invoiceNumber ?? undefined,
        lines: b.lines.map((l) => ({ categoryid: category.categoryid, description: l.description.slice(0, 500), quantity: String(l.quantity), unit_cost: { amount: l.unitPrice.toFixed(2), code } })),
      },
    }),
  });
  return { system: "freshbooks", id: String(res.bill.id), url: `https://my.freshbooks.com/#/bill/${res.bill.id}` };
}

/* ------------------------------------------------------------------ */
/* Sage Accounting                                                     */
/* ------------------------------------------------------------------ */

async function sage(conn: Conn) {
  const token = await accessToken(conn);
  return <T>(path: string, init: RequestInit = {}) =>
    vendorFetch<T>("Sage", `https://api.accounting.sage.com/v3.1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "x-business": String(conn.meta?.businessId), "content-type": "application/json", accept: "application/json", ...(init.headers ?? {}) },
    });
}

type SageInvoice = { id: string; invoice_number?: string; vendor_reference?: string; contact: { id: string; displayed_as: string }; date: string; due_date: string; total_amount: string; outstanding_amount: string; currency?: { id: string } };

async function sageOpenItems(conn: Conn): Promise<OpenItems> {
  const call = await sage(conn);
  const list = async (kind: "sales_invoices" | "purchase_invoices") => {
    const out: SageInvoice[] = [];
    for (const status of ["UNPAID", "PART_PAID"]) out.push(...(await call<{ $items: SageInvoice[] }>(`/${kind}?status_id=${status}&attributes=all&items_per_page=200`)).$items);
    return out;
  };
  const [sales, purchases] = await Promise.all([list("sales_invoices"), list("purchase_invoices")]);
  const emails = new Map<string, string>();
  for (const id of [...new Set(sales.map((i) => i.contact.id))].slice(0, 50)) {
    const c = await call<{ email?: string; main_contact_person?: { email?: string } }>(`/contacts/${id}`).catch(() => null);
    const email = c?.main_contact_person?.email || c?.email;
    if (email) emails.set(id, email);
  }
  const item = (i: SageInvoice, kind: "sales" | "purchase"): OpenItem => ({
    id: i.id,
    number: (kind === "sales" ? i.invoice_number : i.vendor_reference) ?? null,
    contact: i.contact.displayed_as,
    email: kind === "sales" ? (emails.get(i.contact.id) ?? null) : null,
    issueDate: day(i.date),
    dueDate: day(i.due_date),
    total: Number(i.total_amount),
    amountDue: Number(i.outstanding_amount),
    currency: i.currency?.id ?? "GBP",
    url: `https://accounting.sage.com/${kind === "sales" ? "invoicing/sales_invoices" : "purchases/purchase_invoices"}/${i.id}`,
  });
  return { system: "sage", receivable: sales.map((i) => item(i, "sales")), payable: purchases.map((i) => item(i, "purchase")) };
}

async function sageBill(conn: Conn, b: BillInput): Promise<BillResult> {
  const call = await sage(conn);
  const found = await call<{ $items: { id: string; displayed_as: string }[] }>(`/contacts?contact_type_id=VENDOR&search=${encodeURIComponent(b.supplier)}`);
  const contactId =
    found.$items.find((c) => c.displayed_as.toLowerCase().startsWith(b.supplier.toLowerCase()))?.id ??
    (await call<{ id: string }>("/contacts", { method: "POST", body: JSON.stringify({ contact: { name: b.supplier, contact_type_ids: ["VENDOR"] } }) })).id;
  const ledgers = await call<{ $items: { id: string; displayed_as: string }[] }>("/ledger_accounts?visible_in=purchasing&items_per_page=50");
  const ledger = ledgers.$items.find((l) => /general purchases|cost of sales|purchases/i.test(l.displayed_as)) ?? ledgers.$items[0];
  if (!ledger) throw new GatewayError("AGENT_FAILED", "Sage has no purchase ledger account to put the bill against.");
  const net = b.lines.reduce((t, l) => t + l.quantity * l.unitPrice, 0);
  const pct = b.taxAmount && net > 0 ? (b.taxAmount / net) * 100 : 0;
  const rates = await call<{ $items: { id: string; percentage: string }[] }>("/tax_rates?attributes=percentage&items_per_page=50").catch(() => ({ $items: [] as { id: string; percentage: string }[] }));
  const rate = rates.$items.reduce<{ id: string; percentage: string } | null>((best, r) => (!best || Math.abs(Number(r.percentage) - pct) < Math.abs(Number(best.percentage) - pct) ? r : best), null);
  const res = await call<{ id: string }>("/purchase_invoices", {
    method: "POST",
    body: JSON.stringify({
      purchase_invoice: {
        contact_id: contactId,
        date: b.issueDate ?? new Date().toISOString().slice(0, 10),
        ...(b.dueDate && { due_date: b.dueDate }),
        vendor_reference: b.invoiceNumber ?? undefined,
        notes: b.note.slice(0, 2000),
        invoice_lines: b.lines.map((l) => ({ description: l.description.slice(0, 200), ledger_account_id: ledger.id, quantity: l.quantity, unit_price: l.unitPrice, ...(rate && { tax_rate_id: rate.id }) })),
      },
    }),
  });
  return { system: "sage", id: res.id, url: `https://accounting.sage.com/purchases/purchase_invoices/${res.id}` };
}

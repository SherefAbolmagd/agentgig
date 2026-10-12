import "server-only";
import { getConnection } from "./index";
import { vendorFetch } from "./keys";
import { accessToken } from "./tokens";
import type { StoreProduct } from "./store";

/** Square (read-only): takings, catalogue stock, appointments and invoices. */

const VERSION = "2025-01-23";
type Conn = NonNullable<Awaited<ReturnType<typeof getConnection>>>;

async function square(userId: string) {
  const conn = await getConnection(userId, "square");
  if (!conn) return null;
  const base = conn.meta?.sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  const token = await accessToken(conn);
  const call = <T>(path: string, init: RequestInit = {}) =>
    vendorFetch<T>("Square", `${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "square-version": VERSION, "content-type": "application/json", accept: "application/json", ...(init.headers ?? {}) },
    });
  return { conn, call, locations: (conn.meta?.locationIds as string[] | undefined) ?? [] };
}

interface Money {
  amount?: number;
  currency?: string;
}
const major = (m?: Money) => (m?.amount ?? 0) / 100;

/* ---------- takings ---------- */

export interface SalesSummary {
  source: string;
  currency: string;
  gross: number;
  prevGross: number;
  refunds: number;
  count: number;
  disputes: number;
}

/** Completed card and cash payments in the last `days` days, and the period before. */
export async function squareSales(userId: string, days: number): Promise<SalesSummary | null> {
  const s = await square(userId);
  if (!s) return null;
  const now = Date.now();
  const start = new Date(now - 2 * days * 86_400_000).toISOString();
  const cut = now - days * 86_400_000;
  type Payment = { status: string; created_at: string; amount_money?: Money; refunded_money?: Money };
  const payments: Payment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ begin_time: start, limit: "100", ...(cursor && { cursor }) });
    const res = await s.call<{ payments?: Payment[]; cursor?: string }>(`/v2/payments?${q}`);
    payments.push(...(res.payments ?? []));
    cursor = res.cursor;
    if (!cursor) break;
  }
  const done = payments.filter((p) => p.status === "COMPLETED");
  const recent = done.filter((p) => Date.parse(p.created_at) >= cut);
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    source: "Square",
    currency: (done[0]?.amount_money?.currency ?? (s.conn.meta?.currency as string) ?? "USD").toUpperCase(),
    gross: r(recent.reduce((t, p) => t + major(p.amount_money), 0)),
    prevGross: r(done.filter((p) => Date.parse(p.created_at) < cut).reduce((t, p) => t + major(p.amount_money), 0)),
    refunds: r(recent.reduce((t, p) => t + major(p.refunded_money), 0)),
    count: recent.length,
    disputes: 0,
  };
}

/* ---------- stock ---------- */

/** Catalogue items with tracked stock and units sold in the last 7 days. */
export async function squareProducts(userId: string): Promise<StoreProduct[] | null> {
  const s = await square(userId);
  if (!s) return null;
  type Obj = { id: string; type: string; item_data?: { name: string; variations?: { id: string; item_variation_data?: { name?: string; sku?: string; price_money?: Money } }[] } };
  const res = await s.call<{ objects?: Obj[] }>("/v2/catalog/list?types=ITEM");
  const variations = (res.objects ?? []).flatMap((o) =>
    (o.item_data?.variations ?? []).map((v) => ({
      id: v.id,
      name: v.item_variation_data?.name && v.item_variation_data.name !== "Regular" ? `${o.item_data!.name} · ${v.item_variation_data.name}` : o.item_data!.name,
      sku: v.item_variation_data?.sku || null,
      price: v.item_variation_data?.price_money ? major(v.item_variation_data.price_money) : null,
    })),
  );
  if (!variations.length) return [];
  const counts = new Map<string, number>();
  for (let i = 0; i < variations.length; i += 500) {
    const c = await s.call<{ counts?: { catalog_object_id: string; state: string; quantity: string }[] }>("/v2/inventory/counts/batch-retrieve", {
      method: "POST",
      body: JSON.stringify({ catalog_object_ids: variations.slice(i, i + 500).map((v) => v.id), states: ["IN_STOCK"] }),
    });
    for (const x of c.counts ?? []) counts.set(x.catalog_object_id, (counts.get(x.catalog_object_id) ?? 0) + Number(x.quantity));
  }
  const sold = new Map<string, number>();
  if (s.locations.length) {
    const orders = await s.call<{ orders?: { line_items?: { catalog_object_id?: string; quantity: string }[] }[] }>("/v2/orders/search", {
      method: "POST",
      body: JSON.stringify({
        location_ids: s.locations.slice(0, 10),
        limit: 500,
        query: { filter: { state_filter: { states: ["COMPLETED"] }, date_time_filter: { closed_at: { start_at: new Date(Date.now() - 7 * 86_400_000).toISOString() } } }, sort: { sort_field: "CLOSED_AT" } },
      }),
    });
    for (const o of orders.orders ?? []) for (const li of o.line_items ?? []) if (li.catalog_object_id) sold.set(li.catalog_object_id, (sold.get(li.catalog_object_id) ?? 0) + Number(li.quantity));
  }
  return variations
    .filter((v) => counts.has(v.id))
    .map((v) => ({ sku: v.sku ?? v.name, name: v.name, onHand: counts.get(v.id) ?? 0, soldLast7: sold.get(v.id) ?? 0, unitCost: null, price: v.price, supplier: "Unknown supplier", supplierEmail: null }));
}

/* ---------- appointments ---------- */

export interface Booking {
  id: string;
  source: string;
  start: string;
  end: string | null;
  service: string;
  customerName: string;
  customerEmail: string | null;
  /** booked | cancelled | no_show */
  status: "booked" | "cancelled" | "no_show";
}

export async function squareBookings(userId: string, from: Date, to: Date): Promise<Booking[] | null> {
  const s = await square(userId);
  if (!s) return null;
  type B = { id: string; start_at: string; status: string; customer_id?: string; appointment_segments?: { duration_minutes?: number; service_variation_id?: string }[] };
  const out: B[] = [];
  for (const loc of s.locations.length ? s.locations : [undefined]) {
    const q = new URLSearchParams({ start_at_min: from.toISOString(), start_at_max: to.toISOString(), limit: "100", ...(loc && { location_id: loc }) });
    out.push(...((await s.call<{ bookings?: B[] }>(`/v2/bookings?${q}`)).bookings ?? []));
  }
  const customerIds = [...new Set(out.map((b) => b.customer_id).filter(Boolean))] as string[];
  const customers = new Map<string, { name: string; email: string | null }>();
  if (customerIds.length) {
    const res = await s.call<{ responses?: Record<string, { customer?: { given_name?: string; family_name?: string; email_address?: string } }> }>("/v2/customers/bulk-retrieve", {
      method: "POST",
      body: JSON.stringify({ customer_ids: customerIds.slice(0, 100) }),
    });
    for (const [id, r] of Object.entries(res.responses ?? {})) customers.set(id, { name: [r.customer?.given_name, r.customer?.family_name].filter(Boolean).join(" "), email: r.customer?.email_address ?? null });
  }
  const serviceIds = [...new Set(out.flatMap((b) => (b.appointment_segments ?? []).map((a) => a.service_variation_id)).filter(Boolean))] as string[];
  const services = new Map<string, string>();
  if (serviceIds.length) {
    const res = await s.call<{ objects?: { id: string; item_variation_data?: { name?: string } }[]; related_objects?: { item_data?: { name?: string; variations?: { id: string }[] } }[] }>("/v2/catalog/batch-retrieve", {
      method: "POST",
      body: JSON.stringify({ object_ids: serviceIds, include_related_objects: true }),
    });
    for (const item of res.related_objects ?? []) for (const v of item.item_data?.variations ?? []) if (item.item_data?.name) services.set(v.id, item.item_data.name);
    for (const o of res.objects ?? []) if (!services.has(o.id) && o.item_variation_data?.name) services.set(o.id, o.item_variation_data.name);
  }
  return out.map((b) => {
    const minutes = (b.appointment_segments ?? []).reduce((t, a) => t + (a.duration_minutes ?? 0), 0);
    const c = b.customer_id ? customers.get(b.customer_id) : undefined;
    return {
      id: `square-${b.id}`,
      source: "Square",
      start: b.start_at,
      end: minutes ? new Date(Date.parse(b.start_at) + minutes * 60_000).toISOString() : null,
      service: services.get(b.appointment_segments?.[0]?.service_variation_id ?? "") ?? "Appointment",
      customerName: c?.name || "Customer",
      customerEmail: c?.email ?? null,
      status: b.status === "NO_SHOW" ? "no_show" : b.status.startsWith("CANCELLED") || b.status === "DECLINED" ? "cancelled" : "booked",
    };
  });
}

/* ---------- invoices ---------- */

export interface SquareInvoice {
  id: string;
  number: string | null;
  contact: string;
  email: string | null;
  dueDate: string | null;
  total: number;
  amountDue: number;
  currency: string;
  url: string;
}

export async function squareOpenInvoices(userId: string): Promise<SquareInvoice[] | null> {
  const s = await square(userId);
  if (!s) return null;
  type Inv = {
    id: string;
    invoice_number?: string;
    status: string;
    public_url?: string;
    primary_recipient?: { given_name?: string; family_name?: string; company_name?: string; email_address?: string };
    payment_requests?: { due_date?: string; computed_amount_money?: Money; total_completed_amount_money?: Money }[];
  };
  const out: SquareInvoice[] = [];
  for (const loc of s.locations) {
    const res = await s.call<{ invoices?: Inv[] }>(`/v2/invoices?location_id=${encodeURIComponent(loc)}&limit=200`);
    for (const i of res.invoices ?? []) {
      if (!["UNPAID", "PARTIALLY_PAID"].includes(i.status)) continue;
      const req = i.payment_requests?.[0];
      const total = major(req?.computed_amount_money);
      const r = i.primary_recipient;
      out.push({
        id: i.id,
        number: i.invoice_number ?? null,
        contact: r?.company_name || [r?.given_name, r?.family_name].filter(Boolean).join(" ") || "Customer",
        email: r?.email_address ?? null,
        dueDate: req?.due_date ?? null,
        total,
        amountDue: Math.round((total - major(req?.total_completed_amount_money)) * 100) / 100,
        currency: (req?.computed_amount_money?.currency ?? "USD").toUpperCase(),
        url: i.public_url ?? `https://squareup.com/dashboard/invoices/${i.id}`,
      });
    }
  }
  return out;
}

export type { Conn as SquareConnection };

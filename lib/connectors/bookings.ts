import "server-only";
import { GatewayError } from "@/lib/errors";
import { keyFields, vendorFetch, type KeyTester } from "./keys";
import { squareBookings, type Booking } from "./square";

/**
 * Appointments from whichever booking tool the owner uses: Square
 * Appointments, Calendly or Acuity Scheduling. All are combined.
 */

export type { Booking };

/* ---------- Calendly (personal access token) ---------- */

const calendly = <T>(token: string, url: string) => vendorFetch<T>("Calendly", url.startsWith("http") ? url : `https://api.calendly.com${url}`, { headers: { authorization: `Bearer ${token.trim()}`, accept: "application/json" } });

export const testCalendly: KeyTester = async (f) => {
  const me = await calendly<{ resource: { uri: string; name: string; email: string; current_organization: string } }>(f.token, "/users/me");
  return { accountLabel: `Calendly · ${me.resource.name}`, meta: { userUri: me.resource.uri } };
};

async function calendlyBookings(userId: string, from: Date, to: Date): Promise<Booking[] | null> {
  const k = await keyFields(userId, "calendly");
  if (!k) return null;
  const user = k.conn.meta?.userUri as string;
  const statuses = ["active", "canceled"] as const;
  const events: { uri: string; name: string; start_time: string; end_time: string; status: string }[] = [];
  for (const status of statuses) {
    const q = new URLSearchParams({ user, min_start_time: from.toISOString(), max_start_time: to.toISOString(), status, count: "100" });
    events.push(...(await calendly<{ collection: typeof events }>(k.fields.token, `/scheduled_events?${q}`)).collection);
  }
  const out: Booking[] = [];
  for (const e of events.slice(0, 60)) {
    const invitees = await calendly<{ collection: { name: string; email: string; no_show: unknown | null; status: string }[] }>(k.fields.token, `${e.uri}/invitees?count=10`);
    for (const i of invitees.collection) {
      out.push({
        id: `calendly-${e.uri.split("/").pop()}-${i.email}`,
        source: "Calendly",
        start: e.start_time,
        end: e.end_time,
        service: e.name,
        customerName: i.name,
        customerEmail: i.email,
        status: e.status === "canceled" || i.status === "canceled" ? "cancelled" : i.no_show ? "no_show" : "booked",
      });
    }
  }
  return out;
}

/* ---------- Acuity Scheduling (user ID + API key) ---------- */

const acuity = <T>(f: Record<string, string>, path: string) =>
  vendorFetch<T>("Acuity", `https://acuityscheduling.com/api/v1${path}`, { headers: { authorization: `Basic ${Buffer.from(`${f.userId.trim()}:${f.apiKey.trim()}`).toString("base64")}`, accept: "application/json" } });

export const testAcuity: KeyTester = async (f) => {
  if (!/^\d+$/.test(f.userId?.trim() ?? "")) throw new GatewayError("INVALID_INPUT", "The Acuity user ID is a number, shown above the API key.");
  const me = await acuity<{ name?: string; email?: string }>(f, "/me");
  return { accountLabel: `Acuity · ${me.name ?? me.email ?? f.userId}`, meta: {} };
};

async function acuityBookings(userId: string, from: Date, to: Date): Promise<Booking[] | null> {
  const k = await keyFields(userId, "acuity");
  if (!k) return null;
  type A = { id: number; datetime: string; endTime?: string; type: string; firstName: string; lastName: string; email: string; canceled?: boolean; noShow?: boolean };
  const q = (canceled: boolean) => `/appointments?${new URLSearchParams({ minDate: from.toISOString(), maxDate: to.toISOString(), max: "200", canceled: String(canceled) })}`;
  const [live, cancelled] = await Promise.all([acuity<A[]>(k.fields, q(false)), acuity<A[]>(k.fields, q(true))]);
  return [...live, ...cancelled].map((a) => ({
    id: `acuity-${a.id}`,
    source: "Acuity",
    start: new Date(a.datetime).toISOString(),
    end: null,
    service: a.type,
    customerName: `${a.firstName} ${a.lastName}`.trim(),
    customerEmail: a.email || null,
    status: a.canceled ? "cancelled" : a.noShow ? "no_show" : "booked",
  }));
}

/* ---------- combined ---------- */

/** All bookings between two instants from every connected tool. Null if none is connected. */
export async function allBookings(userId: string, from: Date, to: Date): Promise<{ sources: string[]; bookings: Booking[] } | null> {
  const results = await Promise.all([squareBookings(userId, from, to), calendlyBookings(userId, from, to), acuityBookings(userId, from, to)]);
  const names = ["Square", "Calendly", "Acuity"];
  const sources = names.filter((_, i) => results[i] !== null);
  if (!sources.length) return null;
  const bookings = results.flatMap((r) => r ?? []).sort((a, b) => a.start.localeCompare(b.start));
  return { sources, bookings };
}

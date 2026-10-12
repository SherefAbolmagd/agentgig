"use client";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useConnections } from "@/lib/client/firestore";
import type { AgentDoc } from "@/types/firestore";
import { RunRow } from "./task-runner";

type Run = (input: Record<string, unknown>, file?: File) => void;
interface FormProps {
  agent: AgentDoc;
  busy: boolean;
  run: Run;
}

async function sample(path: string) {
  return (await fetch(path)).text();
}

function nextMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

export function DmConciergeForm({ agent, busy, run }: FormProps) {
  const [msg, setMsg] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ customerMessage: msg, ...(String(f.get("customerName")).trim() && { customerName: String(f.get("customerName")) }) });
      }}
    >
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="customerMessage">Customer message</Label>
          <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setMsg("Hi, do you deliver to Salford? And is the oat milk barista grade? We're 25 people.")}>
            Use an example
          </button>
        </div>
        <Textarea id="customerMessage" value={msg} onChange={(e) => setMsg(e.target.value)} rows={3} required minLength={2} maxLength={2000} placeholder="Paste what the customer wrote" />
      </div>
      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor="customerName">
          Customer name <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input id="customerName" name="customerName" maxLength={80} />
      </div>
      <p className="text-xs text-muted-foreground">With Slack connected and “When a customer messages in Slack” chosen, DM Concierge answers in your channel by itself.</p>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function InventoryForm({ agent, busy, run }: FormProps) {
  const [csv, setCsv] = useState("");
  const store = useConnectedStore();
  const [source, setSource] = useState<"store" | "csv" | null>(null);
  const from = source ?? (store ? "store" : "csv");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ ...(from === "csv" && { stockCsv: csv }), leadTimeDays: Number(f.get("leadTimeDays")), coverDays: Number(f.get("coverDays")) });
      }}
    >
      <RadioGroup value={from} onValueChange={(v) => setSource(v as "store" | "csv")} className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <RadioGroupItem value="store" disabled={!store} /> {store ? `Live stock from ${store}` : "Live stock (connect Shopify, WooCommerce or Square)"}
        </label>
        <label className="flex items-center gap-2">
          <RadioGroupItem value="csv" /> A CSV export
        </label>
      </RadioGroup>
      {from === "csv" && <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="stockCsv">Stock export (CSV)</Label>
          <div className="flex gap-3 text-xs">
            <label className="cursor-pointer font-medium text-primary hover:underline">
              Upload CSV
              <input type="file" accept=".csv,text/csv" hidden onChange={async (e) => e.target.files?.[0] && setCsv(await e.target.files[0].text())} />
            </label>
            <button type="button" className="font-medium text-primary hover:underline" onClick={async () => setCsv(await sample("/samples/stock-cafe-lumen.csv"))}>
              Use sample stock
            </button>
          </div>
        </div>
        <Textarea id="stockCsv" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} required className="font-mono text-xs" placeholder="SKU, Product, On hand, Sold last 7 days, Unit cost, Supplier, Supplier email" />
        <p className="text-xs text-muted-foreground">Needs product, on-hand and last-7-days sales columns; Shopify and most till exports work.</p>
      </div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="leadTimeDays">Supplier lead time (days)</Label>
          <Input id="leadTimeDays" name="leadTimeDays" type="number" min={0} max={60} defaultValue={3} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="coverDays">Order enough for (days)</Label>
          <Input id="coverDays" name="coverDays" type="number" min={1} max={90} defaultValue={14} />
        </div>
      </div>
      <RunRow agent={agent} busy={busy} disabled={from === "csv" && !csv.trim()} />
    </form>
  );
}

export function ReviewForm({ agent, busy, run }: FormProps) {
  const [text, setText] = useState("");
  const [rating, setRating] = useState("2");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ reviewText: text, rating: Number(rating), ...(String(f.get("reviewerName")).trim() && { reviewerName: String(f.get("reviewerName")) }) });
      }}
    >
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="reviewText">Review</Label>
          <button
            type="button"
            className="text-xs font-medium text-primary hover:underline"
            onClick={() => {
              setText("Coffee is lovely but our delivery came two hours late on Tuesday and the oat milk was missing. Had to send someone out.");
              setRating("2");
            }}
          >
            Use an example
          </button>
        </div>
        <Textarea id="reviewText" value={text} onChange={(e) => setText(e.target.value)} rows={3} required minLength={2} maxLength={4000} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="rating">Stars</Label>
          <Select value={rating} onValueChange={setRating}>
            <SelectTrigger id="rating" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[5, 4, 3, 2, 1].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {"★".repeat(n)} ({n})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="reviewerName">
            Reviewer <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input id="reviewerName" name="reviewerName" maxLength={80} />
        </div>
      </div>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function RotaForm({ agent, busy, run }: FormProps) {
  const [staff, setStaff] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ staffCsv: staff, weekStarting: String(f.get("weekStarting")), minStaffPerShift: Number(f.get("minStaffPerShift")) });
      }}
    >
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="staffCsv">Team: name, role, max hours, days off</Label>
          <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={async () => setStaff(await sample("/samples/staff-cafe-lumen.csv"))}>
            Use sample team
          </button>
        </div>
        <Textarea id="staffCsv" value={staff} onChange={(e) => setStaff(e.target.value)} rows={5} required className="font-mono text-xs" placeholder={"Amira, barista, 30, Mon\nBen, barista, 20,"} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="weekStarting">Week starting</Label>
          <Input id="weekStarting" name="weekStarting" type="date" defaultValue={nextMonday()} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="minStaffPerShift">People per shift</Label>
          <Input id="minStaffPerShift" name="minStaffPerShift" type="number" min={1} max={20} defaultValue={2} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Shifts: Mon–Fri, 07:00–12:00 and 12:00–17:00. RotaBuilder checks every rule and lists any it couldn&apos;t meet.</p>
      <RunRow agent={agent} busy={busy} disabled={!staff.trim()} />
    </form>
  );
}

export function OnboardingForm({ agent, busy, run }: FormProps) {
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const email = String(f.get("newHireEmail")).trim();
        run({
          newHireName: String(f.get("newHireName")),
          role: String(f.get("role")),
          startDate: String(f.get("startDate")),
          managerName: String(f.get("managerName")),
          ...(email && { newHireEmail: email }),
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="newHireName" label="New hire's name" />
        <Field id="role" label="Role" placeholder="e.g. Barista" />
        <Field id="startDate" label="Start date" type="date" defaultValue={nextMonday()} />
        <Field id="managerName" label="Their manager" />
        <Field id="newHireEmail" label="Their email (optional)" type="email" required={false} hint="Only used to address the Gmail draft; never sent to the AI." />
      </div>
      <p className="text-xs text-muted-foreground">Upload your staff handbook under Company knowledge and tick it when hiring, so answers come from your real policies.</p>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

function Field({ id, label, type = "text", required = true, placeholder, defaultValue, hint }: { id: string; label: string; type?: string; required?: boolean; placeholder?: string; defaultValue?: string; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} type={type} required={required} placeholder={placeholder} defaultValue={defaultValue} maxLength={120} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}


/** Name of the connected store platform, if any. */
function useConnectedStore(): string | null {
  const conns = useConnections();
  const names: Record<string, string> = { shopify: "Shopify", woocommerce: "WooCommerce", square: "Square" };
  const c = conns.data.find((x) => x.provider in names && x.status === "active");
  return c ? names[c.provider] : null;
}

function Choice({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange(v: string): void; options: [string, string][] }) {
  return (
    <div className="grid gap-1.5 sm:max-w-xs">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}

export function OrderDeskForm({ agent, busy, run }: FormProps) {
  const [question, setQuestion] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const orderNumber = String(f.get("orderNumber")).trim();
        const customerEmail = String(f.get("customerEmail")).trim();
        run({ question, ...(orderNumber && { orderNumber }), ...(customerEmail && { customerEmail }) });
      }}
    >
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="question">Customer&apos;s question</Label>
          <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setQuestion("Hi, I ordered last week and haven't had anything yet. Where's my order?")}>
            Use an example
          </button>
        </div>
        <Textarea id="question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} required minLength={2} maxLength={2000} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="orderNumber">
            Order number <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input id="orderNumber" name="orderNumber" maxLength={30} placeholder="e.g. 1042" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="customerEmail">
            Customer email <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input id="customerEmail" name="customerEmail" type="email" placeholder="Used only to find the order" />
        </div>
      </div>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function WinbackForm({ agent, busy, run }: FormProps) {
  const [subscribedOnly, setSubscribedOnly] = useState(true);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const offer = String(f.get("offer")).trim();
        run({ inactiveDays: Number(f.get("inactiveDays")), maxCustomers: Number(f.get("maxCustomers")), subscribedOnly, ...(offer && { offer }) });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="inactiveDays">No order for (days)</Label>
          <Input id="inactiveDays" name="inactiveDays" type="number" min={14} max={730} defaultValue={60} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="maxCustomers">Most emails to draft</Label>
          <Input id="maxCustomers" name="maxCustomers" type="number" min={1} max={25} defaultValue={10} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="offer">
          Offer <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input id="offer" name="offer" maxLength={200} placeholder="e.g. 10% off with code WELCOMEBACK until Friday" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={subscribedOnly} onCheckedChange={(v) => setSubscribedOnly(v === true)} /> Only customers who agreed to marketing emails
      </label>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function RevenueForm({ agent, busy, run }: FormProps) {
  const [days, setDays] = useState("7");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run({ periodDays: Number(days) });
      }}
    >
      <Choice id="periodDays" label="Look at" value={days} onChange={setDays} options={[["7", "The last 7 days"], ["30", "The last 30 days"]]} />
      <Note>Figures are read from Stripe with a read-only key and calculated exactly; the AI only writes the summary and reminder emails.</Note>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function NewsletterForm({ agent, busy, run }: FormProps) {
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const topic = String(f.get("topic")).trim();
        const ctaUrl = String(f.get("ctaUrl")).trim();
        run({ ...(topic && { topic }), ...(ctaUrl && { ctaUrl }) });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="topic">
          Theme <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea id="topic" name="topic" rows={2} maxLength={300} placeholder="Leave empty for what's new and what customers love" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ctaUrl">
          Button link <span className="font-normal text-muted-foreground">(optional, defaults to your website)</span>
        </Label>
        <Input id="ctaUrl" name="ctaUrl" type="url" placeholder="https://" />
      </div>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function LeadForm({ agent, busy, run }: FormProps) {
  const [days, setDays] = useState("3");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run({ sinceDays: Number(days) });
      }}
    >
      <Choice id="sinceDays" label="New leads from" value={days} onChange={setDays} options={[["1", "The last day"], ["3", "The last 3 days"], ["7", "The last week"]]} />
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function BookkeeperForm({ agent, busy, run }: FormProps) {
  const [period, setPeriod] = useState("this-month");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run({ period });
      }}
    >
      <Choice id="bk-period" label="Invoices from" value={period} onChange={setPeriod} options={[["this-month", "This month"], ["last-month", "Last month"]]} />
      <Note>Uses the invoices ReceiptHero has already checked. Ones it flagged are held back, and each invoice is only ever booked once.</Note>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function BookingForm({ agent, busy, run }: FormProps) {
  const [day, setDay] = useState("today");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run({ day });
      }}
    >
      <Choice id="day" label="Meetings" value={day} onChange={setDay} options={[["today", "Today"], ["tomorrow", "Tomorrow"]]} />
      <Note>Only meetings with people outside your company are briefed. Attendees&apos; email addresses aren&apos;t sent to the AI.</Note>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

const optional = <span className="font-normal text-muted-foreground">(optional)</span>;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** Small attach-a-file control for agents that read documents. */
function FilePick({ id, label, accept, file, onFile }: { id: string; label: string; accept: string; file: File | null; onFile(f: File | null): void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm">
      <label htmlFor={id} className="cursor-pointer font-medium text-primary hover:underline">
        {file ? "Change file" : label}
      </label>
      <input id={id} type="file" accept={accept} hidden onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      <span className="min-w-0 truncate text-muted-foreground">{file ? `${file.name} · ${Math.ceil(file.size / 1024)} KB` : "No file attached"}</span>
      {file && (
        <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => onFile(null)}>
          Remove
        </button>
      )}
    </div>
  );
}

export function InvoiceChaserForm({ agent, busy, run }: FormProps) {
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ minDaysOverdue: Number(f.get("minDaysOverdue")), maxInvoices: Number(f.get("maxInvoices")) });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="minDaysOverdue">Chase invoices overdue by at least (days)</Label>
          <Input id="minDaysOverdue" name="minDaysOverdue" type="number" min={0} max={365} defaultValue={1} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="maxInvoices">Most reminders to draft</Label>
          <Input id="maxInvoices" name="maxInvoices" type="number" min={1} max={25} defaultValue={15} />
        </div>
      </div>
      <Note>Reads unpaid invoices from Xero or QuickBooks. Reminders get firmer the later the invoice is, and no invoice is chased twice in a week.</Note>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function QuoteForm({ agent, busy, run }: FormProps) {
  const [enquiry, setEnquiry] = useState("");
  const [currency, setCurrency] = useState("GBP");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({
          enquiry,
          currency,
          vatRate: Number(f.get("vatRate")),
          validDays: Number(f.get("validDays")),
          ...(str(f, "customerName") && { customerName: str(f, "customerName") }),
          ...(str(f, "customerEmail") && { customerEmail: str(f, "customerEmail") }),
        });
      }}
    >
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="enquiry">Customer&apos;s enquiry</Label>
          <button
            type="button"
            className="text-xs font-medium text-primary hover:underline"
            onClick={() => setEnquiry("Hi, we're a team of 25 moving into a new office in Salford next month. Could you quote for a weekly coffee subscription with oat milk, plus a tasting session for the team in the first week?")}
          >
            Use an example
          </button>
        </div>
        <Textarea id="enquiry" value={enquiry} onChange={(e) => setEnquiry(e.target.value)} rows={4} required minLength={10} maxLength={4000} />
        <p className="text-xs text-muted-foreground">Prices come from your business profile and any price list in Company knowledge.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="customerName">Customer name {optional}</Label>
          <Input id="customerName" name="customerName" maxLength={80} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="customerEmail">Customer email {optional}</Label>
          <Input id="customerEmail" name="customerEmail" type="email" placeholder="Only used as the draft's recipient" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Choice id="currency" label="Currency" value={currency} onChange={setCurrency} options={[["GBP", "GBP £"], ["EUR", "EUR €"], ["USD", "USD $"]]} />
        <div className="grid gap-1.5">
          <Label htmlFor="vatRate">VAT %</Label>
          <Input id="vatRate" name="vatRate" type="number" min={0} max={30} step="0.5" defaultValue={20} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="validDays">Valid for (days)</Label>
          <Input id="validDays" name="validDays" type="number" min={1} max={120} defaultValue={30} />
        </div>
      </div>
      <RunRow agent={agent} busy={busy} disabled={enquiry.trim().length < 10} />
    </form>
  );
}

export function CashflowForm({ agent, busy, run }: FormProps) {
  const [currency, setCurrency] = useState("GBP");
  const [costs, setCosts] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ openingBalance: Number(f.get("openingBalance")), currency, regularCosts: costs, ...(str(f, "weeklySales") && { weeklySales: Number(f.get("weeklySales")) }) });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="openingBalance">Cash in the bank today</Label>
          <Input id="openingBalance" name="openingBalance" type="number" step="0.01" required />
        </div>
        <Choice id="cf-currency" label="Currency" value={currency} onChange={setCurrency} options={[["GBP", "GBP £"], ["EUR", "EUR €"], ["USD", "USD $"]]} />
        <div className="grid gap-1.5">
          <Label htmlFor="weeklySales">Other sales per week {optional}</Label>
          <Input id="weeklySales" name="weeklySales" type="number" min={0} step="0.01" placeholder="Uses Stripe if connected" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="regularCosts">Regular costs {optional}</Label>
          <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setCosts("Rent, 1200, monthly, 1\nWages, 2400, monthly, 28\nVan lease, 85, weekly")}>
            Use an example
          </button>
        </div>
        <Textarea id="regularCosts" value={costs} onChange={(e) => setCosts(e.target.value)} rows={4} className="font-mono text-xs" placeholder="One per line: name, amount, weekly or monthly, day of month" />
      </div>
      <Note>Unpaid invoices and bills come from Xero or QuickBooks, and takings from Stripe, when connected. The sums are done exactly; the AI only explains them.</Note>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function ProposalForm({ agent, busy, run }: FormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [brief, setBrief] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run(
          {
            brief,
            ...(str(f, "buyer") && { buyer: str(f, "buyer") }),
            ...(str(f, "deadline") && { deadline: str(f, "deadline") }),
            ...(str(f, "wordLimit") && { wordLimit: Number(f.get("wordLimit")) }),
          },
          file ?? undefined,
        );
      }}
    >
      <FilePick id="proposal-file" label="Attach the tender or brief (PDF or text)" accept="application/pdf,text/plain,text/markdown,.md,.txt" file={file} onFile={setFile} />
      <div className="grid gap-1.5">
        <Label htmlFor="brief">{file ? "Anything to add" : "Or paste the brief"}</Label>
        <Textarea id="brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} maxLength={20000} placeholder="What the buyer wants, their questions and how they'll score answers" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="buyer">Buyer {optional}</Label>
          <Input id="buyer" name="buyer" maxLength={120} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="deadline">Deadline {optional}</Label>
          <Input id="deadline" name="deadline" type="date" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wordLimit">Word limit {optional}</Label>
          <Input id="wordLimit" name="wordLimit" type="number" min={200} max={10000} />
        </div>
      </div>
      <RunRow agent={agent} busy={busy} disabled={!file && brief.trim().length < 30} />
    </form>
  );
}

export function ReviewRequestForm({ agent, busy, run }: FormProps) {
  const [subscribedOnly, setSubscribedOnly] = useState(true);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({
          daysAfterDelivery: Number(f.get("daysAfterDelivery")),
          maxRequests: Number(f.get("maxRequests")),
          subscribedOnly,
          ...(str(f, "reviewUrl") && { reviewUrl: str(f, "reviewUrl") }),
        });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="reviewUrl">Review link {optional}</Label>
        <Input id="reviewUrl" name="reviewUrl" type="url" placeholder="Leave empty to use the link in Company knowledge" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="daysAfterDelivery">Ask this many days after delivery</Label>
          <Input id="daysAfterDelivery" name="daysAfterDelivery" type="number" min={1} max={30} defaultValue={5} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="maxRequests">Most requests to draft</Label>
          <Input id="maxRequests" name="maxRequests" type="number" min={1} max={30} defaultValue={15} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={subscribedOnly} onCheckedChange={(v) => setSubscribedOnly(v === true)} /> Only customers who agreed to marketing emails
      </label>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function HiringForm({ agent, busy, run }: FormProps) {
  const [mode, setMode] = useState<"advert" | "screen">("advert");
  const [file, setFile] = useState<File | null>(null);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run(
          {
            mode,
            role: str(f, "role"),
            mustHaves: str(f, "mustHaves"),
            ...(str(f, "niceToHaves") && { niceToHaves: str(f, "niceToHaves") }),
            ...(str(f, "details") && { details: str(f, "details") }),
          },
          mode === "screen" ? (file ?? undefined) : undefined,
        );
      }}
    >
      <RadioGroup value={mode} onValueChange={(v) => setMode(v as "advert" | "screen")} className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <RadioGroupItem value="advert" /> Write a job advert
        </label>
        <label className="flex items-center gap-2">
          <RadioGroupItem value="screen" /> Check a CV
        </label>
      </RadioGroup>
      <div className="grid gap-1.5">
        <Label htmlFor="role">Role</Label>
        <Input id="role" name="role" required minLength={2} maxLength={120} placeholder="e.g. Part-time barista" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="mustHaves">Must-haves</Label>
          <Textarea id="mustHaves" name="mustHaves" rows={3} required minLength={3} maxLength={2000} placeholder="One per line, e.g. Available weekday mornings" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="niceToHaves">Nice to have {optional}</Label>
          <Textarea id="niceToHaves" name="niceToHaves" rows={3} maxLength={2000} />
        </div>
      </div>
      {mode === "advert" ? (
        <div className="grid gap-1.5">
          <Label htmlFor="details">Pay, hours, location, start date {optional}</Label>
          <Input id="details" name="details" maxLength={2000} placeholder="e.g. £12.60/hour, 20 hours a week, Manchester, start in March" />
        </div>
      ) : (
        <FilePick id="cv-file" label="Attach the CV (PDF or text)" accept="application/pdf,text/plain,.txt" file={file} onFile={setFile} />
      )}
      {mode === "screen" && <Note>The CV is judged only against your criteria. Age, gender, nationality, photos and career gaps are ignored, and nobody is rejected automatically.</Note>}
      <RunRow agent={agent} busy={busy} disabled={mode === "screen" && !file} />
    </form>
  );
}

export function DeadlineForm({ agent, busy, run }: FormProps) {
  const [vat, setVat] = useState("none");
  const [payroll, setPayroll] = useState(false);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({
          vatQuarters: vat,
          payroll,
          otherDates: str(f, "otherDates"),
          lookAheadDays: Number(f.get("lookAheadDays")),
          ...(str(f, "companyNumber") && { companyNumber: str(f, "companyNumber") }),
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="companyNumber">Companies House number {optional}</Label>
          <Input id="companyNumber" name="companyNumber" maxLength={8} placeholder="Uses your profile if empty" />
        </div>
        <Choice
          id="vatQuarters"
          label="VAT periods end in"
          value={vat}
          onChange={setVat}
          options={[["none", "Not VAT registered"], ["mar-jun-sep-dec", "Mar, Jun, Sep, Dec"], ["jan-apr-jul-oct", "Jan, Apr, Jul, Oct"], ["feb-may-aug-nov", "Feb, May, Aug, Nov"], ["monthly", "Every month"]]}
        />
        <div className="grid gap-1.5">
          <Label htmlFor="lookAheadDays">Look ahead (days)</Label>
          <Input id="lookAheadDays" name="lookAheadDays" type="number" min={7} max={365} defaultValue={90} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={payroll} onCheckedChange={(v) => setPayroll(v === true)} /> I run payroll (PAYE)
      </label>
      <div className="grid gap-1.5">
        <Label htmlFor="otherDates">Your own dates {optional}</Label>
        <Textarea id="otherDates" name="otherDates" rows={3} maxLength={3000} className="font-mono text-xs" placeholder={"One per line: what, YYYY-MM-DD\nInsurance renewal, 2026-12-01"} />
      </div>
      <Note>UK rules. Weekly runs reuse these settings.</Note>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function MeetingForm({ agent, busy, run }: FormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ notes, ...(str(f, "meetingTitle") && { meetingTitle: str(f, "meetingTitle") }) }, file ?? undefined);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="meetingTitle">Meeting {optional}</Label>
        <Input id="meetingTitle" name="meetingTitle" maxLength={120} placeholder="e.g. Monthly catch-up with Northside Offices" />
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="notes">Notes</Label>
          <button
            type="button"
            className="text-xs font-medium text-primary hover:underline"
            onClick={() =>
              setNotes("Call w/ Jo (Northside Offices). They want to add 2nd floor from March, ~15 more people. Agreed: trial oat + almond for 4 wks. Jo to confirm headcount by Fri. Sam to send revised price + tasting dates. Delivery day maybe Tue instead of Mon - Jo checking with facilities.")
            }
          >
            Use an example
          </button>
        </div>
        <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} maxLength={30000} placeholder="Rough notes are fine" />
      </div>
      <FilePick id="meeting-file" label="Or attach notes or a transcript (PDF or text)" accept="application/pdf,text/plain,text/markdown,.md,.txt" file={file} onFile={setFile} />
      <RunRow agent={agent} busy={busy} disabled={!file && notes.trim().length < 30} />
    </form>
  );
}

export function BookingAssistantForm({ agent, busy, run }: FormProps) {
  const [mode, setMode] = useState("both");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ mode, ...(str(f, "ba-review") && { reviewUrl: str(f, "ba-review") }), ...(str(f, "ba-booking") && { bookingUrl: str(f, "ba-booking") }) });
      }}
    >
      <Choice id="ba-mode" label="Send" value={mode} onChange={setMode} options={[["both", "Reminders and follow-ups"], ["reminders", "Reminders for tomorrow only"], ["follow-ups", "Follow-ups for yesterday only"]]} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ba-review">Review link {optional}</Label>
          <Input id="ba-review" name="ba-review" type="url" placeholder="Uses Company knowledge if empty" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ba-booking">Booking link {optional}</Label>
          <Input id="ba-booking" name="ba-booking" type="url" placeholder="Where customers rebook; defaults to your website" />
        </div>
      </div>
      <Note>Reads Square Appointments, Calendly and Acuity. Each booking gets each message once, however often this runs.</Note>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function DealNudgerForm({ agent, busy, run }: FormProps) {
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ quietDays: Number(f.get("quietDays")), maxDeals: Number(f.get("maxDeals")) });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="quietDays">No activity for at least (days)</Label>
          <Input id="quietDays" name="quietDays" type="number" min={3} max={120} defaultValue={14} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="maxDeals">Most deals to nudge</Label>
          <Input id="maxDeals" name="maxDeals" type="number" min={1} max={20} defaultValue={10} />
        </div>
      </div>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

export function EnquiryForm({ agent, busy, run }: FormProps) {
  const [hours, setHours] = useState("24");
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run({ sinceHours: Number(hours) });
      }}
    >
      <Choice id="sinceHours" label="New entries from" value={hours} onChange={setHours} options={[["24", "The last day"], ["72", "The last 3 days"], ["168", "The last week"]]} />
      <Note>Reads Typeform and Jotform. Email addresses and phone numbers in answers are hidden from the AI, and each entry is handled once.</Note>
      <RunRow agent={agent} busy={busy} />
    </form>
  );
}

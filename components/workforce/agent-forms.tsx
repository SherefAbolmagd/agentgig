"use client";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AgentDoc } from "@/types/firestore";
import { RunRow } from "./task-runner";

type Run = (input: Record<string, unknown>) => void;
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
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ stockCsv: csv, leadTimeDays: Number(f.get("leadTimeDays")), coverDays: Number(f.get("coverDays")) });
      }}
    >
      <div className="grid gap-1.5">
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
      </div>
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
      <RunRow agent={agent} busy={busy} disabled={!csv.trim()} />
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


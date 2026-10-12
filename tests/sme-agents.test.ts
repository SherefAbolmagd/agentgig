import assert from "node:assert/strict";
import { test } from "node:test";
import { forecastWeeks, parseCosts } from "@/lib/agents/cashflow-forecast";
import { ukDeadlines } from "@/lib/agents/deadline-keeper";
import { screenSuggestion } from "@/lib/agents/hiring-assistant";
import { chaseStage } from "@/lib/agents/invoice-chaser";
import { quoteTotals } from "@/lib/agents/quote-builder";
import { inWindow } from "@/lib/connectors/store";

test("reminders get firmer with lateness and repeat chases", () => {
  assert.equal(chaseStage(3, 0), "friendly");
  assert.equal(chaseStage(20, 0), "firm");
  assert.equal(chaseStage(3, 1), "firm");
  assert.equal(chaseStage(45, 0), "final");
  assert.equal(chaseStage(5, 2), "final");
});

test("quote sums are exact to the penny", () => {
  const t = quoteTotals([{ quantity: 3, unitPrice: 18.5 }, { quantity: 1, unitPrice: 39.99 }, { quantity: 0.5, unitPrice: 0.1 }], 20);
  assert.deepEqual(t.amounts, [55.5, 39.99, 0.05]);
  assert.equal(t.subtotal, 95.54);
  assert.equal(t.vat, 19.11);
  assert.equal(t.total, 114.65);
  assert.equal(quoteTotals([{ quantity: 1, unitPrice: 100 }], 0).total, 100);
});

test("regular costs parse friendly lines and report the rest", () => {
  const { costs, skipped } = parseCosts("Rent, £1,200, monthly, 1\nVan, 85, weekly\nWages, 2400, Monthly, 31\nnonsense\nFree thing, 0, weekly");
  assert.deepEqual(costs, [
    { name: "Rent", amount: 1200, every: "monthly", day: 1 },
    { name: "Van", amount: 85, every: "weekly", day: 1 },
    { name: "Wages", amount: 2400, every: "monthly", day: 28 },
  ]);
  assert.deepEqual(skipped, ["nonsense", "Free thing, 0, weekly"]);
});

test("13-week forecast buckets receipts, bills and costs, overdue items early", () => {
  const start = new Date("2026-10-12T00:00:00Z"); // a Monday
  const weeks = forecastWeeks(
    start,
    1000,
    [
      { label: "Overdue customer", amount: 500, date: "2026-09-30" },
      { label: "Due week 3", amount: 300, date: "2026-10-28" },
      { label: "Beyond horizon", amount: 999, date: "2027-03-01" },
    ],
    [{ label: "Overdue bill", amount: 200, date: "2026-10-01" }],
    [
      { name: "Rent", amount: 1200, every: "monthly", day: 1 },
      { name: "Van", amount: 50, every: "weekly", day: 1 },
    ],
    100,
  );
  assert.equal(weeks.length, 13);
  assert.equal(weeks[0].weekStart, "2026-10-12");
  assert.equal(weeks[0].moneyOut, 250); // overdue bill + van
  assert.equal(weeks[1].moneyIn, 600); // weekly sales + overdue receipt
  assert.equal(weeks[2].moneyIn, 400);
  const rentWeek = weeks.find((w) => w.notes.includes("Rent"))!;
  assert.equal(rentWeek.weekStart, "2026-10-26"); // contains 1 November
  assert.equal(weeks[0].closing, 1000 + 100 - 250);
  const total = weeks.reduce((s, w) => s + w.moneyIn - w.moneyOut, 0);
  assert.equal(weeks[12].closing, Math.round((1000 + total) * 100) / 100);
});

test("UK deadlines follow HMRC and Companies House rules", () => {
  const today = new Date("2026-10-12T09:00:00Z");
  const { deadlines, skipped } = ukDeadlines(today, 120, {
    company: { name: "Café Lumen Ltd", status: "active", accountsDue: "2026-12-31", accountsMadeUpTo: "2026-03-31", confirmationDue: "2026-11-14" },
    vatQuarters: "mar-jun-sep-dec",
    payroll: true,
    otherDates: "Insurance renewal, 2026-11-01\nbad line",
  });
  const find = (what: string) => deadlines.filter((d) => d.what === what).map((d) => d.date);
  assert.deepEqual(find("File annual accounts"), ["2026-12-31"]);
  assert.deepEqual(find("File confirmation statement"), ["2026-11-14"]);
  assert.deepEqual(find("Pay Corporation Tax"), ["2027-01-01"]); // 9 months and a day after 31 March
  assert.deepEqual(find("File Corporation Tax return (CT600)"), []); // March 2027, beyond 120 days
  assert.deepEqual(find("Submit VAT return and pay"), ["2026-11-07", "2027-02-07"]); // quarters to 30 Sep and 31 Dec
  assert.deepEqual(find("Pay PAYE and National Insurance"), ["2026-10-22", "2026-11-22", "2026-12-22", "2027-01-22"]);
  assert.deepEqual(find("Insurance renewal"), ["2026-11-01"]);
  assert.deepEqual(skipped, ["bad line"]);
  assert.equal(deadlines[0].date, "2026-10-22");
  assert.equal(deadlines[0].daysLeft, 10);
  assert.ok(deadlines.every((d, i) => i === 0 || deadlines[i - 1].date <= d.date));
});

test("VAT due dates handle short months", () => {
  const { deadlines } = ukDeadlines(new Date("2027-01-01T00:00:00Z"), 120, { vatQuarters: "feb-may-aug-nov", payroll: false, otherDates: "" });
  assert.deepEqual(deadlines.map((d) => d.date), ["2027-01-07", "2027-04-07"]); // periods to 30 Nov and 28 Feb
});

test("CV suggestions never reject, and unclear isn't treated as a no", () => {
  assert.equal(screenSuggestion([{ mustHave: true, met: "yes" }, { mustHave: false, met: "no" }]).suggestion, "Worth a call");
  assert.equal(screenSuggestion([{ mustHave: true, met: "yes" }, { mustHave: true, met: "unclear" }]).suggestion, "Worth a call, check the unclear points");
  const gaps = screenSuggestion([{ mustHave: true, met: "no" }, { mustHave: true, met: "yes" }]);
  assert.deepEqual(gaps, { met: 1, total: 2, suggestion: "Check the gaps before deciding" });
});

test("delivery window is inclusive of its edges", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  assert.ok(inWindow("2026-10-07T12:00:00Z", 5, 12, now));
  assert.ok(!inWindow("2026-10-09T12:00:00Z", 5, 12, now));
  assert.ok(!inWindow("2026-09-29T12:00:00Z", 5, 12, now));
});

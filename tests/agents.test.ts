import assert from "node:assert/strict";
import { test } from "node:test";
import { analyseStock, parseStockCsv } from "@/lib/agents/inventory-guardian";
import { checkRota, parseStaffCsv, RotaInput } from "@/lib/agents/rotabuilder";

const STOCK = `SKU,Product,On hand,Sold last 7 days,Unit cost,Supplier,Supplier email
OAT-1L,"Oat milk 1L, case of 6",4,21,£14.40,Lumen Supplies,orders@lumen.example
BEAN-1K,Espresso beans 1kg,30,7,18.50,Lumen Supplies,orders@lumen.example
CUP-12,Paper cups 12oz x100,10,0,9.90,PaperCo,`;

test("parses a stock CSV with friendly headers, quotes and currency symbols", () => {
  const rows = parseStockCsv(STOCK);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    sku: "OAT-1L",
    name: "Oat milk 1L, case of 6",
    onHand: 4,
    soldLast7: 21,
    unitCost: 14.4,
    supplier: "Lumen Supplies",
    supplierEmail: "orders@lumen.example",
  });
  assert.equal(rows[2].supplierEmail, null);
});

test("reorders only what runs out within lead time + safety, enough for the cover period", () => {
  const [oat, beans, cups] = analyseStock(parseStockCsv(STOCK), 3, 14);
  // 3/day, 4 on hand → 1.3 days of cover < 3 + 2 → order 3 × 17 − 4 = 47
  assert.equal(oat.daysOfCover, 1.3);
  assert.equal(oat.reorderQty, 47);
  assert.equal(oat.reorderCost, 676.8);
  // 1/day, 30 on hand → 30 days: fine
  assert.equal(beans.reorderQty, 0);
  // no sales → no cover figure, no order
  assert.equal(cups.daysOfCover, null);
  assert.equal(cups.reorderQty, 0);
});

test("a stock file without required columns explains what's missing", () => {
  assert.throws(() => parseStockCsv("sku,price\nA,1"), /needs columns for name, on_hand, sold_last_7_days/);
});

const STAFF = `name, role, max_hours, unavailable
Amira, barista, 20, Mon
Ben, barista, 10,
Cleo, supervisor, 40, Sat Sun`;

test("parses staff lines with availability", () => {
  const staff = parseStaffCsv(STAFF);
  assert.deepEqual(staff[0], { name: "Amira", role: "barista", maxHours: 20, unavailable: ["Mon"] });
  assert.deepEqual(staff[2].unavailable, ["Sat", "Sun"]);
});

test("rota checks catch unavailability, over-hours, thin and missing shifts", () => {
  const input = RotaInput.parse({ staffCsv: STAFF, weekStarting: "2026-10-12", openDays: ["Mon", "Tue"], minStaffPerShift: 2 });
  const staff = parseStaffCsv(STAFF);
  const s = (day: "Mon" | "Tue", shift: string, names: string[]) => {
    const t = input.shifts.find((x) => x.name === shift)!;
    return { day, shift, start: t.start, end: t.end, staff: names };
  };
  const { hours, violations } = checkRota(input, staff, [
    s("Mon", "Morning", ["Amira", "Cleo"]),
    s("Mon", "Afternoon", ["Ben", "Cleo"]),
    s("Tue", "Morning", ["Ben", "Cleo"]),
    s("Tue", "Afternoon", ["Ghost"]),
  ]);
  assert.equal(hours.Ben, 10);
  assert.equal(hours.Cleo, 15);
  assert.ok(violations.some((v) => v.includes("Amira is unavailable on Mon")));
  assert.ok(violations.some((v) => v.includes("“Ghost” isn't on the staff list")));
  assert.ok(violations.some((v) => v.includes("Tue Afternoon: 1 of 2 people")));
  assert.equal(violations.filter((v) => v.includes("hours (max")).length, 0);
});

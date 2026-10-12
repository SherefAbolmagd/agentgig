import assert from "node:assert/strict";
import { test } from "node:test";
import { audit, type Extracted } from "@/lib/agents/receipthero";

// The Lumen Supplies invoice from the prototype: items + 20% VAT = £124.92, printed total £126.92.
const lumen: Extracted = {
  isInvoiceOrReceipt: true,
  vendor: { name: "Lumen Supplies Ltd", address: null, taxId: "GB 293 8841 07", email: null },
  invoiceNumber: "INV-20931",
  issueDate: "2026-10-08",
  currency: "GBP",
  lineItems: [
    { description: "Oat milk 1L (case)", quantity: 12, unitPrice: 2.4, amount: 28.8 },
    { description: "Espresso beans 1kg", quantity: 3, unitPrice: 18.5, amount: 55.5 },
    { description: "Paper cups 12oz x100", quantity: 2, unitPrice: 9.9, amount: 19.8 },
  ],
  subtotal: 104.1,
  taxRate: 0.2,
  taxAmount: 20.82,
  totalPrinted: 126.92,
  readingConfidence: 0.97,
};

test("flags a £2.00 overcharge on the printed total", () => {
  const flags = audit(lumen);
  assert.equal(flags[0].code, "TOTAL_MISMATCH");
  assert.equal(flags[0].severity, "high");
  assert.equal(flags[0].difference, 2);
  assert.match(flags[0].message, /£126\.92.*£124\.92/);
});

test("a correct invoice has no flags", () => {
  assert.deepEqual(audit({ ...lumen, totalPrinted: 124.92 }), []);
});

test("float sums don't cause false alarms", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ description: `Item ${i}`, quantity: 1, unitPrice: 0.1, amount: 0.1 }));
  assert.deepEqual(audit({ ...lumen, lineItems: items, subtotal: 1, taxRate: null, taxAmount: 0, totalPrinted: 1 }), []);
});

test("catches line maths, subtotal and tax errors", () => {
  const codes = audit({
    ...lumen,
    lineItems: [{ description: "Beans", quantity: 3, unitPrice: 18.5, amount: 56.5 }],
    subtotal: 50,
    taxAmount: 15,
    totalPrinted: 65,
  }).map((f) => f.code);
  assert.deepEqual(codes.sort(), ["LINE_MATH", "SUBTOTAL_MISMATCH", "TAX_MISMATCH"]);
});

test("missing invoice number and tax ID are low severity", () => {
  const flags = audit({ ...lumen, invoiceNumber: null, vendor: { ...lumen.vendor, taxId: null }, totalPrinted: 124.92 });
  assert.deepEqual(flags.map((f) => [f.code, f.severity]), [
    ["MISSING_INVOICE_NUMBER", "low"],
    ["MISSING_TAX_ID", "low"],
  ]);
});

test("works without a printed subtotal", () => {
  const flags = audit({ ...lumen, subtotal: null, totalPrinted: 124.92 });
  assert.deepEqual(flags, []);
});

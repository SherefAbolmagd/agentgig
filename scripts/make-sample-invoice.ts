/**
 * Writes fixtures/invoice-lumen-supplies.pdf: the demo invoice whose printed
 * total (£126.92) is £2.00 more than its items plus VAT (£124.92).
 * Hand-built PDF so there's no PDF library dependency.
 *
 *   npx tsx scripts/make-sample-invoice.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";

type Line = [x: number, y: number, size: number, text: string, bold?: boolean];

const lines: Line[] = [
  [50, 790, 20, "Lumen Supplies Ltd", true],
  [50, 770, 10, "Unit 4, Ancoats Works, Manchester M4 6DE"],
  [50, 756, 10, "VAT Reg. No. GB 293 8841 07"],
  [400, 790, 16, "INVOICE", true],
  [400, 770, 10, "Invoice no: INV-20931"],
  [400, 756, 10, "Date: 08/10/2026"],
  [400, 742, 10, "Due: 22/10/2026"],
  [50, 710, 10, "Bill to: Cafe Lumen Ltd, 12 Tib Street, Manchester M4 1SH", true],
  [50, 670, 10, "Description", true],
  [300, 670, 10, "Qty", true],
  [360, 670, 10, "Unit price", true],
  [470, 670, 10, "Amount", true],
  [50, 648, 10, "Oat milk 1L (case of 6)"],
  [300, 648, 10, "12"],
  [360, 648, 10, "GBP 2.40"],
  [470, 648, 10, "GBP 28.80"],
  [50, 630, 10, "Espresso beans 1kg"],
  [300, 630, 10, "3"],
  [360, 630, 10, "GBP 18.50"],
  [470, 630, 10, "GBP 55.50"],
  [50, 612, 10, "Paper cups 12oz x100"],
  [300, 612, 10, "2"],
  [360, 612, 10, "GBP 9.90"],
  [470, 612, 10, "GBP 19.80"],
  [360, 576, 10, "Subtotal"],
  [470, 576, 10, "GBP 104.10"],
  [360, 560, 10, "VAT 20%"],
  [470, 560, 10, "GBP 20.82"],
  [360, 540, 12, "Total due", true],
  [470, 540, 12, "GBP 126.92", true],
  [50, 480, 9, "Payment by bank transfer. Questions: accounts@lumensupplies.example / 0161 555 0123"],
];

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const content = lines
  .map(([x, y, size, text, bold]) => `BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET`)
  .concat("0.6 w 50 662 m 545 662 l S 360 552 m 545 552 l S")
  .join("\n");

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
];

let pdf = "%PDF-1.4\n";
const offsets: number[] = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/invoice-lumen-supplies.pdf", pdf);
console.log(`✓ fixtures/invoice-lumen-supplies.pdf (${Buffer.byteLength(pdf)} bytes)`);

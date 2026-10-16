/**
 * Files the demo video uses, written to fixtures/video/:
 *   invoice-INV-21407.pdf   a Lumen Supplies invoice whose printed total is £38.40 too high
 *   invoice-BD-5582.pdf     a correct Bridgewater Dairy invoice, dropped in with it
 *   catering-price-list.md  uploaded to Company knowledge on camera; Quote Builder prices from it
 *   catering-enquiry.txt    the customer message forwarded to Ada on Telegram
 *   google-review.txt       the review handed to ReviewPulse
 *   staff.csv               pasted into RotaBuilder
 *
 *   npx tsx scripts/video-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildPdf, type PdfLine } from "./pdf";

export const DIR = "fixtures/video";

/** Items + VAT come to £1,008.48; the invoice asks for £1,046.88. */
const invoice: PdfLine[] = [
  [50, 790, 20, "Lumen Supplies Ltd", true],
  [50, 770, 10, "Unit 4, Ancoats Works, Manchester M4 6DE"],
  [50, 756, 10, "VAT Reg. No. GB 293 8841 07"],
  [400, 790, 16, "INVOICE", true],
  [400, 770, 10, "Invoice no: INV-21407"],
  [400, 756, 10, "Date: 14/10/2026"],
  [400, 742, 10, "Due: 13/11/2026"],
  [50, 710, 10, "Bill to: Cafe Lumen Ltd, 12 Tib Street, Manchester M4 1SH", true],
  [50, 670, 10, "Description", true],
  [300, 670, 10, "Qty", true],
  [360, 670, 10, "Unit price", true],
  [470, 670, 10, "Amount", true],
  [50, 648, 10, "Oat milk 1L (case of 6)"],
  [300, 648, 10, "16"],
  [360, 648, 10, "GBP 14.40"],
  [470, 648, 10, "GBP 230.40"],
  [50, 630, 10, "Green coffee, Colombia Huila 10kg"],
  [300, 630, 10, "6"],
  [360, 630, 10, "GBP 62.00"],
  [470, 630, 10, "GBP 372.00"],
  [50, 612, 10, "Paper cups 12oz x1000"],
  [300, 612, 10, "4"],
  [360, 612, 10, "GBP 38.50"],
  [470, 612, 10, "GBP 154.00"],
  [50, 594, 10, "Compostable lids x1000"],
  [300, 594, 10, "4"],
  [360, 594, 10, "GBP 21.00"],
  [470, 594, 10, "GBP 84.00"],
  [360, 558, 10, "Subtotal"],
  [470, 558, 10, "GBP 840.40"],
  [360, 542, 10, "VAT 20%"],
  [470, 542, 10, "GBP 168.08"],
  [360, 522, 12, "Total due", true],
  [470, 522, 12, "GBP 1,046.88", true],
  [50, 470, 9, "Payment by bank transfer within 30 days. Questions: accounts@lumensupplies.example / 0161 555 0123"],
];

/** A correct invoice, so VAT Reconciler has something to reclaim next to the held-back one. */
const cleanInvoice: PdfLine[] = [
  [50, 790, 20, "Bridgewater Dairy Co.", true],
  [50, 770, 10, "Canal Side Farm, Worsley M28 2PD"],
  [50, 756, 10, "VAT Reg. No. GB 418 2207 63"],
  [400, 790, 16, "INVOICE", true],
  [400, 770, 10, "Invoice no: BD-5582"],
  [400, 756, 10, "Date: 09/10/2026"],
  [400, 742, 10, "Due: 08/11/2026"],
  [50, 710, 10, "Bill to: Cafe Lumen Ltd, 12 Tib Street, Manchester M4 1SH", true],
  [50, 670, 10, "Description", true],
  [300, 670, 10, "Qty", true],
  [360, 670, 10, "Unit price", true],
  [470, 670, 10, "Amount", true],
  [50, 648, 10, "Barista oat milk 1L (case of 6)"],
  [300, 648, 10, "20"],
  [360, 648, 10, "GBP 13.80"],
  [470, 648, 10, "GBP 276.00"],
  [50, 630, 10, "Whole milk 2L (crate of 6)"],
  [300, 630, 10, "8"],
  [360, 630, 10, "GBP 9.60"],
  [470, 630, 10, "GBP 76.80"],
  [360, 594, 10, "Subtotal"],
  [470, 594, 10, "GBP 352.80"],
  [360, 578, 10, "VAT 20%"],
  [470, 578, 10, "GBP 70.56"],
  [360, 558, 12, "Total due", true],
  [470, 558, 12, "GBP 423.36", true],
  [50, 506, 9, "Thank you for your custom. Payment within 30 days to the account on your statement."],
];

const priceList = `# Café Lumen: events and catering price list (2026)

All prices exclude VAT at 20%. We deliver within Greater Manchester; delivery is free over £150.

## Coffee
- Coffee cart with a barista, first 2 hours: £180.00
- Each extra hour of barista service: £60.00
- Filter coffee flask (serves 10): £22.00
- Oat milk upgrade, per 10 drinks: £3.00

## Food
- Mini pastries (croissant, pain au chocolat, cinnamon swirl), per person: £3.20
- Breakfast box (pastry, fruit pot, granola), per person: £6.50
- Seasonal fruit platter (serves 10): £24.00

## Extras
- Compostable cups, lids and napkins: included
- Set-up and clear-down: £35.00
- Weekend events: +15% on the total

Minimum order £120. Book at least 3 working days ahead.
`;

const enquiry = `Hi Café Lumen! I'm Hannah, office manager at Brightwell Studio (Ancoats). We're having an all-hands next Friday, 9:30 to 12:00, for 40 people. Could you do proper coffee and some pastries for everyone? A few people are vegan. What would that cost? Thanks! Hannah`;

const review = `2 stars. Tom R. on Google: "Love the coffee but our office delivery came 40 minutes late twice this month and the oat milk was missing last Monday. Had to run out to Tesco before our client meeting."`;

const staff = `name, role, max_hours, unavailable
Priya, barista, 30, Sat Sun
Jordan, driver, 25, Wed
Alex, barista, 20, Mon Tue
Mei, roaster, 35,
Sam, owner, 20, Fri`;

export function writeVideoFixtures() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/invoice-INV-21407.pdf`, buildPdf(invoice, "0.6 w 50 662 m 545 662 l S 360 534 m 545 534 l S"));
  writeFileSync(`${DIR}/invoice-BD-5582.pdf`, buildPdf(cleanInvoice, "0.6 w 50 662 m 545 662 l S 360 570 m 545 570 l S"));
  writeFileSync(`${DIR}/catering-price-list.md`, priceList);
  writeFileSync(`${DIR}/catering-enquiry.txt`, enquiry);
  writeFileSync(`${DIR}/google-review.txt`, review);
  writeFileSync(`${DIR}/staff.csv`, staff);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/video-fixtures.ts")) {
  writeVideoFixtures();
  console.log(`✓ ${DIR}/`);
}

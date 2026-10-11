import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeFindings, scrubFile, scrubText } from "@/lib/dlp";

// lib/env reads these lazily, on the first scrub call.
process.env.GOOGLE_CLOUD_PROJECT ??= "test-project";
process.env.DLP_MODE = "local";

test("local mode replaces emails and phone numbers with their type", async () => {
  const res = await scrubText({
    audience: "Office managers, contact jo@acme.co.uk or +44 161 555 0199",
    topic: "Weekly delivery",
  });
  assert.equal(res.fields.audience, "Office managers, contact [EMAIL_ADDRESS] or [PHONE_NUMBER]");
  assert.equal(res.fields.topic, "Weekly delivery");
  assert.deepEqual(
    res.findings.sort((a, b) => a.infoType.localeCompare(b.infoType)),
    [
      { infoType: "EMAIL_ADDRESS", count: 1 },
      { infoType: "PHONE_NUMBER", count: 1 },
    ],
  );
});

test("card numbers are caught before the phone pattern", async () => {
  const res = await scrubText({ note: "Paid with 4111 1111 1111 1111" });
  assert.equal(res.fields.note, "Paid with [CREDIT_CARD_NUMBER]");
});

test("plain business text is untouched", async () => {
  const text = "Office coffee subscription from £39/week, open Mon–Fri 07:00–17:00";
  const res = await scrubText({ text });
  assert.equal(res.fields.text, text);
  assert.deepEqual(res.findings, []);
});

test("PDFs pass through with a note", async () => {
  const data = Buffer.from("%PDF-1.4");
  const res = await scrubFile(data, "application/pdf");
  assert.equal(res.redacted, false);
  assert.equal(res.data, data);
  assert.match(res.note ?? "", /not redacted/);
});

test("mergeFindings adds counts per type", () => {
  assert.deepEqual(
    mergeFindings([
      { infoType: "EMAIL_ADDRESS", count: 1 },
      { infoType: "EMAIL_ADDRESS", count: 2 },
      { infoType: "PHONE_NUMBER", count: 1 },
    ]),
    [
      { infoType: "EMAIL_ADDRESS", count: 3 },
      { infoType: "PHONE_NUMBER", count: 1 },
    ],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextOccurrence } from "@/lib/agents/echosocial";

// Sat 11 Oct 2026 14:00 UTC = 15:00 in London (BST, UTC+1)
const now = new Date("2026-10-11T14:00:00Z");

test("Tue 08:30 London is 07:30 UTC during BST", () => {
  assert.equal(nextOccurrence("Tue", "08:30", "Europe/London", now).toISOString(), "2026-10-13T07:30:00.000Z");
});

test("after the clocks change it is 08:30 UTC", () => {
  // Sat 31 Oct 2026; UK clocks go back on Sun 25 Oct
  assert.equal(nextOccurrence("Tue", "08:30", "Europe/London", new Date("2026-10-31T12:00:00Z")).toISOString(), "2026-11-03T08:30:00.000Z");
});

test("same day but less than an hour away rolls to next week", () => {
  assert.equal(nextOccurrence("Sat", "15:30", "Europe/London", now).toISOString(), "2026-10-17T14:30:00.000Z");
});

test("works for other zones", () => {
  assert.equal(nextOccurrence("Mon", "09:00", "America/New_York", now).toISOString(), "2026-10-12T13:00:00.000Z");
});

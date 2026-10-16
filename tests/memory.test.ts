import assert from "node:assert/strict";
import { test } from "node:test";
import { groundingPrompt } from "@/lib/agents/types";
import { expiryFrom, hireShelves, memorySettings } from "@/lib/memory";
import { hasRole } from "@/lib/org";
import { defaultShelves } from "@/lib/shelves";

test("agents get shelves that fit their job, falling back to their category", () => {
  assert.deepEqual(defaultShelves({ slug: "inventory-guardian", category: "E-Commerce", source: "native" }), { read: ["stock"], write: ["stock"] });
  assert.deepEqual(defaultShelves({ slug: "some-new-finance-agent", category: "Finance", source: "native" }), { read: ["money", "customers"], write: ["money"] });
});

test("partner agents can read memory but never add to it, whatever the hire says", () => {
  const partner = { slug: "vat-reconciler", category: "Finance" as const, source: "a2a" as const };
  assert.deepEqual(defaultShelves(partner).write, []);
  assert.deepEqual(hireShelves({ memory: { read: ["money"], write: ["money"] } }, partner), { read: ["money"], write: [] });
});

test("memory is on by default, with approval for customers and money", () => {
  assert.deepEqual(memorySettings({}), { enabled: true, approveShelves: ["customers", "money"] });
  assert.equal(memorySettings({ memory: { enabled: false, approveShelves: [] } }).enabled, false);
});

test("a fact's expiry is the end of the given day, ignoring past or far-off dates", () => {
  const now = Date.parse("2026-10-16T09:00:00Z");
  assert.equal(expiryFrom("2026-10-17", now)?.toDate().toISOString(), "2026-10-17T23:59:59.000Z");
  assert.equal(expiryFrom("2026-10-01", now), null);
  assert.equal(expiryFrom("2028-01-01", now), null);
  assert.equal(expiryFrom("next friday", now), null);
  assert.equal(expiryFrom(null, now), null);
});

test("roles rank owner over manager over member", () => {
  assert.ok(hasRole("owner", "manager"));
  assert.ok(hasRole("manager", "manager"));
  assert.ok(!hasRole("member", "manager"));
  assert.ok(!hasRole("manager", "owner"));
});

test("recalled facts are given to the agent in its prompt", () => {
  const prompt = groundingPrompt({
    businessName: "Café Lumen",
    profile: null,
    styleExamples: [],
    documents: [],
    memory: [{ shelf: "stock", fact: "Oat milk is short until Friday 17 Oct." }],
  });
  assert.match(prompt, /Company memory/);
  assert.match(prompt, /- \[stock\] Oat milk is short until Friday 17 Oct\./);
  assert.doesNotMatch(groundingPrompt({ businessName: "X", profile: null, styleExamples: [], documents: [], memory: [] }), /Company memory/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewSubmit, slugify } from "@/lib/reviews";
import { ReviewInput } from "@/lib/agents/reviewpulse";

test("review page addresses are short, plain and without company suffixes", () => {
  assert.equal(slugify("Café Lumen Ltd"), "cafe-lumen");
  assert.equal(slugify("  Hearth & Crumb  "), "hearth-crumb");
  assert.equal(slugify("!!!"), "business");
  assert.ok(slugify("x".repeat(90)).length <= 40);
});

test("a review needs stars, a name and words; bots filling the hidden field are refused", () => {
  assert.ok(ReviewSubmit.safeParse({ rating: 4, name: "Tom", text: "Great flat white" }).success);
  assert.ok(!ReviewSubmit.safeParse({ rating: 6, name: "Tom", text: "Great" }).success);
  assert.ok(!ReviewSubmit.safeParse({ rating: 4, name: "", text: "Great" }).success);
  assert.ok(!ReviewSubmit.safeParse({ rating: 4, name: "Tom", text: "Great", website: "spam.example" }).success);
});

test("ReviewPulse only accepts a review ID that looks like one", () => {
  assert.ok(ReviewInput.safeParse({ reviewText: "ok", rating: 3, reviewId: "Nr14KpppjAwzRc57dEgv" }).success);
  assert.ok(!ReviewInput.safeParse({ reviewText: "ok", rating: 3, reviewId: "../users/x" }).success);
});

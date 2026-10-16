import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { escapeHtml } from "@/lib/telegram/api";
import { isLinkCode } from "@/lib/telegram/link";
import { describeInput, finalReply, profileLines, toContents } from "@/lib/telegram/supervisor";
import { verifyTelegramSecret } from "@/lib/telegram/webhook";

test("link codes accept only Telegram's start-parameter alphabet and a sensible length", () => {
  assert.ok(isLinkCode("Yq3vT8kP2mWn6RdX9aLc4HsB1eFz7JuQ"));
  assert.ok(!isLinkCode("short"));
  assert.ok(!isLinkCode("has spaces in it but is long enough"));
  assert.ok(!isLinkCode("x".repeat(65)));
});

test("the webhook secret must match exactly", () => {
  process.env.GOOGLE_CLOUD_PROJECT ??= "test";
  process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret_value_for_tests";
  assert.doesNotThrow(() => verifyTelegramSecret("s3cret_value_for_tests"));
  assert.throws(() => verifyTelegramSecret("s3cret_value_for_testz"), /Invalid Telegram secret/);
  assert.throws(() => verifyTelegramSecret(null), /Missing Telegram secret/);
});

test("the supervisor is told each agent's inputs, with defaults and choices", () => {
  const schema = z.object({
    minDaysOverdue: z.number().int().default(1),
    tone: z.enum(["Friendly", "Bold"]),
    topic: z.string().optional(),
  });
  const d = describeInput(schema);
  assert.match(d, /minDaysOverdue \(integer, default 1\)/);
  assert.match(d, /tone \(one of Friendly\|Bold, required\)/);
  assert.match(d, /topic \(string\)/);
  assert.equal(describeInput(z.object({})), "nothing; just run it");
  assert.equal(describeInput(undefined), "free-form details");
});

test("chat history keeps who said what, with agents named", () => {
  const contents = toContents([
    { role: "person", text: "chase northside" },
    { role: "agent", agentName: "Invoice Chaser", text: "Draft ready" },
    { role: "supervisor", text: "On it." },
  ]);
  // Agents' posts sit on the user side, so the model never sees itself writing them.
  assert.deepEqual(contents.map((c) => c.role), ["user", "user", "model"]);
  assert.equal(contents[1].parts?.[0].text, "(Chat note: Invoice Chaser posted this result in the chat) Draft ready");
});

test("after an agent posts, Ada can't restate or invent its result", () => {
  const posted = [{ name: "delegate", result: { status: "awaiting_approval", alreadyPostedInChat: true } }];
  assert.equal(finalReply("Want me to remember Hannah's office?", posted), "Want me to remember Hannah's office?");
  assert.equal(finalReply("[Quote Builder posted] Draft for approval: £330", posted), "");
  assert.equal(finalReply("Here it is:\n\nTotal £330", posted), "");
  assert.equal(finalReply("x".repeat(400), posted), "");
  // Without a posted result (a question, a failed delegate) she speaks freely.
  assert.equal(finalReply("x".repeat(400), [{ name: "delegate", result: { error: "missing input" } }]).length, 400);
});

test("text sent to Telegram can't inject HTML", () => {
  assert.equal(escapeHtml("<b>5 > 3 & 2</b>"), "&lt;b&gt;5 &gt; 3 &amp; 2&lt;/b&gt;");
});

test("Ada sees the whole business profile, so she doesn't ask for the website", () => {
  const lines = profileLines({
    businessProfile: {
      description: "Bakery in Leeds",
      products: "Sourdough £4.80",
      audience: "Office managers",
      toneOfVoice: "Warm",
      avoidWords: ["artisanal"],
      website: "https://hearthandcrumb.example",
    },
  }).join("\n");
  assert.match(lines, /Website: https:\/\/hearthandcrumb\.example/);
  assert.match(lines, /Customers: Office managers/);
  assert.match(lines, /Never use: artisanal/);
  assert.match(profileLines({}).join(""), /isn't filled in/);
});

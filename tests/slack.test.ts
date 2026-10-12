import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifySlackSignature } from "@/lib/connectors/slack-events";

process.env.SLACK_SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const sign = (body: string, ts: string) => `v0=${createHmac("sha256", process.env.SLACK_SIGNING_SECRET!).update(`v0:${ts}:${body}`).digest("hex")}`;
const now = 1_790_000_000_000;
const ts = String(now / 1000);

test("accepts a correctly signed, fresh request", () => {
  verifySlackSignature('{"type":"event_callback"}', ts, sign('{"type":"event_callback"}', ts), now);
});

test("rejects a tampered body", () => {
  assert.throws(() => verifySlackSignature('{"type":"x"}', ts, sign('{"type":"event_callback"}', ts), now), /Invalid Slack signature/);
});

test("rejects a replayed request older than 5 minutes", () => {
  const old = String(now / 1000 - 301);
  assert.throws(() => verifySlackSignature("{}", old, sign("{}", old), now), /Stale/);
});

test("rejects a missing signature", () => {
  assert.throws(() => verifySlackSignature("{}", ts, null, now), /Missing/);
});

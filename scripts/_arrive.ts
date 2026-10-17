import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "node:fs";
(async () => {
  const { getConnection } = await import("@/lib/connectors");
  const { accessToken } = await import("@/lib/connectors/tokens");
  const { db } = await import("@/lib/firebase-admin");
  const token = await accessToken((await getConnection("video-cafe-lumen", "google"))!);
  const raw = ["From: Sophie Turner <sophie.turner@example.com>", "Subject: Where is my order #1010?", `Date: ${new Date().toUTCString()}`, `Message-ID: <${Date.now()}@example.com>`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", readFileSync("fixtures/video/order-question.txt", "utf8")].join("\r\n");
  const t0 = Date.now();
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?internalDateSource=dateHeader", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), labelIds: ["INBOX", "UNREAD"] }) });
  console.log("insert", res.status);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const snap = await db().collection("tasks").where("userId", "==", "video-cafe-lumen").where("agentId", "==", "order-desk").get();
    const t = snap.docs.map((d) => d.data()).find((d) => d.createdAt?.toMillis() > t0);
    if (t) { console.log(`after ${(Date.now() - t0) / 1000}s:`, t.status, t.origin, JSON.stringify(t.output?.email), t.output?.reply); if (t.status !== "running" && t.status !== "reserved" && t.status !== "requested") break; }
  }
  process.exit(0);
})();

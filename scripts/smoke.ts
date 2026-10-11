/**
 * End-to-end check of /api/agents/execute against a running app
 * (`npm run dev` with DEMO_AUTH=true, after `npm run seed -- --reset`).
 *
 *   npm run smoke                 # http://localhost:3000
 *   npm run smoke -- https://…    # a deployed URL with DEMO_AUTH on
 */
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const headers = { "x-demo-user": "demo-cafe-lumen" };

async function call(label: string, init: RequestInit) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/agents/execute`, { method: "POST", ...init, headers: { ...headers, ...init.headers } });
  const body = await res.json();
  console.log(`\n── ${label}: HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { status: res.status, body };
}

async function main() {
  // 1. EchoSocial: hired with "ask me first", so it should land in the approval inbox.
  const social = await call("EchoSocial", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: "echosocial",
      input: {
        brandUrl: "https://cafelumen.co.uk",
        audience: "Office managers in Manchester, reach me at sam@cafelumen.example",
        tone: "Friendly",
      },
    }),
  });
  console.log(`status=${social.body.status} charged=${social.body.tokensCharged} balance=${social.body.balance}`);
  console.log(`dlp=${JSON.stringify(social.body.dlpFindings)}`);
  console.log(social.body.output?.text ?? social.body);

  // 2. ReceiptHero: acts on its own, should flag the £2.00 overcharge.
  const form = new FormData();
  form.set("agentId", "receipthero");
  form.set(
    "file",
    new Blob([readFileSync("fixtures/invoice-lumen-supplies.pdf")], { type: "application/pdf" }),
    "invoice-lumen-supplies.pdf",
  );
  const receipt = await call("ReceiptHero", { body: form });
  console.log(`status=${receipt.body.status} charged=${receipt.body.tokensCharged} balance=${receipt.body.balance}`);
  console.log(`verdict=${receipt.body.output?.verdict}`, receipt.body.output?.flags ?? receipt.body);

  // 3. Validation: bad input must fail before any tokens are held.
  const bad = await call("Invalid input", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "echosocial", input: { brandUrl: "not a url", tone: "Shouty" } }),
  });
  console.log(bad.body.error);

  // 4. A preview partner agent can't run yet.
  const partner = await call("Partner preview", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "inventory-guardian", input: {} }),
  });
  console.log(partner.body.error);
}

main().catch((err) => {
  console.error("✗", err.message ?? err);
  process.exit(1);
});

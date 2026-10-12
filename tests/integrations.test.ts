import assert from "node:assert/strict";
import { test } from "node:test";
import { newsletterHtml } from "@/lib/agents/newsletter-writer";
import { changePct } from "@/lib/agents/revenue-pulse";
import { mailchimpDc } from "@/lib/connectors/mailchimp";
import { normaliseShopDomain } from "@/lib/connectors/shopify";
import { INTEGRATIONS, PROVIDERS, providerForTool } from "@/lib/integrations";

test("accepts the usual ways people write their Shopify address", () => {
  assert.equal(normaliseShopDomain("https://Lumen-Coffee.myshopify.com/admin"), "lumen-coffee.myshopify.com");
  assert.equal(normaliseShopDomain("lumen-coffee"), "lumen-coffee.myshopify.com");
  // Custom domains and anything else could point the token at another host.
  assert.throws(() => normaliseShopDomain("shop.lumen.co.uk"), /myshopify\.com/);
  assert.throws(() => normaliseShopDomain("evil.com/x.myshopify.com"), /myshopify\.com/);
});

test("reads the Mailchimp data centre from the key", () => {
  assert.equal(mailchimpDc("0123456789abcdef0123456789abcdef-us21"), "us21");
  assert.throws(() => mailchimpDc("0123456789abcdef"), /data centre/);
  assert.throws(() => mailchimpDc("abc-evil.com"), /data centre/);
});

test("revenue change is a percentage to one decimal, or null with nothing to compare", () => {
  assert.equal(changePct(1150, 1000), 15);
  assert.equal(changePct(900, 1200), -25);
  assert.equal(changePct(1001, 3000), -66.6);
  assert.equal(changePct(500, 0), null);
});

test("newsletter HTML escapes model text and keeps the unsubscribe merge tag", () => {
  const html = newsletterHtml(
    { subject: "s", previewText: "p", sections: [{ heading: "New <b>beans</b>", body: 'First para\n\nSecond "para" & more' }], ctaLabel: "Shop <now>" },
    'https://lumen.example/?a=1&b="2"',
    "Café Lumen",
  );
  assert.ok(html.includes("New &lt;b&gt;beans&lt;/b&gt;"));
  assert.ok(html.includes("Second &quot;para&quot; &amp; more"));
  assert.equal((html.match(/<p style/g) ?? []).length, 2);
  assert.ok(html.includes('href="https://lumen.example/?a=1&amp;b=&quot;2&quot;"'));
  assert.ok(html.includes("*|UNSUB|*"));
  assert.ok(!html.includes("<now>"));
});

test("every provider has a catalogue entry, and key vendors say what to paste", () => {
  for (const p of PROVIDERS) {
    const info = INTEGRATIONS[p];
    assert.ok(info, p);
    if (info.kind !== "oauth") assert.ok(info.fields?.length && info.steps?.length, `${p} needs fields and steps`);
  }
  assert.equal(providerForTool("google_calendar"), "google");
  assert.equal(providerForTool("hubspot"), "hubspot");
  assert.equal(providerForTool("nope"), null);
});

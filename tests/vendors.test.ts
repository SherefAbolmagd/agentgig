import assert from "node:assert/strict";
import { test } from "node:test";
import { messageFor } from "@/lib/agents/booking-assistant";
import { redactContact } from "@/lib/agents/enquiry-desk";
import { contactOf } from "@/lib/connectors/forms";
import { isZohoAccountsServer } from "@/lib/connectors/oauth";
import { notionDatabaseId } from "@/lib/connectors/tasks";
import { INTEGRATION_GROUPS, INTEGRATIONS, PROVIDERS, providerForTool } from "@/lib/integrations";

test("only Zoho's own regional servers may receive the client secret", () => {
  for (const ok of ["https://accounts.zoho.com", "https://accounts.zoho.eu", "https://accounts.zoho.in", "https://accounts.zoho.com.au", "https://accounts.zoho.jp"]) assert.ok(isZohoAccountsServer(ok), ok);
  for (const bad of ["https://accounts.zoho.com.evil.io", "http://accounts.zoho.com", "https://evil.com/accounts.zoho.com", "https://accounts.zoho.com/", "https://accountsxzoho.com"]) assert.ok(!isZohoAccountsServer(bad), bad);
});

test("booking messages: reminder for tomorrow, the right follow-up for yesterday", () => {
  const now = new Date("2026-10-12T09:00:00Z");
  assert.equal(messageFor({ start: "2026-10-13T15:00:00Z", status: "booked" }, now), "reminder");
  assert.equal(messageFor({ start: "2026-10-13T15:00:00Z", status: "cancelled" }, now), null);
  assert.equal(messageFor({ start: "2026-10-11T10:00:00Z", status: "booked" }, now), "thank_you");
  assert.equal(messageFor({ start: "2026-10-11T10:00:00Z", status: "no_show" }, now), "missed");
  assert.equal(messageFor({ start: "2026-10-11T10:00:00Z", status: "cancelled" }, now), "cancelled");
  assert.equal(messageFor({ start: "2026-10-12T16:00:00Z", status: "booked" }, now), null);
});

test("form answers: contact details found, and hidden from the model", () => {
  const answers = [
    { question: "Your name", answer: "Priya Shah" },
    { question: "Company name", answer: "Northside Offices" },
    { question: "Email", answer: " priya@northside.example " },
    { question: "What do you need?", answer: "Coffee for 25 people, call me on +44 7700 900123 or priya@northside.example" },
  ];
  assert.deepEqual(contactOf(answers), { name: "Priya Shah", email: "priya@northside.example" });
  assert.equal(redactContact(answers[3].answer), "Coffee for 25 people, call me on [phone] or [email]");
  assert.equal(redactContact("Order 1042 for 3 bags"), "Order 1042 for 3 bags");
});

test("Notion database IDs come out of the usual link shapes", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(notionDatabaseId(`https://www.notion.so/team/${id}?v=fedcba9876543210fedcba9876543210`), id);
  assert.equal(notionDatabaseId(`https://www.notion.so/Tasks-${id}`), id);
  assert.equal(notionDatabaseId("https://www.notion.so/01234567-89ab-cdef-0123-456789abcdef"), id);
  assert.equal(notionDatabaseId("https://www.notion.so/nothing-here"), null);
});

test("every integration belongs to a shown group, and new tools map to their provider", () => {
  for (const p of PROVIDERS) assert.ok((INTEGRATION_GROUPS as readonly string[]).includes(INTEGRATIONS[p].group), p);
  assert.equal(providerForTool("outlook"), "microsoft");
  assert.equal(providerForTool("outlook_calendar"), "microsoft");
  assert.equal(providerForTool("zoho_crm"), "zoho");
  assert.equal(providerForTool("square"), "square");
});

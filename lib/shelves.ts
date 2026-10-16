import type { AgentCategory } from "@/types/a2a";
import type { MemorySettings, Shelf } from "@/types/firestore";

/**
 * Company memory is split into shelves so each agent only reads what its job
 * needs. Shared by server and browser code.
 */

export const SHELF_INFO: Record<Shelf, { label: string; hint: string }> = {
  customers: { label: "Customers", hint: "Who pays late, preferences, regular orders. Business names only." },
  money: { label: "Money", hint: "Payment terms, expected receipts, VAT dates, cash warnings." },
  stock: { label: "Stock", hint: "What's running low, delivery days, items off the menu." },
  brand: { label: "Brand", hint: "Promotions, words to avoid, what works on social." },
  team: { label: "Team", hint: "Holidays, rota changes, who handles what." },
};

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { enabled: true, approveShelves: ["customers", "money"] };

/** Per-agent defaults where the category guess would be wrong or too broad. */
const AGENT_SHELVES: Record<string, { read: Shelf[]; write: Shelf[] }> = {
  "inventory-guardian": { read: ["stock"], write: ["stock"] },
  "order-desk": { read: ["stock", "customers"], write: ["stock", "customers"] },
  "enquiry-desk": { read: ["customers", "stock", "brand", "team"], write: ["customers"] },
  "dm-concierge": { read: ["customers", "stock", "brand"], write: ["customers"] },
  echosocial: { read: ["stock", "brand"], write: ["brand"] },
  "newsletter-writer": { read: ["stock", "brand"], write: ["brand"] },
  "invoice-chaser": { read: ["customers", "money"], write: ["money", "customers"] },
  "cashflow-forecast": { read: ["money"], write: ["money"] },
  "deal-nudger": { read: ["customers", "money"], write: ["customers"] },
  "quote-builder": { read: ["customers", "stock"], write: ["customers"] },
  "booking-assistant": { read: ["customers", "team"], write: ["customers"] },
  rotabuilder: { read: ["team"], write: ["team"] },
  "hiring-assistant": { read: ["team"], write: ["team"] },
  "meeting-actions": { read: ["customers", "team"], write: ["customers", "team"] },
};

const CATEGORY_SHELVES: Record<AgentCategory, { read: Shelf[]; write: Shelf[] }> = {
  Marketing: { read: ["brand", "stock", "customers"], write: ["brand"] },
  "E-Commerce": { read: ["stock", "customers"], write: ["stock", "customers"] },
  Finance: { read: ["money", "customers"], write: ["money"] },
  "HR/Ops": { read: ["team"], write: ["team"] },
};

/** Shelves a hire uses when the owner hasn't chosen. Partner agents never write. */
export function defaultShelves(agent: { slug: string; category: AgentCategory; source: "native" | "a2a" }): { read: Shelf[]; write: Shelf[] } {
  const base = AGENT_SHELVES[agent.slug] ?? CATEGORY_SHELVES[agent.category] ?? { read: [], write: [] };
  return { read: [...base.read], write: agent.source === "a2a" ? [] : [...base.write] };
}

import "server-only";
import { shopifyDeliveredOrders, shopifyFindOrders, shopifyLapsedCustomers, shopifyProducts } from "./shopify";
import { wooDeliveredOrders, wooFindOrders, wooLapsedCustomers, wooProducts } from "./woocommerce";

/**
 * One view of the owner's online store, whichever platform it runs on.
 * Shopify is used if both are connected.
 */

export interface StoreProduct {
  sku: string;
  name: string;
  onHand: number;
  soldLast7: number;
  unitCost: number | null;
  price: number | null;
  supplier: string;
  supplierEmail: string | null;
}

export interface StoreOrder {
  number: string;
  createdAt: string;
  paymentStatus: string;
  fulfilmentStatus: string;
  total: number;
  currency: string;
  items: string[];
  tracking: { company: string | null; number: string | null; url: string | null }[];
}

export interface StoreCustomer {
  firstName: string;
  email: string;
  orders: number;
  spent: number;
  currency: string;
  lastOrderAt: string;
  marketingConsent: boolean;
}

export interface StoreDeliveredOrder {
  number: string;
  firstName: string;
  email: string;
  items: string[];
  deliveredAt: string;
  refunded: boolean;
  marketingConsent: boolean;
}

/** True when an ISO time is between `fromDays` and `toDays` days ago. */
export function inWindow(iso: string, fromDays: number, toDays: number, now = Date.now()): boolean {
  const age = (now - Date.parse(iso)) / 86_400_000;
  return age >= fromDays && age <= toDays;
}

export type StoreSource = "shopify" | "woocommerce" | "square";

export async function storeProducts(userId: string): Promise<{ source: StoreSource; products: StoreProduct[] } | null> {
  const s = await shopifyProducts(userId);
  if (s) return { source: "shopify", products: s };
  const w = await wooProducts(userId);
  if (w) return { source: "woocommerce", products: w };
  const { squareProducts } = await import("./square");
  const q = await squareProducts(userId);
  return q ? { source: "square", products: q } : null;
}

export async function storeFindOrders(userId: string, q: { orderNumber?: string; email?: string }): Promise<{ source: StoreSource; orders: StoreOrder[] } | null> {
  const s = await shopifyFindOrders(userId, q);
  if (s) return { source: "shopify", orders: s };
  const w = await wooFindOrders(userId, q);
  return w ? { source: "woocommerce", orders: w } : null;
}

export async function storeLapsedCustomers(userId: string, days: number): Promise<{ source: StoreSource; customers: StoreCustomer[] } | null> {
  const s = await shopifyLapsedCustomers(userId, days);
  if (s) return { source: "shopify", customers: s };
  const w = await wooLapsedCustomers(userId, days);
  return w ? { source: "woocommerce", customers: w } : null;
}

export async function storeDeliveredOrders(userId: string, fromDays: number, toDays: number): Promise<{ source: StoreSource; orders: StoreDeliveredOrder[] } | null> {
  const s = await shopifyDeliveredOrders(userId, fromDays, toDays);
  if (s) return { source: "shopify", orders: s };
  const w = await wooDeliveredOrders(userId, fromDays, toDays);
  return w ? { source: "woocommerce", orders: w } : null;
}

import "server-only";
import { shopifyFindOrders, shopifyLapsedCustomers, shopifyProducts } from "./shopify";
import { wooFindOrders, wooLapsedCustomers, wooProducts } from "./woocommerce";

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

export type StoreSource = "shopify" | "woocommerce";

export async function storeProducts(userId: string): Promise<{ source: StoreSource; products: StoreProduct[] } | null> {
  const s = await shopifyProducts(userId);
  if (s) return { source: "shopify", products: s };
  const w = await wooProducts(userId);
  return w ? { source: "woocommerce", products: w } : null;
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

import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Marketplace",
  description: "Browse ready-made AI employees for social posts, bookkeeping, customer messages and stock. See each one's price per task, the tools it works in and the time it saves.",
  path: "/marketplace",
});

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "List your agent",
  description: "Publish an A2A Agent Card and put your AI agent in front of businesses ready to hire it. You earn 80% of every token spent on your agent.",
  path: "/developers",
});

export default function DevelopersLayout({ children }: { children: React.ReactNode }) {
  return children;
}

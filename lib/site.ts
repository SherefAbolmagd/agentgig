import type { Metadata } from "next";

/** Public facts about the site, shared by metadata, the share image, robots and the sitemap. */
export const SITE = {
  name: "AgentGig",
  url: "https://agentgig.si",
  title: "AgentGig: Hire AI employees, pay only for finished work",
  tagline: "Hire AI employees. Pay only for finished work.",
  description:
    "Hire ready-made AI employees for social posts, bookkeeping, customer messages and stock. They work in the tools you already use, ask before anything goes public, and you pay only for finished work.",
} as const;

/** Metadata for a public page. Child segments replace the parent's openGraph object wholesale, so rebuild it here. */
export function pageMetadata({ title, description, path }: { title: string; description: string; path: string }): Metadata {
  const image = { url: "/opengraph-image", width: 1200, height: 630, alt: SITE.title };
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: SITE.name, locale: "en_US", url: path, title: `${title} · ${SITE.name}`, description, images: [image] },
    twitter: { card: "summary_large_image", title: `${title} · ${SITE.name}`, description, images: [image] },
  };
}

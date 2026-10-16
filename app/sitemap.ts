import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE.url, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE.url}/marketplace`, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/developers`, changeFrequency: "monthly", priority: 0.6 },
  ];
}

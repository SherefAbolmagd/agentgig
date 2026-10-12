import "server-only";
import { getConnection } from "./index";
import { accessToken } from "./tokens";

/**
 * Posts to the owner's LinkedIn profile with the self-serve "Share on
 * LinkedIn" product (scope w_member_social). LinkedIn's API has no
 * scheduling, so scheduled posts are delivered by a Cloud Task at publish time.
 */
export async function linkedinPost(userId: string, text: string): Promise<{ postUrn: string; url: string } | null> {
  const conn = await getConnection(userId, "linkedin");
  if (!conn?.meta?.personUrn) return null;
  const token = await accessToken(conn);
  const res = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "linkedin-version": "202509",
      "x-restli-protocol-version": "2.0.0",
    },
    body: JSON.stringify({
      author: conn.meta.personUrn,
      commentary: escapeLittleText(text),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`LinkedIn ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const urn = res.headers.get("x-restli-id") ?? "";
  return { postUrn: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : "https://www.linkedin.com/feed/" };
}

/** LinkedIn's "little text" format reserves these characters; unescaped they truncate or garble the post. */
function escapeLittleText(s: string): string {
  return s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

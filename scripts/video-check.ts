/**
 * Pre-flight for a recording take: is the video account wired up?
 *   npx tsx --conditions=react-server scripts/video-check.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("@/lib/firebase-admin");
  const { googleSelf } = await import("@/lib/connectors/google");
  const uid = "video-cafe-lumen";
  const conns = await db().collection("connections").where("userId", "==", uid).get();
  console.log("connections:", conns.docs.map((d) => `${d.get("provider")}=${d.get("status")}`).join(", ") || "none");
  console.log("google account:", (await googleSelf(uid).catch((e) => `error: ${e.message}`)) ?? "not connected");
  const link = await db().collection("telegram_links").doc(uid).get();
  console.log("telegram:", link.exists ? `linked to ${link.get("firstName")} (@${link.get("username") ?? "-"})` : "not linked");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

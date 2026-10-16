/**
 * Points the shared AgentGig Telegram bot at this app and sets its commands
 * and description. Run once after creating the bot with @BotFather, and again
 * if the URL or webhook secret changes.
 *
 *   npm run telegram:setup                 # webhook at https://agentgig.si
 *   npm run telegram:setup -- https://…    # another base URL
 *
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.local");
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16–256 letters, digits, _ or -");
  const base = (process.argv[2] ?? process.env.PUBLIC_URL ?? "https://agentgig.si").replace(/\/$/, "");

  const call = async (method: string, body: Record<string, unknown>) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
  };

  const me = (await call("getMe", {})) as { username: string };
  await call("setWebhook", {
    url: `${base}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
    max_connections: 20,
  });
  await call("setMyCommands", {
    commands: [
      { command: "help", description: "What I can do" },
      { command: "stop", description: "Disconnect this chat from AgentGig" },
    ],
  });
  await call("setMyShortDescription", { short_description: "Your AgentGig team lead. Text or send voice notes; she hands work to your agents." });
  await call("setMyDescription", {
    description:
      "Talk to your AgentGig AI team from Telegram. Connect from the Team page at agentgig.si. Only linked team members get answers, and each team's chats and data stay separate.",
  });
  const info = (await call("getWebhookInfo", {})) as { url: string; pending_update_count: number; last_error_message?: string };
  console.log(`✓ @${me.username} → ${info.url}`);
  console.log(`  Add TELEGRAM_BOT_USERNAME=${me.username} to .env.local and the Cloud Run service.`);
  if (info.last_error_message) console.log(`  Last delivery error: ${info.last_error_message}`);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});

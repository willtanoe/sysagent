import * as dotenv from "dotenv";
import { HubServer } from "./server";
import { createHubBot } from "./bot";

dotenv.config();

const port = Number(process.env.HUB_PORT || 8765);
const secretToken = process.env.HUB_TOKEN || "poc-secret-token";
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const allowedUsers = (process.env.ALLOWED_USER_ID || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

async function main() {
  console.log(`[boot] Memulai Aster Hub Fleet Manager...`);
  const hub = new HubServer(port, secretToken);
  await hub.start();

  if (botToken) {
    console.log(`[boot] Mengaktifkan Telegram Bot...`);
    const bot = createHubBot({ token: botToken, allowedUsers }, hub);
    bot.start({
      onStart: (info) => {
        console.log(`[boot] Telegram Bot @${info.username} aktif.`);
      },
    });

    const shutdown = async () => {
      console.log(`\n[stop] Mematikan Aster Hub...`);
      bot.stop();
      await hub.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    console.log(`[boot] TELEGRAM_BOT_TOKEN tidak diset. Hub berjalan dalam mode headless API/WSS.`);
  }
}

main().catch((err) => {
  console.error("[fatal] Gagal memulai Aster Hub:", err);
  process.exit(1);
});

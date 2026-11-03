import * as dotenv from "dotenv";
import { run } from "@grammyjs/runner";
import { HubServer, parseNodeTokens } from "./server";
import { createHubBot, HUB_BOT_COMMANDS } from "./bot";
import { HubStore } from "./store";

dotenv.config();

function listIds(raw: string | undefined): number[] {
  return (raw || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

const host = process.env.HUB_HOST || "0.0.0.0";
const port = Number(process.env.HUB_PORT || 8765);
const secretToken = process.env.HUB_TOKEN || "";
const nodeTokens = parseNodeTokens(process.env.NODE_TOKENS);
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const botName = process.env.BOT_NAME;
const allowedUsers = listIds(process.env.ALLOWED_USER_ID).filter((n) => n > 0);
const allowedChats = listIds(process.env.ALLOWED_CHAT_ID);
const stateFile = process.env.HUB_STATE_FILE || "./hub-state.json";

if (!secretToken && Object.keys(nodeTokens).length === 0) {
  console.error("[fatal] HUB_TOKEN atau NODE_TOKENS wajib diisi di .env sebelum menjalankan Hub.");
  process.exit(1);
}

async function main() {
  console.log(`[boot] Memulai Aster Hub Fleet Manager...`);
  const store = new HubStore(stateFile);
  const hub = new HubServer(port, secretToken, {
    host,
    nodeTokens,
    tlsCertPath: process.env.TLS_CERT_PATH,
    tlsKeyPath: process.env.TLS_KEY_PATH,
  });
  await hub.start();

  if (botToken) {
    if (allowedUsers.length === 0) {
      console.warn(
        "[warn] ALLOWED_USER_ID kosong! Sangat disarankan mengisi ALLOWED_USER_ID di .env untuk produksi."
      );
    }

    console.log(`[boot] Mengaktifkan Telegram Bot (concurrent runner)...`);
    const bot = createHubBot(
      {
        token: botToken,
        botName,
        allowedUsers,
        allowedChats,
        defaultModel: process.env.MODEL_NAME || process.env.OPENAI_MODEL,
        notifyNodeEvents: process.env.NOTIFY_NODE_EVENTS !== "false",
      },
      hub,
      store
    );

    await bot.api.setMyCommands(HUB_BOT_COMMANDS).catch((err) => {
      console.warn("[boot] Gagal mendaftarkan daftar command Telegram:", err.message);
    });
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => undefined);

    const runner = run(bot);
    console.log(`[boot] Telegram Bot aktif dan siap melayani fleet.`);

    let stopping = false;
    const shutdown = async (sig: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n[stop] Signal ${sig} diterima, mematikan Aster Hub...`);
      store.flush();
      await Promise.allSettled([runner.stop(), hub.stop()]);
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  } else {
    console.log(`[boot] TELEGRAM_BOT_TOKEN tidak diset. Hub berjalan dalam mode headless WSS Coordinator.`);
    const shutdown = async () => {
      store.flush();
      await hub.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  }
}

main().catch((err) => {
  console.error("[fatal] Gagal memulai Aster Hub:", err);
  process.exit(1);
});

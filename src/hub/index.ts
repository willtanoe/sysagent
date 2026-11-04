import * as dotenv from "dotenv";
import * as path from "path";
import * as crypto from "crypto";
import { run } from "@grammyjs/runner";
import { HubServer, parseNodeTokens } from "./server";
import { createHubBot, HUB_BOT_COMMANDS, parseAllowedTopics } from "./bot";
import { HubStore } from "./store";
import { AutoUpdateMonitor } from "../shared/updater";
import { escapeHtml } from "../shared/format";
import { NodeExecutor, isRoot } from "../node/executor";
import { NodeEngine } from "../node/engine";
import { NodeClient } from "../node/client";
import { isManagedOpenCode, ManagedOpenCodeServer } from "../node/opencode-server";

dotenv.config();

function listIds(raw: string | undefined): number[] {
  return (raw || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

function intEnv(val: string | undefined, fallback: number): number {
  const parsed = Number(val);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function listEnv(val: string | undefined): string[] {
  return (val || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const host = process.env.HUB_HOST || "0.0.0.0";
const port = Number(process.env.HUB_PORT || 8765);
const secretToken = process.env.HUB_TOKEN || "";
const nodeTokens = parseNodeTokens(process.env.NODE_TOKENS);
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const botName = process.env.BOT_NAME;
const allowedUsers = listIds(process.env.ALLOWED_USER_ID).filter((n) => n > 0);
const allowedChats = listIds(process.env.ALLOWED_CHAT_ID);
const parsedTopics = parseAllowedTopics(process.env.ALLOWED_TOPIC_ID);
const botGroupCommands = process.env.BOT_GROUP_COMMANDS !== "false";
const stateFile = process.env.HUB_STATE_FILE || "./hub-state.json";
const embedHubNode = process.env.HUB_EMBED_NODE !== "false";
const hubNodeId = process.env.HUB_NODE_ID || "hub";

if (!secretToken && Object.keys(nodeTokens).length === 0) {
  console.error("[fatal] HUB_TOKEN atau NODE_TOKENS wajib diisi di .env sebelum menjalankan Hub.");
  process.exit(1);
}

// Pastikan embedded node 'hub' selalu memiliki token valid meskipun user hanya mengisi NODE_TOKENS
const embeddedHubToken =
  nodeTokens[hubNodeId] || secretToken || crypto.randomBytes(24).toString("hex");
if (embedHubNode && !nodeTokens[hubNodeId] && !secretToken) {
  nodeTokens[hubNodeId] = embeddedHubToken;
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

  let hubManagedOpenCode: ManagedOpenCodeServer | null = null;
  let hubNodeClient: NodeClient | null = null;

  if (embedHubNode) {
    const hubEngineMode =
      (process.env.HUB_ENGINE || process.env.ENGINE || "opencode").toLowerCase() === "local"
        ? "local"
        : "opencode";
    const stateDir = path.dirname(path.resolve(stateFile));
    const hubAuditPath =
      process.env.HUB_AUDIT_PATH || path.join(stateDir, `audit-${hubNodeId}.jsonl`);
    const fleetCtlPath = path.resolve(__dirname, "fleet-ctl.js");
    const loopback = hub.getLoopbackConfig();

    const hubExecutor = new NodeExecutor(hubNodeId, hubAuditPath, {
      sudoPassword: process.env.SUDO_PASSWORD,
      shellTimeoutMs: intEnv(process.env.SHELL_TIMEOUT_MS, 120_000),
      packageTimeoutMs: intEnv(process.env.PACKAGE_TIMEOUT_MS, 900_000),
      maxCommandsPerMinute: intEnv(process.env.MAX_COMMANDS_PER_MINUTE, 30),
    });

    const hubEngine = new NodeEngine(hubNodeId, hubExecutor, {
      engineMode: hubEngineMode,
      model:
        hubEngineMode === "opencode"
          ? process.env.OPENCODE_MODEL || "opencode/glm-5.3-flash-free"
          : process.env.MODEL_NAME || process.env.OPENAI_MODEL || "ag/gemini-3.8-flash",
      fallbackModels: listEnv(process.env.MODEL_FALLBACK),
      apiKey: process.env.GATEWAY_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: process.env.GATEWAY_URL || process.env.GATEWAY_BASE_URL || process.env.OPENAI_BASE_URL,
      aiTimeoutMs: intEnv(process.env.AI_TIMEOUT_MS, 90_000),
      maxToolLoops: intEnv(process.env.MAX_TOOL_LOOPS, 12),
      maxReadOnlySteps: intEnv(process.env.MAX_READ_ONLY_STEPS, 6),
      statusServices: listEnv(process.env.STATUS_SERVICES),
      extraSystemContext: (runCtx) =>
        hub.buildFleetContextSummary(hubNodeId, fleetCtlPath, runCtx?.chatId, runCtx?.userId),
      remoteNodeExec: (targetNodeId, command, chatId, userId) =>
        hub.executeRemoteCommand(targetNodeId, command, chatId, userId),
    });

    const bundled = isManagedOpenCode(hubEngineMode, process.env.OPENCODE_URL);
    console.log(
      `[boot:hub-node] Menyalakan Embedded Hub Agent: id="${hubNodeId}" root=${isRoot} engine=${hubEngineMode}${hubEngineMode === "opencode" ? (bundled ? "(bundled)" : "(external)") : ""}`
    );

    if (bundled) {
      try {
        const defaultDataDir = path.join(stateDir, `opencode-${hubNodeId}`);
        hubManagedOpenCode = new ManagedOpenCodeServer({
          bin: process.env.OPENCODE_BIN,
          port: intEnv(process.env.HUB_OPENCODE_PORT || process.env.OPENCODE_PORT, 0),
          password: process.env.OPENCODE_PASSWORD,
          dataDir: process.env.HUB_OPENCODE_DATA_DIR || process.env.OPENCODE_DATA_DIR || defaultDataDir,
          extraEnv: {
            ASTER_HUB_LOOPBACK_URL: loopback.url,
            ASTER_HUB_LOOPBACK_COOKIE: loopback.cookie,
          },
        });
        const { url, password } = await hubManagedOpenCode.start();
        hubEngine.setOpenCodeEndpoint(url, password);
      } catch (err: any) {
        console.warn(`[boot:hub-node] Gagal menjalankan bundled OpenCode di Hub (${err?.message ?? err}), melanjutkan dengan mode fallback.`);
      }
    }

    const useTls = Boolean(process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH);
    const localWsUrl = `${useTls ? "wss" : "ws"}://127.0.0.1:${port}`;
    hubNodeClient = new NodeClient(
      {
        hubUrl: localWsUrl,
        nodeId: hubNodeId,
        token: embeddedHubToken,
        heartbeatIntervalMs: intEnv(process.env.HEARTBEAT_INTERVAL_MS, 15_000),
        approvalTimeoutMs: intEnv(process.env.APPROVAL_TIMEOUT_MS, 300_000),
        tlsRejectUnauthorized: false,
      },
      hubEngine
    );
    hubNodeClient.start();
  }

  const stopEmbeddedHubNode = async () => {
    hubNodeClient?.stop();
    if (hubManagedOpenCode) {
      await hubManagedOpenCode.stop();
      hubManagedOpenCode = null;
    }
  };

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
        allowedTopics: parsedTopics.byChat,
        defaultAllowedTopic: parsedTopics.defaultTopic,
        defaultModel: process.env.MODEL_NAME || process.env.OPENAI_MODEL,
        notifyNodeEvents: process.env.NOTIFY_NODE_EVENTS !== "false",
        hubNodeId,
      },
      hub,
      store
    );

    await bot.api
      .setMyCommands(HUB_BOT_COMMANDS, { scope: { type: "all_private_chats" } })
      .catch((err) => {
        console.warn("[boot] Gagal mendaftarkan daftar command Telegram (private):", err.message);
      });

    if (!botGroupCommands || store.hasAnyHiddenGroupMenu()) {
      await bot.api.deleteMyCommands({ scope: { type: "default" } }).catch(() => undefined);
      await bot.api.deleteMyCommands({ scope: { type: "all_group_chats" } }).catch(() => undefined);
    } else {
      await bot.api.setMyCommands(HUB_BOT_COMMANDS).catch((err) => {
        console.warn("[boot] Gagal mendaftarkan daftar command Telegram:", err.message);
      });
    }
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => undefined);

    const runner = run(bot);
    console.log(`[boot] Telegram Bot aktif dan siap melayani fleet.`);

    let autoUpdater: AutoUpdateMonitor | null = null;
    if (process.env.AUTO_UPDATE !== "false") {
      const intervalMs = Number(process.env.AUTO_UPDATE_INTERVAL_MS) || 120_000;
      const primaryAdmin = allowedUsers[0];
      autoUpdater = new AutoUpdateMonitor({
        label: "aster-hub",
        intervalMs,
        branch: process.env.AUTO_UPDATE_BRANCH,
        isBusy: () => hub.hasActiveRuns(),
        onUpdated: async (res) => {
          if (primaryAdmin !== undefined) {
            await bot.api
              .sendMessage(
                primaryAdmin,
                `🔄 <b>[aster-hub] Auto-Update Berhasil</b>\n` +
                  `Branch: <code>${escapeHtml(res.branch)}</code> (<code>${escapeHtml(res.fromCommit)}</code> → <code>${escapeHtml(res.toCommit)}</code>)\n` +
                  `<i>Me-restart Aster Hub...</i>`,
                { parse_mode: "HTML" }
              )
              .catch(() => undefined);
          }
          store.flush();
        },
        onError: (err) => {
          console.warn("[updater:aster-hub] Gagal cek auto-update:", err);
        },
        onBeforeRestart: async () => {
          store.flush();
          await Promise.allSettled([runner.stop(), stopEmbeddedHubNode(), hub.stop()]);
        },
      });
      autoUpdater.start();
    }

    let stopping = false;
    const shutdown = async (sig: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n[stop] Signal ${sig} diterima, mematikan Aster Hub...`);
      autoUpdater?.stop();
      store.flush();
      await Promise.allSettled([runner.stop(), stopEmbeddedHubNode(), hub.stop()]);
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  } else {
    console.log(`[boot] TELEGRAM_BOT_TOKEN tidak diset. Hub berjalan dalam mode headless WSS Coordinator.`);
    let autoUpdater: AutoUpdateMonitor | null = null;
    if (process.env.AUTO_UPDATE !== "false") {
      autoUpdater = new AutoUpdateMonitor({
        label: "aster-hub",
        intervalMs: Number(process.env.AUTO_UPDATE_INTERVAL_MS) || 120_000,
        branch: process.env.AUTO_UPDATE_BRANCH,
        isBusy: () => hub.hasActiveRuns(),
        onBeforeRestart: async () => {
          store.flush();
          await Promise.allSettled([stopEmbeddedHubNode(), hub.stop()]);
        },
      });
      autoUpdater.start();
    }
    const shutdown = async () => {
      autoUpdater?.stop();
      store.flush();
      await Promise.allSettled([stopEmbeddedHubNode(), hub.stop()]);
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

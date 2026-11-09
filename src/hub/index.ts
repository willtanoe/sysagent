import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { format as formatUtil } from "util";
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

const BOT_RESTART_BASE_MS = 2_000;
const BOT_RESTART_MAX_MS = 60_000;

function telegramErrorCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { error_code?: unknown }).error_code;
  return typeof code === "number" ? code : undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Jangan pernah menulis token bot ke journal: grammY/node-fetch mencetak URL
 * lengkap `https://api.telegram.org/bot<id>:<token>/...` pada error jaringan.
 * Filter ini mengganti token menjadi `bot<redacted>` dari semua output console.
 */
function installLogRedaction(): void {
  const BOT_TOKEN_RE = /bot\d+:[A-Za-z0-9_-]+/g;
  const wrap = (original: (...args: unknown[]) => void) => {
    return (...args: unknown[]): void => {
      try {
        original(formatUtil(...args).replace(BOT_TOKEN_RE, "bot<redacted>"));
      } catch {
        // jika format gagal, teruskan apa adanya agar log tidak hilang
        original(...args);
      }
    };
  };
  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
}
installLogRedaction();

// Rejection transien (mis. Telegram 409/ECONNRESET) tidak boleh mematikan Hub.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled promise rejection:", reason);
});
// Exception tak tertangani berarti state proses tidak lagi dipercaya; keluar
// agar systemd (Restart=always) menyalakan ulang.
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  setTimeout(() => process.exit(1), 250).unref?.();
});

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
    // Selaras dengan APPROVAL_TIMEOUT_MS node: approval kedaluwarsa tak bisa diputuskan lagi.
    approvalTimeoutMs: intEnv(process.env.APPROVAL_TIMEOUT_MS, 300_000),
    // Arsip audit off-node per node (verifikasi hash & deteksi gap dilakukan Hub).
    centralAuditDir: path.join(path.dirname(path.resolve(stateFile)), "audit-central"),
    // Throttle handshake gagal per (IP, nodeId) + watchdog run tanpa aktivitas.
    authBanThreshold: intEnv(process.env.HUB_AUTH_BAN_THRESHOLD, 10),
    authBanMs: intEnv(process.env.HUB_AUTH_BAN_MS, 60_000),
    runIdleTimeoutMs:
      process.env.HUB_RUN_IDLE_TIMEOUT_MS === "0" ? 0 : intEnv(process.env.HUB_RUN_IDLE_TIMEOUT_MS, 900_000),
  });
  await hub.start();

  const hubHasTls = Boolean(process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH);
  const hubExternallyBound = ["", "0.0.0.0", "::", "::/0", "*"].includes(host.trim());
  if (!hubHasTls && hubExternallyBound) {
    console.warn(
      `[warn] Hub berjalan TANPA TLS pada ${host}:${port} (bind eksternal) — token node & seluruh output perintah terkirim plaintext.\n` +
        `       Konfigurasikan TLS_CERT_PATH/TLS_KEY_PATH, atau letakkan reverse proxy WSS di depan Hub.`
    );
  }

  let hubManagedOpenCode: ManagedOpenCodeServer | null = null;
  let hubNodeClient: NodeClient | null = null;
  // Cookie loopback tidak pernah diletakkan di environment agen. Agen hanya
  // menerima path file 0600 yang dibaca oleh fleet-ctl saat benar-benar dipakai.
  let loopbackCookieFile: string | null = null;

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

    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    loopbackCookieFile = path.join(stateDir, `loopback-cookie-${hubNodeId}`);
    fs.writeFileSync(loopbackCookieFile, loopback.cookie, { mode: 0o600 });
    fs.chmodSync(loopbackCookieFile, 0o600);

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
            ASTER_HUB_LOOPBACK_COOKIE_FILE: loopbackCookieFile,
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
    if (loopbackCookieFile !== null) {
      try {
        fs.rmSync(loopbackCookieFile, { force: true });
      } catch {
        // abaikan: file mungkin sudah tidak ada
      }
      loopbackCookieFile = null;
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

    // Lepas webhook sebelum long polling dengan timeout singkat; tanpa itu,
    // jaringan lambat menunda polling puluhan detik. Jangan buang pesan saat restart.
    const webhookCleanup = bot.api
      .deleteWebhook({ drop_pending_updates: false })
      .catch((err) => {
        console.warn(
          "[boot] Gagal melepas webhook Telegram (runner akan mencoba ulang):",
          describeError(err)
        );
      });
    // Batasi tunggu 10 detik; jika Telegram lambat, polling tetap dimulai dan
    // runner akan menangani kemungkinan 409 lewat jalur restart di bawah.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      timer.unref?.();
      void webhookCleanup.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    let stopping = false;
    let botRunnerRestarts = 0;
    let botRunnerStartedAt = Date.now();
    let botRunnerRestartTimer: NodeJS.Timeout | null = null;
    let botWatchdogTimer: NodeJS.Timeout | null = null;
    let runner: ReturnType<typeof run>;

    const startBotRunner = (): void => {
      botRunnerStartedAt = Date.now();
      runner = run(bot, {
        // Backoff eksponensial bawaan bisa membuat bot diam 2-5 menit saat Telegram
        // membalas 502/504; interval tetap 2 detik pulih cepat tanpa membanjiri API.
        runner: { maxRetryTime: 60 * 60 * 1000, retryInterval: 2_000 },
      });
      // `task()` reject jika runner berhenti karena error yang dianggap fatal
      // oleh grammY (mis. 409 Conflict). Tanpa handler ini, proses ikut mati.
      void (runner.task() ?? Promise.resolve()).catch((err: unknown) => {
        void handleBotRunnerCrash(err);
      });
    };

    // Watchdog: runner bisa berhenti tanpa rejection (mis. source ditutup).
    // Tanpa ini proses tetap "active" di systemd tetapi bot tidak merespons.
    const startBotWatchdog = (): void => {
      if (botWatchdogTimer) return;
      botWatchdogTimer = setInterval(() => {
        if (stopping || botRunnerRestartTimer) return;
        let alive = false;
        try {
          alive = runner.isRunning();
        } catch {
          alive = false;
        }
        if (!alive) {
          console.error("[bot] Watchdog: runner Telegram tidak aktif, memulai ulang.");
          void handleBotRunnerCrash(new Error("runner tidak aktif (watchdog)"));
        }
      }, 15_000);
      botWatchdogTimer.unref?.();
    };

    const handleBotRunnerCrash = async (err: unknown): Promise<void> => {
      if (stopping) return;
      const code = telegramErrorCode(err);
      // Runner yang sempat stabil >60 detik dianggap sehat: reset backoff.
      if (Date.now() - botRunnerStartedAt > 60_000) botRunnerRestarts = 0;
      botRunnerRestarts += 1;
      const delay = Math.min(
        BOT_RESTART_MAX_MS,
        BOT_RESTART_BASE_MS * 2 ** Math.min(botRunnerRestarts - 1, 5)
      );
      console.error(
        `[bot] Runner berhenti (${code ? `error_code=${code}` : describeError(err)}); ` +
          `restart dalam ${Math.round(delay / 1000)}s.`
      );
      if (botRunnerRestartTimer) clearTimeout(botRunnerRestartTimer);
      botRunnerRestartTimer = setTimeout(() => {
        botRunnerRestartTimer = null;
        if (stopping) return;
        void (async () => {
          try {
            if (code === 409) {
              // 409 = masih ada long-poll lain (instance lama/duplikat).
              // Lepaskan dulu sebelum memulai polling baru.
              await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
            }
            startBotRunner();
            console.log("[bot] Runner Telegram dijalankan ulang.");
          } catch (restartErr) {
            void handleBotRunnerCrash(restartErr);
          }
        })();
      }, delay);
      botRunnerRestartTimer.unref?.();
    };

    bot.catch((err) => {
      console.error("[bot] Error saat menangani update:", err.error ?? err);
    });

    startBotRunner();
    startBotWatchdog();
    console.log(`[boot] Telegram Bot aktif dan siap melayani fleet.`);

    // Registrasi menu di latar belakang: di-await, latensi Telegram menunda
    // polling. Kegagalannya tidak memengaruhi penerimaan pesan.
    void (async () => {
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
    })();

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

    const shutdown = async (sig: string) => {
      if (stopping) return;
      stopping = true;
      if (botRunnerRestartTimer) {
        clearTimeout(botRunnerRestartTimer);
        botRunnerRestartTimer = null;
      }
      if (botWatchdogTimer) {
        clearInterval(botWatchdogTimer);
        botWatchdogTimer = null;
      }
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

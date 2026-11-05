import * as dotenv from "dotenv";
import * as path from "path";
import { NodeExecutor, isRoot } from "./executor";
import { NodeEngine } from "./engine";
import { NodeClient } from "./client";
import { NodeAlertMonitor } from "./alerts";
import { isManagedOpenCode, ManagedOpenCodeServer } from "./opencode-server";
import { AutoUpdateMonitor } from "../shared/updater";
import { escapeHtml } from "../shared/format";

dotenv.config();

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

const nodeId = process.env.NODE_ID || "node-default";
const hubUrl = process.env.HUB_URL || "ws://127.0.0.1:8765";
const hubToken = process.env.NODE_TOKEN || process.env.HUB_TOKEN || "";
const auditPath = process.env.AUDIT_PATH || path.join(process.cwd(), `audit-${nodeId}.jsonl`);
const engineMode = (process.env.ENGINE || "local").toLowerCase() === "opencode" ? "opencode" : "local";

if (!hubToken) {
  console.error("[fatal] HUB_TOKEN atau NODE_TOKEN wajib diisi di .env sebelum menjalankan node agent.");
  process.exit(1);
}

try {
  const hubEndpoint = new URL(hubUrl);
  if (
    hubEndpoint.protocol === "ws:" &&
    !["127.0.0.1", "::1", "localhost"].includes(hubEndpoint.hostname)
  ) {
    console.warn(
      `[warn] HUB_URL memakai ws:// non-loopback (${hubEndpoint.hostname}) — token & output perintah terkirim plaintext.\n` +
        `       Gunakan wss:// (TLS), atau pastikan jalur ini terenkripsi (WireGuard/Tailscale/VPN internal).`
    );
  }
} catch {
  // URL tidak valid — biarkan NodeClient yang menampilkan error koneksinya
}

// Referensi client diisi setelah konstruksi; dipakai untuk forward entri audit ke Hub (off-node copy).
let clientRef: NodeClient | null = null;

const executor = new NodeExecutor(nodeId, auditPath, {
  sudoPassword: process.env.SUDO_PASSWORD,
  shellTimeoutMs: intEnv(process.env.SHELL_TIMEOUT_MS, 120_000),
  packageTimeoutMs: intEnv(process.env.PACKAGE_TIMEOUT_MS, 900_000),
  maxCommandsPerMinute: intEnv(process.env.MAX_COMMANDS_PER_MINUTE, 30),
  onAuditEntry: (entry) => {
    clientRef?.sendAudit(entry);
  },
});

const engine = new NodeEngine(nodeId, executor, {
  engineMode,
  model:
    engineMode === "opencode"
      ? process.env.OPENCODE_MODEL || "opencode/glm-5.3-flash-free"
      : process.env.MODEL_NAME || process.env.OPENAI_MODEL || "ag/gemini-3.8-flash",
  fallbackModels: listEnv(process.env.MODEL_FALLBACK),
  apiKey: process.env.GATEWAY_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.GATEWAY_URL || process.env.GATEWAY_BASE_URL || process.env.OPENAI_BASE_URL,
  aiTimeoutMs: intEnv(process.env.AI_TIMEOUT_MS, 90_000),
  maxToolLoops: intEnv(process.env.MAX_TOOL_LOOPS, 12),
  maxReadOnlySteps: intEnv(process.env.MAX_READ_ONLY_STEPS, 6),
  statusServices: listEnv(process.env.STATUS_SERVICES),
});

let managedOpenCode: ManagedOpenCodeServer | null = null;
let autoUpdater: AutoUpdateMonitor | null = null;

const alertMonitor = new NodeAlertMonitor(
  nodeId,
  executor,
  (ev) => (clientRef ? clientRef.sendAlert(ev.key, ev.severity, ev.html) : false),
  {
    intervalMs: intEnv(process.env.ALERT_INTERVAL_MS, 300_000),
    cooldownMs: intEnv(process.env.ALERT_COOLDOWN_MS, 1_800_000),
    diskPct: intEnv(process.env.ALERT_DISK_PCT, 90),
    memPct: intEnv(process.env.ALERT_MEM_PCT, 92),
    ignoreUnits: listEnv(process.env.ALERT_IGNORE_UNITS),
  }
);

const client = new NodeClient(
  {
    hubUrl,
    nodeId,
    token: hubToken,
    heartbeatIntervalMs: intEnv(process.env.HEARTBEAT_INTERVAL_MS, 15_000),
    approvalTimeoutMs: intEnv(process.env.APPROVAL_TIMEOUT_MS, 300_000),
    tlsCaPath: process.env.TLS_CA_PATH,
    tlsRejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== "false",
  },
  engine,
  alertMonitor
);
clientRef = client;

async function main() {
  const bundled = isManagedOpenCode(engineMode, process.env.OPENCODE_URL);
  console.log(
    `[boot] Memulai Aster Node Agent: id="${nodeId}" uid=${process.getuid?.() ?? "?"} root=${isRoot} engine=${engineMode}${engineMode === "opencode" ? (bundled ? "(bundled)" : "(external)") : ""}`
  );

  if (bundled) {
    const defaultDataDir = path.join(path.dirname(path.resolve(auditPath)), `opencode-${nodeId}`);
    managedOpenCode = new ManagedOpenCodeServer({
      bin: process.env.OPENCODE_BIN,
      port: intEnv(process.env.OPENCODE_PORT, 0),
      password: process.env.OPENCODE_PASSWORD,
      dataDir: process.env.OPENCODE_DATA_DIR || defaultDataDir,
    });
    const { url, password } = await managedOpenCode.start();
    engine.setOpenCodeEndpoint(url, password);
  }

  client.start();

  if (process.env.AUTO_UPDATE !== "false") {
    autoUpdater = new AutoUpdateMonitor({
      label: `node:${nodeId}`,
      intervalMs: intEnv(process.env.AUTO_UPDATE_INTERVAL_MS, 120_000),
      branch: process.env.AUTO_UPDATE_BRANCH,
      isBusy: () => client.hasActiveRuns(),
      onUpdated: (res) => {
        client.sendAlert(
          "auto-update",
          "ok",
          `🔄 <b>[${escapeHtml(nodeId)}] Auto-Update Berhasil</b>\n` +
            `Branch: <code>${escapeHtml(res.branch)}</code> (<code>${escapeHtml(res.fromCommit)}</code> → <code>${escapeHtml(res.toCommit)}</code>)\n` +
            `<i>Me-restart node agent...</i>`
        );
      },
      onError: (err) => {
        console.warn(`[updater:${nodeId}] Gagal cek auto-update:`, err);
      },
      onBeforeRestart: async () => {
        client.stop();
        if (managedOpenCode) await managedOpenCode.stop();
      },
    });
    autoUpdater.start();
  }
}

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`\n[stop] Signal ${signal} diterima, menghentikan node ${nodeId}...`);
  autoUpdater?.stop();
  client.stop();
  void Promise.allSettled([managedOpenCode ? managedOpenCode.stop() : Promise.resolve()]).finally(() =>
    process.exit(0)
  );
  setTimeout(() => process.exit(0), 6000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error(`[fatal:${nodeId}] Gagal memulai node agent:`, err);
  process.exit(1);
});

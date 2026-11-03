import * as dotenv from "dotenv";
import * as path from "path";
import { NodeExecutor, isRoot } from "./executor";
import { NodeEngine } from "./engine";
import { NodeClient } from "./client";
import { NodeAlertMonitor } from "./alerts";

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

if (!hubToken) {
  console.error("[fatal] HUB_TOKEN atau NODE_TOKEN wajib diisi di .env sebelum menjalankan node agent.");
  process.exit(1);
}

console.log(
  `[boot] Memulai Aster Node Agent: id="${nodeId}" uid=${process.getuid?.() ?? "?"} root=${isRoot}`
);

const executor = new NodeExecutor(nodeId, auditPath, {
  sudoPassword: process.env.SUDO_PASSWORD,
  shellTimeoutMs: intEnv(process.env.SHELL_TIMEOUT_MS, 120_000),
  packageTimeoutMs: intEnv(process.env.PACKAGE_TIMEOUT_MS, 900_000),
  maxCommandsPerMinute: intEnv(process.env.MAX_COMMANDS_PER_MINUTE, 30),
});

const engine = new NodeEngine(nodeId, executor, {
  model: process.env.MODEL_NAME || process.env.OPENAI_MODEL || "ag/gemini-3.8-flash",
  fallbackModels: listEnv(process.env.MODEL_FALLBACK),
  apiKey: process.env.GATEWAY_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.GATEWAY_URL || process.env.GATEWAY_BASE_URL || process.env.OPENAI_BASE_URL,
  aiTimeoutMs: intEnv(process.env.AI_TIMEOUT_MS, 90_000),
  maxToolLoops: intEnv(process.env.MAX_TOOL_LOOPS, 12),
  maxReadOnlySteps: intEnv(process.env.MAX_READ_ONLY_STEPS, 6),
  statusServices: listEnv(process.env.STATUS_SERVICES),
});

let clientRef: NodeClient | null = null;

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

client.start();

const shutdown = (signal: string) => {
  console.log(`\n[stop] Signal ${signal} diterima, menghentikan node ${nodeId}...`);
  client.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

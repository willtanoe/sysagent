import * as dotenv from "dotenv";
import * as path from "path";
import { NodeExecutor } from "./executor";
import { NodeEngine } from "./engine";
import { NodeClient } from "./client";

dotenv.config();

const nodeId = process.env.NODE_ID || "node-default";
const hubUrl = process.env.HUB_URL || "ws://127.0.0.1:8765";
const hubToken = process.env.HUB_TOKEN || "poc-secret-token";
const auditPath = process.env.AUDIT_PATH || path.join(process.cwd(), `audit-${nodeId}.jsonl`);

console.log(`[boot] Memulai node agent: ${nodeId}`);
const executor = new NodeExecutor(nodeId, auditPath);
const engine = new NodeEngine(nodeId, executor, {
  model: process.env.OPENAI_MODEL || "ag/gemini-3.8-flash",
  apiKey: process.env.GATEWAY_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.GATEWAY_BASE_URL || process.env.OPENAI_BASE_URL,
});

const client = new NodeClient(
  {
    hubUrl,
    nodeId,
    token: hubToken,
  },
  engine
);

client.start();

const shutdown = () => {
  console.log(`\n[stop] Menghentikan node ${nodeId}...`);
  client.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

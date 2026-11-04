import WebSocket, { WebSocketServer, RawData } from "ws";
import * as https from "https";
import * as fs from "fs";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import {
  NodeInfo,
  NodeToHubMsg,
  HubToNodeMsg,
  ChatHistoryItem,
  TokenUsage,
} from "../shared/protocol";

const NODE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface ConnectedNode {
  nodeId: string;
  ws: WebSocket;
  info: NodeInfo;
  connectedAt: number;
  lastSeen: number;
}

export interface ActiveRun {
  runId: string;
  nodeId: string;
  chatId: number;
  startedAt: number;
  onChunk: (chunk: string) => void;
  onApprovalReq: (approvalId: string, command: string, reason: string) => void;
  onDone: (fullText: string, error?: string, usage?: TokenUsage) => void;
}

export interface BroadcastNodeProgress {
  nodeId: string;
  hostname: string;
  state: "running" | "approval" | "done" | "error" | "aborted";
  durationMs: number;
}

export interface NodeBroadcastResult {
  nodeId: string;
  hostname: string;
  distroName: string;
  status: "ok" | "error" | "aborted";
  fullText: string;
  error?: string;
  durationMs: number;
  usage?: TokenUsage;
}

export interface HubServerOptions {
  host?: string;
  nodeTokens?: Record<string, string>;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  authTimeoutMs?: number;
  maxPayloadBytes?: number;
}

/** Perbandingan token constant-time menggunakan SHA-256 digest agar aman dari timing attack. */
export function verifySecretToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const hashA = crypto.createHash("sha256").update(provided).digest();
  const hashB = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/** Parse string "hongyun:tok1,hongchen:tok2" menjadi map token per-node. */
export function parseNodeTokens(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const nodeId = pair.slice(0, idx).trim();
    const token = pair.slice(idx + 1).trim();
    if (nodeId && token) map[nodeId] = token;
  }
  return map;
}

export class HubServer extends EventEmitter {
  private port: number;
  private host: string;
  private secretToken: string;
  private nodeTokens: Record<string, string>;
  private tlsCertPath?: string;
  private tlsKeyPath?: string;
  private authTimeoutMs: number;
  private maxPayloadBytes: number;
  private httpsServer: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private nodes = new Map<string, ConnectedNode>();
  private runs = new Map<string, ActiveRun>();
  private approvals = new Map<string, { nodeId: string; runId: string; chatId: number }>();

  constructor(port: number, secretToken: string, opts?: HubServerOptions) {
    super();
    this.port = port;
    this.host = opts?.host || "0.0.0.0";
    this.secretToken = secretToken;
    this.nodeTokens = opts?.nodeTokens ?? {};
    this.tlsCertPath = opts?.tlsCertPath;
    this.tlsKeyPath = opts?.tlsKeyPath;
    this.authTimeoutMs = opts?.authTimeoutMs ?? 5_000;
    this.maxPayloadBytes = opts?.maxPayloadBytes ?? 2 * 1024 * 1024;
  }

  private isValidTokenForNode(nodeId: string, token: string): boolean {
    const specificToken = this.nodeTokens[nodeId];
    if (specificToken) {
      return verifySecretToken(token, specificToken);
    }
    return verifySecretToken(token, this.secretToken);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        let wss: WebSocketServer;

        if (this.tlsCertPath && this.tlsKeyPath) {
          const cert = fs.readFileSync(this.tlsCertPath);
          const key = fs.readFileSync(this.tlsKeyPath);
          this.httpsServer = https.createServer({ cert, key });
          wss = new WebSocketServer({
            server: this.httpsServer,
            maxPayload: this.maxPayloadBytes,
          });
          this.httpsServer.listen(this.port, this.host, () => {
            console.log(`[hub] WSS (TLS) Server listening di ${this.host}:${this.port}`);
            resolve();
          });
        } else {
          wss = new WebSocketServer(
            {
              port: this.port,
              host: this.host,
              maxPayload: this.maxPayloadBytes,
            },
            () => {
              console.log(`[hub] WS Server listening di ${this.host}:${this.port}`);
              resolve();
            }
          );
        }

        this.wss = wss;

        wss.on("connection", (ws: WebSocket) => {
          let authenticatedNodeId: string | null = null;

          // Timeout jika koneksi baru tidak mengirim node_hello dalam batas waktu
          const authTimer = setTimeout(() => {
            if (!authenticatedNodeId && ws.readyState === WebSocket.OPEN) {
              ws.close(4001, "Authentication timeout");
            }
          }, this.authTimeoutMs);
          authTimer.unref?.();

          ws.on("message", (raw: RawData) => {
            try {
              const msg = JSON.parse(raw.toString()) as NodeToHubMsg;

              if (msg.type === "node_hello") {
                clearTimeout(authTimer);

                if (!msg.nodeId || !NODE_ID_RE.test(msg.nodeId)) {
                  const rejectMsg: HubToNodeMsg = {
                    type: "hub_welcome",
                    success: false,
                    message: "Format nodeId tidak valid.",
                  };
                  ws.send(JSON.stringify(rejectMsg));
                  ws.close();
                  return;
                }

                if (!this.isValidTokenForNode(msg.nodeId, msg.token)) {
                  const rejectMsg: HubToNodeMsg = {
                    type: "hub_welcome",
                    success: false,
                    message: "Token autentikasi salah.",
                  };
                  ws.send(JSON.stringify(rejectMsg));
                  ws.close();
                  return;
                }

                // Tutup koneksi lama jika node yang sama reconnect sebelum socket lama timeout
                const existing = this.nodes.get(msg.nodeId);
                if (existing && existing.ws !== ws) {
                  try {
                    existing.ws.close();
                  } catch {
                    // abaikan
                  }
                }

                authenticatedNodeId = msg.nodeId;
                const now = Date.now();
                this.nodes.set(msg.nodeId, {
                  nodeId: msg.nodeId,
                  ws,
                  info: msg.info,
                  connectedAt: now,
                  lastSeen: now,
                });

                console.log(
                  `[hub] Node terdaftar: "${msg.nodeId}" (${msg.info.hostname}, ${msg.info.distro?.name || msg.info.platform})`
                );
                const welcome: HubToNodeMsg = {
                  type: "hub_welcome",
                  success: true,
                  message: `Selamat datang di Aster Hub, node ${msg.nodeId}!`,
                };
                ws.send(JSON.stringify(welcome));
                this.emit("node_joined", msg.nodeId, msg.info);
                return;
              }

              if (!authenticatedNodeId) {
                ws.close();
                return;
              }

              const node = this.nodes.get(authenticatedNodeId);
              if (node) node.lastSeen = Date.now();

              if (msg.type === "node_heartbeat") {
                if (node) {
                  node.info.uptime = msg.uptime;
                  node.info.loadAvg = msg.loadAvg;
                  node.info.memory = msg.memory;
                  if (msg.diskPct !== undefined) node.info.diskPct = msg.diskPct;
                }
                return;
              }

              if (msg.type === "node_chunk") {
                const run = this.runs.get(msg.runId);
                if (run) run.onChunk(msg.chunk);
                return;
              }

              if (msg.type === "node_approval_req") {
                const run = this.runs.get(msg.runId);
                if (run && run.nodeId === authenticatedNodeId) {
                  this.approvals.set(msg.approvalId, {
                    nodeId: authenticatedNodeId,
                    runId: msg.runId,
                    chatId: run.chatId,
                  });
                  Promise.resolve(run.onApprovalReq(msg.approvalId, msg.command, msg.reason)).catch((err: any) => {
                    console.error("[hub] Gagal mengirim permintaan approval:", err?.message ?? err);
                  });
                }
                return;
              }

              if (msg.type === "node_done") {
                const run = this.runs.get(msg.runId);
                if (run && run.nodeId === authenticatedNodeId) {
                  this.clearApprovalsForRun(msg.runId);
                  this.runs.delete(msg.runId);
                  Promise.resolve(run.onDone(msg.fullText, msg.error, msg.usage)).catch((err: any) => {
                    console.error("[hub] Gagal menyelesaikan callback onDone:", err?.message ?? err);
                  });
                }
                return;
              }

              if (msg.type === "node_alert") {
                this.emit("node_alert", authenticatedNodeId, msg.key, msg.severity, msg.html);
                return;
              }
            } catch (err: any) {
              console.error("[hub] Gagal memproses pesan socket:", err.message);
            }
          });

          ws.on("close", () => {
            clearTimeout(authTimer);
            if (authenticatedNodeId) {
              const current = this.nodes.get(authenticatedNodeId);
              if (current && current.ws === ws) {
                console.log(`[hub] Node disconnect: "${authenticatedNodeId}"`);
                this.nodes.delete(authenticatedNodeId);
                for (const [runId, run] of this.runs.entries()) {
                  if (run.nodeId === authenticatedNodeId) {
                    this.clearApprovalsForRun(runId);
                    this.runs.delete(runId);
                    Promise.resolve(
                      run.onDone(`[${authenticatedNodeId}] Koneksi node terputus.`, "NODE_DISCONNECTED")
                    ).catch(() => undefined);
                  }
                }
                this.emit("node_left", authenticatedNodeId);
              }
            }
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const [, node] of this.nodes) {
        try {
          node.ws.close();
        } catch {
          // abaikan
        }
      }
      this.nodes.clear();
      this.runs.clear();
      this.approvals.clear();

      const closeHttps = () => {
        if (this.httpsServer) {
          this.httpsServer.close(() => resolve());
          this.httpsServer = null;
        } else {
          resolve();
        }
      };

      if (this.wss) {
        this.wss.close(() => closeHttps());
        this.wss = null;
      } else {
        closeHttps();
      }
    });
  }

  listNodes(): ConnectedNode[] {
    return Array.from(this.nodes.values());
  }

  getNode(nodeId: string): ConnectedNode | undefined {
    return this.nodes.get(nodeId);
  }

  hasActiveRuns(): boolean {
    return this.runs.size > 0;
  }

  startRun(
    nodeId: string,
    chatId: number,
    prompt: string,
    handlers: {
      onChunk: (chunk: string) => void;
      onApprovalReq: (approvalId: string, command: string, reason: string) => void;
      onDone: (fullText: string, error?: string, usage?: TokenUsage) => void;
    },
    model?: string,
    opts?: { userId?: number; history?: ChatHistoryItem[] }
  ): string {
    const node = this.nodes.get(nodeId);
    if (!node || node.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Node "${nodeId}" tidak terhubung atau sedang offline.`);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.runs.set(runId, {
      runId,
      nodeId,
      chatId,
      startedAt: Date.now(),
      ...handlers,
    });

    const msg: HubToNodeMsg = {
      type: "hub_run",
      runId,
      chatId,
      userId: opts?.userId,
      prompt,
      model,
      history: opts?.history,
    };
    node.ws.send(JSON.stringify(msg));
    return runId;
  }

  cancelRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;

    const node = this.nodes.get(run.nodeId);
    if (node && node.ws.readyState === WebSocket.OPEN) {
      const msg: HubToNodeMsg = {
        type: "hub_cancel",
        runId,
      };
      node.ws.send(JSON.stringify(msg));
    } else {
      run.onDone("[dibatalkan]", "ABORTED");
      this.runs.delete(runId);
    }
    return true;
  }

  cancelChatRuns(chatId: number): number {
    let count = 0;
    for (const [runId, run] of this.runs.entries()) {
      if (run.chatId === chatId) {
        if (this.cancelRun(runId)) count += 1;
      }
    }
    return count;
  }

  private clearApprovalsForRun(runId: string): void {
    for (const [approvalId, meta] of this.approvals.entries()) {
      if (meta.runId === runId) this.approvals.delete(approvalId);
    }
  }

  sendApproval(nodeId: string, runId: string, approvalId: string, approved: boolean, chatId?: number): boolean {
    const tracked = this.approvals.get(approvalId);
    if (chatId !== undefined && tracked && tracked.chatId !== chatId) {
      return false;
    }
    this.approvals.delete(approvalId);

    const targetNodeId = tracked?.nodeId ?? nodeId;
    const targetRunId = tracked?.runId ?? runId;
    const node = this.nodes.get(targetNodeId);
    if (!node || node.ws.readyState !== WebSocket.OPEN) return false;

    const msg: HubToNodeMsg = {
      type: "hub_approval_res",
      runId: targetRunId,
      approvalId,
      approved,
    };
    node.ws.send(JSON.stringify(msg));
    return true;
  }

  resolveApprovalById(approvalId: string, approved: boolean, chatId?: number): boolean {
    const tracked = this.approvals.get(approvalId);
    if (!tracked) return false;
    return this.sendApproval(tracked.nodeId, tracked.runId, approvalId, approved, chatId);
  }

  async broadcastRun(
    chatId: number,
    prompt: string,
    opts?: {
      nodeIds?: string[];
      model?: string;
      userId?: number;
      getHistory?: (nodeId: string) => ChatHistoryItem[] | undefined;
      timeoutMs?: number;
      onProgress?: (progress: BroadcastNodeProgress[]) => void;
      onApprovalReq?: (nodeId: string, approvalId: string, command: string, reason: string) => void;
    }
  ): Promise<NodeBroadcastResult[]> {
    const allOnline = this.listNodes().sort((a, b) =>
      a.nodeId.localeCompare(b.nodeId, undefined, { sensitivity: "base" })
    );
    const targets = opts?.nodeIds
      ? allOnline.filter((n) => opts.nodeIds!.includes(n.nodeId))
      : allOnline;

    if (targets.length === 0) return [];

    const progressMap = new Map<string, BroadcastNodeProgress>();
    for (const n of targets) {
      progressMap.set(n.nodeId, {
        nodeId: n.nodeId,
        hostname: n.info.hostname,
        state: "running",
        durationMs: 0,
      });
    }

    const emitProgress = () => {
      if (!opts?.onProgress) return;
      opts.onProgress(Array.from(progressMap.values()));
    };

    const tasks = targets.map((node) => {
      return new Promise<NodeBroadcastResult>((resolve) => {
        const startedAt = Date.now();
        const distroName = node.info.distro
          ? `${node.info.distro.id} ${node.info.distro.version}`.trim()
          : `${node.info.platform}/${node.info.arch}`;
        let settled = false;
        let runId = "";
        let timer: NodeJS.Timeout | null = null;

        const finish = (res: NodeBroadcastResult) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          progressMap.set(node.nodeId, {
            nodeId: node.nodeId,
            hostname: node.info.hostname,
            state: res.status === "ok" ? "done" : res.status === "aborted" ? "aborted" : "error",
            durationMs: res.durationMs,
          });
          emitProgress();
          resolve(res);
        };

        if (opts?.timeoutMs && opts.timeoutMs > 0) {
          timer = setTimeout(() => {
            if (runId) {
              this.cancelRun(runId);
              this.clearApprovalsForRun(runId);
              this.runs.delete(runId);
            }
            finish({
              nodeId: node.nodeId,
              hostname: node.info.hostname,
              distroName,
              status: "error",
              fullText: "",
              error: `Timeout setelah ${Math.round(opts.timeoutMs! / 1000)}s`,
              durationMs: Date.now() - startedAt,
            });
          }, opts.timeoutMs);
          timer.unref?.();
        }

        try {
          runId = this.startRun(
            node.nodeId,
            chatId,
            prompt,
            {
              onChunk: () => {
                const cur = progressMap.get(node.nodeId);
                if (cur && cur.state === "approval") {
                  cur.state = "running";
                }
                if (cur) cur.durationMs = Date.now() - startedAt;
                emitProgress();
              },
              onApprovalReq: (approvalId, command, reason) => {
                const cur = progressMap.get(node.nodeId);
                if (cur) {
                  cur.state = "approval";
                  cur.durationMs = Date.now() - startedAt;
                }
                emitProgress();
                opts?.onApprovalReq?.(node.nodeId, approvalId, command, reason);
              },
              onDone: (fullText, error, usage) => {
                const durationMs = Date.now() - startedAt;
                if (error === "ABORTED") {
                  finish({
                    nodeId: node.nodeId,
                    hostname: node.info.hostname,
                    distroName,
                    status: "aborted",
                    fullText,
                    error,
                    durationMs,
                    usage,
                  });
                  return;
                }
                if (error) {
                  finish({
                    nodeId: node.nodeId,
                    hostname: node.info.hostname,
                    distroName,
                    status: "error",
                    fullText,
                    error,
                    durationMs,
                    usage,
                  });
                  return;
                }
                finish({
                  nodeId: node.nodeId,
                  hostname: node.info.hostname,
                  distroName,
                  status: "ok",
                  fullText,
                  durationMs,
                  usage,
                });
              },
            },
            opts?.model,
            {
              userId: opts?.userId,
              history: opts?.getHistory?.(node.nodeId),
            }
          );
        } catch (err: any) {
          finish({
            nodeId: node.nodeId,
            hostname: node.info.hostname,
            distroName,
            status: "error",
            fullText: "",
            error: err?.message ?? String(err),
            durationMs: Date.now() - startedAt,
          });
        }
      });
    });

    return Promise.all(tasks);
  }
}

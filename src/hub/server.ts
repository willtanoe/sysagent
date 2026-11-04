import WebSocket, { WebSocketServer, RawData } from "ws";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import {
  NodeInfo,
  NodeToHubMsg,
  HubToNodeMsg,
  ChatHistoryItem,
  TokenUsage,
} from "../shared/protocol";
import { AuditLogger, AuditEntry, isValidAuditEntry, verifyEntryHash } from "../shared/audit";
import { escapeHtml, preBlock } from "../shared/format";

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
  userId?: number;
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
  /** Usia maksimal permintaan approval (harus selaras APPROVAL_TIMEOUT_MS node). Default 300s. */
  approvalTimeoutMs?: number;
  /** Direktori arsip audit off-node per node. Kosong = forwarding audit dinonaktifkan. */
  centralAuditDir?: string;
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
  private approvalTimeoutMs: number;
  private centralAuditDir?: string;
  private centralAudits = new Map<string, AuditLogger>();
  private centralExpected = new Map<string, string>();
  private auditAlertCooldowns = new Map<string, number>();
  private approvalCleanupTimer: NodeJS.Timeout | null = null;
  private httpServer: http.Server | null = null;
  private httpsServer: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private nodes = new Map<string, ConnectedNode>();
  private runs = new Map<string, ActiveRun>();
  private approvals = new Map<
    string,
    { nodeId: string; runId: string; chatId: number; userId?: number; command?: string; reason?: string; createdAt?: number }
  >();
  private loopbackCookie = crypto.randomBytes(24).toString("hex");

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
    this.approvalTimeoutMs = opts?.approvalTimeoutMs ?? 300_000;
    this.centralAuditDir = opts?.centralAuditDir;
  }

  getLoopbackConfig(): { url: string; cookie: string } {
    const proto = this.tlsCertPath && this.tlsKeyPath ? "https" : "http";
    return {
      url: `${proto}://127.0.0.1:${this.port}`,
      cookie: this.loopbackCookie,
    };
  }

  private isLoopbackAddress(addr: string | undefined): boolean {
    if (!addr) return false;
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  private handleInternalHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || "";
    if (!url.startsWith("/internal/fleet/")) {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Upgrade Required");
      return;
    }

    if (!this.isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Loopback only" }));
      return;
    }

    const providedCookie = String(req.headers["x-aster-loopback"] || "");
    if (!verifySecretToken(providedCookie, this.loopbackCookie)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized internal request" }));
      return;
    }

    if (req.method === "GET" && url === "/internal/fleet/nodes") {
      const nodes = this.listNodes().map((n) => ({
        nodeId: n.nodeId,
        info: n.info,
        connectedAt: n.connectedAt,
        lastSeen: n.lastSeen,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ nodes }));
      return;
    }

    if (req.method === "POST" && url === "/internal/fleet/exec") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
        if (body.length > 256_000) req.destroy();
      });
      req.on("end", () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body || "{}") as {
              nodeId?: string;
              command?: string;
              chatId?: number;
              userId?: number;
              timeoutMs?: number;
            };
            const targetNodeId = (parsed.nodeId || "").trim();
            const command = (parsed.command || "").trim();
            if (!targetNodeId || !command) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "nodeId dan command wajib diisi" }));
              return;
            }
            const output = await this.executeRemoteCommand(
              targetNodeId,
              command,
              parsed.chatId,
              parsed.userId,
              parsed.timeoutMs
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", output }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", error: err?.message ?? String(err) }));
          }
        })();
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
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
          this.httpsServer = https.createServer({ cert, key }, (req, res) =>
            this.handleInternalHttpRequest(req, res)
          );
          wss = new WebSocketServer({
            server: this.httpsServer,
            maxPayload: this.maxPayloadBytes,
          });
          this.httpsServer.listen(this.port, this.host, () => {
            console.log(`[hub] WSS (TLS) Server listening di ${this.host}:${this.port}`);
            resolve();
          });
        } else {
          this.httpServer = http.createServer((req, res) => this.handleInternalHttpRequest(req, res));
          wss = new WebSocketServer({
            server: this.httpServer,
            maxPayload: this.maxPayloadBytes,
          });
          this.httpServer.listen(this.port, this.host, () => {
            console.log(`[hub] WS Server listening di ${this.host}:${this.port}`);
            resolve();
          });
        }

        this.wss = wss;

        // GC periodik: permintaan approval yang kedaluwarsa dihapus dari memori.
        this.approvalCleanupTimer = setInterval(() => this.cleanupExpiredApprovals(), 30_000);
        this.approvalCleanupTimer.unref?.();

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
                    userId: run.userId,
                    command: msg.command,
                    reason: msg.reason,
                    createdAt: Date.now(),
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

              if (msg.type === "node_audit") {
                this.handleCentralAudit(authenticatedNodeId, msg.entry);
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
      if (this.approvalCleanupTimer) {
        clearInterval(this.approvalCleanupTimer);
        this.approvalCleanupTimer = null;
      }
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

      const closeServers = () => {
        if (this.httpsServer) {
          this.httpsServer.close(() => resolve());
          this.httpsServer = null;
        } else if (this.httpServer) {
          this.httpServer.close(() => resolve());
          this.httpServer = null;
        } else {
          resolve();
        }
      };

      if (this.wss) {
        this.wss.close(() => closeServers());
        this.wss = null;
      } else {
        closeServers();
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
    opts?: { userId?: number; userName?: string; history?: ChatHistoryItem[] }
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
      userId: opts?.userId,
      startedAt: Date.now(),
      ...handlers,
    });

    const msg: HubToNodeMsg = {
      type: "hub_run",
      runId,
      chatId,
      userId: opts?.userId,
      userName: opts?.userName,
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

  /** Batalkan run di chat; jika userId diberikan, hanya run milik user tersebut (sesi per-user di grup). */
  cancelChatRuns(chatId: number, userId?: number): number {
    let count = 0;
    for (const [runId, run] of this.runs.entries()) {
      if (run.chatId !== chatId) continue;
      if (userId !== undefined && run.userId !== undefined && run.userId !== userId) continue;
      if (this.cancelRun(runId)) count += 1;
    }
    return count;
  }

  private clearApprovalsForRun(runId: string): void {
    for (const [approvalId, meta] of this.approvals.entries()) {
      if (meta.runId === runId) this.approvals.delete(approvalId);
    }
  }

  private cleanupExpiredApprovals(): void {
    const now = Date.now();
    for (const [approvalId, meta] of this.approvals.entries()) {
      if (meta.createdAt !== undefined && now - meta.createdAt > this.approvalTimeoutMs) {
        this.approvals.delete(approvalId);
      }
    }
  }

  sendApproval(
    nodeId: string,
    runId: string,
    approvalId: string,
    approved: boolean,
    chatId?: number,
    userId?: number
  ): boolean {
    const tracked = this.approvals.get(approvalId);
    if (chatId !== undefined && tracked && tracked.chatId !== chatId) {
      return false;
    }
    // Approval hanya boleh diputuskan oleh user yang memulai tugas
    if (userId !== undefined && tracked?.userId !== undefined && tracked.userId !== userId) {
      return false;
    }
    // Approval kedaluwarsa tidak dapat diputuskan lagi (selaras timeout di sisi node).
    if (tracked?.createdAt !== undefined && Date.now() - tracked.createdAt > this.approvalTimeoutMs) {
      this.approvals.delete(approvalId);
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

  resolveApprovalById(approvalId: string, approved: boolean, chatId?: number, userId?: number): boolean {
    const tracked = this.approvals.get(approvalId);
    if (!tracked) return false;
    return this.sendApproval(tracked.nodeId, tracked.runId, approvalId, approved, chatId, userId);
  }

  /** Alert anomali audit terpusat dengan cooldown per (key, node) agar tidak spam. */
  private emitAuditAlert(nodeId: string, key: string, detail: string): void {
    const now = Date.now();
    const cooldownKey = `${key}:${nodeId}`;
    if (now - (this.auditAlertCooldowns.get(cooldownKey) ?? 0) < 60_000) return;
    this.auditAlertCooldowns.set(cooldownKey, now);
    const html =
      `🛡️ <b>[${escapeHtml(nodeId)}] Anomali audit terdeteksi</b>\n` +
      `<i>${escapeHtml(key)}</i>\n` +
      `${preBlock(detail)}`;
    this.emit("node_alert", nodeId, key, "warn", html);
  }

  /**
   * Arsip audit off-node: verifikasi bentuk + hash tiap entri dari node, lalu simpan apa adanya
   * (rantai hash milik node dipertahankan) ke file per-node di Hub. Gap rantai = entri hilang
   * atau file audit node di-reset/regenerasi -> alert real-time.
   */
  private handleCentralAudit(nodeId: string, rawEntry: unknown): void {
    if (!this.centralAuditDir) return;
    if (!isValidAuditEntry(rawEntry)) {
      this.emitAuditAlert(nodeId, "audit-invalid", "Entri audit tidak valid (bentuk rusak) — diabaikan.");
      return;
    }
    const entry: AuditEntry = rawEntry;
    if (entry.nodeId !== nodeId) {
      this.emitAuditAlert(
        nodeId,
        "audit-invalid",
        `Entri audit mengaku node '${entry.nodeId}' melalui koneksi '${nodeId}' — diabaikan.`
      );
      return;
    }
    if (!verifyEntryHash(entry)) {
      this.emitAuditAlert(
        nodeId,
        "audit-invalid",
        `Hash entri audit tidak cocok (data dimanipulasi?): cmd=${entry.command.slice(0, 80)} — diabaikan.`
      );
      return;
    }

    let central = this.centralAudits.get(nodeId);
    if (!central) {
      central = new AuditLogger(path.join(this.centralAuditDir, `central-${nodeId}.jsonl`));
      this.centralAudits.set(nodeId, central);
    }

    const expected = this.centralExpected.get(nodeId) ?? central.getLastHash();
    const centralStartEmpty = expected === "GENESIS";
    if (!centralStartEmpty && entry.prevHash !== expected) {
      this.emitAuditAlert(
        nodeId,
        "audit-gap",
        `Rantai audit terputus: ekspektasi prevHash ${expected.slice(0, 12)}…, dapat ${entry.prevHash.slice(0, 12)}… (ada entri yang tidak sampai atau file audit node di-reset).`
      );
    }
    if (central.appendExternal(entry)) {
      this.centralExpected.set(nodeId, entry.hash);
    }
  }

  async broadcastRun(
    chatId: number,
    prompt: string,
    opts?: {
      nodeIds?: string[];
      model?: string;
      userId?: number;
      userName?: string;
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
              userName: opts?.userName,
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

  /**
   * Eksekusi perintah shell ($ <cmd>) atau built-in RPC ke satu node atau semua node ('all')
   * dari OpenCode / AgentEngine yang berjalan di Hub.
   */
  async executeRemoteCommand(
    targetNodeId: string,
    command: string,
    chatId = 0,
    userId?: number,
    timeoutMs = 90_000
  ): Promise<string> {
    const trimmed = command.trim();
    const prompt =
      trimmed.startsWith("__builtin:") || trimmed.startsWith("$ ") ? trimmed : `$ ${trimmed}`;

    if (targetNodeId.toLowerCase() === "all") {
      const results = await this.broadcastRun(chatId, prompt, {
        userId,
        timeoutMs,
        onApprovalReq: (nodeId, approvalId, cmd, reason) => {
          this.emit("remote_approval_req", { nodeId, runId: "", approvalId, command: cmd, reason, chatId });
        },
      });
      if (results.length === 0) return "(Tidak ada node yang sedang online)";
      return results
        .map((r) => {
          const header = `=== [${r.nodeId}] (${r.hostname} · ${r.distroName}) [${r.status.toUpperCase()} · ${r.durationMs}ms] ===`;
          const body = r.status === "ok" ? r.fullText : `ERROR: ${r.error || "Unknown error"}`;
          return `${header}\n${body}`;
        })
        .join("\n\n");
    }

    const node = this.getNode(targetNodeId);
    if (!node || node.ws.readyState !== WebSocket.OPEN) {
      const available = this.listNodes()
        .map((n) => n.nodeId)
        .join(", ");
      throw new Error(
        `Node "${targetNodeId}" tidak ditemukan atau sedang offline. Node yang online saat ini: ${available || "(kosong)"}`
      );
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let runId = "";

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (runId) {
          this.cancelRun(runId);
          this.clearApprovalsForRun(runId);
          this.runs.delete(runId);
        }
        reject(new Error(`Timeout (${Math.round(timeoutMs / 1000)}s) menunggu respons dari node ${targetNodeId}`));
      }, timeoutMs);
      timer.unref?.();

      try {
        runId = this.startRun(
          targetNodeId,
          chatId,
          prompt,
          {
            onChunk: () => undefined,
            onApprovalReq: (approvalId, cmd, reason) => {
              this.emit("remote_approval_req", {
                nodeId: targetNodeId,
                runId,
                approvalId,
                command: cmd,
                reason,
                chatId,
              });
            },
            onDone: (fullText, error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (error) {
                reject(new Error(error));
                return;
              }
              resolve(fullText);
            },
          },
          undefined,
          { userId }
        );
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  /** Bangun ringkasan konteks fleet live untuk disuntikkan ke OpenCode / AI di Hub. */
  buildFleetContextSummary(hubNodeId = "hub", fleetCtlPath?: string, chatId?: number, userId?: number): string {
    const nodes = this.listNodes().sort((a, b) =>
      a.nodeId.localeCompare(b.nodeId, undefined, { sensitivity: "base" })
    );
    const nodeLines =
      nodes.length === 0
        ? ["  (Belum ada node yang terhubung)"]
        : nodes.map((n) => {
            const distro = n.info.distro
              ? `${n.info.distro.id} ${n.info.distro.version}`.trim()
              : `${n.info.platform}/${n.info.arch}`;
            const load = n.info.loadAvg?.[0]?.toFixed(2) ?? "0.00";
            const freeMb = n.info.memory?.freeMb ?? 0;
            const totalMb = n.info.memory?.totalMb ?? 0;
            const roleTag = n.nodeId === hubNodeId ? " [SERVER HUB LOKAL INI]" : "";
            return `  - ${n.nodeId}${roleTag}: host=${n.info.hostname}, os=${distro}, cpu=${n.info.cpus}c, load=${load}, ram_free=${freeMb}/${totalMb}MB`;
          });

    const ctlFlags = [
      chatId ? `--chat ${chatId}` : "",
      userId ? `--user ${userId}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const flagSuffix = ctlFlags ? ` ${ctlFlags}` : "";

    return [
      "[KONTEKS KOORDINATOR PUSAT ASTER HUB]",
      `Anda adalah AI Koordinator Pusat (OpenCode Hub) yang berjalan langsung di server Aster Hub ('${hubNodeId}').`,
      "Anda dapat menjawab diskusi teknis/umum, mengelola server Hub lokal ini, SEKALIGUS memeriksa atau menjalankan perintah di seluruh server node cabang yang terhubung.",
      `Daftar Node Online Saat Ini (${nodes.length} node):`,
      ...nodeLines,
      ...(fleetCtlPath
        ? [
            "",
            "Cara Mengeksekusi Perintah ke Server Node Lain dari Shell (Bash Tool):",
            `- Cek daftar node live: \`node ${fleetCtlPath} nodes\``,
            `- Jalankan perintah di 1 node cabang: \`node ${fleetCtlPath} exec <node_id> "<perintah_shell>"${flagSuffix}\``,
            `- Jalankan perintah serentak di semua node: \`node ${fleetCtlPath} broadcast "<perintah_shell>"${flagSuffix}\``,
            `- Ambil dashboard status lengkap node: \`node ${fleetCtlPath} status <node_id|all>${flagSuffix}\``,
          ]
        : []),
    ].join("\n");
  }
}

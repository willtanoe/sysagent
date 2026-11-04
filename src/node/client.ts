import WebSocket, { RawData } from "ws";
import * as os from "os";
import * as fs from "fs";
import {
  NodeInfo,
  NodeToHubMsg,
  HubToNodeMsg,
  TokenUsage,
} from "../shared/protocol";
import { NodeEngine, ABORTED } from "./engine";
import { distro } from "./distro";
import { isRoot } from "./executor";
import { NodeAlertMonitor, NodeAlertConfig } from "./alerts";

export interface NodeClientConfig {
  hubUrl: string;
  nodeId: string;
  token: string;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  approvalTimeoutMs?: number;
  tlsCaPath?: string;
  tlsRejectUnauthorized?: boolean;
  alerts?: NodeAlertConfig;
}

export class NodeClient {
  private config: NodeClientConfig;
  private engine: NodeEngine;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private alertMonitor: NodeAlertMonitor | null = null;
  private isClosed: boolean = false;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private activeRuns = new Map<string, AbortController>();

  constructor(config: NodeClientConfig, engine: NodeEngine, alertMonitor?: NodeAlertMonitor) {
    this.config = config;
    this.engine = engine;
    this.alertMonitor = alertMonitor ?? null;
  }

  private collectNodeInfo(): NodeInfo {
    const totalMem = Math.round(os.totalmem() / (1024 * 1024));
    const freeMem = Math.round(os.freemem() / (1024 * 1024));
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: Math.round(os.uptime()),
      loadAvg: os.loadavg(),
      memory: {
        totalMb: totalMem,
        freeMb: freeMem,
      },
      distro,
      kernel: os.release(),
      cpus: os.cpus().length,
      isRoot,
    };
  }

  start(): void {
    this.isClosed = false;
    this.connect();
    this.alertMonitor?.start();
  }

  stop(): void {
    this.isClosed = true;
    this.alertMonitor?.stop();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, controller] of this.activeRuns) {
      controller.abort();
    }
    this.activeRuns.clear();
    for (const [, resolver] of this.pendingApprovals) {
      resolver(false);
    }
    this.pendingApprovals.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  hasActiveRuns(): boolean {
    return this.activeRuns.size > 0;
  }

  sendAlert(key: string, severity: "warn" | "ok", html: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.send({
      type: "node_alert",
      nodeId: this.config.nodeId,
      key,
      severity,
      html,
    });
    return true;
  }

  private connect(): void {
    if (this.isClosed) return;

    console.log(`[node:${this.config.nodeId}] Konek ke Hub di ${this.config.hubUrl}...`);
    const wsOpts: WebSocket.ClientOptions = {};
    if (this.config.tlsCaPath && fs.existsSync(this.config.tlsCaPath)) {
      wsOpts.ca = fs.readFileSync(this.config.tlsCaPath);
    }
    if (this.config.tlsRejectUnauthorized !== undefined) {
      wsOpts.rejectUnauthorized = this.config.tlsRejectUnauthorized;
    }

    const ws = new WebSocket(this.config.hubUrl, wsOpts);
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[node:${this.config.nodeId}] Terhubung ke Hub. Mengirim handshake hello...`);
      const hello: NodeToHubMsg = {
        type: "node_hello",
        nodeId: this.config.nodeId,
        token: this.config.token,
        info: this.collectNodeInfo(),
      };
      ws.send(JSON.stringify(hello));

      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const info = this.collectNodeInfo();
          const hb: NodeToHubMsg = {
            type: "node_heartbeat",
            nodeId: this.config.nodeId,
            uptime: info.uptime,
            loadAvg: info.loadAvg,
            memory: info.memory,
          };
          ws.send(JSON.stringify(hb));
        }
      }, this.config.heartbeatIntervalMs || 15_000);
      this.heartbeatTimer.unref?.();
    });

    ws.on("message", async (raw: RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as HubToNodeMsg;
        await this.handleHubMessage(msg);
      } catch (err: any) {
        console.error(`[node:${this.config.nodeId}] Gagal parse pesan hub:`, err.message);
      }
    });

    ws.on("close", () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      console.log(`[node:${this.config.nodeId}] Sambungan ke Hub terputus.`);
      if (!this.isClosed) {
        const delay = this.config.reconnectDelayMs ?? 3000;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });

    ws.on("error", (err) => {
      console.error(`[node:${this.config.nodeId}] Socket error:`, err.message);
    });
  }

  private async handleHubMessage(msg: HubToNodeMsg): Promise<void> {
    if (msg.type === "hub_welcome") {
      if (msg.success) {
        console.log(`[node:${this.config.nodeId}] Handshake sukses: ${msg.message}`);
      } else {
        console.error(`[node:${this.config.nodeId}] Handshake DITOLAK: ${msg.message}`);
        this.stop();
      }
      return;
    }

    if (msg.type === "hub_approval_res") {
      const resolver = this.pendingApprovals.get(msg.approvalId);
      if (resolver) {
        resolver(msg.approved);
        this.pendingApprovals.delete(msg.approvalId);
      }
      return;
    }

    if (msg.type === "hub_cancel") {
      const controller = this.activeRuns.get(msg.runId);
      if (controller) {
        console.log(`[node:${this.config.nodeId}] Membatalkan run [${msg.runId}]...`);
        controller.abort();
        this.activeRuns.delete(msg.runId);
      }
      return;
    }

    if (msg.type === "hub_ping") {
      this.send({ type: "node_pong", timestamp: Date.now() });
      return;
    }

    if (msg.type === "hub_run") {
      const { runId, prompt, model, history, chatId, userId } = msg;
      console.log(`[node:${this.config.nodeId}] Menerima run [${runId}]: "${prompt.slice(0, 60)}"`);

      const controller = new AbortController();
      this.activeRuns.set(runId, controller);

      const approvalTimeoutMs = this.config.approvalTimeoutMs ?? 300_000;
      const requestApproval = (command: string, reason: string): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
          if (controller.signal.aborted) {
            resolve(false);
            return;
          }

          const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const onAbort = () => {
            if (this.pendingApprovals.has(approvalId)) {
              this.pendingApprovals.delete(approvalId);
              resolve(false);
            }
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });

          this.pendingApprovals.set(approvalId, (approved: boolean) => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve(approved);
          });

          this.send({
            type: "node_approval_req",
            runId,
            approvalId,
            command,
            reason,
          });

          const timer = setTimeout(() => {
            if (this.pendingApprovals.has(approvalId)) {
              this.pendingApprovals.delete(approvalId);
              controller.signal.removeEventListener("abort", onAbort);
              resolve(false);
            }
          }, approvalTimeoutMs);
          timer.unref?.();
        });
      };

      let usage: TokenUsage | undefined;
      try {
        const fullText = await this.engine.run(
          prompt,
          (chunk) => {
            this.send({ type: "node_chunk", runId, chunk });
          },
          requestApproval,
          model,
          {
            signal: controller.signal,
            history,
            chatId,
            userId,
            onUsage: (u) => {
              usage = u;
            },
          }
        );

        this.send({
          type: "node_done",
          runId,
          fullText,
          ...(usage ? { usage } : {}),
        });
      } catch (err: any) {
        const isAborted = err?.message === ABORTED || controller.signal.aborted;
        this.send({
          type: "node_done",
          runId,
          fullText: isAborted ? `[${this.config.nodeId}] ⏹ Tugas dihentikan oleh operator.` : `Error di node: ${err.message}`,
          error: isAborted ? ABORTED : err.message,
        });
      } finally {
        this.activeRuns.delete(runId);
      }
    }
  }

  private send(msg: NodeToHubMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

import WebSocket, { RawData } from "ws";
import * as os from "os";
import {
  NodeInfo,
  NodeToHubMsg,
  HubToNodeMsg,
} from "../shared/protocol";
import { NodeEngine } from "./engine";

export interface NodeClientConfig {
  hubUrl: string;
  nodeId: string;
  token: string;
  heartbeatIntervalMs?: number;
}

export class NodeClient {
  private config: NodeClientConfig;
  private engine: NodeEngine;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isClosed: boolean = false;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(config: NodeClientConfig, engine: NodeEngine) {
    this.config = config;
    this.engine = engine;
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
    };
  }

  start(): void {
    this.isClosed = false;
    this.connect();
  }

  stop(): void {
    this.isClosed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.isClosed) return;

    console.log(`[node:${this.config.nodeId}] Konek ke Hub di ${this.config.hubUrl}...`);
    const ws = new WebSocket(this.config.hubUrl);
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

      // Mulai heartbeat berkala
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
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      console.log(`[node:${this.config.nodeId}] Sambungan ke Hub terputus.`);
      if (!this.isClosed) {
        setTimeout(() => this.connect(), 3000);
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

    if (msg.type === "hub_ping") {
      this.send({ type: "node_pong", timestamp: Date.now() });
      return;
    }

    if (msg.type === "hub_run") {
      const { runId, prompt, model } = msg;
      console.log(`[node:${this.config.nodeId}] Menerima run [${runId}]: "${prompt.slice(0, 60)}"`);

      const requestApproval = (command: string, reason: string): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
          const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          this.pendingApprovals.set(approvalId, resolve);

          this.send({
            type: "node_approval_req",
            runId,
            approvalId,
            command,
            reason,
          });

          // Timeout 120 detik untuk approval
          setTimeout(() => {
            if (this.pendingApprovals.has(approvalId)) {
              this.pendingApprovals.delete(approvalId);
              resolve(false);
            }
          }, 120_000);
        });
      };

      try {
        const fullText = await this.engine.run(
          prompt,
          (chunk) => {
            this.send({ type: "node_chunk", runId, chunk });
          },
          requestApproval,
          model
        );

        this.send({
          type: "node_done",
          runId,
          fullText,
        });
      } catch (err: any) {
        this.send({
          type: "node_done",
          runId,
          fullText: `Error di node: ${err.message}`,
          error: err.message,
        });
      }
    }
  }

  private send(msg: NodeToHubMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

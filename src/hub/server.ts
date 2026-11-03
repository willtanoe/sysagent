import WebSocket, { WebSocketServer, RawData } from "ws";
import { EventEmitter } from "events";
import {
  NodeInfo,
  NodeToHubMsg,
  HubToNodeMsg,
} from "../shared/protocol";

export interface ConnectedNode {
  nodeId: string;
  ws: WebSocket;
  info: NodeInfo;
  lastSeen: number;
}

export interface ActiveRun {
  runId: string;
  nodeId: string;
  chatId: number;
  onChunk: (chunk: string) => void;
  onApprovalReq: (approvalId: string, command: string, reason: string) => void;
  onDone: (fullText: string, error?: string) => void;
}

export class HubServer extends EventEmitter {
  private port: number;
  private secretToken: string;
  private wss: WebSocketServer | null = null;
  private nodes = new Map<string, ConnectedNode>();
  private runs = new Map<string, ActiveRun>();

  constructor(port: number, secretToken: string) {
    super();
    this.port = port;
    this.secretToken = secretToken;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wss = new WebSocketServer({ port: this.port }, () => {
          console.log(`[hub] WSS Server listening di port ${this.port}`);
          resolve();
        });
        this.wss = wss;

        wss.on("connection", (ws: WebSocket) => {
          let authenticatedNodeId: string | null = null;

          ws.on("message", (raw: RawData) => {
            try {
              const msg = JSON.parse(raw.toString()) as NodeToHubMsg;

              if (msg.type === "node_hello") {
                if (msg.token !== this.secretToken) {
                  const rejectMsg: HubToNodeMsg = {
                    type: "hub_welcome",
                    success: false,
                    message: "Token autentikasi salah.",
                  };
                  ws.send(JSON.stringify(rejectMsg));
                  ws.close();
                  return;
                }

                authenticatedNodeId = msg.nodeId;
                this.nodes.set(msg.nodeId, {
                  nodeId: msg.nodeId,
                  ws,
                  info: msg.info,
                  lastSeen: Date.now(),
                });

                console.log(`[hub] Node terdaftar: "${msg.nodeId}" (${msg.info.hostname}, ${msg.info.platform})`);
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
                if (run) run.onApprovalReq(msg.approvalId, msg.command, msg.reason);
                return;
              }

              if (msg.type === "node_done") {
                const run = this.runs.get(msg.runId);
                if (run) {
                  run.onDone(msg.fullText, msg.error);
                  this.runs.delete(msg.runId);
                }
                return;
              }
            } catch (err: any) {
              console.error("[hub] Gagal memproses pesan socket:", err.message);
            }
          });

          ws.on("close", () => {
            if (authenticatedNodeId) {
              console.log(`[hub] Node disconnect: "${authenticatedNodeId}"`);
              this.nodes.delete(authenticatedNodeId);
              this.emit("node_left", authenticatedNodeId);
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
        node.ws.close();
      }
      this.nodes.clear();
      this.runs.clear();
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  listNodes(): ConnectedNode[] {
    return Array.from(this.nodes.values());
  }

  getNode(nodeId: string): ConnectedNode | undefined {
    return this.nodes.get(nodeId);
  }

  startRun(
    nodeId: string,
    chatId: number,
    prompt: string,
    handlers: {
      onChunk: (chunk: string) => void;
      onApprovalReq: (approvalId: string, command: string, reason: string) => void;
      onDone: (fullText: string, error?: string) => void;
    },
    model?: string
  ): string {
    const node = this.nodes.get(nodeId);
    if (!node || node.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Node "${nodeId}" tidak terhubung atau offline.`);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.runs.set(runId, {
      runId,
      nodeId,
      chatId,
      ...handlers,
    });

    const msg: HubToNodeMsg = {
      type: "hub_run",
      runId,
      chatId,
      prompt,
      model,
    };
    node.ws.send(JSON.stringify(msg));
    return runId;
  }

  sendApproval(nodeId: string, runId: string, approvalId: string, approved: boolean): void {
    const node = this.nodes.get(nodeId);
    if (!node || node.ws.readyState !== WebSocket.OPEN) return;

    const msg: HubToNodeMsg = {
      type: "hub_approval_res",
      runId,
      approvalId,
      approved,
    };
    node.ws.send(JSON.stringify(msg));
  }
}

export interface NodeDistroInfo {
  id: string;
  name: string;
  version: string;
  packageManager: string;
}

export interface NodeInfo {
  hostname: string;
  platform: string;
  arch: string;
  uptime: number;
  loadAvg: number[];
  memory: {
    totalMb: number;
    freeMb: number;
  };
  distro?: NodeDistroInfo;
  kernel?: string;
  cpus?: number;
  diskPct?: number;
  isRoot?: boolean;
}

export interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

// Node -> Hub
export interface NodeHelloMsg {
  type: "node_hello";
  nodeId: string;
  token: string;
  info: NodeInfo;
}

export interface NodeHeartbeatMsg {
  type: "node_heartbeat";
  nodeId: string;
  uptime: number;
  loadAvg: number[];
  memory: {
    totalMb: number;
    freeMb: number;
  };
  diskPct?: number;
}

export interface NodeRunChunkMsg {
  type: "node_chunk";
  runId: string;
  chunk: string;
}

export interface NodeApprovalReqMsg {
  type: "node_approval_req";
  runId: string;
  approvalId: string;
  command: string;
  reason: string;
}

export interface NodeRunDoneMsg {
  type: "node_done";
  runId: string;
  fullText: string;
  error?: string;
  usage?: TokenUsage;
}

export interface NodeAlertMsg {
  type: "node_alert";
  nodeId: string;
  key: string;
  severity: "warn" | "ok";
  html: string;
}

export interface NodePongMsg {
  type: "node_pong";
  timestamp: number;
}

export type NodeToHubMsg =
  | NodeHelloMsg
  | NodeHeartbeatMsg
  | NodeRunChunkMsg
  | NodeApprovalReqMsg
  | NodeRunDoneMsg
  | NodeAlertMsg
  | NodePongMsg;

// Hub -> Node
export interface HubWelcomeMsg {
  type: "hub_welcome";
  success: boolean;
  message: string;
}

export interface HubRunPromptMsg {
  type: "hub_run";
  runId: string;
  chatId: number;
  userId?: number;
  prompt: string;
  model?: string;
  history?: ChatHistoryItem[];
}

export interface HubApprovalResMsg {
  type: "hub_approval_res";
  runId: string;
  approvalId: string;
  approved: boolean;
}

export interface HubRunCancelMsg {
  type: "hub_cancel";
  runId: string;
}

export interface HubPingMsg {
  type: "hub_ping";
  timestamp: number;
}

export type HubToNodeMsg =
  | HubWelcomeMsg
  | HubRunPromptMsg
  | HubApprovalResMsg
  | HubRunCancelMsg
  | HubPingMsg;

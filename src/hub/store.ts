import * as fs from "fs";
import * as path from "path";
import { ChatHistoryItem, TokenUsage } from "../shared/protocol";

export interface UsageStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface HubPersistedState {
  activeNodes: Record<string, string>;
  histories: Record<string, ChatHistoryItem[]>;
  models: Record<string, string>;
  usage: Record<string, UsageStats>;
}

export class HubStore {
  private filePath: string;
  private state: HubPersistedState = {
    activeNodes: {},
    histories: {},
    models: {},
    usage: {},
  };
  private saveTimer: NodeJS.Timeout | null = null;
  private memoryTurns: number;
  private memoryChars: number;

  constructor(filePath: string, opts?: { memoryTurns?: number; memoryChars?: number }) {
    this.filePath = filePath;
    this.memoryTurns = opts?.memoryTurns ?? 4;
    this.memoryChars = opts?.memoryChars ?? 400;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HubPersistedState>;
      this.state = {
        activeNodes: parsed.activeNodes ?? {},
        histories: parsed.histories ?? {},
        models: parsed.models ?? {},
        usage: parsed.usage ?? {},
      };
    } catch {
      this.state = { activeNodes: {}, histories: {}, models: {}, usage: {} };
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 1000);
    this.saveTimer.unref?.();
  }

  flush(): void {
    try {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      const dir = path.dirname(path.resolve(this.filePath));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        // 忽略
      }
      fs.renameSync(tmp, this.filePath);
    } catch (err: any) {
      console.error("[hub:store] Gagal menyimpan state:", err.message);
    }
  }

  getActiveNode(chatId: number): string | undefined {
    return this.state.activeNodes[String(chatId)];
  }

  setActiveNode(chatId: number, nodeId: string | null): void {
    if (nodeId === null) {
      delete this.state.activeNodes[String(chatId)];
    } else {
      this.state.activeNodes[String(chatId)] = nodeId;
    }
    this.scheduleSave();
  }

  getHistory(chatId: number, nodeId: string): ChatHistoryItem[] {
    return this.state.histories[`${chatId}:${nodeId}`] ?? [];
  }

  remember(chatId: number, nodeId: string, prompt: string, reply: string): void {
    const key = `${chatId}:${nodeId}`;
    const list = [...(this.state.histories[key] ?? [])];
    const conciseReply = reply.replace(/\s+/g, " ").trim().slice(0, this.memoryChars);
    list.push(
      { role: "user", content: prompt.slice(0, this.memoryChars) },
      { role: "assistant", content: conciseReply }
    );
    const maxItems = Math.max(2, this.memoryTurns * 2);
    while (list.length > maxItems) list.shift();
    this.state.histories[key] = list;
    this.scheduleSave();
  }

  resetChat(chatId: number, nodeId?: string): void {
    if (nodeId) {
      delete this.state.histories[`${chatId}:${nodeId}`];
    } else {
      for (const key of Object.keys(this.state.histories)) {
        if (key.startsWith(`${chatId}:`)) delete this.state.histories[key];
      }
    }
    delete this.state.usage[String(chatId)];
    this.scheduleSave();
  }

  getModelOverride(chatId: number): string | undefined {
    return this.state.models[String(chatId)];
  }

  setModelOverride(chatId: number, model: string | null): void {
    if (model === null) {
      delete this.state.models[String(chatId)];
    } else {
      this.state.models[String(chatId)] = model;
    }
    this.scheduleSave();
  }

  addUsage(chatId: number, usage: TokenUsage): void {
    const key = String(chatId);
    const current = this.state.usage[key] ?? { requests: 0, promptTokens: 0, completionTokens: 0 };
    current.requests += 1;
    current.promptTokens += usage.promptTokens;
    current.completionTokens += usage.completionTokens;
    this.state.usage[key] = current;
    this.scheduleSave();
  }

  getUsage(chatId: number): UsageStats {
    return this.state.usage[String(chatId)] ?? { requests: 0, promptTokens: 0, completionTokens: 0 };
  }
}

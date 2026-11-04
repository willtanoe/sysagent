import { NodeExecutor } from "./executor";
import { escapeHtml, preBlock } from "../shared/format";

export interface AlertSnapshot {
  diskPct: number | null;
  diskDetail: string;
  memPct: number | null;
  memDetail: string;
  failedUnits: string[];
  failedDetail: string;
}

export interface NodeAlertEvent {
  key: string;
  severity: "warn" | "ok";
  html: string;
}

export interface AlertEvaluatorDeps {
  nodeId: string;
  send: (event: NodeAlertEvent) => Promise<boolean> | boolean;
  get: (key: string) => string | null;
  set: (key: string, value: string | null) => void;
  now: () => number;
  cooldownMs: number;
  diskPct: number;
  memPct: number;
}

const RECOVERY_MARGIN = 3;

/**
 * 每节点主动告警评估器：
 * - 仅在状况恶化时发送告警（5% bucket 上升或出现新的失败单元）。
 * - 当降至阈值 - 3% 以下或所有单元恢复健康时，发送 1 条恢复通知。
 */
export function createNodeAlertEvaluator(
  deps: AlertEvaluatorDeps
): (snapshot: AlertSnapshot) => Promise<void> {
  const lastSent = new Map<string, number>();

  const notify = async (key: string, severity: "warn" | "ok", html: string): Promise<boolean> => {
    const previous = lastSent.get(key) ?? 0;
    if (deps.now() - previous < deps.cooldownMs) return false;
    lastSent.set(key, deps.now());
    try {
      const ok = await deps.send({ key, severity, html });
      if (!ok) lastSent.delete(key);
      return ok;
    } catch {
      lastSent.delete(key);
      return false;
    }
  };

  const percentAlert = async (
    key: "disk" | "mem",
    label: string,
    pct: number | null,
    threshold: number,
    detail: string
  ): Promise<void> => {
    if (pct === null || !Number.isFinite(pct)) return;
    const stored = deps.get(key);

    if (pct >= threshold) {
      const bucket = Math.floor(pct / 5) * 5;
      if (stored !== null && bucket <= Number(stored)) return;
      const html = `⚠️ <b>[${escapeHtml(deps.nodeId)}] ${label} ${pct}%</b>\n${preBlock(detail)}`;
      if (await notify(key, "warn", html)) {
        deps.set(key, String(bucket));
      }
      return;
    }

    if (stored !== null && pct < threshold - RECOVERY_MARGIN) {
      deps.set(key, null);
      await notify(`${key}-ok`, "ok", `✅ <b>[${escapeHtml(deps.nodeId)}] ${label} pulih</b> (${pct}%)`);
    }
  };

  return async (snapshot: AlertSnapshot): Promise<void> => {
    await percentAlert("disk", "Disk / sudah", snapshot.diskPct, deps.diskPct, snapshot.diskDetail);
    await percentAlert("mem", "Memory terpakai", snapshot.memPct, deps.memPct, snapshot.memDetail);

    const current = [...new Set(snapshot.failedUnits)].sort();
    const storedRaw = deps.get("failed-units");
    const previous = storedRaw === null || storedRaw === "" ? [] : storedRaw.split(",");
    const fresh = current.filter((unit) => !previous.includes(unit));

    if (fresh.length > 0) {
      const html = `⚠️ <b>[${escapeHtml(deps.nodeId)}] ${fresh.length} service gagal baru</b>\n${preBlock(snapshot.failedDetail)}`;
      if (await notify("failed-units", "warn", html)) {
        deps.set("failed-units", current.join(","));
      }
      return;
    }

    if (current.length === 0) {
      if (storedRaw !== null) {
        deps.set("failed-units", null);
        await notify("failed-units-ok", "ok", `✅ <b>[${escapeHtml(deps.nodeId)}] Semua service kembali normal</b>`);
      }
      return;
    }

    if (current.join(",") !== storedRaw) {
      deps.set("failed-units", current.join(","));
    }
  };
}

export interface NodeAlertConfig {
  intervalMs?: number;
  cooldownMs?: number;
  diskPct?: number;
  memPct?: number;
  ignoreUnits?: string[];
}

export class NodeAlertMonitor {
  private nodeId: string;
  private executor: NodeExecutor;
  private config: Required<NodeAlertConfig>;
  private state = new Map<string, string>();
  private evaluate: (snapshot: AlertSnapshot) => Promise<void>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    nodeId: string,
    executor: NodeExecutor,
    onAlert: (event: NodeAlertEvent) => boolean,
    config?: NodeAlertConfig
  ) {
    this.nodeId = nodeId;
    this.executor = executor;
    this.config = {
      intervalMs: config?.intervalMs ?? 300_000,
      cooldownMs: config?.cooldownMs ?? 1_800_000,
      diskPct: config?.diskPct ?? 90,
      memPct: config?.memPct ?? 92,
      ignoreUnits: config?.ignoreUnits ?? [],
    };

    this.evaluate = createNodeAlertEvaluator({
      nodeId: this.nodeId,
      send: onAlert,
      get: (k) => this.state.get(k) ?? null,
      set: (k, v) => {
        if (v === null) this.state.delete(k);
        else this.state.set(k, v);
      },
      now: Date.now,
      cooldownMs: this.config.cooldownMs,
      diskPct: this.config.diskPct,
      memPct: this.config.memPct,
    });
  }

  async measure(): Promise<AlertSnapshot> {
    const parseNum = (out: string): number | null => {
      const val = Number(out.trim());
      return Number.isFinite(val) ? val : null;
    };

    const disk = await this.executor.execRaw("df -P / | awk 'NR==2 {gsub(/%/,\"\",$5); print $5}'", 10_000);
    const diskPct = parseNum(disk.output);
    const diskDetail =
      diskPct !== null && diskPct >= this.config.diskPct
        ? (await this.executor.execRaw("df -h /", 10_000)).output
        : "";

    const mem = await this.executor.execRaw("free | awk '/Mem:/{printf \"%.0f\", $3/$2*100}'", 10_000);
    const memPct = parseNum(mem.output);
    const memDetail =
      memPct !== null && memPct >= this.config.memPct
        ? (await this.executor.execRaw("free -h", 10_000)).output
        : "";

    const failed = await this.executor.execRaw("systemctl --failed --no-legend --no-pager 2>/dev/null", 10_000);
    const ignored = new Set(this.config.ignoreUnits);
    const lines = failed.output
      .split("\n")
      .map((line) => line.replace(/^[●*]\s*/, "").trim())
      .filter((line) => line !== "" && line !== "(tidak ada output)")
      .filter((line) => !ignored.has(line.split(/\s+/)[0] ?? ""));

    return {
      diskPct,
      diskDetail,
      memPct,
      memDetail,
      failedUnits: lines.map((line) => line.split(/\s+/)[0] ?? line),
      failedDetail: lines.join("\n"),
    };
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const snap = await this.measure();
      await this.evaluate(snap);
    } catch (err: any) {
      console.error(`[alert:${this.nodeId}] Tick gagal:`, err.message);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    this.stop();
    if (this.config.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

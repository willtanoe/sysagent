import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assessRisk, Verdict } from "../shared/risk";
import { 审计日志器, AuditVerifyResult } from "../shared/audit";

const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_MODEL_OUTPUT = 12_000;
const PACKAGE_COMMAND = /\b(apt|apt-get|dpkg|dnf|yum|pacman|apk|snap|zypper|rpm|add-apt-repository)\b/;
const SUDO_CALL = /(^|[\n;&|(]\s*)sudo(?!\s+-[An])/gm;
const REDUNDANT_ROOT_SUDO = /(^|[\n;&|(]\s*)sudo(?:\s+-[AnEHKPSv]+)*(?=\s+(?![-]))\s+/gm;

export const isRoot: boolean = typeof process.getuid === "function" && process.getuid() === 0;

/** 当进程已以 root (uid=0) 运行时，移除不改变目标用户 (-u/-g) 的 sudo 前缀。 */
export function stripRedundantSudo(command: string): string {
  return command.replace(REDUNDANT_ROOT_SUDO, "$1");
}

export interface ExecResult {
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
  blocked?: boolean;
  rejected?: boolean;
  reason?: string;
}

export interface ExecutorOptions {
  sudoPassword?: string;
  shellTimeoutMs?: number;
  packageTimeoutMs?: number;
  maxCommandsPerMinute?: number;
}

export type RequestApprovalFn = (command: string, reason: string) => Promise<boolean>;

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 从传递给子进程 shell 的 env 中移除敏感变量。 */
export function sanitizeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...source };
  const sensitive =
    /(TOKEN|PASSWORD|PASSWD|SECRET|API|KEY|PRIVATE|CREDENTIAL|AUTH|JWT|DSN|DATABASE_URL|ASKPASS)/i;
  for (const key of Object.keys(result)) {
    if (key === "SUDO_ASKPASS") continue;
    if (sensitive.test(key)) delete result[key];
  }
  return result;
}

export function truncateForModel(output: string): string {
  if (output.length <= MAX_MODEL_OUTPUT) return output;
  const dropped = output.length - MAX_MODEL_OUTPUT;
  return `${output.slice(0, MAX_MODEL_OUTPUT)}\n[...dipotong ${dropped} karakter]`;
}

export class 节点执行器 {
  private nodeId: string;
  private audit: 审计日志器;
  private askpassPath: string | null = null;
  private shellTimeoutMs: number;
  private packageTimeoutMs: number;
  private maxCommandsPerMinute: number;
  private executionTimestamps: number[] = [];

  constructor(nodeId: string, auditPath: string, opts?: ExecutorOptions) {
    this.nodeId = nodeId;
    this.audit = new 审计日志器(auditPath);
    this.shellTimeoutMs = Math.min(opts?.shellTimeoutMs ?? 120_000, 1_800_000);
    this.packageTimeoutMs = Math.min(opts?.packageTimeoutMs ?? 900_000, 1_800_000);
    this.maxCommandsPerMinute = opts?.maxCommandsPerMinute ?? 30;

    if (opts?.sudoPassword) {
      this.initSudo(opts.sudoPassword);
    }
  }

  initSudo(password: string): void {
    if (isRoot) return;
    if (!password) return;

    const candidates = [
      path.join(os.homedir(), ".config", "aster"),
      path.join(path.dirname(path.resolve(this.audit.getLogPath())), ".aster-askpass"),
    ];

    const safeId = this.nodeId.replace(/[^A-Za-z0-9_-]/g, "_");
    let lastErr: any = null;
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
        const file = path.join(dir, `askpass-${safeId}.sh`);
        fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${singleQuote(password)}\n`, { mode: 0o700 });
        fs.chmodSync(file, 0o700);
        this.askpassPath = file;
        return;
      } catch (err: any) {
        lastErr = err;
      }
    }
    if (lastErr) {
      console.error(`[executor:${this.nodeId}] Gagal menyiapkan sudo askpass:`, lastErr.message);
    }
  }

  private prepareCommand(command: string): string {
    if (isRoot) {
      return stripRedundantSudo(command);
    }
    const flag = this.askpassPath === null ? "sudo -n" : "sudo -A";
    return command.replace(SUDO_CALL, (_match: string, prefix: string) => `${prefix}${flag}`);
  }

  timeoutFor(command: string): number {
    return PACKAGE_COMMAND.test(command) ? this.packageTimeoutMs : this.shellTimeoutMs;
  }

  /** 原始 shell 执行，支持 process-group kill 与 env 清洗（内部与 runCommand 共用）。 */
  execRaw(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult> {
    const effectiveTimeout = timeoutMs ?? this.timeoutFor(command);
    const prepared = this.prepareCommand(command);

    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      let aborted = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let onAbort: (() => void) | null = null;

      const finish = (result: ExecResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (onAbort !== null) signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      if (signal?.aborted) {
        finish({
          output: "[dibatalkan]",
          exitCode: 130,
          durationMs: 0,
          timedOut: false,
          aborted: true,
        });
        return;
      }

      const env: NodeJS.ProcessEnv = sanitizeEnv(process.env);
      env.DEBIAN_FRONTEND = "noninteractive";
      env.APT_LISTCHANGES_FRONTEND = "none";
      env.NEEDRESTART_MODE = "a";
      if (this.askpassPath !== null) {
        env.SUDO_ASKPASS = this.askpassPath;
        env.SUDO_ASKPASS_REQUIRE = "force";
      }

      const child = spawn("/bin/bash", ["-c", prepared], {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;

      const collect = (target: "out" | "err", chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        if (target === "out") {
          if (stdout.length < MAX_BUFFER) stdout += text;
          else truncated = true;
        } else if (stderr.length < MAX_BUFFER) {
          stderr += text;
        } else {
          truncated = true;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => collect("out", chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect("err", chunk));

      const killTree = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // 已停止
          }
        }
      };

      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, effectiveTimeout);

      onAbort = (): void => {
        aborted = true;
        killTree();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err: Error) => {
        finish({
          output: `[error] ${err.message}`,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          aborted,
        });
      });

      child.on("close", (code) => {
        let output = stdout;
        if (stderr.trim() !== "") {
          output += `${output.trim() ? "\n[stderr]\n" : ""}${stderr}`;
        }

        if (aborted) output += "\n[dibatalkan oleh operator]";
        else if (timedOut) output += `\n[error] timeout setelah ${Math.round(effectiveTimeout / 1000)}s`;

        if (truncated) output += "\n[output dipotong: melebihi batas buffer]";

        const trimmed = output.trim();
        finish({
          output: trimmed === "" ? "(tidak ada output)" : trimmed,
          exitCode: aborted ? 130 : timedOut ? 124 : (code ?? 0),
          durationMs: Date.now() - startedAt,
          timedOut,
          aborted,
        });
      });
    });
  }

  async runCommand(
    command: string,
    requestApproval?: RequestApprovalFn,
    timeoutMs?: number,
    signal?: AbortSignal,
    meta?: { chatId?: number; userId?: number }
  ): Promise<ExecResult> {
    const verdict: Verdict = assessRisk(command);

    if (verdict.level === "block") {
      this.audit.log({
        nodeId: this.nodeId,
        command,
        exitCode: 126,
        durationMs: 0,
        risk: "block",
        approved: false,
        outputPreview: verdict.reason,
        chatId: meta?.chatId,
        userId: meta?.userId,
      });
      return {
        output: `[BLOCKED] Perintah dilarang: ${verdict.reason}`,
        exitCode: 126,
        durationMs: 0,
        blocked: true,
        reason: verdict.reason,
      };
    }

    let approved = true;
    if (verdict.level === "approve") {
      if (!requestApproval) {
        return {
          output: `[APPROVAL REQUIRED] Butuh persetujuan admin: ${verdict.reason}`,
          exitCode: 126,
          durationMs: 0,
          rejected: true,
          reason: verdict.reason,
        };
      }
      approved = await requestApproval(command, verdict.reason);
      if (!approved) {
        this.audit.log({
          nodeId: this.nodeId,
          command,
          exitCode: 125,
          durationMs: 0,
          risk: "approve",
          approved: false,
          outputPreview: "Ditolak oleh operator",
          chatId: meta?.chatId,
          userId: meta?.userId,
        });
        return {
          output: `[REJECTED] Ditolak oleh operator.`,
          exitCode: 125,
          durationMs: 0,
          rejected: true,
          reason: "Ditolak oleh operator",
        };
      }
    }

    // 每分钟速率限制
    const now = Date.now();
    while (this.executionTimestamps.length > 0 && now - (this.executionTimestamps[0] ?? 0) > 60_000) {
      this.executionTimestamps.shift();
    }
    if (this.executionTimestamps.length >= this.maxCommandsPerMinute) {
      return {
        output: `[RATE LIMIT] Melebihi batas ${this.maxCommandsPerMinute} perintah per menit di node ${this.nodeId}.`,
        exitCode: 129,
        durationMs: 0,
        rejected: true,
        reason: "Rate limit tercapai",
      };
    }
    this.executionTimestamps.push(now);

    const res = await this.execRaw(command, timeoutMs, signal);

    this.audit.log({
      nodeId: this.nodeId,
      command,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      risk: verdict.level,
      approved,
      timedOut: res.timedOut,
      outputPreview: res.output.slice(0, 500),
      chatId: meta?.chatId,
      userId: meta?.userId,
    });

    return res;
  }

  verifyAudit(): AuditVerifyResult {
    return this.audit.verify();
  }

  logAudit(entry: {
    command: string;
    exitCode: number | null;
    durationMs: number;
    risk: string;
    approved: boolean;
    outputPreview?: string;
    chatId?: number;
    userId?: number;
  }): void {
    this.audit.log({
      nodeId: this.nodeId,
      ...entry,
    });
  }

  getAuditPath(): string {
    return this.audit.getLogPath();
  }
}

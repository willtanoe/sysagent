import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface AuditEntry {
  ts: string;
  nodeId: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  risk: string;
  approved: boolean;
  timedOut?: boolean;
  outputPreview?: string;
  chatId?: number;
  userId?: number;
  prevHash: string;
  hash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  total: number;
  brokenAt?: number;
  reason?: string;
}

/** 对密码、token 或敏感 secret 的模式进行脱敏，避免泄露到明文审计追踪中。 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/(?:printf|echo)\s+(['"])[^\n]*?\1\s*([;|]\s*sudo)/gi, "printf '[REDACTED]' $2")
    .replace(/sudo\s+-S\s+-p\s+(['"])[^\n]*?\1/gi, "sudo -S -p '[REDACTED]'")
    .replace(/\b(password|passwd|token|secret|api[_-]?key|hub[_-]?token)=([^\s&;'"]+)/gi, "$1=[REDACTED]")
    .replace(/(?:--password|--token|-p)\s+(['"]?)[^\s'"]+\1/gi, "--password [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

function computeEntryHash(entryWithoutHash: Omit<AuditEntry, "hash">): string {
  const payload = [
    entryWithoutHash.ts,
    entryWithoutHash.nodeId,
    entryWithoutHash.command,
    String(entryWithoutHash.exitCode ?? ""),
    String(entryWithoutHash.durationMs),
    entryWithoutHash.risk,
    String(entryWithoutHash.approved),
    String(entryWithoutHash.timedOut ?? false),
    entryWithoutHash.outputPreview ?? "",
    String(entryWithoutHash.chatId ?? ""),
    String(entryWithoutHash.userId ?? ""),
    entryWithoutHash.prevHash,
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export class AuditLogger {
  private lastHash: string = "GENESIS";
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.init();
  }

  private init(): void {
    try {
      const dir = path.dirname(path.resolve(this.logPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      if (!fs.existsSync(this.logPath)) {
        return;
      }
      try {
        fs.chmodSync(this.logPath, 0o600);
      } catch {
        // 若文件系统不支持 chmod 则忽略
      }
      const lines = fs.readFileSync(this.logPath, "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Partial<AuditEntry>;
          if (typeof parsed.hash === "string" && parsed.hash.length > 0) {
            this.lastHash = parsed.hash;
            break;
          }
        } catch {
          // 初始化时跳过损坏行
        }
      }
    } catch {
      // 文件不存在或无法访问
    }
  }

  log(data: {
    nodeId: string;
    command: string;
    exitCode: number | null;
    durationMs: number;
    risk: string;
    approved: boolean;
    timedOut?: boolean;
    outputPreview?: string;
    chatId?: number;
    userId?: number;
  }): AuditEntry {
    // 若有其他进程写入，则从磁盘重新同步 lastHash
    this.init();

    const ts = new Date().toISOString();
    const safeCommand = redactSecrets(data.command);
    const safePreview = data.outputPreview ? redactSecrets(data.outputPreview.slice(0, 500)) : undefined;

    const baseEntry: Omit<AuditEntry, "hash"> = {
      ts,
      nodeId: data.nodeId,
      command: safeCommand,
      exitCode: data.exitCode,
      durationMs: data.durationMs,
      risk: data.risk,
      approved: data.approved,
      ...(data.timedOut !== undefined ? { timedOut: data.timedOut } : {}),
      ...(safePreview !== undefined ? { outputPreview: safePreview } : {}),
      ...(data.chatId !== undefined ? { chatId: data.chatId } : {}),
      ...(data.userId !== undefined ? { userId: data.userId } : {}),
      prevHash: this.lastHash,
    };

    const hash = computeEntryHash(baseEntry);
    const entry: AuditEntry = { ...baseEntry, hash };

    this.lastHash = hash;
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
      try {
        fs.chmodSync(this.logPath, 0o600);
      } catch {
        // 忽略
      }
    } catch (err: any) {
      console.error(`[audit:${data.nodeId}] Gagal menulis audit log:`, err.message);
    }
    return entry;
  }

  verify(): AuditVerifyResult {
    if (!fs.existsSync(this.logPath)) {
      return { ok: true, total: 0 };
    }

    let raw = "";
    try {
      raw = fs.readFileSync(this.logPath, "utf8");
    } catch (err: any) {
      return { ok: false, total: 0, reason: `gagal membaca file: ${err.message}` };
    }

    const lines = raw.trim().split("\n").filter(Boolean);
    let expectedPrev = "GENESIS";

    for (let i = 0; i < lines.length; i++) {
      let parsed: AuditEntry;
      try {
        parsed = JSON.parse(lines[i]!) as AuditEntry;
      } catch {
        return { ok: false, total: lines.length, brokenAt: i + 1, reason: "baris bukan JSON valid" };
      }

      if (parsed.prevHash !== expectedPrev) {
        return {
          ok: false,
          total: lines.length,
          brokenAt: i + 1,
          reason: `prevHash tidak cocok (ekspektasi ${expectedPrev.slice(0, 12)}..., dapat ${String(parsed.prevHash).slice(0, 12)}...)`,
        };
      }

      const { hash, ...rest } = parsed;
      const expectedHash = computeEntryHash(rest);
      if (hash !== expectedHash) {
        return {
          ok: false,
          total: lines.length,
          brokenAt: i + 1,
          reason: "hash SHA-256 tidak cocok (data baris telah diubah)",
        };
      }

      expectedPrev = hash;
    }

    return { ok: true, total: lines.length };
  }

  getLogPath(): string {
    return this.logPath;
  }
}

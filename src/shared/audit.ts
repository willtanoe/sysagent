import * as crypto from "crypto";
import * as fs from "fs";

export interface AuditEntry {
  ts: string;
  nodeId: string;
  command: string;
  exitCode: number;
  durationMs: number;
  risk: string;
  approved: boolean;
  prevHash: string;
  hash: string;
}

export class AuditLogger {
  private lastHash: string = "GENESIS";
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.init();
  }

  private init(): void {
    if (!fs.existsSync(this.logPath)) return;
    try {
      const lines = fs.readFileSync(this.logPath, "utf8").trim().split("\n");
      if (lines.length > 0 && lines[lines.length - 1].trim()) {
        const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
        if (last && last.hash) {
          this.lastHash = last.hash;
        }
      }
    } catch {
      // jika file baru/kosong
    }
  }

  log(data: {
    nodeId: string;
    command: string;
    exitCode: number;
    durationMs: number;
    risk: string;
    approved: boolean;
  }): AuditEntry {
    const ts = new Date().toISOString();
    const payload = `${ts}|${data.nodeId}|${data.command}|${data.exitCode}|${data.durationMs}|${data.risk}|${data.approved}|${this.lastHash}`;
    const hash = crypto.createHash("sha256").update(payload).digest("hex");

    const entry: AuditEntry = {
      ts,
      nodeId: data.nodeId,
      command: data.command,
      exitCode: data.exitCode,
      durationMs: data.durationMs,
      risk: data.risk,
      approved: data.approved,
      prevHash: this.lastHash,
      hash,
    };

    this.lastHash = hash;
    fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }
}

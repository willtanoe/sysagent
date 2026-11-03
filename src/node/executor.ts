import { exec } from "child_process";
import { assessRisk, Verdict } from "../shared/risk";
import { AuditLogger } from "../shared/audit";

export interface ExecResult {
  output: string;
  exitCode: number;
  durationMs: number;
  blocked?: boolean;
  rejected?: boolean;
  reason?: string;
}

export type RequestApprovalFn = (command: string, reason: string) => Promise<boolean>;

export class NodeExecutor {
  private nodeId: string;
  private audit: AuditLogger;

  constructor(nodeId: string, auditPath: string) {
    this.nodeId = nodeId;
    this.audit = new AuditLogger(auditPath);
  }

  async runCommand(
    command: string,
    requestApproval?: RequestApprovalFn,
    timeoutMs: number = 30_000
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

    const start = Date.now();
    return new Promise((resolve) => {
      exec(command, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const out = stdout.trim() || stderr.trim() || "(tidak ada output)";
        const exitCode = err?.code ?? (err ? 1 : 0);

        this.audit.log({
          nodeId: this.nodeId,
          command,
          exitCode,
          durationMs,
          risk: verdict.level,
          approved,
        });

        resolve({
          output: out,
          exitCode,
          durationMs,
        });
      });
    });
  }
}

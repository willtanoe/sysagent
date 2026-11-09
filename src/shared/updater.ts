import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface GitVersionInfo {
  branch: string;
  commit: string;
  shortCommit: string;
  subject: string;
}

export interface UpdateResult {
  status: "up_to_date" | "updated" | "failed";
  branch: string;
  fromCommit: string;
  toCommit: string;
  changes?: string;
  error?: string;
  restartRequired: boolean;
}

export type ExecStepFn = (
  command: string,
  cwd: string,
  timeoutMs?: number
) => Promise<{ exitCode: number; output: string }>;

export function resolveRepoDir(customDir?: string): string {
  if (customDir && fs.existsSync(customDir)) return path.resolve(customDir);
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname, "../../.."),
  ];
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, ".git")) &&
      fs.existsSync(path.join(candidate, "package.json"))
    ) {
      return candidate;
    }
  }
  return process.cwd();
}

export const defaultExecStep: ExecStepFn = (
  command: string,
  cwd: string,
  timeoutMs = 180_000
): Promise<{ exitCode: number; output: string }> => {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // abaikan
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: out.trim() });
    });
  });
};

export async function getGitVersionInfo(
  repoDir?: string,
  execFn: ExecStepFn = defaultExecStep
): Promise<GitVersionInfo> {
  const dir = resolveRepoDir(repoDir);
  const res = await execFn(
    "git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git log -1 --pretty=%s",
    dir,
    10_000
  );
  const lines = res.output.split("\n").map((s) => s.trim());
  const branch = lines[0] || "unknown";
  const commit = lines[1] || "unknown";
  const subject = lines.slice(2).join(" ") || "";
  return {
    branch,
    commit,
    shortCommit: commit.slice(0, 7),
    subject,
  };
}

let updateInProgress = false;

export async function checkAndApplyUpdate(opts?: {
  repoDir?: string;
  remote?: string;
  branch?: string;
  forceBuild?: boolean;
  execFn?: ExecStepFn;
}): Promise<UpdateResult> {
  if (updateInProgress) {
    return {
      status: "failed",
      branch: opts?.branch || "unknown",
      fromCommit: "",
      toCommit: "",
      error: "Proses update lain sedang berjalan.",
      restartRequired: false,
    };
  }

  updateInProgress = true;
  const execFn = opts?.execFn ?? defaultExecStep;
  const dir = resolveRepoDir(opts?.repoDir);
  const remote = (opts?.remote || process.env.AUTO_UPDATE_REMOTE || "origin").trim();

  try {
    const info = await getGitVersionInfo(dir, execFn);
    let branch = (opts?.branch || process.env.AUTO_UPDATE_BRANCH || info.branch).trim();
    if (!branch || branch === "HEAD" || branch === "unknown") {
      branch = "root-ecc-integrate";
    }

    let fetchRes = await execFn(`git fetch --prune ${remote} ${branch}`, dir, 60_000);
    let switchedBranch = false;

    if (fetchRes.exitCode !== 0 && /couldn't find remote ref/i.test(fetchRes.output)) {
      for (const fallback of ["root-ecc-integrate", "main"]) {
        if (fallback === branch) continue;
        const retry = await execFn(`git fetch --prune ${remote} ${fallback}`, dir, 60_000);
        if (retry.exitCode === 0) {
          branch = fallback;
          fetchRes = retry;
          switchedBranch = true;
          break;
        }
      }
    }

    if (fetchRes.exitCode !== 0) {
      return {
        status: "failed",
        branch,
        fromCommit: info.shortCommit,
        toCommit: info.shortCommit,
        error: `git fetch gagal: ${fetchRes.output.slice(0, 300)}`,
        restartRequired: false,
      };
    }

    const remoteRev = await execFn(`git rev-parse ${remote}/${branch}`, dir, 10_000);
    if (remoteRev.exitCode !== 0 || !remoteRev.output) {
      return {
        status: "failed",
        branch,
        fromCommit: info.shortCommit,
        toCommit: info.shortCommit,
        error: `Gagal membaca commit ${remote}/${branch}: ${remoteRev.output.slice(0, 200)}`,
        restartRequired: false,
      };
    }

    const remoteCommit = remoteRev.output.split("\n")[0]!.trim();
    const remoteShort = remoteCommit.slice(0, 7);

    if (info.commit === remoteCommit && !switchedBranch && !opts?.forceBuild) {
      return {
        status: "up_to_date",
        branch,
        fromCommit: info.shortCommit,
        toCommit: remoteShort,
        restartRequired: false,
      };
    }

    // Local bisa lebih maju dari remote (mis. commit lokal belum di-push).
    // `git pull --ff-only` menghasilkan "Already up to date" dan exit 0, yang
    // sebelumnya dilaporkan sebagai update sukses + memicu restart sia-sia.
    if (!switchedBranch && !opts?.forceBuild) {
      const anc = await execFn(
        `git merge-base --is-ancestor ${remoteCommit} ${info.commit}`,
        dir,
        10_000
      );
      if (anc.exitCode === 0) {
        return {
          status: "up_to_date",
          branch,
          fromCommit: info.shortCommit,
          toCommit: remoteShort,
          restartRequired: false,
        };
      }
    }

    const diffFilesRes = await execFn(
      `git diff --name-only ${info.commit}..${remoteCommit} 2>/dev/null || true`,
      dir,
      15_000
    );
    const changedFiles = diffFilesRes.output.split("\n").map((s) => s.trim());
    const depsChanged =
      switchedBranch ||
      changedFiles.includes("package.json") ||
      changedFiles.includes("package-lock.json");

    const logRes = await execFn(
      `git log --oneline -n 5 ${info.commit}..${remoteCommit} 2>/dev/null || git log --oneline -n 3 ${remoteCommit}`,
      dir,
      10_000
    );

    // Reset perubahan lokal pada dist/ bila ada agar git pull --ff-only tidak tertahan
    await execFn("git checkout -- dist/ 2>/dev/null || true", dir, 10_000);

    const pullCmd = switchedBranch
      ? `git checkout -f -B ${branch} --track ${remote}/${branch}`
      : `git pull --ff-only ${remote} ${branch} || git reset --hard ${remote}/${branch}`;
    const pullRes = await execFn(pullCmd, dir, 60_000);
    if (pullRes.exitCode !== 0) {
      return {
        status: "failed",
        branch,
        fromCommit: info.shortCommit,
        toCommit: remoteShort,
        error: `git pull gagal: ${pullRes.output.slice(0, 300)}`,
        restartRequired: false,
      };
    }

    if (depsChanged) {
      const ciRes = await execFn("npm ci --include=dev || npm install", dir, 300_000);
      if (ciRes.exitCode !== 0) {
        return {
          status: "failed",
          branch,
          fromCommit: info.shortCommit,
          toCommit: remoteShort,
          error: `npm install gagal: ${ciRes.output.slice(-400)}`,
          restartRequired: false,
        };
      }
    }

    const buildRes = await execFn("npm run build", dir, 120_000);
    if (buildRes.exitCode !== 0) {
      return {
        status: "failed",
        branch,
        fromCommit: info.shortCommit,
        toCommit: remoteShort,
        error: `npm run build gagal (proses lama tetap berjalan): ${buildRes.output.slice(-400)}`,
        restartRequired: false,
      };
    }

    return {
      status: "updated",
      branch,
      fromCommit: info.shortCommit,
      toCommit: remoteShort,
      changes: logRes.output || `${info.shortCommit} -> ${remoteShort}`,
      restartRequired: true,
    };
  } finally {
    updateInProgress = false;
  }
}

/**
 * Jadwalkan restart proses setelah update selesai:
 * - Bila dijalankan di bawah systemd / PM2, kirim SIGTERM agar supervisor menyalakan ulang proses.
 * - Bila dijalankan manual (tanpa supervisor), jalankan callback cleanup lalu spawn proses pengganti.
 */
export function scheduleSelfRestart(
  delayMs = 1500,
  onBeforeExit?: () => Promise<void> | void
): void {
  const timer = setTimeout(async () => {
    const isManagedSupervisor = Boolean(
      process.env.INVOCATION_ID ||
        process.env.NOTIFY_SOCKET ||
        process.env.pm_id !== undefined ||
        process.ppid === 1
    );

    if (isManagedSupervisor) {
      process.kill(process.pid, "SIGTERM");
      return;
    }

    try {
      await onBeforeExit?.();
    } catch {
      // abaikan
    }

    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    process.exit(0);
  }, delayMs);
  timer.unref?.();
}

export interface AutoUpdateMonitorOptions {
  label: string;
  intervalMs?: number;
  repoDir?: string;
  branch?: string;
  isBusy?: () => boolean;
  onUpdated?: (res: UpdateResult) => Promise<void> | void;
  onError?: (err: string) => void;
  execFn?: ExecStepFn;
  autoRestart?: boolean;
  onBeforeRestart?: () => Promise<void> | void;
}

export class AutoUpdateMonitor {
  private opts: AutoUpdateMonitorOptions;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(opts: AutoUpdateMonitorOptions) {
    this.opts = opts;
  }

  async tick(): Promise<UpdateResult | null> {
    if (this.checking) return null;
    if (this.opts.isBusy?.()) return null;

    this.checking = true;
    try {
      const res = await checkAndApplyUpdate({
        repoDir: this.opts.repoDir,
        branch: this.opts.branch,
        execFn: this.opts.execFn,
      });

      if (res.status === "updated") {
        console.log(
          `[updater:${this.opts.label}] Update berhasil (${res.fromCommit} -> ${res.toCommit} di branch ${res.branch}).`
        );
        await this.opts.onUpdated?.(res);
        if (this.opts.autoRestart !== false) {
          this.stop();
          scheduleSelfRestart(1500, this.opts.onBeforeRestart);
        }
      } else if (res.status === "failed" && res.error) {
        this.opts.onError?.(res.error);
      }
      return res;
    } catch (err: any) {
      this.opts.onError?.(err?.message ?? String(err));
      return null;
    } finally {
      this.checking = false;
    }
  }

  start(): void {
    this.stop();
    const interval = this.opts.intervalMs ?? 120_000;
    if (interval <= 0) return;
    console.log(
      `[updater:${this.opts.label}] Auto-update poller aktif (interval ${Math.round(interval / 1000)}s).`
    );
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import { createServer } from "net";
import * as path from "path";
import { sanitizeEnv } from "./executor";
import { provisionOpenCodeEcc } from "./ecc";

const READY_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

export interface OpenCodeServerOptions {
  bin?: string;
  port?: number;
  password?: string;
  dataDir?: string;
}

/** true jika node menggunakan engine opencode dan tidak memakai server eksternal (OPENCODE_URL kosong). */
export function isManagedOpenCode(engine: string, openCodeUrl?: string): boolean {
  return engine.toLowerCase() === "opencode" && (!openCodeUrl || openCodeUrl.trim() === "");
}

/** Lokasi binary: OPENCODE_BIN, lalu dependency @opencode/cli terpasang, lalu `opencode` di PATH. */
export function resolveOpenCodeBinary(customBin?: string): string {
  if (customBin && customBin.trim() !== "") return customBin.trim();
  try {
    const manifest = require.resolve("@opencode/cli/package.json");
    const binary = path.join(path.dirname(manifest), "bin", "opencode.exe");
    if (fs.existsSync(binary)) return binary;
  } catch {
    // dependency tidak ditemukan via require.resolve
  }
  return "opencode";
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const value = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(value));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipeOpenCodeLogs(stream: NodeJS.ReadableStream | null, label: string): void {
  if (stream === null) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text === "" || /password/i.test(text)) continue;
      console.log(`[opencode:${label}] ${text.slice(0, 300)}`);
    }
  });
}

export class ManagedOpenCodeServer {
  private opts: OpenCodeServerOptions;
  private child: ChildProcess | null = null;
  private stopping = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private port = 0;
  private password = "";
  private url = "";

  constructor(opts?: OpenCodeServerOptions) {
    this.opts = opts ?? {};
  }

  getUrl(): string {
    return this.url;
  }

  getPassword(): string {
    return this.password;
  }

  private launch(): ChildProcess {
    const dataDir = this.opts.dataDir || path.join(process.cwd(), ".opencode-data");
    const stateDir = path.join(dataDir, "state");
    const cacheDir = path.join(dataDir, "cache");
    const configDir = path.join(dataDir, "config");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    provisionOpenCodeEcc(configDir);

    const env: NodeJS.ProcessEnv = {
      ...sanitizeEnv(process.env),
      OPENCODE_SERVER_PASSWORD: this.password,
      XDG_DATA_HOME: dataDir,
      XDG_STATE_HOME: stateDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_CONFIG_HOME: configDir,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ECC_HOOK_PROFILE: process.env.ECC_HOOK_PROFILE || "standard",
      ECC_DISABLED_HOOKS: process.env.ECC_DISABLED_HOOKS || "",
    };

    const bin = resolveOpenCodeBinary(this.opts.bin);
    const proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(this.port)], {
      env,
      cwd: "/",
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    pipeOpenCodeLogs(proc.stdout, "out");
    pipeOpenCodeLogs(proc.stderr, "err");

    proc.on("exit", (code, signal) => {
      if (this.child === proc) this.child = null;
      if (this.stopping) return;
      this.restarts += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.restarts, 5));
      console.error(`[opencode] server berhenti (code=${code} signal=${signal}), restart ${delay}ms lagi`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.stopping) return;
        try {
          this.child = this.launch();
        } catch (err) {
          console.error("[opencode] restart gagal:", err);
        }
      }, delay);
      this.restartTimer.unref?.();
    });

    return proc;
  }

  private async waitReady(proc: ChildProcess): Promise<void> {
    const auth = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`server OpenCode berhenti saat start (code=${proc.exitCode})`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/api/info`, {
          headers: { authorization: auth },
          signal: AbortSignal.timeout(2000),
        });
        if (response.status === 200) return;
      } catch {
        // belum siap
      }
      await sleep(300);
    }
    throw new Error(`server OpenCode belum siap setelah ${READY_TIMEOUT_MS / 1000}s`);
  }

  async start(): Promise<{ url: string; password: string }> {
    if (this.child !== null) {
      return { url: this.url, password: this.password };
    }
    this.stopping = false;
    this.restarts = 0;

    this.port = this.opts.port && this.opts.port > 0 ? this.opts.port : await findFreePort();
    this.password =
      this.opts.password && this.opts.password !== ""
        ? this.opts.password
        : randomBytes(24).toString("hex");

    const proc = this.launch();
    this.child = proc;
    try {
      await this.waitReady(proc);
    } catch (err) {
      await this.stop();
      throw err;
    }

    this.url = `http://127.0.0.1:${this.port}`;
    console.log(
      `[opencode] server terkelola siap di 127.0.0.1:${this.port} (bin=${resolveOpenCodeBinary(this.opts.bin)})`
    );
    return { url: this.url, password: this.password };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const proc = this.child;
    this.child = null;
    if (proc === null || proc.pid === undefined || proc.exitCode !== null) return;

    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill("SIGTERM");
    }

    await Promise.race([exited, sleep(5000)]);
    if (proc.exitCode === null) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
  }
}

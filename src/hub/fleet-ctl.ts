#!/usr/bin/env node
import * as fs from "fs";
import * as https from "https";
import * as http from "http";

interface FleetNodeItem {
  nodeId: string;
  info: {
    hostname: string;
    platform: string;
    arch: string;
    cpus: number;
    memory?: { totalMb: number; freeMb: number };
    loadAvg?: number[];
    uptime?: number;
    distro?: { id: string; version: string; name?: string };
  };
}

function parseFlags(args: string[]): { positional: string[]; chatId?: number; userId?: number } {
  const positional: string[] = [];
  let chatId: number | undefined;
  let userId: number | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--chat" && args[i + 1]) {
      chatId = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (a === "--user" && args[i + 1]) {
      userId = Number(args[i + 1]);
      i += 1;
      continue;
    }
    positional.push(a);
  }
  return { positional, chatId, userId };
}

function requestLoopback(
  baseUrl: string,
  cookie: string,
  method: "GET" | "POST",
  pathName: string,
  body?: Record<string, unknown>
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(pathName, baseUrl);
    const isHttps = parsedUrl.protocol === "https:";
    const payload = body ? JSON.stringify(body) : undefined;

    const req = (isHttps ? https : http).request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        rejectUnauthorized: false,
        headers: {
          "x-aster-loopback": cookie,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: 120_000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 500, data: JSON.parse(raw || "{}") });
          } catch {
            resolve({ status: res.statusCode ?? 500, data: { raw } });
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Loopback request timeout"));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Cookie loopback dibaca dari file 0600 (ASTER_HUB_LOOPBACK_COOKIE_FILE) agar
 * tidak pernah masuk ke environment proses agen. Variabel lama tetap didukung
 * untuk kompatibilitas deployment.
 */
function resolveLoopbackCookie(): string {
  const cookieFile = process.env.ASTER_HUB_LOOPBACK_COOKIE_FILE;
  if (cookieFile) {
    try {
      const value = fs.readFileSync(cookieFile, "utf8").trim();
      if (value !== "") return value;
    } catch (err) {
      console.error(
        `ERROR: gagal membaca ASTER_HUB_LOOPBACK_COOKIE_FILE (${cookieFile}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return (process.env.ASTER_HUB_LOOPBACK_COOKIE || "").trim();
}

async function main() {
  const baseUrl = process.env.ASTER_HUB_LOOPBACK_URL || "http://127.0.0.1:8765";
  const cookie = resolveLoopbackCookie();

  if (!cookie) {
    console.error(
      "ERROR: cookie loopback tidak tersedia (ASTER_HUB_LOOPBACK_COOKIE_FILE / ASTER_HUB_LOOPBACK_COOKIE)."
    );
    process.exit(1);
  }

  const { positional, chatId, userId } = parseFlags(process.argv.slice(2));
  const action = (positional[0] || "nodes").toLowerCase();

  if (action === "nodes" || action === "list") {
    const res = await requestLoopback(baseUrl, cookie, "GET", "/internal/fleet/nodes");
    if (res.status !== 200) {
      console.error(`ERROR (${res.status}):`, res.data?.error || JSON.stringify(res.data));
      process.exit(1);
    }
    const nodes = (res.data?.nodes || []) as FleetNodeItem[];
    if (nodes.length === 0) {
      console.log("(Tidak ada node yang terhubung saat ini)");
      return;
    }
    for (const n of nodes) {
      const distro = n.info.distro
        ? `${n.info.distro.id} ${n.info.distro.version}`.trim()
        : `${n.info.platform}/${n.info.arch}`;
      const load = n.info.loadAvg?.[0]?.toFixed(2) ?? "0.00";
      const freeMb = n.info.memory?.freeMb ?? 0;
      const totalMb = n.info.memory?.totalMb ?? 0;
      const upH = Math.round((n.info.uptime ?? 0) / 3600);
      console.log(
        `${n.nodeId}\thost=${n.info.hostname}\tos=${distro}\tcpu=${n.info.cpus}c\tload=${load}\tram=${freeMb}/${totalMb}MB_free\tup=${upH}h`
      );
    }
    return;
  }

  if (action === "status") {
    const target = positional[1] || "all";
    const res = await requestLoopback(baseUrl, cookie, "POST", "/internal/fleet/exec", {
      nodeId: target,
      command: "__builtin:status",
      chatId,
      userId,
    });
    if (res.status !== 200) {
      console.error(`ERROR (${res.status}):`, res.data?.error || JSON.stringify(res.data));
      process.exit(1);
    }
    console.log(res.data?.output || "");
    return;
  }

  if (action === "broadcast") {
    const command = positional.slice(1).join(" ").trim();
    if (!command) {
      console.error("Usage: fleet-ctl.js broadcast \"<command>\"");
      process.exit(1);
    }
    const res = await requestLoopback(baseUrl, cookie, "POST", "/internal/fleet/exec", {
      nodeId: "all",
      command,
      chatId,
      userId,
    });
    if (res.status !== 200) {
      console.error(`ERROR (${res.status}):`, res.data?.error || JSON.stringify(res.data));
      process.exit(1);
    }
    console.log(res.data?.output || "");
    return;
  }

  if (action === "exec" || action === "run") {
    const target = positional[1] || "";
    const command = positional.slice(2).join(" ").trim();
    if (!target || !command) {
      console.error("Usage: fleet-ctl.js exec <nodeId|all> \"<command>\"");
      process.exit(1);
    }
    const res = await requestLoopback(baseUrl, cookie, "POST", "/internal/fleet/exec", {
      nodeId: target,
      command,
      chatId,
      userId,
    });
    if (res.status !== 200) {
      console.error(`ERROR (${res.status}):`, res.data?.error || JSON.stringify(res.data));
      process.exit(1);
    }
    console.log(res.data?.output || "");
    return;
  }

  console.error(`Unknown action: ${action}. Gunakan: nodes | status | exec | broadcast`);
  process.exit(1);
}

main().catch((err) => {
  console.error("FATAL fleet-ctl:", err?.message ?? err);
  process.exit(1);
});

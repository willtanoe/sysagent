import { NodeExecutor } from "./executor";
import { distro } from "./distro";

const UNIT_RE = /^[A-Za-z0-9@_.:-]+\.service$/;
const RULE = "─".repeat(34);

interface ServiceState {
  name: string;
  state: "up" | "down" | "fail";
}

function humanBytes(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)}${units[index]}`;
}

export function shortUptime(raw: string): string {
  const value = (pattern: RegExp): string => pattern.exec(raw)?.[1] ?? "0";
  const weeks = value(/(\d+)\s+week/);
  const days = value(/(\d+)\s+day/);
  const hours = value(/(\d+)\s+hour/);
  const minutes = value(/(\d+)\s+minute/);

  if (weeks !== "0") return `${weeks}w${days}d${hours}h`;
  if (days !== "0") return `${days}d${hours}h`;
  if (hours !== "0") return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

export function bar(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function firstLine(output: string): string {
  return output.split("\n")[0]?.trim() ?? "";
}

function num(output: string): number {
  const parsed = Number(firstLine(output));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function serviceLine(service: ServiceState): string {
  const icon = service.state === "up" ? "●" : service.state === "fail" ? "✕" : "○";
  const label = service.state === "up" ? "up" : service.state === "fail" ? "FAILED" : "down";
  return `  ${shorten(service.name, 18).padEnd(18)} ${icon} ${label}`;
}

async function resolveStatusUnits(executor: NodeExecutor, configuredUnits?: string[]): Promise<string[]> {
  if (configuredUnits && configuredUnits.length > 0) {
    return configuredUnits
      .map((u) => (u.endsWith(".service") ? u : `${u}.service`))
      .filter((u) => UNIT_RE.test(u));
  }

  const listed = await executor.execRaw(
    "find /etc/systemd/system -maxdepth 1 -name '*.service' -printf '%f\\n' 2>/dev/null | sort",
    5_000
  );
  return listed.output
    .split("\n")
    .map((line) => line.trim())
    .filter((unit) => UNIT_RE.test(unit) && !unit.startsWith("dbus-org."))
    .slice(0, 8);
}

async function collectServices(executor: NodeExecutor, configuredUnits?: string[]): Promise<ServiceState[]> {
  const units = await resolveStatusUnits(executor, configuredUnits);
  if (units.length === 0) return [];

  const command = units
    .map((unit) => `printf '%s=%s\\n' '${unit}' "$(systemctl is-active '${unit}' 2>/dev/null)"`)
    .join("; ");

  const result = await executor.execRaw(command, 8_000);
  return result.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("="))
    .map((line) => {
      const [unitRaw, stateRaw] = line.split("=");
      const state = stateRaw === "active" ? "up" : stateRaw === "failed" ? "fail" : "down";
      return {
        name: (unitRaw ?? "").replace(/\.service$/, ""),
        state: state as ServiceState["state"],
      };
    });
}

async function collectPm2(executor: NodeExecutor): Promise<ServiceState[]> {
  const result = await executor.execRaw(
    "command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null || true",
    6_000
  );
  const raw = result.output.trim();
  if (raw === "" || raw === "(tidak ada output)" || !raw.startsWith("[")) return [];

  try {
    const apps = JSON.parse(raw) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    return apps
      .filter((app) => (app.name ?? "") !== "")
      .map((app) => {
        const status = app.pm2_env?.status ?? "";
        return {
          name: app.name ?? "?",
          state: (status === "online" ? "up" : status === "errored" ? "fail" : "down") as ServiceState["state"],
        };
      });
  } catch {
    return [];
  }
}

/** Bangun dashboard monospace gaya netdata untuk node ini. */
export async function buildNodeStatusText(
  executor: NodeExecutor,
  configuredUnits?: string[]
): Promise<string> {
  const [
    hostOut,
    kernelOut,
    upOut,
    loadOut,
    coresOut,
    memOut,
    diskOut,
    failedOut,
    topOut,
    portsOut,
    procOut,
    netOut,
    services,
    pm2,
  ] = await Promise.all([
    executor.execRaw("hostname", 5_000),
    executor.execRaw("uname -r", 5_000),
    executor.execRaw("uptime -p", 5_000),
    executor.execRaw("cat /proc/loadavg", 5_000),
    executor.execRaw("nproc", 5_000),
    executor.execRaw("free -b | awk '/Mem:/{print $2, $3}'", 5_000),
    executor.execRaw("df -PB1 / | awk 'NR==2{print $2, $3, $5}'", 5_000),
    executor.execRaw("systemctl --failed --no-legend --no-pager 2>/dev/null | awk '{print $1}'", 5_000),
    executor.execRaw(
      "ps -eo pcpu=,comm= --sort=-pcpu | awk '$2 !~ /^(ps|ss|awk|sed|bash|sh|cat|wc|head|tail|sort|nproc|df|free|uname|hostname|uptime|systemctl|command)$/ {print; n++; if (n==2) exit}'",
      5_000
    ),
    executor.execRaw("ss -ltn 2>/dev/null | tail -n +2 | wc -l", 5_000),
    executor.execRaw("ps -e --no-headers | wc -l", 5_000),
    executor.execRaw(
      "awk 'NR>2 {gsub(/:/,\"\",$1); if ($1 != \"lo\") {rx+=$2; tx+=$10}} END {print rx+0, tx+0}' /proc/net/dev",
      5_000
    ),
    collectServices(executor, configuredUnits),
    collectPm2(executor),
  ]);

  const load = loadOut.output
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map((v) => Number(v).toFixed(2))
    .join(" ");
  const coreCount = num(coresOut.output);

  const [memTotal, memUsed] = memOut.output.trim().split(/\s+/).map(Number);
  const memPct = memTotal && memUsed ? Math.round((memUsed / memTotal) * 100) : 0;

  const [diskSizeRaw, diskUsedRaw, diskPctRaw] = diskOut.output.trim().split(/\s+/);
  const diskSize = Number(diskSizeRaw) || 0;
  const diskUsed = Number(diskUsedRaw) || 0;
  const diskPct = Number((diskPctRaw ?? "0").replace("%", "")) || 0;

  const [rxRaw, txRaw] = netOut.output.trim().split(/\s+/);
  const rx = Number(rxRaw) || 0;
  const tx = Number(txRaw) || 0;

  const failedUnits = failedOut.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "(tidak ada output)")
    .filter((unit) => UNIT_RE.test(unit));

  const top = topOut.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "(tidak ada output)")
    .map((line) => {
      const [cpu, ...name] = line.split(/\s+/);
      return { name: name.join(" ") || "?", cpu: Math.round(Number(cpu) || 0) };
    });

  const lines: string[] = [];
  const distroLabel = `${distro.id.charAt(0).toUpperCase()}${distro.id.slice(1)} ${distro.version}`.trim();
  lines.push(`${shorten(firstLine(hostOut.output), 14)} · ${shorten(distroLabel, 18)}`);
  lines.push(`${shorten(firstLine(kernelOut.output), 22)} · ${coreCount}c`);
  lines.push(RULE);
  lines.push(`up    ${shortUptime(firstLine(upOut.output))}`);
  lines.push(`load  ${load}`);
  lines.push(`mem   ${bar(memPct)} ${String(memPct).padStart(3)}%  ${humanBytes(memUsed || 0)}/${humanBytes(memTotal || 0)}`);
  lines.push(`disk  ${bar(diskPct)} ${String(diskPct).padStart(3)}%  ${humanBytes(diskUsed)}/${humanBytes(diskSize)}`);
  lines.push(`net   rx ${humanBytes(rx)} tx ${humanBytes(tx)}`);
  lines.push(`proc  ${num(procOut.output)} · port ${num(portsOut.output)}`);
  lines.push(RULE);

  lines.push("services");
  if (failedUnits.length > 0) {
    const listed = new Set(services.map((s) => s.name));
    for (const unit of failedUnits.slice(0, 3)) {
      const name = unit.replace(/\.service$/, "");
      if (!listed.has(name)) lines.push(serviceLine({ name, state: "fail" }));
    }
  }
  if (services.length > 0) {
    for (const service of services) lines.push(serviceLine(service));
  } else if (failedUnits.length === 0) {
    lines.push("  (tidak ada unit terdaftar)");
  }

  if (pm2.length > 0) {
    lines.push("pm2");
    for (const app of pm2) lines.push(serviceLine(app));
  }

  if (top.length > 0) {
    lines.push(RULE);
    lines.push(`top   ${top.map((item) => `${shorten(item.name, 12)} ${item.cpu}%`).join(" · ")}`);
  }

  return lines.join("\n");
}

import { NodeExecutor } from "./executor";
import { distro } from "./distro";

const UNIT_RE = /^[A-Za-z0-9@_.:-]+\.service$/;
const RULE = "─".repeat(53);

interface ServiceState {
  name: string;
  state: "up" | "down" | "fail";
  memoryBytes?: number;
  fragmentPath?: string;
}

type ServiceCategory =
  | "App & Web"
  | "Database & Cache"
  | "Container & VM"
  | "Network & Security"
  | "Monitoring & Log"
  | "System & Core";

const CATEGORY_ORDER: ServiceCategory[] = [
  "App & Web",
  "Database & Cache",
  "Container & VM",
  "Network & Security",
  "Monitoring & Log",
  "System & Core",
];

function classifyServiceCategory(service: ServiceState): ServiceCategory {
  const n = service.name.toLowerCase();

  if (
    /^(redis|valkey|mysql|mariadb|postgres|postgresql|mongod|mongodb|memcached|elasticsearch|opensearch|clickhouse|rabbitmq|kafka|etcd|influxdb|cockroach|couchdb|neo4j|meilisearch|typesense|qdrant|milvus)\b/.test(
      n
    )
  ) {
    return "Database & Cache";
  }

  if (
    /^(docker|containerd|k3s|kubelet|crio|cri-o|podman|libvirtd|qemu|vmtoolsd|open-vm-tools|vbox|lxc|lxd|incus|nomad)\b/.test(
      n
    )
  ) {
    return "Container & VM";
  }

  if (
    /^(ssh|sshd|warp-svc|wg-quick|wireguard|openvpn|tailscaled|cloudflared|zerotier|networkmanager|modemmanager|systemd-networkd|systemd-resolved|wpa_supplicant|ufw|firewalld|nftables|iptables|fail2ban|crowdsec|named|bind9|unbound|dnsmasq|pihole|frr|bird|strongswan|ipsec|keepalived)\b/.test(
      n
    )
  ) {
    return "Network & Security";
  }

  if (
    /^(netdata|prometheus|node_exporter|alertmanager|grafana|victoriametrics|zabbix|datadog|telegraf|vector|fluent|logstash|filebeat|rsyslog|syslog|systemd-journald|auditd|acct|sysstat|loki|promtail|uptime-kuma)\b/.test(
      n
    )
  ) {
    return "Monitoring & Log";
  }

  if (
    /^(nginx|apache2|httpd|caddy|traefik|haproxy|envoy|lighttpd|php[0-9.-]*|node|pm2|aster|dashy|opencode|gunicorn|uvicorn|celery|puma|sidekiq|passenger|tomcat|jetty|jenkins|gitlab|gitea|forgejo|nextcloud|ghost|wordpress|minio|keycloak|vault|consul)(\b|-|_|\.)/.test(
      n
    )
  ) {
    return "App & Web";
  }

  if (
    /^(cron|crond|atd|dbus|polkit|systemd-|udev|udisks|multipathd|fwupd|snapd|snap\.|unattended-upgrades|packagekit|getty|serial-getty|container-getty|user@|user-runtime-dir|accounts-daemon|upower|thermald|irqbalance|acpid|chrony|ntp|ntpd|timesyncd|logind|avahi|cups|bluetooth|colord|switcheroo|power-profiles|apport|plymouth|apparmor|selinux|lvm2|mdmonitor|smartd|rngd|haveged|gpm)\b/.test(
      n
    )
  ) {
    return "System & Core";
  }

  if (service.fragmentPath && service.fragmentPath.startsWith("/etc/systemd/system/")) {
    return "App & Web";
  }

  return "System & Core";
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

function formatServiceCell(service: ServiceState): string {
  const icon = service.state === "up" ? "●" : service.state === "fail" ? "✕" : "○";
  let memStr = "    -";
  if (service.memoryBytes !== undefined && service.memoryBytes > 0) {
    memStr = humanBytes(service.memoryBytes).padStart(5);
  } else if (service.state === "fail") {
    memStr = " FAIL";
  } else if (service.state === "down") {
    memStr = " down";
  }
  return `${icon} ${shorten(service.name, 16).padEnd(16)} ${memStr}`;
}

function renderTwoColumnServices(group: ServiceState[]): string[] {
  const byAlpha = [...group].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const byRam = [...group].sort((a, b) => {
    const memDiff = (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1);
    if (memDiff !== 0) return memDiff;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const rows: string[] = [];
  for (let i = 0; i < byAlpha.length; i += 1) {
    rows.push(`  ${formatServiceCell(byAlpha[i])} │ ${formatServiceCell(byRam[i])}`);
  }
  return rows;
}

async function resolveStatusUnits(executor: NodeExecutor, configuredUnits?: string[]): Promise<string[]> {
  const configured = (configuredUnits ?? [])
    .map((u) => (u.endsWith(".service") ? u : `${u}.service`))
    .filter((u) => UNIT_RE.test(u));

  const listed = await executor.execRaw(
    "systemctl list-units --type=service --state=running,failed --no-pager --no-legend 2>/dev/null | awk '{if ($1 ~ /^[●*]/) print $2; else print $1}'",
    6_000
  );
  const activeOrFailed = listed.output
    .split("\n")
    .map((line) => line.trim())
    .filter((unit) => UNIT_RE.test(unit) && !unit.startsWith("dbus-org."));

  return [...new Set([...configured, ...activeOrFailed])];
}

async function collectServices(executor: NodeExecutor, configuredUnits?: string[]): Promise<ServiceState[]> {
  const units = await resolveStatusUnits(executor, configuredUnits);
  if (units.length === 0) return [];

  const quotedUnits = units.map((u) => `'${u.replace(/'/g, "")}'`).join(" ");
  const command = `systemctl show --property=Id,ActiveState,SubState,MemoryCurrent,FragmentPath ${quotedUnits} 2>/dev/null`;

  const result = await executor.execRaw(command, 10_000);
  const blocks = result.output.trim().split(/\n\s*\n/);
  const states: ServiceState[] = [];

  for (const block of blocks) {
    const props: Record<string, string> = {};
    for (const rawLine of block.split("\n")) {
      const idx = rawLine.indexOf("=");
      if (idx <= 0) continue;
      props[rawLine.slice(0, idx).trim()] = rawLine.slice(idx + 1).trim();
    }
    const id = props.Id ?? "";
    if (!id) continue;
    const activeState = props.ActiveState ?? "";
    const state: ServiceState["state"] =
      activeState === "active" ? "up" : activeState === "failed" ? "fail" : "down";
    const memRaw = Number(props.MemoryCurrent);
    const memoryBytes =
      Number.isFinite(memRaw) && memRaw > 0 && memRaw < 1e15 ? memRaw : undefined;

    states.push({
      name: id.replace(/\.service$/, ""),
      state,
      memoryBytes,
      fragmentPath: props.FragmentPath,
    });
  }

  return states.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

async function collectPm2(executor: NodeExecutor): Promise<ServiceState[]> {
  const result = await executor.execRaw(
    "command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null || true",
    6_000
  );
  const raw = result.output.trim();
  if (raw === "" || raw === "(tidak ada output)" || !raw.startsWith("[")) return [];

  try {
    const apps = JSON.parse(raw) as Array<{
      name?: string;
      pm2_env?: { status?: string };
      monit?: { memory?: number; cpu?: number };
    }>;
    return apps
      .filter((app) => (app.name ?? "") !== "")
      .map((app) => {
        const status = app.pm2_env?.status ?? "";
        const memRaw = Number(app.monit?.memory);
        return {
          name: app.name ?? "?",
          state: (status === "online" ? "up" : status === "errored" ? "fail" : "down") as ServiceState["state"],
          memoryBytes: Number.isFinite(memRaw) && memRaw > 0 ? memRaw : undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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
    topMemOut,
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
    executor.execRaw(
      "free -b | awk '/^Mem:/{print $2, $3, $4, $5, $6, $7} /^Swap:/{print $2, $3, $4}'",
      5_000
    ),
    executor.execRaw("df -PB1 / | awk 'NR==2{print $2, $3, $5}'", 5_000),
    executor.execRaw(
      "systemctl --failed --no-legend --no-pager 2>/dev/null | awk '{if ($1 ~ /^[●*]/) print $2; else print $1}'",
      5_000
    ),
    executor.execRaw(
      "ps -eo pcpu=,comm= --sort=-pcpu | awk '$2 !~ /^(ps|ss|awk|sed|bash|sh|cat|wc|head|tail|sort|nproc|df|free|uname|hostname|uptime|systemctl|command)$/ {print; n++; if (n==3) exit}'",
      5_000
    ),
    executor.execRaw(
      "ps -eo rss=,comm= --sort=-rss | awk '$2 !~ /^(ps|ss|awk|sed|bash|sh|cat|wc|head|tail|sort|nproc|df|free|uname|hostname|uptime|systemctl|command)$/ {print; n++; if (n==5) exit}'",
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

  const memLines = memOut.output.trim().split("\n");
  const [memTotal = 0, memUsed = 0, memFree = 0, memShared = 0, memBuffCache = 0, memAvail = 0] = (
    memLines[0] ?? ""
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  const [swapTotal = 0, swapUsed = 0, swapFree = 0] = (memLines[1] ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  const memPct = memTotal && memUsed ? Math.round((memUsed / memTotal) * 100) : 0;
  const swapPct = swapTotal && swapUsed ? Math.round((swapUsed / swapTotal) * 100) : 0;

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

  const topMem = topMemOut.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "(tidak ada output)")
    .map((line) => {
      const [rssKb, ...name] = line.split(/\s+/);
      return { name: name.join(" ") || "?", bytes: (Number(rssKb) || 0) * 1024 };
    })
    .filter((item) => item.bytes > 0);

  const lines: string[] = [];
  const distroLabel = `${distro.id.charAt(0).toUpperCase()}${distro.id.slice(1)} ${distro.version}`.trim();
  lines.push(`${shorten(firstLine(hostOut.output), 14)} · ${shorten(distroLabel, 18)}`);
  lines.push(`${shorten(firstLine(kernelOut.output), 22)} · ${coreCount}c`);
  lines.push(RULE);
  lines.push(`up    ${shortUptime(firstLine(upOut.output))}`);
  lines.push(`load  ${load}`);
  lines.push(`mem   ${bar(memPct)} ${String(memPct).padStart(3)}%  ${humanBytes(memUsed || 0)}/${humanBytes(memTotal || 0)}`);
  lines.push(
    `      used ${humanBytes(memUsed || 0)} · free ${humanBytes(memFree || 0)} · avail ${humanBytes(memAvail || 0)}`
  );
  lines.push(`      buff/cache ${humanBytes(memBuffCache || 0)} · shared ${humanBytes(memShared || 0)}`);
  if (swapTotal > 0) {
    lines.push(
      `swap  ${bar(swapPct)} ${String(swapPct).padStart(3)}%  ${humanBytes(swapUsed)}/${humanBytes(swapTotal)} (free ${humanBytes(swapFree)})`
    );
  } else {
    lines.push(`swap  0B/0B (off)`);
  }
  lines.push(`disk  ${bar(diskPct)} ${String(diskPct).padStart(3)}%  ${humanBytes(diskUsed)}/${humanBytes(diskSize)}`);
  lines.push(`net   rx ${humanBytes(rx)} tx ${humanBytes(tx)}`);
  lines.push(`proc  ${num(procOut.output)} · port ${num(portsOut.output)}`);
  lines.push(RULE);

  const activeCount = services.filter((s) => s.state === "up").length;
  lines.push(`services (${activeCount} active)`);
  const listed = new Set(services.map((s) => s.name));
  const extraFailed: ServiceState[] = [];
  for (const unit of failedUnits) {
    const name = unit.replace(/\.service$/, "");
    if (!listed.has(name)) extraFailed.push({ name, state: "fail" });
  }
  const allServices = [...services, ...extraFailed].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  if (allServices.length > 0) {
    lines.push(`  ${"Urut A-Z".padEnd(24)} │ ${"Urut Top RAM".padEnd(24)}`);
    lines.push(`  ${"─".repeat(24)}─┼─${"─".repeat(24)}`);

    const byCategory = new Map<ServiceCategory, ServiceState[]>();
    for (const svc of allServices) {
      const cat = classifyServiceCategory(svc);
      const list = byCategory.get(cat) ?? [];
      list.push(svc);
      byCategory.set(cat, list);
    }

    for (const cat of CATEGORY_ORDER) {
      const group = byCategory.get(cat);
      if (!group || group.length === 0) continue;
      const catMem = group.reduce((sum, s) => sum + (s.memoryBytes ?? 0), 0);
      const catHeader = `[${cat}]`.padEnd(24);
      const catMemStr = catMem > 0 ? `total ${humanBytes(catMem)}`.padStart(24) : "".padStart(24);
      lines.push(`  ${catHeader} │ ${catMemStr}`);
      lines.push(...renderTwoColumnServices(group));
    }
  } else {
    lines.push("  (tidak ada service aktif)");
  }

  if (pm2.length > 0) {
    const pm2UpCount = pm2.filter((a) => a.state === "up").length;
    lines.push(`pm2 (${pm2UpCount}/${pm2.length} online)`);
    lines.push(...renderTwoColumnServices(pm2));
  }

  if (top.length > 0 || topMem.length > 0) {
    lines.push(RULE);
    if (top.length > 0) {
      lines.push(`top cpu  ${top.map((item) => `${shorten(item.name, 10)} ${item.cpu}%`).join(" · ")}`);
    }
    if (topMem.length > 0) {
      lines.push(`top mem  ${topMem.map((item) => `${shorten(item.name, 10)} ${humanBytes(item.bytes)}`).join(" · ")}`);
    }
  }

  return lines.join("\n");
}

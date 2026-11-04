import { Bot, Context, InlineKeyboard } from "grammy";
import { BroadcastNodeProgress, ConnectedNode, HubServer, NodeBroadcastResult } from "./server";
import { HubStore } from "./store";
import { chunkHtml, escapeHtml, escapeRegExp, preBlock, renderMarkdown } from "../shared/format";
import { checkAndApplyUpdate, getGitVersionInfo, scheduleSelfRestart } from "../shared/updater";

const SYNTAX_UNIT = /^[A-Za-z0-9@_.:-]+$/;

function stripNodePrefix(nodeId: string, text: string): string {
  const escaped = escapeRegExp(nodeId);
  return text
    .replace(new RegExp(`^\\s*\\[${escaped}\\]\\s*\\n?`), "")
    .replace(new RegExp(`^\\s*🖥️\\s*\\*\\*\\[${escaped}\\]\\*\\*\\s*\\n?`), "")
    .trim();
}

function parseHumanBytes(str: string): number {
  const m = /^(\d+(?:\.\d+)?)([BKMGT])$/i.exec(str.trim());
  if (!m) return 0;
  const val = Number(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };
  return val * (mult[unit] ?? 1);
}

interface ParsedNodeStatus {
  uptime?: string;
  load?: string;
  memPct?: string;
  memUsedTotal?: string;
  memFree?: string;
  memAvail?: string;
  memCache?: string;
  memShared?: string;
  swap?: string;
  diskPct?: string;
  diskUsedTotal?: string;
  netRx?: string;
  netTx?: string;
  proc?: string;
  port?: string;
  activeServices?: number;
  failedServices: string[];
  categoryCounts: Record<string, number>;
  topServicesRam: Array<{ name: string; mem: string; bytes: number }>;
  pm2Online?: string;
  topCpu?: string;
  topMem?: string;
}

const SHORT_CATEGORY_LABEL: Record<string, string> = {
  "App & Web": "App",
  "Database & Cache": "DB",
  "Container & VM": "VM",
  "Network & Security": "Net",
  "Monitoring & Log": "Mon",
  "System & Core": "Sys",
};

function parseNodeStatusText(rawText: string): ParsedNodeStatus {
  const cleaned = rawText
    .replace(/^```[A-Za-z0-9_+-]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  const parsed: ParsedNodeStatus = {
    failedServices: [],
    categoryCounts: {},
    topServicesRam: [],
  };

  let inServices = false;
  let inPm2 = false;
  let currentCat = "";
  const seenServices = new Set<string>();

  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    let m: RegExpExecArray | null;

    if ((m = /^up\s+(.+)$/.exec(trimmed))) {
      parsed.uptime = m[1].trim();
      continue;
    }
    if ((m = /^load\s+(.+)$/.exec(trimmed))) {
      parsed.load = m[1].trim().split(/\s+/).join(" / ");
      continue;
    }
    if ((m = /^mem\s+\[[^\]]+\]\s*(\d+%)\s+(\S+)/.exec(trimmed))) {
      parsed.memPct = m[1];
      parsed.memUsedTotal = m[2];
      continue;
    }
    if ((m = /^used\s+(\S+)\s*·\s*free\s+(\S+)\s*·\s*avail\s+(\S+)/.exec(trimmed))) {
      parsed.memFree = m[2];
      parsed.memAvail = m[3];
      continue;
    }
    if ((m = /^buff\/cache\s+(\S+)\s*·\s*shared\s+(\S+)/.exec(trimmed))) {
      parsed.memCache = m[1];
      parsed.memShared = m[2];
      continue;
    }
    if ((m = /^swap\s+(.+)$/.exec(trimmed))) {
      const rest = m[1].trim();
      if (rest.includes("(off)")) {
        parsed.swap = "off";
      } else {
        const sm = /\[[^\]]+\]\s*(\d+%)\s+(\S+)/.exec(rest);
        parsed.swap = sm ? `${sm[2]} (${sm[1]})` : rest;
      }
      continue;
    }
    if ((m = /^disk\s+\[[^\]]+\]\s*(\d+%)\s+(\S+)/.exec(trimmed))) {
      parsed.diskPct = m[1];
      parsed.diskUsedTotal = m[2];
      continue;
    }
    if ((m = /^net\s+rx\s+(\S+)\s+tx\s+(\S+)/.exec(trimmed))) {
      parsed.netRx = m[1];
      parsed.netTx = m[2];
      continue;
    }
    if ((m = /^proc\s+(\d+)\s*·\s*port\s+(\d+)/.exec(trimmed))) {
      parsed.proc = m[1];
      parsed.port = m[2];
      continue;
    }
    if ((m = /^services\s*\((\d+)\s+active\)/.exec(trimmed))) {
      parsed.activeServices = Number(m[1]);
      inServices = true;
      inPm2 = false;
      continue;
    }
    if ((m = /^pm2\s*\(([^)]+)\)/.exec(trimmed))) {
      parsed.pm2Online = m[1].replace(/\s+online$/, "").trim();
      inServices = false;
      inPm2 = true;
      continue;
    }
    if ((m = /^top cpu\s+(.+)$/.exec(trimmed))) {
      parsed.topCpu = m[1].trim();
      inServices = false;
      inPm2 = false;
      continue;
    }
    if ((m = /^top mem\s+(.+)$/.exec(trimmed))) {
      parsed.topMem = m[1].trim();
      inServices = false;
      inPm2 = false;
      continue;
    }

    if (inServices && !inPm2) {
      if ((m = /^\[([^\]]+)\]/.exec(trimmed))) {
        currentCat = SHORT_CATEGORY_LABEL[m[1]] || m[1];
        continue;
      }

      // Format 2 kolom: "● nginx              46M │ ..."
      const col2 = /^([●✕○])\s+(\S+)\s+(\S+)\s*│/.exec(trimmed);
      if (col2) {
        const [, icon, svcName, memOrState] = col2;
        if (currentCat) {
          parsed.categoryCounts[currentCat] = (parsed.categoryCounts[currentCat] ?? 0) + 1;
        }
        if (icon === "✕" || memOrState === "FAIL") {
          parsed.failedServices.push(svcName);
        }
        const bytes = parseHumanBytes(memOrState);
        if (bytes > 0 && !seenServices.has(svcName)) {
          seenServices.add(svcName);
          parsed.topServicesRam.push({ name: svcName, mem: memOrState, bytes });
        }
        continue;
      }

      // Format 1 kolom (kompatibilitas node lama): "nginx              ● up      46M"
      const col1 = /^(\S+)\s+([●✕○])\s+(up|FAIL|down)\s+(\S+)$/.exec(trimmed);
      if (col1) {
        const [, svcName, icon, state, memStr] = col1;
        if (currentCat) {
          parsed.categoryCounts[currentCat] = (parsed.categoryCounts[currentCat] ?? 0) + 1;
        }
        if (icon === "✕" || state === "FAIL") {
          parsed.failedServices.push(svcName);
        }
        const bytes = parseHumanBytes(memStr);
        if (bytes > 0 && !seenServices.has(svcName)) {
          seenServices.add(svcName);
          parsed.topServicesRam.push({ name: svcName, mem: memStr, bytes });
        }
      }
    }
  }

  parsed.topServicesRam.sort((a, b) => b.bytes - a.bytes);
  return parsed;
}

export function formatFleetSummaryReport(
  nodes: ConnectedNode[],
  results: NodeBroadcastResult[],
  activeNodeId?: string
): string {
  const sortedNodes = [...nodes].sort((a, b) =>
    a.nodeId.localeCompare(b.nodeId, undefined, { sensitivity: "base" })
  );
  const resultMap = new Map(results.map((r) => [r.nodeId, r]));

  let totalCores = 0;
  let totalRamMb = 0;
  let usedRamMb = 0;
  let healthyCount = 0;

  const nodeBlocks: string[] = [];

  for (const n of sortedNodes) {
    const res = resultMap.get(n.nodeId);
    const cores = n.info.cpus ?? 0;
    const totMb = n.info.memory?.totalMb ?? 0;
    const freeMb = n.info.memory?.freeMb ?? 0;
    const uMb = Math.max(0, totMb - freeMb);
    const memPctNum = totMb > 0 ? Math.round((uMb / totMb) * 100) : 0;
    const load1 = n.info.loadAvg?.[0] ?? 0;

    totalCores += cores;
    totalRamMb += totMb;
    usedRamMb += uMb;

    const distroLabel = n.info.distro
      ? `${n.info.distro.id.charAt(0).toUpperCase()}${n.info.distro.id.slice(1)} ${n.info.distro.version}`.trim()
      : `${n.info.platform}/${n.info.arch}`;
    const activeStar = n.nodeId === activeNodeId ? " ⭐" : "";

    if (!res || res.status !== "ok") {
      const errText = res?.error || "Data status live belum tersedia";
      nodeBlocks.push(
        [
          `🔴 **${n.nodeId}**${activeStar} · \`${n.info.hostname}\` · \`${distroLabel}\` · \`${cores}c\``,
          `└─ ❌ **Gagal mengambil status:** \`${errText}\``,
        ].join("\n")
      );
      continue;
    }

    const p = parseNodeStatusText(stripNodePrefix(n.nodeId, res.fullText));
    const failCount = p.failedServices.length;
    const isWarn = memPctNum >= 90 || (cores > 0 && load1 > cores * 1.5) || failCount > 0;
    if (!isWarn) healthyCount += 1;

    const statusDot = failCount > 0 ? "🔴" : isWarn ? "🟡" : "🟢";
    const upStr = p.uptime || `${Math.round((n.info.uptime ?? 0) / 3600)}h`;
    const loadStr =
      p.load ||
      (n.info.loadAvg ? n.info.loadAvg.slice(0, 3).map((v) => v.toFixed(2)).join(" / ") : "0.00");

    const ramMain =
      p.memPct && p.memUsedTotal
        ? `\`${p.memPct}\` (\`${p.memUsedTotal}\`)`
        : `\`${memPctNum}%\` (\`${(uMb / 1024).toFixed(1)}G/${(totMb / 1024).toFixed(1)}G\`)`;
    const ramExtras: string[] = [];
    if (p.memAvail) ramExtras.push(`Avail \`${p.memAvail}\``);
    if (p.memCache) ramExtras.push(`Cache \`${p.memCache}\``);
    if (p.swap) ramExtras.push(`Swap \`${p.swap}\``);

    const diskPart =
      p.diskPct && p.diskUsedTotal ? `\`${p.diskPct}\` (\`${p.diskUsedTotal}\`)` : "`-`";
    const netPart = p.netRx && p.netTx ? `\`↓${p.netRx} ↑${p.netTx}\`` : "`-`";

    const catOrder = ["App", "DB", "VM", "Net", "Mon", "Sys"];
    const catSummary = catOrder
      .filter((k) => (p.categoryCounts[k] ?? 0) > 0)
      .map((k) => `${k} ${p.categoryCounts[k]}`)
      .join(" · ");
    const svcStatusPart =
      failCount > 0
        ? `\`${p.activeServices ?? 0} up\` · ⚠️ **${failCount} FAIL:** \`${p.failedServices.join(", ")}\``
        : `\`${p.activeServices ?? 0} up\` · \`0 fail\``;
    const pm2Part = p.pm2Online ? ` · PM2 \`${p.pm2Online}\`` : "";

    const topSvcRamStr =
      p.topServicesRam.length > 0
        ? p.topServicesRam
            .slice(0, 5)
            .map((s) => `\`${s.name} ${s.mem}\``)
            .join(" · ")
        : "";

    const topProcParts: string[] = [];
    if (p.topCpu) {
      topProcParts.push(
        `CPU \`${p.topCpu.split(" · ").slice(0, 2).join(", ")}\``
      );
    }
    if (p.topMem) {
      topProcParts.push(
        `RAM \`${p.topMem.split(" · ").slice(0, 2).join(", ")}\``
      );
    }

    const cardLines: string[] = [
      `${statusDot} **${n.nodeId}**${activeStar} · \`${n.info.hostname}\` · \`${distroLabel}\` · \`${cores}c\` · ⏱ \`${upStr}\``,
      `├─ **CPU/Load:** \`${loadStr}\`${p.proc ? ` · **Proc:** \`${p.proc}\`` : ""}${p.port ? ` · **Port:** \`${p.port}\`` : ""}`,
      `├─ **RAM:** ${ramMain}${ramExtras.length > 0 ? ` · ${ramExtras.join(" · ")}` : ""}`,
      `├─ **Disk \`/\`:** ${diskPart} · **Net:** ${netPart}`,
    ];

    const hasTopSvc = topSvcRamStr !== "";
    const hasTopProc = topProcParts.length > 0;

    const svcBranch = hasTopSvc || hasTopProc ? "├─" : "└─";
    cardLines.push(
      `${svcBranch} **Services:** ${svcStatusPart}${catSummary ? ` (${catSummary})` : ""}${pm2Part}`
    );

    if (hasTopSvc) {
      const topSvcBranch = hasTopProc ? "├─" : "└─";
      cardLines.push(`${topSvcBranch} **Top Service RAM:** ${topSvcRamStr}`);
    }

    if (hasTopProc) {
      cardLines.push(`└─ **Top Process:** ${topProcParts.join(" · ")}`);
    }

    nodeBlocks.push(cardLines.join("\n"));
  }

  const fleetRamPct = totalRamMb > 0 ? Math.round((usedRamMb / totalRamMb) * 100) : 0;
  return [
    `📊 **ASTER FLEET SUMMARY** · \`${healthyCount}/${sortedNodes.length} Sehat\` · \`${totalCores} vCPU\` · \`RAM ${(usedRamMb / 1024).toFixed(1)}G/${(totalRamMb / 1024).toFixed(1)}G (${fleetRamPct}%)\``,
    "",
    nodeBlocks.join("\n\n"),
  ].join("\n");
}

export function formatBroadcastReport(
  prompt: string,
  results: NodeBroadcastResult[],
  totalDurationMs: number
): string {
  const sorted = [...results].sort((a, b) =>
    a.nodeId.localeCompare(b.nodeId, undefined, { sensitivity: "base" })
  );
  const okCount = sorted.filter((r) => r.status === "ok").length;
  const errCount = sorted.length - okCount;
  const totalSec = (totalDurationMs / 1000).toFixed(1);

  const lines: string[] = [
    `📡 **ASTER FLEET BROADCAST** · \`${okCount}/${sorted.length} Sukses\` · ⏱ \`${totalSec}s\``,
    `💬 **Instruksi:** \`${prompt.replace(/`/g, "'").slice(0, 180)}\``,
    ...(errCount > 0 ? [`⚠️ **Perhatian:** \`${errCount} node gagal / dihentikan\``] : []),
  ];

  sorted.forEach((r, idx) => {
    const sec = `${(r.durationMs / 1000).toFixed(1)}s`;
    const badge =
      r.status === "ok"
        ? `✅ \`${sec}\``
        : r.status === "aborted"
          ? `⏹ \`DIHENTIKAN (${sec})\``
          : `❌ \`ERROR (${sec})\``;

    lines.push("");
    lines.push(`🖥️ **[${idx + 1}/${sorted.length}] ${r.nodeId}** (\`${r.hostname}\` · \`${r.distroName}\`) — ${badge}`);

    if (r.status === "ok") {
      const cleaned = stripNodePrefix(r.nodeId, r.fullText);
      lines.push(cleaned || "`(Selesai tanpa output teks)`");
    } else if (r.status === "aborted") {
      lines.push("`(Eksekusi dihentikan oleh operator)`");
    } else {
      lines.push(`❌ \`${r.error || "Unknown error"}\``);
    }
  });

  return lines.join("\n");
}

export interface BotConfig {
  token: string;
  botName?: string;
  allowedUsers: number[];
  allowedChats?: number[];
  allowedTopics?: Record<string, number>;
  defaultAllowedTopic?: number;
  defaultModel?: string;
  notifyNodeEvents?: boolean;
  hubNodeId?: string;
}

export function parseAllowedTopics(raw: string | undefined): {
  byChat: Record<string, number>;
  defaultTopic?: number;
} {
  const byChat: Record<string, number> = {};
  let defaultTopic: number | undefined;
  if (!raw) return { byChat };

  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const chatStr = trimmed.slice(0, colonIdx).trim();
      const topicNum = Number(trimmed.slice(colonIdx + 1).trim());
      if (chatStr && Number.isFinite(topicNum) && topicNum > 0) {
        byChat[String(Number(chatStr))] = Math.trunc(topicNum);
      }
    } else {
      const topicNum = Number(trimmed);
      if (Number.isFinite(topicNum) && topicNum > 0) {
        defaultTopic = Math.trunc(topicNum);
      }
    }
  }
  return { byChat, defaultTopic };
}

export const HUB_BOT_COMMANDS = [
  { command: "start", description: "Informasi bot & panduan singkat" },
  { command: "help", description: "Daftar lengkap perintah fleet & SRE" },
  { command: "hub", description: "Chat / operasi langsung dengan OpenCode di Hub: /hub [pesan]" },
  { command: "nodes", description: "Daftar server node yang online" },
  { command: "use", description: "Pilih target node: /use <node>" },
  { command: "unuse", description: "Lepas pilihan node (kembali ke OpenCode Hub)" },
  { command: "status", description: "Dashboard kondisi server (/status [node|all])" },
  { command: "broadcast", description: "Chat AI / shell serentak ke semua node: /broadcast <prompt>" },
  { command: "disk", description: "Cek penggunaan disk di node aktif" },
  { command: "mem", description: "Cek penggunaan memory di node aktif" },
  { command: "ps", description: "Proses paling boros CPU di node aktif" },
  { command: "ports", description: "Port TCP yang listening di node aktif" },
  { command: "logs", description: "Tail journal service: /logs <unit> [baris]" },
  { command: "svc", description: "Kontrol service: /svc <aksi> <unit>" },
  { command: "exec", description: "Jalankan shell langsung: /exec <perintah>" },
  { command: "chat", description: "Konsultasi & operasi AI: /chat <prompt>" },
  { command: "ecc", description: "Katalog & workflow ECC: /ecc [skills|agents|commands|<workflow>]" },
  { command: "stop", description: "Hentikan eksekusi yang sedang berjalan" },
  { command: "update", description: "Update kode Hub & Node dari Git: /update [all|hub|<node>|status]" },
  { command: "auditcheck", description: "Verifikasi rantai hash audit log di node" },
  { command: "model", description: "Lihat atau ganti model AI: /model [id|reset]" },
  { command: "usage", description: "Statistik pemakaian token chat ini" },
  { command: "reset", description: "Hapus riwayat percakapan di node aktif" },
  { command: "topic", description: "Kunci bot di 1 topic grup: /topic [here|off|menu off|menu on]" },
  { command: "id", description: "Tampilkan Telegram User ID, Chat ID & Topic ID" },
];

export function createHubBot(config: BotConfig, hub: HubServer, store?: HubStore): Bot {
  const bot = new Bot(config.token);
  const hubStore = store ?? new HubStore("./hub-state.json");
  const allowedChats = config.allowedChats ?? [];
  const defaultModel = config.defaultModel || process.env.MODEL_NAME || process.env.OPENAI_MODEL || "ag/gemini-3.8-flash";
  const hubNodeId = config.hubNodeId || process.env.HUB_NODE_ID || "hub";
  const knownCommands = new Set(HUB_BOT_COMMANDS.map((c) => c.command.toLowerCase()));

  function getMessageTopicId(ctx: Context): number | undefined {
    const msg = (ctx.message ?? ctx.callbackQuery?.message) as any;
    if (!msg) return undefined;
    if (typeof msg.message_thread_id === "number" && (msg.is_topic_message || (ctx.chat as any)?.is_forum)) {
      return msg.message_thread_id;
    }
    if ((ctx.chat as any)?.is_forum) {
      return 1;
    }
    if (typeof msg.message_thread_id === "number") {
      return msg.message_thread_id;
    }
    return undefined;
  }

  function getEffectiveAllowedTopic(chatId: number): number | undefined {
    const persisted = hubStore.getAllowedTopic(chatId);
    if (persisted !== undefined) {
      return persisted > 0 ? persisted : undefined;
    }
    const fromChatMap = config.allowedTopics?.[String(chatId)];
    if (fromChatMap !== undefined && fromChatMap > 0) {
      return fromChatMap;
    }
    if (chatId < 0 && config.defaultAllowedTopic && config.defaultAllowedTopic > 0) {
      return config.defaultAllowedTopic;
    }
    return undefined;
  }

  function isTopicManagementCommand(ctx: Context): boolean {
    const text = ctx.message?.text?.trim();
    if (!text || !text.startsWith("/")) return false;
    const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text);
    if (!m) return false;
    const cmdName = m[1]!.toLowerCase();
    return cmdName === "topic" || cmdName === "id";
  }

  function getBotUsernames(ctx: Context): string[] {
    const names = new Set<string>();
    if (ctx.me?.username) names.add(ctx.me.username.replace(/^@/, "").trim().toLowerCase());
    if (config.botName) names.add(config.botName.replace(/^@/, "").trim().toLowerCase());
    return [...names].filter(Boolean);
  }

  function isGroupMessageAddressedToBot(ctx: Context): boolean {
    if (ctx.callbackQuery) return true;
    const text = ctx.message?.text?.trim();
    if (!text) return false;

    const botUsers = getBotUsernames(ctx);
    const actualBotUser = ctx.me?.username?.replace(/^@/, "").trim().toLowerCase() || botUsers[0] || "";
    const replyFrom = ctx.message?.reply_to_message?.from;
    const isReplyToBot = Boolean(
      replyFrom?.is_bot &&
        ((ctx.me?.id && replyFrom.id === ctx.me.id) ||
          (replyFrom.username && botUsers.includes(replyFrom.username.toLowerCase())))
    );

    if (text.startsWith("/")) {
      const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text);
      if (!m) return false;
      const cmdName = m[1]!.toLowerCase();
      const targetBot = (m[2] || "").toLowerCase();
      // Abaikan command milik bot lain (misal /ask)
      if (!knownCommands.has(cmdName)) return false;
      // Abaikan jika men-tag username bot lain (misal /status@bot_lain)
      if (targetBot && actualBotUser && !botUsers.includes(targetBot)) return false;
      return true;
    }

    const lowerText = text.toLowerCase();
    for (const bu of botUsers) {
      if (lowerText.includes(`@${bu}`)) return true;
    }

    // Cek juga text_mention entity jika user men-tag bot tanpa username teks
    const entities = ctx.message?.entities ?? [];
    for (const ent of entities) {
      if (ent.type === "text_mention" && ent.user?.id && ctx.me?.id && ent.user.id === ctx.me.id) {
        return true;
      }
    }

    return isReplyToBot;
  }

  function isAuthorized(ctx: Context): boolean {
    const fromId = ctx.from?.id;
    if (!fromId) return false;
    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(fromId)) {
      return false;
    }
    if (allowedChats.length > 0) {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return false;
      if (allowedChats.includes(chatId)) return true;
      // Jika admin (ALLOWED_USER_ID) hanya mengisi User ID pribadinya (positif) di ALLOWED_CHAT_ID,
      // tetap izinkan admin tersebut memanggil bot di grup.
      const hasExplicitGroupAllowlist = allowedChats.some((id) => id < 0);
      if (!hasExplicitGroupAllowlist && config.allowedUsers.includes(fromId)) {
        return true;
      }
      return false;
    }
    return true;
  }

  async function sendFormatted(ctx: Context, text: string, mode: "md" | "html" = "md"): Promise<void> {
    const chunks = mode === "html" ? chunkHtml(text) : renderMarkdown(text);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      } catch {
        await ctx.reply(chunk.replace(/<[^>]*>/g, "").slice(0, 4000));
      }
    }
  }

  // Forward alert proaktif dari node ke admin utama
  const primaryAdmin = config.allowedUsers[0];
  if (primaryAdmin !== undefined) {
    hub.on("node_alert", (_nodeId: string, _key: string, _severity: string, html: string) => {
      void bot.api
        .sendMessage(primaryAdmin, html, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        })
        .catch((err) => console.error("[bot:alert] Gagal kirim alert ke admin:", err.message));
    });

    if (config.notifyNodeEvents) {
      hub.on("node_joined", (nodeId: string, info: { hostname: string; distro?: { name?: string }; platform: string }) => {
        const osName = info.distro?.name || info.platform;
        void bot.api
          .sendMessage(
            primaryAdmin,
            `🟢 <b>Node Online:</b> <code>${escapeHtml(nodeId)}</code> (${escapeHtml(info.hostname)} · ${escapeHtml(osName)})`,
            { parse_mode: "HTML" }
          )
          .catch(() => undefined);
      });

      hub.on("node_left", (nodeId: string) => {
        void bot.api
          .sendMessage(primaryAdmin, `🔴 <b>Node Terputus:</b> <code>${escapeHtml(nodeId)}</code>`, {
            parse_mode: "HTML",
          })
          .catch(() => undefined);
      });
    }
  }

  // Forward permintaan approval lintas-node yang dipicu dari OpenCode Hub
  hub.on(
    "remote_approval_req",
    (ev: { nodeId: string; runId: string; approvalId: string; command: string; reason: string; chatId?: number }) => {
      const targetChatId = ev.chatId && ev.chatId !== 0 ? ev.chatId : primaryAdmin;
      if (targetChatId === undefined) return;
      const boundTopic = getEffectiveAllowedTopic(targetChatId);
      const kb = new InlineKeyboard()
        .text("✅ Setujui", `ap:${ev.approvalId}:yes`)
        .text("❌ Tolak", `ap:${ev.approvalId}:no`);
      void bot.api
        .sendMessage(
          targetChatId,
          `🔐 <b>[${escapeHtml(ev.nodeId)}] Konfirmasi Eksekusi (via OpenCode Hub)</b>\n` +
            `Alasan: ${escapeHtml(ev.reason)}\n` +
            `${preBlock(ev.command, "bash")}`,
          {
            parse_mode: "HTML",
            reply_markup: kb,
            ...(boundTopic && boundTopic > 1 ? { message_thread_id: boundTopic } : {}),
          }
        )
        .catch((err) => console.error("[bot:remote-approval] Gagal kirim tombol approval:", err?.message));
    }
  );

  // Middleware Filter Grup, Topic & Otorisasi
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") {
      if (!isGroupMessageAddressedToBot(ctx)) {
        return;
      }

      // Jika grup dikunci ke 1 Topic tertentu, abaikan semua command/pesan dari topic lain
      // (kecuali /topic dan /id agar admin tetap bisa mengecek ID atau memindahkan kunci topic)
      if (!isTopicManagementCommand(ctx) && ctx.chat?.id !== undefined) {
        const allowedTopic = getEffectiveAllowedTopic(ctx.chat.id);
        if (allowedTopic !== undefined) {
          const currentTopic = getMessageTopicId(ctx) ?? 1;
          if (currentTopic !== allowedTopic) {
            if (ctx.callbackQuery) {
              await ctx
                .answerCallbackQuery({ text: `⚠️ Bot hanya aktif di Topic #${allowedTopic}.` })
                .catch(() => undefined);
            }
            return;
          }
        }
      }
    }

    if (!isAuthorized(ctx)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "⛔ Akses ditolak." }).catch(() => undefined);
      } else if (ctx.message) {
        if (ctx.chat?.type === "private") {
          await ctx.reply("⛔ Akses ditolak. User atau chat tidak terdaftar di allowlist.");
        } else if (ctx.from?.id && config.allowedUsers.includes(ctx.from.id)) {
          await ctx.reply(
            `⛔ Grup ini (Chat ID: <code>${ctx.chat?.id}</code>) belum terdaftar di <code>ALLOWED_CHAT_ID</code>.`,
            { parse_mode: "HTML" }
          );
        }
      }
      return;
    }
    await next();
  });

  // Helper eksekusi prompt/command ke node tertentu
  async function executeOnNode(
    ctx: Context,
    nodeId: string,
    prompt: string,
    opts?: { rememberInHistory?: boolean }
  ): Promise<void> {
    const chatId = ctx.chat?.id ?? 0;
    const userId = ctx.from?.id ?? 0;
    const node = hub.getNode(nodeId);

    if (!node) {
      await sendFormatted(
        ctx,
        `❌ Node <b>${escapeHtml(nodeId)}</b> sedang offline. Ketik <code>/nodes</code> untuk melihat daftar server aktif.`,
        "html"
      );
      return;
    }

    const initialMsg = await ctx.reply(`⏳ <b>[${escapeHtml(nodeId)}]</b> Memproses...`, {
      parse_mode: "HTML",
    });

    let lastText = "";
    let lastEditTime = 0;
    let editDisabled = false;

    const updatePreview = async (text: string) => {
      if (editDisabled) return;
      const now = Date.now();
      if (now - lastEditTime < 1500) return;
      lastEditTime = now;
      try {
        await ctx.api.editMessageText(
          chatId,
          initialMsg.message_id,
          `⏳ <b>[${escapeHtml(nodeId)}]</b>\n<pre>${escapeHtml(text.slice(-3200))}</pre>`,
          { parse_mode: "HTML" }
        );
      } catch {
        // abaikan rate limit / unchanged text
      }
    };

    try {
      let currentRunId = "";
      const modelOverride = hubStore.getModelOverride(chatId);
      const history = opts?.rememberInHistory ? hubStore.getHistory(chatId, nodeId) : undefined;

      currentRunId = hub.startRun(
        nodeId,
        chatId,
        prompt,
        {
          onChunk: (chunk) => {
            lastText += chunk;
            void updatePreview(lastText);
          },
          onApprovalReq: async (approvalId, command, reason) => {
            const kb = new InlineKeyboard()
              .text("✅ Setujui", `ap:${approvalId}:yes`)
              .text("❌ Tolak", `ap:${approvalId}:no`);

            await ctx.reply(
              `🔐 <b>Persetujuan Diperlukan di [${escapeHtml(nodeId)}]</b>\n` +
                `Alasan: <i>${escapeHtml(reason)}</i>\n\n` +
                `${preBlock(command, "bash")}`,
              { parse_mode: "HTML", reply_markup: kb }
            );
          },
          onDone: async (fullText, error, usage) => {
            editDisabled = true;
            if (usage) {
              hubStore.addUsage(chatId, usage);
            }
            if (opts?.rememberInHistory && !error) {
              hubStore.remember(chatId, nodeId, prompt, fullText);
            }

            try {
              await ctx.api.deleteMessage(chatId, initialMsg.message_id);
            } catch {
              // jika gagal dihapus, akan ditimpa atau dikirim pesan baru
            }

            if (error === "ABORTED") {
              await sendFormatted(ctx, `⏹ <b>[${escapeHtml(nodeId)}]</b> Tugas dihentikan.`, "html");
              return;
            }

            if (error) {
              await sendFormatted(
                ctx,
                `❌ <b>[${escapeHtml(nodeId)}] Error</b>\n${preBlock(error)}`,
                "html"
              );
              return;
            }

            const header = fullText.startsWith(`[${nodeId}]`) ? "" : `🖥️ **[${nodeId}]**\n`;
            await sendFormatted(ctx, `${header}${fullText}`, "md");
          },
        },
        modelOverride,
        { userId, history }
      );
    } catch (err: any) {
      await ctx.api
        .editMessageText(
          chatId,
          initialMsg.message_id,
          `❌ Gagal memulai eksekusi di [${escapeHtml(nodeId)}]: ${escapeHtml(err.message)}`,
          { parse_mode: "HTML" }
        )
        .catch(() => undefined);
    }
  }

  async function requireActiveNode(ctx: Context): Promise<string | null> {
    const chatId = ctx.chat?.id ?? 0;
    const current = hubStore.getActiveNode(chatId);
    if (current) return current;

    // Default otomatis ke OpenCode Hub jika node embedded 'hub' sedang aktif
    if (hub.getNode(hubNodeId)) {
      return hubNodeId;
    }

    const nodes = hub.listNodes();
    if (nodes.length === 1 && nodes[0]) {
      return nodes[0].nodeId;
    }

    const keyboard = new InlineKeyboard();
    nodes.forEach((n, idx) => {
      keyboard.text(n.nodeId, `select_node:${n.nodeId}`);
      if ((idx + 1) % 2 === 0) keyboard.row();
    });

    await ctx.reply(
      `⚠️ <b>Belum ada server node yang dipilih.</b>\nPilih target di bawah ini atau ketik <code>/use &lt;nama_node&gt;</code>:`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return null;
  }

  bot.command("start", async (ctx) => {
    await sendFormatted(
      ctx,
      `👋 <b>Aster Fleet Manager</b>\n\n` +
        `Satu kendali terpusat untuk mengelola seluruh server kantor secara aman (outbound WSS, approval gate, dan tamper-evident audit).\n\n` +
        `• <code>/nodes</code> — Lihat daftar server yang terhubung\n` +
        `• <code>/use &lt;node&gt;</code> — Pilih server target aktif\n` +
        `• <code>/status</code> — Dashboard kesehatan server\n` +
        `• <code>/help</code> — Daftar lengkap perintah SRE\n\n` +
        `Ketik pesan atau <code>$ &lt;perintah&gt;</code> setelah memilih node.`,
      "html"
    );
  });

  bot.command("help", async (ctx) => {
    const lines = [
      `<b>Aster Fleet Manager — Panduan Perintah</b>`,
      "",
      ...HUB_BOT_COMMANDS.map((item) => `• /<b>${item.command}</b> — ${escapeHtml(item.description)}`),
      "",
      "<b>Shortcut Eksekusi:</b>",
      "• Kirim teks biasa atau <code>/chat &lt;pertanyaan&gt;</code> untuk analisis & aksi AI SRE",
      "• Kirim <code>$ &lt;perintah&gt;</code> atau <code>/exec &lt;perintah&gt;</code> untuk shell langsung",
      ...(config.botName ? [`• Mention <code>@${escapeHtml(config.botName)} &lt;pesan&gt;</code> di grup`] : []),
    ];
    await sendFormatted(ctx, lines.join("\n"), "html");
  });

  bot.command("id", async (ctx) => {
    const chatId = ctx.chat?.id;
    const topicId = getMessageTopicId(ctx);
    const lockedTopic = chatId !== undefined ? getEffectiveAllowedTopic(chatId) : undefined;
    const lines = [
      `👤 User ID: <code>${ctx.from?.id ?? "-"}</code>`,
      `💬 Chat ID: <code>${chatId ?? "-"}</code>`,
    ];
    if (ctx.chat?.type !== "private") {
      lines.push(`🧵 Topic / Thread ID: <code>${topicId ?? 1}</code>`);
      lines.push(
        `🔒 Kunci Topic Grup: ${
          lockedTopic !== undefined
            ? `<b>Aktif</b> (Hanya Topic <code>#${lockedTopic}</code>)`
            : `<i>Semua Topic Diizinkan</i>`
        }`
      );
    }
    await sendFormatted(ctx, lines.join("\n"), "html");
  });

  bot.command("topic", async (ctx) => {
    if (ctx.chat.type === "private") {
      await sendFormatted(
        ctx,
        "ℹ️ Perintah <code>/topic</code> hanya digunakan di dalam Grup Telegram (Forum / Topics).",
        "html"
      );
      return;
    }

    const chatId = ctx.chat.id;
    const currentTopic = getMessageTopicId(ctx) ?? 1;
    const rawArg = (ctx.match ?? "").trim().toLowerCase();

    if (rawArg === "status") {
      const lockedTopic = getEffectiveAllowedTopic(chatId);
      const menuHidden = hubStore.isGroupMenuHidden(chatId);
      await sendFormatted(
        ctx,
        `🧵 <b>Status Konfigurasi Topic Grup</b>\n` +
          `• Chat ID: <code>${chatId}</code>\n` +
          `• Topic Saat Ini: <code>#${currentTopic}</code>\n` +
          `• Topic yang Diizinkan: ${
            lockedTopic !== undefined
              ? `<b>Hanya Topic <code>#${lockedTopic}</code></b>`
              : `<b>Semua Topic</b> (belum dikunci)`
          }\n` +
          `• Popup Menu <code>/</code> di Grup: <b>${menuHidden ? "Disembunyikan" : "Aktif"}</b>\n\n` +
          `<b>Perintah:</b>\n` +
          `• <code>/topic</code> atau <code>/topic here</code> — Kunci bot hanya di topic ini\n` +
          `• <code>/topic &lt;id_topic&gt;</code> — Kunci bot ke ID topic tertentu\n` +
          `• <code>/topic off</code> — Izinkan kembali di semua topic grup\n` +
          `• <code>/topic menu off</code> — Sembunyikan popup daftar <code>/</code> di grup\n` +
          `• <code>/topic menu on</code> — Tampilkan kembali popup daftar <code>/</code> di grup`,
        "html"
      );
      return;
    }

    if (rawArg === "off" || rawArg === "unlock" || rawArg === "all" || rawArg === "reset") {
      hubStore.setAllowedTopic(chatId, 0);
      await sendFormatted(
        ctx,
        `🔓 <b>Kunci Topic Dibuka</b>\nBot sekarang kembali merespons perintah <code>/</code> dan mention di seluruh topic grup ini.`,
        "html"
      );
      return;
    }

    if (rawArg === "menu off" || rawArg === "hide" || rawArg === "nomenu") {
      hubStore.setGroupMenuHidden(chatId, true);
      await ctx.api
        .setMyCommands(HUB_BOT_COMMANDS, { scope: { type: "all_private_chats" } })
        .catch(() => undefined);
      await ctx.api.deleteMyCommands({ scope: { type: "default" } }).catch(() => undefined);
      await ctx.api.deleteMyCommands({ scope: { type: "all_group_chats" } }).catch(() => undefined);
      await ctx.api
        .setMyCommands([], { scope: { type: "chat", chat_id: chatId } })
        .catch(() => undefined);
      await ctx.api
        .setMyCommands([], { scope: { type: "chat_administrators", chat_id: chatId } })
        .catch(() => undefined);

      await sendFormatted(
        ctx,
        `🙈 <b>Popup Menu <code>/</code> Grup Disembunyikan</b>\n` +
          `Daftar autocomplete <code>/</code> milik bot ini telah dihapus dari grup agar tidak memenuhi topic lain (menu <code>/</code> di chat pribadi/DM tetap aktif).\n` +
          `Anda tetap bisa mengetik perintah seperti <code>/status</code>, <code>/hub</code>, <code>/nodes</code> secara langsung di topic yang diizinkan.\n\n` +
          `<i>Gunakan <code>/topic menu on</code> jika ingin memunculkan kembali popup <code>/</code> di grup.</i>`,
        "html"
      );
      return;
    }

    if (rawArg === "menu on" || rawArg === "show" || rawArg === "menu") {
      hubStore.setGroupMenuHidden(chatId, false);
      await ctx.api
        .setMyCommands(HUB_BOT_COMMANDS, { scope: { type: "chat", chat_id: chatId } })
        .catch(() => undefined);
      await ctx.api
        .setMyCommands(HUB_BOT_COMMANDS, { scope: { type: "chat_administrators", chat_id: chatId } })
        .catch(() => undefined);

      await sendFormatted(
        ctx,
        `📋 <b>Popup Menu <code>/</code> Grup Diaktifkan</b>\nDaftar autocomplete command <code>/</code> untuk bot ini kembali ditampilkan di grup.`,
        "html"
      );
      return;
    }

    let targetTopic = currentTopic;
    if (rawArg && rawArg !== "here" && rawArg !== "lock") {
      const parsedTopic = Number(rawArg);
      if (!Number.isFinite(parsedTopic) || parsedTopic <= 0) {
        await sendFormatted(
          ctx,
          `⚠️ Format: <code>/topic [here | &lt;id_topic&gt; | off | status | menu off | menu on]</code>`,
          "html"
        );
        return;
      }
      targetTopic = Math.trunc(parsedTopic);
    }

    hubStore.setAllowedTopic(chatId, targetTopic);
    await sendFormatted(
      ctx,
      `🔒 <b>Bot Dikunci ke Topic <code>#${targetTopic}</code></b>\n` +
        `• Bot sekarang <b>hanya merespons</b> command <code>/</code> dan pesan di topic ini.\n` +
        `• Semua command dan pesan di topic/thread lain dalam grup ini akan diabaikan sepenuhnya.\n\n` +
        `💡 <b>Tips:</b>\n` +
        `• Ketik <code>/topic off</code> jika ingin membuka kembali ke semua topic.\n` +
        `• Karena API Telegram mengatur popup autocomplete <code>/</code> di level grup (bukan per-topic), ketik <code>/topic menu off</code> jika Anda juga ingin menyembunyikan daftar popup <code>/</code> bot ini dari grup.`,
      "html"
    );
  });

  bot.command("nodes", async (ctx) => {
    const nodes = hub.listNodes();
    if (nodes.length === 0) {
      await sendFormatted(ctx, "❌ Tidak ada server node yang terhubung saat ini.", "html");
      return;
    }

    const current = hubStore.getActiveNode(ctx.chat.id);
    let text = `🌐 <b>Daftar Server Terhubung (${nodes.length})</b>:\n\n`;
    const keyboard = new InlineKeyboard();

    nodes.forEach((n, idx) => {
      const isCurrent = n.nodeId === current;
      const badge = isCurrent ? " <b>[AKTIF]</b>" : "";
      const load = n.info.loadAvg?.[0]?.toFixed(2) ?? "0.00";
      const freeMem = n.info.memory?.freeMb ?? "?";
      const totalMem = n.info.memory?.totalMb ?? "?";
      const distroName = n.info.distro ? `${n.info.distro.id} ${n.info.distro.version}`.trim() : `${n.info.platform}/${n.info.arch}`;
      const upHours = Math.round((n.info.uptime || 0) / 3600);

      text += `${idx + 1}. <b>${escapeHtml(n.nodeId)}</b>${badge}\n`;
      text += `   Host: <code>${escapeHtml(n.info.hostname)}</code> (${escapeHtml(distroName)})\n`;
      text += `   Load: <code>${load}</code> | RAM: <code>${freeMem}/${totalMem} MB free</code> | Up: <code>${upHours}h</code>\n\n`;

      keyboard.text(`${isCurrent ? "✓ " : ""}${n.nodeId}`, `select_node:${n.nodeId}`);
      if ((idx + 1) % 2 === 0) keyboard.row();
    });

    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.command("use", async (ctx) => {
    const target = (ctx.match ?? "").trim().split(/\s+/)[0];
    if (!target) {
      await sendFormatted(
        ctx,
        "⚠️ Format: <code>/use &lt;nama_node&gt;</code>\nContoh: <code>/use hongyun</code>",
        "html"
      );
      return;
    }

    const node = hub.getNode(target);
    if (!node) {
      await sendFormatted(
        ctx,
        `❌ Node "<b>${escapeHtml(target)}</b>" tidak ditemukan atau sedang offline. Cek <code>/nodes</code>.`,
        "html"
      );
      return;
    }

    hubStore.setActiveNode(ctx.chat.id, target);
    await sendFormatted(
      ctx,
      `✅ Node aktif disetel ke: <b>${escapeHtml(target)}</b> (<code>${escapeHtml(node.info.hostname)}</code>)`,
      "html"
    );
  });

  bot.command("unuse", async (ctx) => {
    hubStore.setActiveNode(ctx.chat.id, null);
    if (hub.getNode(hubNodeId)) {
      await sendFormatted(
        ctx,
        `ℹ️ Pilihan node cabang dilepas. Chat sekarang otomatis terhubung ke <b>OpenCode Hub</b> (<code>${escapeHtml(hubNodeId)}</code>).\nGunakan <code>/use &lt;node&gt;</code> jika ingin berpindah ke server tertentu.`,
        "html"
      );
      return;
    }
    await sendFormatted(ctx, "ℹ️ Target node dilepas. Gunakan <code>/use &lt;node&gt;</code> untuk memilih kembali.", "html");
  });

  bot.command("hub", async (ctx) => {
    const prompt = (ctx.match ?? "").trim();
    const hubNode = hub.getNode(hubNodeId);

    if (!hubNode) {
      await sendFormatted(
        ctx,
        `❌ Embedded OpenCode Hub (<code>${escapeHtml(hubNodeId)}</code>) belum aktif atau sedang offline.`,
        "html"
      );
      return;
    }

    if (!prompt) {
      hubStore.setActiveNode(ctx.chat.id, hubNodeId);
      const otherNodes = hub
        .listNodes()
        .filter((n) => n.nodeId !== hubNodeId)
        .map((n) => `<code>${escapeHtml(n.nodeId)}</code>`)
        .join(", ");
      await sendFormatted(
        ctx,
        `🧠 <b>OpenCode Hub (<code>${escapeHtml(hubNodeId)}</code>) Aktif</b>\n` +
          `• Host: <code>${escapeHtml(hubNode.info.hostname)}</code>\n` +
          `• Node Cabang Terhubung: ${otherNodes || "<i>(belum ada)</i>"}\n\n` +
          `Anda sekarang bisa langsung mengetik pesan untuk berdiskusi dengan OpenCode di Hub, mengelola server Hub, atau meminta OpenCode Hub memeriksa/membandingkan kondisi antar node cabang.`,
        "html"
      );
      return;
    }

    const isDirectShell = prompt.startsWith("$ ");
    await executeOnNode(ctx, hubNodeId, prompt, { rememberInHistory: !isDirectShell });
  });

  async function runFleetSummary(ctx: Context): Promise<void> {
    const nodes = hub.listNodes();
    if (nodes.length === 0) {
      await sendFormatted(ctx, "❌ Tidak ada server node yang terhubung saat ini.", "html");
      return;
    }

    const chatId = ctx.chat?.id ?? 0;
    const current = hubStore.getActiveNode(chatId);
    const waitMsg = await ctx.reply(
      `⏳ <b>Mengumpulkan status live dari ${nodes.length} node secara paralel...</b>`,
      { parse_mode: "HTML" }
    );

    const results = await hub.broadcastRun(chatId, "__builtin:status", {
      timeoutMs: 25_000,
    });

    await ctx.api.deleteMessage(chatId, waitMsg.message_id).catch(() => undefined);
    const reportMd = formatFleetSummaryReport(nodes, results, current);
    await sendFormatted(ctx, reportMd, "md");
  }

  bot.command("status", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const current = hubStore.getActiveNode(ctx.chat.id);
    const nodes = hub.listNodes();
    const targetNodeId =
      arg && arg !== "all"
        ? arg
        : current || (arg !== "all" && nodes.length === 1 ? nodes[0]?.nodeId : undefined);

    if (arg === "all" || !targetNodeId) {
      await runFleetSummary(ctx);
      return;
    }

    await executeOnNode(ctx, targetNodeId, "__builtin:status");
  });

  bot.command("broadcast", async (ctx) => {
    const prompt = (ctx.match ?? "").trim();
    if (!prompt) {
      await sendFormatted(
        ctx,
        `📡 <b>Panduan Perintah /broadcast</b>\n` +
          `Menjalankan instruksi AI SRE atau perintah shell secara <b>serentak di seluruh node yang online</b>.\n\n` +
          `• <b>AI Chat Serentak:</b>\n` +
          `  <code>/broadcast cek penggunaan RAM tertinggi dan service yang bermasalah</code>\n` +
          `• <b>Shell Langsung Serentak:</b>\n` +
          `  <code>/broadcast $ uptime &amp;&amp; df -h /</code>`,
        "html"
      );
      return;
    }

    const nodes = hub.listNodes();
    if (nodes.length === 0) {
      await sendFormatted(ctx, "❌ Tidak ada server node yang terhubung saat ini.", "html");
      return;
    }

    const chatId = ctx.chat?.id ?? 0;
    const userId = ctx.from?.id ?? 0;
    const isDirectShell = prompt.startsWith("$ ");
    const modelOverride = hubStore.getModelOverride(chatId);
    const startedAt = Date.now();

    const renderProgressHtml = (progressList: BroadcastNodeProgress[]): string => {
      const rows = progressList.map((p) => {
        const sec = `${(p.durationMs / 1000).toFixed(1)}s`;
        if (p.state === "done") return `✅ <b>${escapeHtml(p.nodeId)}</b> — Selesai (${sec})`;
        if (p.state === "approval") return `🔐 <b>${escapeHtml(p.nodeId)}</b> — Menunggu persetujuan...`;
        if (p.state === "aborted") return `⏹ <b>${escapeHtml(p.nodeId)}</b> — Dihentikan`;
        if (p.state === "error") return `❌ <b>${escapeHtml(p.nodeId)}</b> — Error (${sec})`;
        return `⏳ <b>${escapeHtml(p.nodeId)}</b> — Memproses...`;
      });
      return (
        `📡 <b>Broadcast ke ${nodes.length} Node</b>\n` +
        `Instruksi: <code>${escapeHtml(prompt.slice(0, 140))}</code>\n\n` +
        rows.join("\n")
      );
    };

    const initialProgress: BroadcastNodeProgress[] = [...nodes]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId, undefined, { sensitivity: "base" }))
      .map((n) => ({
        nodeId: n.nodeId,
        hostname: n.info.hostname,
        state: "running",
        durationMs: 0,
      }));

    const boardMsg = await ctx.reply(renderProgressHtml(initialProgress), {
      parse_mode: "HTML",
    });

    let lastEditTime = 0;
    let boardClosed = false;

    const results = await hub.broadcastRun(chatId, prompt, {
      model: modelOverride,
      userId,
      getHistory: (nodeId) => (!isDirectShell ? hubStore.getHistory(chatId, nodeId) : undefined),
      onProgress: (progressList) => {
        if (boardClosed) return;
        const now = Date.now();
        if (now - lastEditTime < 1500) return;
        lastEditTime = now;
        void ctx.api
          .editMessageText(chatId, boardMsg.message_id, renderProgressHtml(progressList), {
            parse_mode: "HTML",
          })
          .catch(() => undefined);
      },
      onApprovalReq: (nodeId, approvalId, command, reason) => {
        const kb = new InlineKeyboard()
          .text("✅ Setujui", `ap:${approvalId}:yes`)
          .text("❌ Tolak", `ap:${approvalId}:no`);

        void ctx
          .reply(
            `🔐 <b>[Broadcast] Persetujuan Diperlukan di [${escapeHtml(nodeId)}]</b>\n` +
              `Alasan: <i>${escapeHtml(reason)}</i>\n\n` +
              `${preBlock(command, "bash")}`,
            { parse_mode: "HTML", reply_markup: kb }
          )
          .catch(() => undefined);
      },
    });

    boardClosed = true;
    for (const res of results) {
      if (res.usage) {
        hubStore.addUsage(chatId, res.usage);
      }
      if (!isDirectShell && res.status === "ok") {
        hubStore.remember(chatId, res.nodeId, prompt, res.fullText);
      }
    }

    await ctx.api.deleteMessage(chatId, boardMsg.message_id).catch(() => undefined);
    const reportMd = formatBroadcastReport(prompt, results, Date.now() - startedAt);
    await sendFormatted(ctx, reportMd, "md");
  });

  bot.command("disk", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;
    await executeOnNode(ctx, target, "$ df -h -x tmpfs -x devtmpfs");
  });

  bot.command("mem", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;
    await executeOnNode(ctx, target, "$ free -h");
  });

  bot.command("ps", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;
    await executeOnNode(ctx, target, "$ ps aux --sort=-%cpu | head -12");
  });

  bot.command("ports", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;
    await executeOnNode(ctx, target, "$ ss -ltnp");
  });

  bot.command("logs", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;

    const [unit, rawLines] = (ctx.match ?? "").trim().split(/\s+/);
    if (!unit || !SYNTAX_UNIT.test(unit)) {
      await sendFormatted(
        ctx,
        "⚠️ Format: <code>/logs &lt;unit&gt; [jumlah_baris]</code>\nContoh: <code>/logs nginx 80</code>",
        "html"
      );
      return;
    }
    const lines = Math.min(Math.max(Number(rawLines) || 80, 1), 500);
    await executeOnNode(ctx, target, `$ journalctl -u ${unit} -n ${lines} --no-pager -o cat`);
  });

  bot.command("svc", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;

    const [action, unit] = (ctx.match ?? "").trim().split(/\s+/);
    const allowedActions = ["status", "start", "stop", "restart", "reload", "enable", "disable"];
    if (!action || !allowedActions.includes(action) || !unit || !SYNTAX_UNIT.test(unit)) {
      await sendFormatted(
        ctx,
        `⚠️ Format: <code>/svc &lt;aksi&gt; &lt;unit&gt;</code>\nAksi: ${allowedActions.join(", ")}\nContoh: <code>/svc restart nginx</code>`,
        "html"
      );
      return;
    }

    const command =
      action === "status"
        ? `$ systemctl status ${unit} --no-pager -l | head -25`
        : `$ systemctl ${action} ${unit} --no-pager && systemctl status ${unit} --no-pager -l | head -20`;
    await executeOnNode(ctx, target, command);
  });

  bot.command("exec", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;

    const cmd = (ctx.match ?? "").trim();
    if (!cmd) {
      await sendFormatted(ctx, "⚠️ Format: <code>/exec &lt;perintah_shell&gt;</code>", "html");
      return;
    }
    await executeOnNode(ctx, target, `$ ${cmd}`);
  });

  bot.command("chat", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;

    const prompt = (ctx.match ?? "").trim();
    if (!prompt) {
      await sendFormatted(ctx, "⚠️ Format: <code>/chat &lt;pertanyaan_atau_instruksi&gt;</code>", "html");
      return;
    }
    await executeOnNode(ctx, target, prompt, { rememberInHistory: true });
  });

  bot.command("ecc", async (ctx) => {
    const target = await requireActiveNode(ctx);
    if (!target) return;

    const rawArgs = (ctx.match ?? "").trim();
    if (!rawArgs) {
      await executeOnNode(ctx, target, "__builtin:ecc:status");
      return;
    }

    const parts = rawArgs.split(/\s+/);
    const sub = parts[0]!.toLowerCase();
    const rest = parts.slice(1).join(" ").trim();

    if (["status", "info", "skills", "agents", "commands"].includes(sub) && !rest) {
      await executeOnNode(ctx, target, `__builtin:ecc:${sub}`);
      return;
    }

    if (!rest && !["verify", "security", "security-scan", "code-review", "harness-audit", "pm2"].includes(sub)) {
      await executeOnNode(ctx, target, `__builtin:ecc:${sub}`);
      return;
    }

    await executeOnNode(ctx, target, `ecc:${sub} ${rest}`.trim(), { rememberInHistory: true });
  });

  bot.command("stop", async (ctx) => {
    const cancelled = hub.cancelChatRuns(ctx.chat.id);
    if (cancelled === 0) {
      await sendFormatted(ctx, "ℹ️ Tidak ada eksekusi yang sedang berjalan di chat ini.", "html");
    } else {
      await sendFormatted(ctx, `⏹ Sinyal penghentian dikirim ke <b>${cancelled}</b> tugas aktif.`, "html");
    }
  });

  bot.command("auditcheck", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const target = arg || (await requireActiveNode(ctx));
    if (!target) return;
    await executeOnNode(ctx, target, "__builtin:auditcheck");
  });

  bot.command("update", async (ctx) => {
    const arg = (ctx.match ?? "").trim().toLowerCase();

    if (arg === "status" || arg === "check" || arg === "version") {
      const hubVer = await getGitVersionInfo();
      await sendFormatted(
        ctx,
        `📦 <b>Aster Hub</b>: <code>${escapeHtml(hubVer.branch)}@${escapeHtml(hubVer.shortCommit)}</code> — ${escapeHtml(hubVer.subject)}`,
        "html"
      );
      for (const n of hub.listNodes()) {
        await executeOnNode(ctx, n.nodeId, "__builtin:version");
      }
      return;
    }

    const updateHubSelf = async () => {
      const statusMsg = await ctx.reply(`🔄 <b>[aster-hub]</b> Mengecek pembaruan dari git remote...`, {
        parse_mode: "HTML",
      });
      const res = await checkAndApplyUpdate();
      if (res.status === "up_to_date") {
        await ctx.api
          .editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            `✅ <b>[aster-hub] Sudah versi terbaru</b> (<code>${escapeHtml(res.branch)}@${escapeHtml(res.toCommit)}</code>)`,
            { parse_mode: "HTML" }
          )
          .catch(() => undefined);
        return;
      }
      if (res.status === "failed") {
        await ctx.api
          .editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            `❌ <b>[aster-hub] Update gagal</b>\n${preBlock(res.error || "Unknown error")}`,
            { parse_mode: "HTML" }
          )
          .catch(() => undefined);
        return;
      }
      await ctx.api
        .editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `🔄 <b>[aster-hub] Update berhasil</b> (<code>${escapeHtml(res.fromCommit)}</code> → <code>${escapeHtml(res.toCommit)}</code> di <code>${escapeHtml(res.branch)}</code>)\n` +
            (res.changes ? `${preBlock(res.changes)}\n` : "") +
            `♻️ <i>Me-restart Aster Hub...</i>`,
          { parse_mode: "HTML" }
        )
        .catch(() => undefined);
      hubStore.flush();
      scheduleSelfRestart(1500);
    };

    if (arg === "hub") {
      await updateHubSelf();
      return;
    }

    if (arg && arg !== "all") {
      await executeOnNode(ctx, arg, "__builtin:update");
      return;
    }

    // Default (/update atau /update all): update seluruh node yang terhubung lalu update Hub
    const nodes = hub.listNodes();
    for (const n of nodes) {
      await executeOnNode(ctx, n.nodeId, "__builtin:update");
    }
    await updateHubSelf();
  });

  bot.command("model", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const currentOverride = hubStore.getModelOverride(ctx.chat.id);
    const activeModel = currentOverride || defaultModel;
    const currentNode = hubStore.getActiveNode(ctx.chat.id);

    if (!arg) {
      await sendFormatted(
        ctx,
        `🤖 <b>Konfigurasi Model AI</b>\n` +
          `• Aktif: <code>${escapeHtml(activeModel)}</code> ${currentOverride ? "(override chat ini)" : "(default)"}\n\n` +
          `Ganti model: <code>/model &lt;id_model&gt;</code>\n` +
          `Kembali ke default: <code>/model reset</code>`,
        "html"
      );
      if (currentNode && hub.getNode(currentNode)) {
        await executeOnNode(ctx, currentNode, "__builtin:models");
      }
      return;
    }

    if (arg === "reset" || arg === "default") {
      hubStore.setModelOverride(ctx.chat.id, null);
      await sendFormatted(
        ctx,
        `↩️ Model dikembalikan ke default: <code>${escapeHtml(defaultModel)}</code>`,
        "html"
      );
      return;
    }

    hubStore.setModelOverride(ctx.chat.id, arg);
    await sendFormatted(ctx, `✅ Model AI untuk chat ini disetel ke: <code>${escapeHtml(arg)}</code>`, "html");
  });

  bot.command("usage", async (ctx) => {
    const stats = hubStore.getUsage(ctx.chat.id);
    await sendFormatted(
      ctx,
      `📊 <b>Statistik Token Chat Ini</b>\n` +
        `• Request AI: <code>${stats.requests}</code>\n` +
        `• Prompt tokens: <code>${stats.promptTokens}</code>\n` +
        `• Completion tokens: <code>${stats.completionTokens}</code>\n` +
        `• Total tokens: <code>${stats.promptTokens + stats.completionTokens}</code>`,
      "html"
    );
  });

  bot.command("reset", async (ctx) => {
    const current = hubStore.getActiveNode(ctx.chat.id);
    hubStore.resetChat(ctx.chat.id, current);
    if (current && hub.getNode(current)) {
      try {
        hub.startRun(current, ctx.chat.id, "__builtin:reset", {
          onChunk: () => {},
          onApprovalReq: () => {},
          onDone: () => {},
        });
      } catch {
        // abaikan jika node sedang sibuk/offline
      }
    }
    await sendFormatted(
      ctx,
      `🧠 Riwayat percakapan ${current ? `untuk node <b>${escapeHtml(current)}</b> ` : ""}dan statistik token telah direset.`,
      "html"
    );
  });

  bot.callbackQuery(/^select_node:(.+)$/, async (ctx) => {
    const target = ctx.match[1]!;
    const node = hub.getNode(target);
    if (!node) {
      await ctx.answerCallbackQuery({ text: `Node "${target}" sedang offline.` });
      return;
    }

    hubStore.setActiveNode(ctx.chat!.id, target);
    await ctx.answerCallbackQuery({ text: `Dipilih: ${target}` });
    await ctx.editMessageText(
      `✅ Node aktif disetel ke: <b>${escapeHtml(target)}</b> (<code>${escapeHtml(node.info.hostname)}</code>)\n` +
        `Ketik pesan, <code>/status</code>, atau <code>$ &lt;perintah&gt;</code> untuk dieksekusi di node ini.`,
      { parse_mode: "HTML" }
    );
  });

  const handleApprovalCallback = async (ctx: Context, ok: boolean, approved: boolean) => {
    if (!ok) {
      await ctx
        .answerCallbackQuery({ text: "⚠️ Permintaan persetujuan sudah kedaluwarsa atau tidak valid." })
        .catch(() => undefined);
      return;
    }
    await ctx
      .answerCallbackQuery({
        text: approved ? "Perintah disetujui." : "Perintah ditolak.",
      })
      .catch(() => undefined);

    const statusText = approved
      ? "✅ <b>DISETUJUI</b> oleh operator."
      : "❌ <b>DITOLAK</b> oleh operator.";
    const originalText = ctx.callbackQuery?.message?.text ?? "";
    await ctx
      .editMessageText(`${escapeHtml(originalText)}\n\n${statusText}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => undefined);
  };

  // Callback persetujuan ringkas (<=64 byte): ap:<approvalId>:<yes|no>
  bot.callbackQuery(/^ap:([^:]+):(yes|no)$/, async (ctx) => {
    const [, approvalId, decision] = ctx.match;
    const approved = decision === "yes";
    const ok = hub.resolveApprovalById(approvalId!, approved, ctx.chat?.id);
    await handleApprovalCallback(ctx, ok, approved);
  });

  // Callback persetujuan legacy: appr:<nodeId>:<runId>:<approvalId>:<yes|no>
  bot.callbackQuery(/^appr:([^:]+):([^:]+):([^:]+):(yes|no)$/, async (ctx) => {
    const [, nodeId, runId, approvalId, decision] = ctx.match;
    const approved = decision === "yes";
    const ok = hub.sendApproval(nodeId!, runId!, approvalId!, approved, ctx.chat?.id);
    await handleApprovalCallback(ctx, ok, approved);
  });

  // Handler pesan teks biasa / mention di grup
  bot.on("message:text", async (ctx) => {
    let prompt = ctx.message.text.trim();
    if (prompt.startsWith("/")) return;

    // Di grup, hapus semua variasi mention @botUsername dari prompt sebelum dikirim ke node
    if (ctx.chat.type !== "private") {
      for (const bu of getBotUsernames(ctx)) {
        prompt = prompt.replace(new RegExp(escapeRegExp(`@${bu}`), "gi"), "").trim();
      }
    }

    if (!prompt) return;

    const current = await requireActiveNode(ctx);
    if (!current) return;

    const isDirectShell = prompt.startsWith("$ ");
    await executeOnNode(ctx, current, prompt, { rememberInHistory: !isDirectShell });
  });

  bot.catch((err) => {
    console.error("[hub:bot] Unhandled error:", err.error);
  });

  return bot;
}

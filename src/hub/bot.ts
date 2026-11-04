import { Bot, Context, InlineKeyboard } from "grammy";
import { BroadcastNodeProgress, ConnectedNode, HubServer, NodeBroadcastResult } from "./server";
import { HubStore } from "./store";
import { chunkHtml, escapeHtml, escapeRegExp, preBlock, renderMarkdown } from "../shared/format";
import { checkAndApplyUpdate, getGitVersionInfo, scheduleSelfRestart } from "../shared/updater";

const SYNTAX_UNIT = /^[A-Za-z0-9@_.:-]+$/;

function fitText(text: string, width: number): string {
  if (text.length > width) return `${text.slice(0, width - 1)}…`;
  return text.padEnd(width);
}

function stripNodePrefix(nodeId: string, text: string): string {
  const escaped = escapeRegExp(nodeId);
  return text
    .replace(new RegExp(`^\\s*\\[${escaped}\\]\\s*\\n?`), "")
    .replace(new RegExp(`^\\s*🖥️\\s*\\*\\*\\[${escaped}\\]\\*\\*\\s*\\n?`), "")
    .trim();
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

  const tableRows: string[] = [
    `${"NODE".padEnd(13)} ST ${"LOAD".padStart(4)} ${"RAM".padStart(7)} ${"UP".padStart(4)}`,
    "─".repeat(34),
  ];

  for (const n of sortedNodes) {
    const res = resultMap.get(n.nodeId);
    const cores = n.info.cpus ?? 0;
    const totMb = n.info.memory?.totalMb ?? 0;
    const freeMb = n.info.memory?.freeMb ?? 0;
    const uMb = Math.max(0, totMb - freeMb);
    const memPct = totMb > 0 ? Math.round((uMb / totMb) * 100) : 0;
    const load1 = n.info.loadAvg?.[0] ?? 0;
    const upH = `${Math.round((n.info.uptime ?? 0) / 3600)}h`;

    totalCores += cores;
    totalRamMb += totMb;
    usedRamMb += uMb;

    const hasFailInStatus = res?.status === "ok" && /\bFAIL\b/.test(res.fullText);
    const isWarn = memPct >= 90 || (cores > 0 && load1 > cores * 1.5) || hasFailInStatus;
    const isErr = res && res.status !== "ok";
    if (!isErr && !isWarn) healthyCount += 1;

    const stLabel = isErr ? "ER" : isWarn ? "WN" : "OK";
    const uGb = Math.round(uMb / 1024);
    const tGb = Math.max(1, Math.round(totMb / 1024));
    const ramLabel = `${uGb}/${tGb}G`.padStart(7);

    tableRows.push(
      `${fitText(n.nodeId, 13)} ${stLabel} ${load1.toFixed(2).padStart(4)} ${ramLabel} ${upH.padStart(4)}`
    );
  }

  const fleetRamPct = totalRamMb > 0 ? Math.round((usedRamMb / totalRamMb) * 100) : 0;
  const sections: string[] = [
    `📊 **RINGKASAN STATUS FLEET (${sortedNodes.length} Node Online)**`,
    `• Kesehatan Fleet: \`${healthyCount}/${sortedNodes.length} node normal\` · Node aktif chat: \`${activeNodeId || "(belum dipilih)"}\``,
    `• Kapasitas Total: \`${totalCores} vCPU\` · RAM Fleet: \`${(usedRamMb / 1024).toFixed(1)}G / ${(totalRamMb / 1024).toFixed(1)}G (${fleetRamPct}%)\``,
    "",
    "```text",
    ...tableRows,
    "```",
  ];

  sortedNodes.forEach((n, idx) => {
    const res = resultMap.get(n.nodeId);
    const distroLabel = n.info.distro
      ? `${n.info.distro.id} ${n.info.distro.version}`.trim()
      : `${n.info.platform}/${n.info.arch}`;
    const activeBadge = n.nodeId === activeNodeId ? " · **[AKTIF]**" : "";
    const durSec = res ? `${(res.durationMs / 1000).toFixed(1)}s` : "-";

    sections.push("");
    sections.push(
      `🖥️ **[${idx + 1}/${sortedNodes.length}] ${n.nodeId}** (\`${n.info.hostname}\` · ${distroLabel} · ${durSec})${activeBadge}`
    );

    if (!res) {
      sections.push("```text\n(Data status live belum tersedia)\n```");
    } else if (res.status !== "ok") {
      sections.push(`❌ Gagal mengambil status: \`${res.error || "Unknown error"}\``);
    } else {
      sections.push(stripNodePrefix(n.nodeId, res.fullText));
    }
  });

  return sections.join("\n");
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

  const summaryTable: string[] = [
    `${"NODE".padEnd(18)} ${"STATUS".padEnd(6)} ${"WAKTU".padStart(8)}`,
    "─".repeat(34),
    ...sorted.map((r) => {
      const st = r.status === "ok" ? "OK" : r.status === "aborted" ? "STOP" : "ERROR";
      const sec = `${(r.durationMs / 1000).toFixed(1)}s`;
      return `${fitText(r.nodeId, 18)} ${st.padEnd(6)} ${sec.padStart(8)}`;
    }),
  ];

  const lines: string[] = [
    `📡 **LAPORAN BROADCAST FLEET (${okCount}/${sorted.length} Sukses · ${totalSec}s)**`,
    `• Instruksi: \`${prompt.replace(/`/g, "'").slice(0, 180)}\``,
    ...(errCount > 0 ? [`• Perhatian: \`${errCount} node gagal / dihentikan\``] : []),
    "",
    "```text",
    ...summaryTable,
    "```",
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
    lines.push(`🖥️ **[${idx + 1}/${sorted.length}] ${r.nodeId}** (\`${r.hostname}\` · ${r.distroName}) — ${badge}`);

    if (r.status === "ok") {
      const cleaned = stripNodePrefix(r.nodeId, r.fullText);
      lines.push(cleaned || "`(Selesai tanpa output teks)`");
    } else if (r.status === "aborted") {
      lines.push("`(Eksekusi dihentikan oleh operator)`");
    } else {
      lines.push(`\`\`\`text\n${r.error || "Unknown error"}\n\`\`\``);
    }
  });

  return lines.join("\n");
}

export interface BotConfig {
  token: string;
  botName?: string;
  allowedUsers: number[];
  allowedChats?: number[];
  defaultModel?: string;
  notifyNodeEvents?: boolean;
}

export const HUB_BOT_COMMANDS = [
  { command: "start", description: "Informasi bot & panduan singkat" },
  { command: "help", description: "Daftar lengkap perintah fleet & SRE" },
  { command: "nodes", description: "Daftar server node yang online" },
  { command: "use", description: "Pilih target node: /use <node>" },
  { command: "unuse", description: "Lepas pilihan target node" },
  { command: "status", description: "Dashboard kondisi server (/status [node|all])" },
  { command: "summary", description: "Dashboard ringkasan & status live seluruh node" },
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
  { command: "id", description: "Tampilkan Telegram User ID & Chat ID" },
];

export function createHubBot(config: BotConfig, hub: HubServer, store?: HubStore): Bot {
  const bot = new Bot(config.token);
  const hubStore = store ?? new HubStore("./hub-state.json");
  const allowedChats = config.allowedChats ?? [];
  const defaultModel = config.defaultModel || process.env.MODEL_NAME || process.env.OPENAI_MODEL || "ag/gemini-3.8-flash";

  function isAuthorized(ctx: Context): boolean {
    const fromId = ctx.from?.id;
    if (!fromId) return false;
    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(fromId)) {
      return false;
    }
    if (allowedChats.length > 0) {
      const chatId = ctx.chat?.id;
      if (chatId === undefined || !allowedChats.includes(chatId)) return false;
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

  // Middleware Otorisasi
  bot.use(async (ctx, next) => {
    if (!isAuthorized(ctx)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "⛔ Akses ditolak." }).catch(() => undefined);
      } else if (ctx.message) {
        await ctx.reply("⛔ Akses ditolak. User atau chat tidak terdaftar di allowlist.");
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

    const nodes = hub.listNodes();
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
    await sendFormatted(
      ctx,
      `👤 User ID: <code>${ctx.from?.id ?? "-"}</code>\n💬 Chat ID: <code>${ctx.chat?.id ?? "-"}</code>`,
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
    await sendFormatted(ctx, "ℹ️ Target node dilepas. Gunakan <code>/use &lt;node&gt;</code> untuk memilih kembali.", "html");
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

  bot.command("summary", async (ctx) => {
    await runFleetSummary(ctx);
  });

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

    // Jika di grup dan botName diset, dukung mention @botName
    if (ctx.chat.type !== "private" && config.botName) {
      const mention = `@${config.botName}`.toLowerCase();
      if (!prompt.toLowerCase().includes(mention) && !prompt.startsWith("$ ")) {
        return;
      }
      prompt = prompt.replace(new RegExp(escapeRegExp(`@${config.botName}`), "gi"), "").trim();
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

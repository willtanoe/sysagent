import { Bot, Context, InlineKeyboard } from "grammy";
import { HubServer } from "./server";
import { HubStore } from "./store";
import { chunkHtml, escapeHtml, escapeRegExp, preBlock, renderMarkdown } from "../shared/format";

const SYNTAX_UNIT = /^[A-Za-z0-9@_.:-]+$/;

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
  { command: "disk", description: "Cek penggunaan disk di node aktif" },
  { command: "mem", description: "Cek penggunaan memory di node aktif" },
  { command: "ps", description: "Proses paling boros CPU di node aktif" },
  { command: "ports", description: "Port TCP yang listening di node aktif" },
  { command: "logs", description: "Tail journal service: /logs <unit> [baris]" },
  { command: "svc", description: "Kontrol service: /svc <aksi> <unit>" },
  { command: "exec", description: "Jalankan shell langsung: /exec <perintah>" },
  { command: "chat", description: "Konsultasi & operasi AI: /chat <prompt>" },
  { command: "stop", description: "Hentikan eksekusi yang sedang berjalan" },
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

  bot.command("status", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const current = hubStore.getActiveNode(ctx.chat.id);
    const targetNodeId = arg && arg !== "all" ? arg : current;

    if (arg === "all" || !targetNodeId) {
      const nodes = hub.listNodes();
      let text = `📊 <b>Ringkasan Fleet Aster Hub</b>\n`;
      text += `• Total node online: <b>${nodes.length}</b>\n`;
      text += `• Node aktif chat ini: <b>${escapeHtml(current || "(belum dipilih)")}</b>\n\n`;

      if (nodes.length > 0) {
        const rows = nodes.map((n) => {
          const load = n.info.loadAvg?.[0]?.toFixed(2) ?? "0.00";
          const usedMb = Math.max(0, (n.info.memory?.totalMb ?? 0) - (n.info.memory?.freeMb ?? 0));
          const totalMb = n.info.memory?.totalMb ?? 0;
          const upH = `${Math.round((n.info.uptime ?? 0) / 3600)}h`;
          return `${n.nodeId.padEnd(12)} load ${load.padStart(5)}  ram ${String(usedMb).padStart(5)}/${totalMb}M  up ${upH}`;
        });
        text += preBlock(rows.join("\n"));
      }
      await sendFormatted(ctx, text, "html");
      return;
    }

    await executeOnNode(ctx, targetNodeId, "__builtin:status");
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

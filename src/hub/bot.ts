import { Bot, InlineKeyboard } from "grammy";
import { HubServer } from "./server";
import { escapeHtml } from "../shared/format";

export interface BotConfig {
  token: string;
  allowedUsers: number[];
}

export function createHubBot(config: BotConfig, hub: HubServer): Bot {
  const bot = new Bot(config.token);
  const chatActiveNode = new Map<number, string>();

  // Filter otorisasi user
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || (config.allowedUsers.length > 0 && !config.allowedUsers.includes(fromId))) {
      await ctx.reply("⛔ Akses ditolak. User tidak terdaftar.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      `👋 <b>Aster Hub Fleet Manager</b>\n\n` +
      `Satu bot untuk mengelola seluruh fleet VPS:\n` +
      `• <code>/nodes</code> - Lihat daftar VPS yang terhubung\n` +
      `• <code>/use &lt;node&gt;</code> - Pilih VPS target eksekusi\n` +
      `• <code>/unuse</code> - Lepas pilihan VPS\n` +
      `• <code>/status</code> - Status hub & node aktif\n\n` +
      `Ketik pesan apa saja setelah memilih node untuk menjalankan perintah atau konsultasi ops.`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("nodes", async (ctx) => {
    const nodes = hub.listNodes();
    if (nodes.length === 0) {
      await ctx.reply("❌ Tidak ada node yang terhubung saat ini.");
      return;
    }

    const current = chatActiveNode.get(ctx.chat.id);
    let text = `🌐 <b>Daftar Node Terhubung (${nodes.length})</b>:\n\n`;
    const keyboard = new InlineKeyboard();

    nodes.forEach((n, idx) => {
      const isCurrent = n.nodeId === current;
      const badge = isCurrent ? " <b>[AKTIF]</b>" : "";
      const load = n.info.loadAvg?.[0]?.toFixed(2) ?? "0.00";
      const freeMem = n.info.memory?.freeMb ?? "?";
      const totalMem = n.info.memory?.totalMb ?? "?";

      text += `${idx + 1}. <b>${n.nodeId}</b>${badge}\n`;
      text += `   Host: <code>${n.info.hostname}</code> (${n.info.platform}/${n.info.arch})\n`;
      text += `   Load: ${load} | RAM: ${freeMem}MB free / ${totalMem}MB\n\n`;

      keyboard.text(`${isCurrent ? "✓ " : ""}${n.nodeId}`, `select_node:${n.nodeId}`);
      if ((idx + 1) % 2 === 0) keyboard.row();
    });

    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.command("use", async (ctx) => {
    const target = ctx.message?.text?.split(/\s+/)[1]?.trim();
    if (!target) {
      await ctx.reply("⚠️ Format: <code>/use &lt;nama_node&gt;</code>\nContoh: <code>/use junin</code>", {
        parse_mode: "HTML",
      });
      return;
    }

    const node = hub.getNode(target);
    if (!node) {
      await ctx.reply(`❌ Node "${target}" tidak ditemukan atau sedang offline. Cek <code>/nodes</code>.`, {
        parse_mode: "HTML",
      });
      return;
    }

    chatActiveNode.set(ctx.chat.id, target);
    await ctx.reply(`✅ Node aktif disetel ke: <b>${target}</b> (${node.info.hostname})`, {
      parse_mode: "HTML",
    });
  });

  bot.command("unuse", async (ctx) => {
    chatActiveNode.delete(ctx.chat.id);
    await ctx.reply("Target node dilepas. Gunakan /use untuk memilih node lagi.");
  });

  bot.command("status", async (ctx) => {
    const nodes = hub.listNodes();
    const current = chatActiveNode.get(ctx.chat.id);
    const nodeObj = current ? hub.getNode(current) : undefined;

    let text = `📊 <b>Status Aster Hub</b>:\n`;
    text += `• Total fleet online: <b>${nodes.length} node</b>\n`;
    text += `• Node aktif chat ini: <b>${current || "(belum dipilih)"}</b>\n`;

    if (nodeObj) {
      text += `  - Host: <code>${nodeObj.info.hostname}</code>\n`;
      text += `  - Uptime: ${Math.round(nodeObj.info.uptime / 3600)} jam\n`;
      text += `  - Load: ${nodeObj.info.loadAvg.map((l) => l.toFixed(2)).join(", ")}\n`;
    }

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^select_node:(.+)$/, async (ctx) => {
    const target = ctx.match[1];
    const node = hub.getNode(target);
    if (!node) {
      await ctx.answerCallbackQuery({ text: `Node "${target}" offline.` });
      return;
    }

    chatActiveNode.set(ctx.chat!.id, target);
    await ctx.answerCallbackQuery({ text: `Dipilih: ${target}` });
    await ctx.editMessageText(
      `✅ Node aktif disetel ke: <b>${target}</b> (${node.info.hostname})\n` +
      `Ketik pesan apa saja untuk menjalankan perintah di node ini.`,
      { parse_mode: "HTML" }
    );
  });

  // Approval buttons: appr:<nodeId>:<runId>:<approvalId>:<yes|no>
  bot.callbackQuery(/^appr:([^:]+):([^:]+):([^:]+):(yes|no)$/, async (ctx) => {
    const [, nodeId, runId, approvalId, decision] = ctx.match;
    const approved = decision === "yes";

    hub.sendApproval(nodeId, runId, approvalId, approved);
    await ctx.answerCallbackQuery({
      text: approved ? "Perintah disetujui." : "Perintah ditolak.",
    });

    const statusText = approved ? "✅ <b>DISETUJUI</b> oleh admin." : "❌ <b>DITOLAK</b> oleh admin.";
    await ctx.editMessageText(
      `${ctx.callbackQuery.message?.text ?? ""}\n\n${statusText}`,
      { parse_mode: "HTML" }
    );
  });

  // Handler prompt pesan biasa
  bot.on("message:text", async (ctx) => {
    const prompt = ctx.message.text.trim();
    if (prompt.startsWith("/")) return; // command lain sudah dihandle

    const current = chatActiveNode.get(ctx.chat.id);
    if (!current) {
      const nodes = hub.listNodes();
      const keyboard = new InlineKeyboard();
      nodes.forEach((n, idx) => {
        keyboard.text(n.nodeId, `select_node:${n.nodeId}`);
        if ((idx + 1) % 2 === 0) keyboard.row();
      });

      await ctx.reply(
        `⚠️ <b>Belum ada node yang dipilih.</b>\nPilih salah satu VPS target di bawah ini atau ketik <code>/use &lt;nama_node&gt;</code>:`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
      return;
    }

    const node = hub.getNode(current);
    if (!node) {
      await ctx.reply(`❌ Node <b>${current}</b> sedang offline. Cek <code>/nodes</code>.`, {
        parse_mode: "HTML",
      });
      return;
    }

    const initialMsg = await ctx.reply(`⏳ <b>[${current}]</b> Menjalankan...`, {
      parse_mode: "HTML",
    });

    let lastText = "";
    let lastEditTime = 0;

    const updatePreview = async (text: string) => {
      const now = Date.now();
      if (now - lastEditTime < 1500) return; // throttle telegram edit rate limit
      lastEditTime = now;
      lastText = text;
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          initialMsg.message_id,
          `⏳ <b>[${escapeHtml(current)}]</b>\n\n${escapeHtml(text.slice(-3000))}`,
          { parse_mode: "HTML" }
        );
      } catch {
        // abaikan rate limit / unchanged text
      }
    };

    try {
      let currentRunId = "";
      currentRunId = hub.startRun(current, ctx.chat.id, prompt, {
        onChunk: (chunk) => {
          lastText += chunk;
          void updatePreview(lastText);
        },
        onApprovalReq: async (approvalId, command, reason) => {
          const kb = new InlineKeyboard()
            .text("✅ Setujui", `appr:${current}:${currentRunId}:${approvalId}:yes`)
            .text("❌ Tolak", `appr:${current}:${currentRunId}:${approvalId}:no`);

          await ctx.reply(
            `⚠️ <b>Persetujuan Diperlukan di [${escapeHtml(current)}]</b>\n\n` +
            `Perintah: <code>${escapeHtml(command)}</code>\n` +
            `Alasan: <i>${escapeHtml(reason)}</i>`,
            { parse_mode: "HTML", reply_markup: kb }
          );
        },
        onDone: async (fullText, error) => {
          const content = error
            ? `❌ <b>[${escapeHtml(current)}] Error</b>:\n${escapeHtml(error)}`
            : `🖥️ <b>[${escapeHtml(current)}]</b>\n\n${escapeHtml(fullText)}`;

          try {
            await ctx.api.editMessageText(
              ctx.chat.id,
              initialMsg.message_id,
              content.slice(0, 4000),
              { parse_mode: "HTML" }
            );
          } catch {
            await ctx.reply(content.slice(0, 4000), { parse_mode: "HTML" });
          }
        },
      });
    } catch (err: any) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        initialMsg.message_id,
        `❌ Gagal memulai eksekusi di [${current}]: ${err.message}`
      );
    }
  });

  return bot;
}

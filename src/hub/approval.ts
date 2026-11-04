import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import { escapeHtml, preBlock } from "../shared/format";

export interface ApprovalRequest {
  nodeId: string;
  runId?: string;
  approvalId: string;
  command: string;
  reason: string;
  chatId: number;
  userId?: number;
  topicId?: number;
  source?: "direct" | "broadcast" | "remote";
}

export interface ApprovalBatchItem {
  approvalId: string;
  nodeId: string;
  runId?: string;
  command: string;
  reason: string;
  createdAt: number;
}

export interface ApprovalBatch {
  batchId: string;
  chatId: number;
  userId?: number;
  topicId?: number;
  command: string;
  reason: string;
  items: Map<string, ApprovalBatchItem>;
  nodes: Set<string>;
  messageId?: number;
  debounceTimer?: NodeJS.Timeout;
  editTimer?: NodeJS.Timeout;
  resolved: boolean;
  decision?: boolean;
  decidedBy?: string;
  createdAt: number;
}

export interface DecisionCacheEntry {
  approved: boolean;
  decidedAt: number;
  expiresAt: number;
  userId?: number;
  command: string;
}

export interface TelegramApi {
  sendMessage(
    chatId: number,
    text: string,
    opts?: {
      parse_mode?: "HTML";
      reply_markup?: any;
      message_thread_id?: number;
    }
  ): Promise<{ message_id: number }>;

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: {
      parse_mode?: "HTML";
      reply_markup?: any;
    }
  ): Promise<any>;

  answerCallbackQuery(
    callbackQueryId: string,
    opts?: { text?: string; show_alert?: boolean }
  ): Promise<any>;
}

export type ApprovalResolver = (
  approvalId: string,
  approved: boolean,
  chatId?: number,
  userId?: number
) => boolean;

export interface ApprovalBatcherOptions {
  debounceMs?: number;
  cacheTtlMs?: number;
}

export class ApprovalBatcher {
  private batchesById = new Map<string, ApprovalBatch>();
  private activeBatches = new Map<string, ApprovalBatch>();
  private decisionCache = new Map<string, DecisionCacheEntry>();
  private telegram: TelegramApi;
  private resolver: ApprovalResolver;
  private debounceMs: number;
  private cacheTtlMs: number;

  constructor(
    telegram: TelegramApi,
    resolver: ApprovalResolver,
    opts?: ApprovalBatcherOptions
  ) {
    this.telegram = telegram;
    this.resolver = resolver;
    this.debounceMs = opts?.debounceMs ?? 350;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 5 * 60 * 1000;
  }

  normalizeCommand(cmd: string): string {
    return cmd.trim().replace(/\r\n/g, "\n");
  }

  private getBatchKey(chatId: number, userId: number | undefined, command: string): string {
    const userPart = userId ? String(userId) : "all";
    return `${chatId}:${userPart}:${this.normalizeCommand(command)}`;
  }

  private getCacheKey(chatId: number, userId: number | undefined, command: string): string {
    const userPart = userId ? String(userId) : "all";
    return `${chatId}:${userPart}:${this.normalizeCommand(command)}`;
  }

  async onRequest(req: ApprovalRequest): Promise<{ batchId?: string; autoResolved: boolean; approved?: boolean }> {
    const cacheKey = this.getCacheKey(req.chatId, req.userId, req.command);
    const cached = this.decisionCache.get(cacheKey);

    // 1. Cek riwayat keputusan terbaru untuk perintah identik (Auto-Decision Memory)
    if (cached && Date.now() < cached.expiresAt) {
      this.resolver(req.approvalId, cached.approved, req.chatId, req.userId);
      console.log(
        `[approval-batch] Auto-${cached.approved ? "approved" : "rejected"} node [${req.nodeId}] untuk perintah: "${req.command.slice(0, 35)}"`
      );
      return { autoResolved: true, approved: cached.approved };
    }

    const batchKey = this.getBatchKey(req.chatId, req.userId, req.command);
    let batch = this.activeBatches.get(batchKey);

    // 2. Gabungkan ke batch aktif jika perintah identik sedang menunggu persetujuan
    if (batch && !batch.resolved) {
      batch.items.set(req.approvalId, {
        approvalId: req.approvalId,
        nodeId: req.nodeId,
        runId: req.runId,
        command: req.command,
        reason: req.reason,
        createdAt: Date.now(),
      });
      batch.nodes.add(req.nodeId);

      // Jika pesan Telegram sudah terkirim, jadwalkan pembaruan teks (live update daftar node & jumlah)
      if (batch.messageId) {
        this.scheduleMessageUpdate(batch);
      }
      return { batchId: batch.batchId, autoResolved: false };
    }

    // 3. Buat batch baru jika belum ada
    const batchId = "b_" + crypto.randomBytes(4).toString("hex");
    batch = {
      batchId,
      chatId: req.chatId,
      userId: req.userId,
      topicId: req.topicId,
      command: req.command,
      reason: req.reason,
      items: new Map([
        [
          req.approvalId,
          {
            approvalId: req.approvalId,
            nodeId: req.nodeId,
            runId: req.runId,
            command: req.command,
            reason: req.reason,
            createdAt: Date.now(),
          },
        ],
      ]),
      nodes: new Set([req.nodeId]),
      resolved: false,
      createdAt: Date.now(),
    };

    this.activeBatches.set(batchKey, batch);
    this.batchesById.set(batchId, batch);

    // Beri jeda debounce sebelum mengirim pesan awal agar node-node serentak tergabung dalam 1 pesan
    batch.debounceTimer = setTimeout(() => {
      void this.sendBatchMessage(batch!);
    }, this.debounceMs);

    return { batchId, autoResolved: false };
  }

  private async sendBatchMessage(batch: ApprovalBatch): Promise<void> {
    if (batch.resolved) return;
    const text = this.renderBatchPromptHtml(batch);
    const kb = this.renderBatchKeyboard(batch);

    try {
      const res = await this.telegram.sendMessage(batch.chatId, text, {
        parse_mode: "HTML",
        reply_markup: kb,
        ...(batch.topicId && batch.topicId > 1 ? { message_thread_id: batch.topicId } : {}),
      });
      batch.messageId = res.message_id;
    } catch (err: any) {
      console.error("[approval-batch] Gagal mengirim pesan approval batch:", err?.message ?? err);
    }
  }

  private scheduleMessageUpdate(batch: ApprovalBatch): void {
    if (batch.editTimer || batch.resolved || !batch.messageId) return;
    batch.editTimer = setTimeout(async () => {
      batch.editTimer = undefined;
      if (batch.resolved || !batch.messageId) return;
      const text = this.renderBatchPromptHtml(batch);
      const kb = this.renderBatchKeyboard(batch);
      try {
        await this.telegram.editMessageText(batch.chatId, batch.messageId, text, {
          parse_mode: "HTML",
          reply_markup: kb,
        });
      } catch (err: any) {
        if (!err?.message?.includes("message is not modified")) {
          console.error("[approval-batch] Gagal memperbarui pesan batch:", err?.message ?? err);
        }
      }
    }, 250);
  }

  renderBatchPromptHtml(batch: ApprovalBatch): string {
    const nodes = Array.from(batch.nodes).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
    const count = nodes.length;

    let targetSummary: string;
    if (count === 1) {
      targetSummary = `<b>Server:</b> <code>${escapeHtml(nodes[0]!)}</code>`;
    } else if (count <= 6) {
      targetSummary = `<b>Target (${count} Node):</b> <code>${escapeHtml(nodes.join(", "))}</code>`;
    } else {
      const firstFive = nodes.slice(0, 5).join(", ");
      const remaining = count - 5;
      targetSummary = `<b>Target (${count} Node):</b> <code>${escapeHtml(firstFive)}</code> <i>(+${remaining} node lainnya)</i>`;
    }

    const title = count === 1
      ? `🔐 <b>Persetujuan Diperlukan [${escapeHtml(nodes[0]!)}]</b>`
      : `🔐 <b>Persetujuan Diperlukan (${count} Node)</b>`;

    return (
      `${title}\n` +
      `${targetSummary}\n` +
      `<b>Alasan:</b> <i>${escapeHtml(batch.reason)}</i>\n\n` +
      `${preBlock(batch.command, "bash")}`
    );
  }

  renderBatchKeyboard(batch: ApprovalBatch): InlineKeyboard {
    const count = batch.nodes.size;
    const kb = new InlineKeyboard();

    if (count === 1) {
      kb.text("✅ Setujui", `apb:${batch.batchId}:yes`).row();
      kb.text("❌ Tolak", `apb:${batch.batchId}:no`);
    } else {
      kb.text(`✅ Setujui Semua (${count} Node)`, `apb:${batch.batchId}:yes`).row();
      kb.text(`❌ Tolak Semua (${count} Node)`, `apb:${batch.batchId}:no`);
    }

    return kb;
  }

  async handleCallback(ctx: any, batchId: string, approved: boolean): Promise<boolean> {
    const batch = this.batchesById.get(batchId);
    if (!batch) {
      await ctx.answerCallbackQuery({
        text: "Persetujuan ini tidak ditemukan atau sudah kedaluwarsa.",
      }).catch(() => undefined);
      return false;
    }

    if (batch.resolved) {
      await ctx.answerCallbackQuery({
        text: "Persetujuan ini sudah diproses sebelumnya.",
      }).catch(() => undefined);
      return false;
    }

    const callerId = ctx.from?.id;
    if (batch.userId !== undefined && callerId !== undefined && callerId !== batch.userId) {
      await ctx.answerCallbackQuery({
        text: "⚠️ Hanya pengguna yang menjalankan perintah ini yang berhak memberikan persetujuan.",
        show_alert: true,
      }).catch(() => undefined);
      return false;
    }

    if (batch.debounceTimer) clearTimeout(batch.debounceTimer);
    if (batch.editTimer) clearTimeout(batch.editTimer);

    batch.resolved = true;
    batch.decision = approved;

    const callerName =
      [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") ||
      (ctx.from?.username ? `@${ctx.from.username}` : "operator");
    batch.decidedBy = callerName;

    // Simpan keputusan ke cache agar node terlambat/berurutan di-resolve otomatis (TTL 5 menit)
    const cacheKey = this.getCacheKey(batch.chatId, batch.userId, batch.command);
    this.decisionCache.set(cacheKey, {
      approved,
      decidedAt: Date.now(),
      expiresAt: Date.now() + this.cacheTtlMs,
      userId: batch.userId,
      command: batch.command,
    });

    // Eksekusi persetujuan ke seluruh node yang tergabung dalam batch
    let resolvedCount = 0;
    for (const item of batch.items.values()) {
      const ok = this.resolver(item.approvalId, approved, batch.chatId, batch.userId);
      if (ok) resolvedCount++;
    }

    const count = batch.nodes.size;
    const actionLabel = approved ? "disetujui" : "ditolak";
    const answerText = count === 1
      ? `Perintah ${actionLabel}.`
      : `${count} node berhasil ${actionLabel}.`;

    await ctx.answerCallbackQuery({ text: answerText }).catch(() => undefined);

    const statusBanner = approved
      ? (count === 1
          ? `✅ <b>DISETUJUI</b> oleh ${escapeHtml(callerName)}.`
          : `✅ <b>DISETUJUI SEMUA (${count} Node)</b> oleh ${escapeHtml(callerName)}.`)
      : (count === 1
          ? `❌ <b>DITOLAK</b> oleh ${escapeHtml(callerName)}.`
          : `❌ <b>DITOLAK SEMUA (${count} Node)</b> oleh ${escapeHtml(callerName)}.`);

    const basePrompt = this.renderBatchPromptHtml(batch);
    const finalHtml = `${basePrompt}\n\n${statusBanner}`;

    if (batch.messageId) {
      await ctx.api
        .editMessageText(batch.chatId, batch.messageId, finalHtml, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        })
        .catch((err: any) => {
          if (!err?.message?.includes("message is not modified")) {
            console.error("[approval-batch] Edit final status failed:", err?.message ?? err);
          }
        });
    }

    return true;
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.decisionCache.entries()) {
      if (now >= entry.expiresAt) this.decisionCache.delete(key);
    }
    for (const [id, batch] of this.batchesById.entries()) {
      if (now - batch.createdAt > 30 * 60 * 1000) {
        this.batchesById.delete(id);
      }
    }
  }
}

import { escapeHtml } from "../shared/format";

export type ProgressPhase = "thinking" | "tool" | "writing" | "approval" | "shell";

export interface ProgressToolEntry {
  command: string;
  remote: boolean;
  blocked: boolean;
}

export interface ProgressSnapshot {
  nodeId: string;
  phase: ProgressPhase;
  elapsedMs: number;
  tools: ProgressToolEntry[];
  textTail: string;
  frame: number;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_LINE_RE = /(?:^|\n)(⚙️|🌐|🚫)\s*(?:\*\*\[BLOCKED\]\*\*[^`]*)?`([^`\n]+)`/g;

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
}

/** Ekstrak daftar tool/command yang dijalankan agent dari marker chunk (⚙️ / 🌐 / 🚫). */
export function extractTools(text: string): ProgressToolEntry[] {
  const out: ProgressToolEntry[] = [];
  TOOL_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_LINE_RE.exec(text))) {
    out.push({ command: m[2]!.trim(), remote: m[1] === "🌐", blocked: m[1] === "🚫" });
  }
  return out;
}

function clip(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/** Render pesan status live (HTML Telegram). Fungsi murni agar mudah diuji. */
export function renderProgress(s: ProgressSnapshot): string {
  const spin = SPINNER[s.frame % SPINNER.length];
  const time = formatElapsed(s.elapsedMs);
  const node = `<b>[${escapeHtml(s.nodeId)}]</b>`;

  const label: Record<ProgressPhase, string> = {
    thinking: "🤔 Berpikir",
    tool: "🔧 Menjalankan perintah",
    writing: "✍️ Menulis jawaban",
    approval: "🔐 Menunggu persetujuan Anda",
    shell: "⚙️ Mengeksekusi",
  };

  const lines: string[] = [`${spin} ${node} ${label[s.phase]}… <code>${time}</code>`];

  const shown = s.tools.slice(-3);
  if (shown.length > 0) {
    const hidden = s.tools.length - shown.length;
    if (hidden > 0) lines.push(`<i>… ${hidden} langkah sebelumnya selesai</i>`);
    shown.forEach((t, idx) => {
      const isLast = idx === shown.length - 1;
      const icon = t.blocked ? "🚫" : isLast && s.phase === "tool" ? "⏳" : "✅";
      const prefix = t.remote ? "🌐 " : "";
      lines.push(`${icon} <code>${escapeHtml(prefix + clip(t.command, 70))}</code>`);
    });
  }

  if (s.textTail.trim() && (s.phase === "writing" || s.phase === "shell")) {
    lines.push(`<pre>${escapeHtml(s.textTail.slice(-1200))}</pre>`);
  }

  if (s.elapsedMs >= 60_000) {
    lines.push(`<i>Sudah ${time}. Tugas masih berjalan, kirim /stop untuk membatalkan.</i>`);
  } else if (s.elapsedMs >= 20_000) {
    lines.push(`<i>Masih berjalan — tugas berat biasanya butuh 30–90 detik.</i>`);
  }

  return lines.join("\n");
}

export interface RunProgressOptions {
  nodeId: string;
  /** Prompt asli, dipakai untuk menentukan mode (shell langsung / builtin / AI). */
  prompt: string;
  /** Interval edit pesan status (ms). */
  editIntervalMs: number;
  /** Interval kirim "typing" (ms). */
  typingIntervalMs?: number;
  sendTyping: () => Promise<unknown>;
  editStatus: (html: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * Menjaga indikator "sedang bekerja" tetap hidup: typing action + pesan status
 * yang di-edit berkala (fase, timer, langkah tool, cuplikan jawaban).
 */
export class RunProgress {
  private opts: RunProgressOptions;
  private startedAt: number;
  private text = "";
  private lastChunkHadTool = false;
  private approvalPending = false;
  private frame = 0;
  private lastRendered = "";
  private editTimer: NodeJS.Timeout | null = null;
  private typingTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private editing = false;
  private isShell: boolean;

  constructor(opts: RunProgressOptions) {
    this.opts = opts;
    this.startedAt = (opts.now ?? Date.now)();
    const p = opts.prompt.trim();
    this.isShell = p.startsWith("$ ") || p.startsWith("__builtin:");
  }

  start(): void {
    void this.opts.sendTyping().catch(() => undefined);
    this.typingTimer = setInterval(() => {
      if (!this.stopped) void this.opts.sendTyping().catch(() => undefined);
    }, this.opts.typingIntervalMs ?? 4500);
    this.editTimer = setInterval(() => void this.tick(), this.opts.editIntervalMs);
    this.typingTimer.unref?.();
    this.editTimer.unref?.();
  }

  onChunk(chunk: string): void {
    this.text += chunk;
    this.approvalPending = false;
    this.lastChunkHadTool = /(?:^|\n)(?:⚙️|🌐)\s*`/.test(chunk);
  }

  setApprovalPending(pending: boolean): void {
    this.approvalPending = pending;
  }

  elapsedMs(): number {
    return (this.opts.now ?? Date.now)() - this.startedAt;
  }

  snapshot(): ProgressSnapshot {
    let phase: ProgressPhase;
    if (this.approvalPending) phase = "approval";
    else if (this.isShell) phase = "shell";
    else if (this.lastChunkHadTool) phase = "tool";
    else if (this.text.trim()) phase = "writing";
    else phase = "thinking";

    return {
      nodeId: this.opts.nodeId,
      phase,
      elapsedMs: this.elapsedMs(),
      tools: this.isShell ? [] : extractTools(this.text),
      textTail: this.text,
      frame: this.frame,
    };
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.editing) return;
    this.frame += 1;
    const html = renderProgress(this.snapshot());
    if (html === this.lastRendered) return;
    this.lastRendered = html;
    this.editing = true;
    try {
      await this.opts.editStatus(html);
    } catch {
      // abaikan rate limit / message not modified
    } finally {
      this.editing = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.editTimer) clearInterval(this.editTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.editTimer = null;
    this.typingTimer = null;
  }
}

import { Bot, Context, InlineKeyboard } from "grammy";
import { 中枢服务器 } from "./server";
import { 中枢存储类 } from "./store";
import { 块超文本标记, 转义超文本标记, 转义正则指数, 预阻断, 渲染标记文本 } from "../shared/format";
const 语法单元 = /^[A-Za-z0-9@_.:-]+$/;
export interface 机器人配置 {
    令牌: string;
    机器人名称?: string;
    允许用户列表: number[];
    允许聊天列表?: number[];
    默认模型?: string;
    通知节点事件列表?: boolean;
}
export const 中枢机器人命令列表 = [
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
    { command: "ecc", description: "Katalog & workflow ECC: /ecc [skills|agents|commands|<workflow>]" },
    { command: "stop", description: "Hentikan eksekusi yang sedang berjalan" },
    { command: "auditcheck", description: "Verifikasi rantai hash audit log di node" },
    { command: "model", description: "Lihat atau ganti model AI: /model [id|reset]" },
    { command: "usage", description: "Statistik pemakaian token chat ini" },
    { command: "reset", description: "Hapus riwayat percakapan di node aktif" },
    { command: "id", description: "Tampilkan Telegram User ID & Chat ID" },
];
export function 创建中枢机器人(配置: 机器人配置, 中枢: 中枢服务器, 存储?: 中枢存储类): Bot {
    const 机器人 = new Bot(配置.令牌);
    const 中枢存储实例 = 存储 ?? new 中枢存储类("./hub-state.json");
    const 允许聊天列表 = 配置.允许聊天列表 ?? [];
    const 默认模型 = 配置.默认模型 || process.env.MODEL_NAME || process.env.OPENAI_MODEL || "ag/gemini-3.8-flash";
    function 是否已授权(上下文简称: Context): boolean {
        const 来自标识 = 上下文简称.from?.id;
        if (!来自标识)
            return false;
        if (配置.允许用户列表.length > 0 && !配置.允许用户列表.includes(来自标识)) {
            return false;
        }
        if (允许聊天列表.length > 0) {
            const 聊天标识 = 上下文简称.chat?.id;
            if (聊天标识 === undefined || !允许聊天列表.includes(聊天标识))
                return false;
        }
        return true;
    }
    async function 发送已格式化(上下文简称: Context, 文本: string, 运行模式: "md" | "html" = "md"): Promise<void> {
        const 消息块列表 = 运行模式 === "html" ? 块超文本标记(文本) : 渲染标记文本(文本);
        for (const 数据块 of 消息块列表) {
            try {
                await 上下文简称.reply(数据块, {
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true },
                });
            }
            catch {
                await 上下文简称.reply(数据块.replace(/<[^>]*>/g, "").slice(0, 4000));
            }
        }
    }
    // 将节点的主动告警转发给主管理员
    const 主管理员 = 配置.允许用户列表[0];
    if (主管理员 !== undefined) {
        中枢.on("node_alert", (私有节点标识: string, 私有键: string, 私有严重度: string, 超文本标记: string) => {
            void 机器人.api
                .sendMessage(主管理员, 超文本标记, {
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
            })
                .catch((错误对象) => console.error("[bot:alert] Gagal kirim alert ke admin:", 错误对象.message));
        });
        if (配置.通知节点事件列表) {
            中枢.on("node_joined", (节点标识: string, 信息: {
                主机名: string;
                发行版?: {
                    名称?: string;
                };
                平台: string;
            }) => {
                const 操作系统名称 = 信息.发行版?.名称 || 信息.平台;
                void 机器人.api
                    .sendMessage(主管理员, `🟢 <b>Node Online:</b> <code>${转义超文本标记(节点标识)}</code> (${转义超文本标记(信息.主机名)} · ${转义超文本标记(操作系统名称)})`, { parse_mode: "HTML" })
                    .catch(() => undefined);
            });
            中枢.on("node_left", (节点标识: string) => {
                void 机器人.api
                    .sendMessage(主管理员, `🔴 <b>Node Terputus:</b> <code>${转义超文本标记(节点标识)}</code>`, {
                    parse_mode: "HTML",
                })
                    .catch(() => undefined);
            });
        }
    }
    // 授权中间件
    机器人.use(async (上下文简称, 下一个) => {
        if (!是否已授权(上下文简称)) {
            if (上下文简称.callbackQuery) {
                await 上下文简称.answerCallbackQuery({ text: "⛔ Akses ditolak." }).catch(() => undefined);
            }
            else if (上下文简称.message) {
                await 上下文简称.reply("⛔ Akses ditolak. User atau chat tidak terdaftar di allowlist.");
            }
            return;
        }
        await 下一个();
    });
    // 将 prompt/command 执行到指定节点的辅助函数
    async function 执行当节点(上下文简称: Context, 节点标识: string, 提示词: string, 选项集?: {
        记住输入历史?: boolean;
    }): Promise<void> {
        const 聊天标识 = 上下文简称.chat?.id ?? 0;
        const 用户标识 = 上下文简称.from?.id ?? 0;
        const 节点 = 中枢.获取节点(节点标识);
        if (!节点) {
            await 发送已格式化(上下文简称, `❌ Node <b>${转义超文本标记(节点标识)}</b> sedang offline. Ketik <code>/nodes</code> untuk melihat daftar server aktif.`, "html");
            return;
        }
        const 初始消息 = await 上下文简称.reply(`⏳ <b>[${转义超文本标记(节点标识)}]</b> Memproses...`, {
            parse_mode: "HTML",
        });
        let 最后文本 = "";
        let 最后编辑时间 = 0;
        let 编辑已禁用 = false;
        const 更新预览 = async (文本: string) => {
            if (编辑已禁用)
                return;
            const 当前时间 = Date.now();
            if (当前时间 - 最后编辑时间 < 1500)
                return;
            最后编辑时间 = 当前时间;
            try {
                await 上下文简称.api.editMessageText(聊天标识, 初始消息.message_id, `⏳ <b>[${转义超文本标记(节点标识)}]</b>\n<pre>${转义超文本标记(文本.slice(-3200))}</pre>`, { parse_mode: "HTML" });
            }
            catch {
                // 忽略速率限制/未变更文本
            }
        };
        try {
            let 当前运行标识 = "";
            const 模型覆盖 = 中枢存储实例.获取模型覆盖(聊天标识);
            const 历史 = 选项集?.记住输入历史 ? 中枢存储实例.获取历史(聊天标识, 节点标识) : undefined;
            当前运行标识 = 中枢.启动运行(节点标识, 聊天标识, 提示词, {
                当块: (数据块) => {
                    最后文本 += 数据块;
                    void 更新预览(最后文本);
                },
                当审批请求: async (审批标识, 命令, 原因) => {
                    const 千字节 = new InlineKeyboard()
                        .text("✅ Setujui", `ap:${审批标识}:yes`)
                        .text("❌ Tolak", `ap:${审批标识}:no`);
                    await 上下文简称.reply(`🔐 <b>Persetujuan Diperlukan di [${转义超文本标记(节点标识)}]</b>\n` +
                        `Alasan: <i>${转义超文本标记(原因)}</i>\n\n` +
                        `${预阻断(命令, "bash")}`, { parse_mode: "HTML", reply_markup: 千字节 });
                },
                当完成: async (完整文本, 错误, 用量) => {
                    编辑已禁用 = true;
                    if (用量) {
                        中枢存储实例.添加用量(聊天标识, 用量);
                    }
                    if (选项集?.记住输入历史 && !错误) {
                        中枢存储实例.记住(聊天标识, 节点标识, 提示词, 完整文本);
                    }
                    try {
                        await 上下文简称.api.deleteMessage(聊天标识, 初始消息.message_id);
                    }
                    catch {
                        // 若删除失败，将被覆盖或发送新消息
                    }
                    if (错误 === "ABORTED") {
                        await 发送已格式化(上下文简称, `⏹ <b>[${转义超文本标记(节点标识)}]</b> Tugas dihentikan.`, "html");
                        return;
                    }
                    if (错误) {
                        await 发送已格式化(上下文简称, `❌ <b>[${转义超文本标记(节点标识)}] Error</b>\n${预阻断(错误)}`, "html");
                        return;
                    }
                    const 头部 = 完整文本.startsWith(`[${节点标识}]`) ? "" : `🖥️ **[${节点标识}]**\n`;
                    await 发送已格式化(上下文简称, `${头部}${完整文本}`, "md");
                },
            }, 模型覆盖, { 用户标识, 历史 });
        }
        catch (错误对象: any) {
            await 上下文简称.api
                .editMessageText(聊天标识, 初始消息.message_id, `❌ Gagal memulai eksekusi di [${转义超文本标记(节点标识)}]: ${转义超文本标记(错误对象.message)}`, { parse_mode: "HTML" })
                .catch(() => undefined);
        }
    }
    async function 要求活跃节点(上下文简称: Context): Promise<string | null> {
        const 聊天标识 = 上下文简称.chat?.id ?? 0;
        const 当前 = 中枢存储实例.获取活跃节点(聊天标识);
        if (当前)
            return 当前;
        const 节点列表 = 中枢.列出节点列表();
        const 键盘 = new InlineKeyboard();
        节点列表.forEach((数量索引, 下标) => {
            键盘.text(数量索引.节点标识, `select_node:${数量索引.节点标识}`);
            if ((下标 + 1) % 2 === 0)
                键盘.row();
        });
        await 上下文简称.reply(`⚠️ <b>Belum ada server node yang dipilih.</b>\nPilih target di bawah ini atau ketik <code>/use &lt;nama_node&gt;</code>:`, { parse_mode: "HTML", reply_markup: 键盘 });
        return null;
    }
    机器人.command("start", async (上下文简称) => {
        await 发送已格式化(上下文简称, `👋 <b>Aster Fleet Manager</b>\n\n` +
            `Satu kendali terpusat untuk mengelola seluruh server kantor secara aman (outbound WSS, approval gate, dan tamper-evident audit).\n\n` +
            `• <code>/nodes</code> — Lihat daftar server yang terhubung\n` +
            `• <code>/use &lt;node&gt;</code> — Pilih server target aktif\n` +
            `• <code>/status</code> — Dashboard kesehatan server\n` +
            `• <code>/help</code> — Daftar lengkap perintah SRE\n\n` +
            `Ketik pesan atau <code>$ &lt;perintah&gt;</code> setelah memilih node.`, "html");
    });
    机器人.command("help", async (上下文简称) => {
        const 行列表 = [
            `<b>Aster Fleet Manager — Panduan Perintah</b>`,
            "",
            ...中枢机器人命令列表.map((项目) => `• /<b>${项目.command}</b> — ${转义超文本标记(项目.description)}`),
            "",
            "<b>Shortcut Eksekusi:</b>",
            "• Kirim teks biasa atau <code>/chat &lt;pertanyaan&gt;</code> untuk analisis & aksi AI SRE",
            "• Kirim <code>$ &lt;perintah&gt;</code> atau <code>/exec &lt;perintah&gt;</code> untuk shell langsung",
            ...(配置.机器人名称 ? [`• Mention <code>@${转义超文本标记(配置.机器人名称)} &lt;pesan&gt;</code> di grup`] : []),
        ];
        await 发送已格式化(上下文简称, 行列表.join("\n"), "html");
    });
    机器人.command("id", async (上下文简称) => {
        await 发送已格式化(上下文简称, `👤 User ID: <code>${上下文简称.from?.id ?? "-"}</code>\n💬 Chat ID: <code>${上下文简称.chat?.id ?? "-"}</code>`, "html");
    });
    机器人.command("nodes", async (上下文简称) => {
        const 节点列表 = 中枢.列出节点列表();
        if (节点列表.length === 0) {
            await 发送已格式化(上下文简称, "❌ Tidak ada server node yang terhubung saat ini.", "html");
            return;
        }
        const 当前 = 中枢存储实例.获取活跃节点(上下文简称.chat.id);
        let 文本 = `🌐 <b>Daftar Server Terhubung (${节点列表.length})</b>:\n\n`;
        const 键盘 = new InlineKeyboard();
        节点列表.forEach((数量索引, 下标) => {
            const 是否当前 = 数量索引.节点标识 === 当前;
            const 徽章 = 是否当前 ? " <b>[AKTIF]</b>" : "";
            const 加载 = 数量索引.信息.加载平均值?.[0]?.toFixed(2) ?? "0.00";
            const 空闲内存 = 数量索引.信息.记忆?.空闲兆字节 ?? "?";
            const 总计内存 = 数量索引.信息.记忆?.总计兆字节 ?? "?";
            const 发行版名称 = 数量索引.信息.发行版 ? `${数量索引.信息.发行版.标识} ${数量索引.信息.发行版.版本}`.trim() : `${数量索引.信息.平台}/${数量索引.信息.架构}`;
            const 上升小时 = Math.round((数量索引.信息.运行时长 || 0) / 3600);
            文本 += `${下标 + 1}. <b>${转义超文本标记(数量索引.节点标识)}</b>${徽章}\n`;
            文本 += `   Host: <code>${转义超文本标记(数量索引.信息.主机名)}</code> (${转义超文本标记(发行版名称)})\n`;
            文本 += `   Load: <code>${加载}</code> | RAM: <code>${空闲内存}/${总计内存} MB free</code> | Up: <code>${上升小时}h</code>\n\n`;
            键盘.text(`${是否当前 ? "✓ " : ""}${数量索引.节点标识}`, `select_node:${数量索引.节点标识}`);
            if ((下标 + 1) % 2 === 0)
                键盘.row();
        });
        await 上下文简称.reply(文本, { parse_mode: "HTML", reply_markup: 键盘 });
    });
    机器人.command("use", async (上下文简称) => {
        const 目标 = (上下文简称.match ?? "").trim().split(/\s+/)[0];
        if (!目标) {
            await 发送已格式化(上下文简称, "⚠️ Format: <code>/use &lt;nama_node&gt;</code>\nContoh: <code>/use hongyun</code>", "html");
            return;
        }
        const 节点 = 中枢.获取节点(目标);
        if (!节点) {
            await 发送已格式化(上下文简称, `❌ Node "<b>${转义超文本标记(目标)}</b>" tidak ditemukan atau sedang offline. Cek <code>/nodes</code>.`, "html");
            return;
        }
        中枢存储实例.设置活跃节点(上下文简称.chat.id, 目标);
        await 发送已格式化(上下文简称, `✅ Node aktif disetel ke: <b>${转义超文本标记(目标)}</b> (<code>${转义超文本标记(节点.信息.主机名)}</code>)`, "html");
    });
    机器人.command("unuse", async (上下文简称) => {
        中枢存储实例.设置活跃节点(上下文简称.chat.id, null);
        await 发送已格式化(上下文简称, "ℹ️ Target node dilepas. Gunakan <code>/use &lt;node&gt;</code> untuk memilih kembali.", "html");
    });
    机器人.command("status", async (上下文简称) => {
        const 参数 = (上下文简称.match ?? "").trim();
        const 当前 = 中枢存储实例.获取活跃节点(上下文简称.chat.id);
        const 目标节点标识 = 参数 && 参数 !== "all" ? 参数 : 当前;
        if (参数 === "all" || !目标节点标识) {
            const 节点列表 = 中枢.列出节点列表();
            let 文本 = `📊 <b>Ringkasan Fleet Aster Hub</b>\n`;
            文本 += `• Total node online: <b>${节点列表.length}</b>\n`;
            文本 += `• Node aktif chat ini: <b>${转义超文本标记(当前 || "(belum dipilih)")}</b>\n\n`;
            if (节点列表.length > 0) {
                const 记录列表 = 节点列表.map((数量索引) => {
                    const 加载 = 数量索引.信息.加载平均值?.[0]?.toFixed(2) ?? "0.00";
                    const 已使用兆字节 = Math.max(0, (数量索引.信息.记忆?.总计兆字节 ?? 0) - (数量索引.信息.记忆?.空闲兆字节 ?? 0));
                    const 总计兆字节 = 数量索引.信息.记忆?.总计兆字节 ?? 0;
                    const 上升主机 = `${Math.round((数量索引.信息.运行时长 ?? 0) / 3600)}h`;
                    return `${数量索引.节点标识.padEnd(12)} load ${加载.padStart(5)}  ram ${String(已使用兆字节).padStart(5)}/${总计兆字节}M  up ${上升主机}`;
                });
                文本 += 预阻断(记录列表.join("\n"));
            }
            await 发送已格式化(上下文简称, 文本, "html");
            return;
        }
        await 执行当节点(上下文简称, 目标节点标识, "__builtin:status");
    });
    机器人.command("disk", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        await 执行当节点(上下文简称, 目标, "$ df -h -x tmpfs -x devtmpfs");
    });
    机器人.command("mem", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        await 执行当节点(上下文简称, 目标, "$ free -h");
    });
    机器人.command("ps", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        await 执行当节点(上下文简称, 目标, "$ ps aux --sort=-%cpu | head -12");
    });
    机器人.command("ports", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        await 执行当节点(上下文简称, 目标, "$ ss -ltnp");
    });
    机器人.command("logs", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        const [单元, 原始行列表] = (上下文简称.match ?? "").trim().split(/\s+/);
        if (!单元 || !语法单元.test(单元)) {
            await 发送已格式化(上下文简称, "⚠️ Format: <code>/logs &lt;unit&gt; [jumlah_baris]</code>\nContoh: <code>/logs nginx 80</code>", "html");
            return;
        }
        const 行列表 = Math.min(Math.max(Number(原始行列表) || 80, 1), 500);
        await 执行当节点(上下文简称, 目标, `$ journalctl -u ${单元} -n ${行列表} --no-pager -o cat`);
    });
    机器人.command("svc", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        const [动作, 单元] = (上下文简称.match ?? "").trim().split(/\s+/);
        const 允许动作列表 = ["status", "start", "stop", "restart", "reload", "enable", "disable"];
        if (!动作 || !允许动作列表.includes(动作) || !单元 || !语法单元.test(单元)) {
            await 发送已格式化(上下文简称, `⚠️ Format: <code>/svc &lt;aksi&gt; &lt;unit&gt;</code>\nAksi: ${允许动作列表.join(", ")}\nContoh: <code>/svc restart nginx</code>`, "html");
            return;
        }
        const 命令 = 动作 === "status"
            ? `$ systemctl status ${单元} --no-pager -l | head -25`
            : `$ systemctl ${动作} ${单元} --no-pager && systemctl status ${单元} --no-pager -l | head -20`;
        await 执行当节点(上下文简称, 目标, 命令);
    });
    机器人.command("exec", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        const 命令文本 = (上下文简称.match ?? "").trim();
        if (!命令文本) {
            await 发送已格式化(上下文简称, "⚠️ Format: <code>/exec &lt;perintah_shell&gt;</code>", "html");
            return;
        }
        await 执行当节点(上下文简称, 目标, `$ ${命令文本}`);
    });
    机器人.command("chat", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        const 提示词 = (上下文简称.match ?? "").trim();
        if (!提示词) {
            await 发送已格式化(上下文简称, "⚠️ Format: <code>/chat &lt;pertanyaan_atau_instruksi&gt;</code>", "html");
            return;
        }
        await 执行当节点(上下文简称, 目标, 提示词, { 记住输入历史: true });
    });
    机器人.command("ecc", async (上下文简称) => {
        const 目标 = await 要求活跃节点(上下文简称);
        if (!目标)
            return;
        const 原始参数 = (上下文简称.match ?? "").trim();
        if (!原始参数) {
            await 执行当节点(上下文简称, 目标, "__builtin:ecc:status");
            return;
        }
        const 部分 = 原始参数.split(/\s+/);
        const 子 = 部分[0]!.toLowerCase();
        const 剩余 = 部分.slice(1).join(" ").trim();
        if (["status", "info", "skills", "agents", "commands"].includes(子) && !剩余) {
            await 执行当节点(上下文简称, 目标, `__builtin:ecc:${子}`);
            return;
        }
        if (!剩余 && !["verify", "security", "security-scan", "code-review", "harness-audit", "pm2"].includes(子)) {
            await 执行当节点(上下文简称, 目标, `__builtin:ecc:${子}`);
            return;
        }
        await 执行当节点(上下文简称, 目标, `ecc:${子} ${剩余}`.trim(), { 记住输入历史: true });
    });
    机器人.command("stop", async (上下文简称) => {
        const 已取消 = 中枢.取消聊天运行列表(上下文简称.chat.id);
        if (已取消 === 0) {
            await 发送已格式化(上下文简称, "ℹ️ Tidak ada eksekusi yang sedang berjalan di chat ini.", "html");
        }
        else {
            await 发送已格式化(上下文简称, `⏹ Sinyal penghentian dikirim ke <b>${已取消}</b> tugas aktif.`, "html");
        }
    });
    机器人.command("auditcheck", async (上下文简称) => {
        const 参数 = (上下文简称.match ?? "").trim();
        const 目标 = 参数 || (await 要求活跃节点(上下文简称));
        if (!目标)
            return;
        await 执行当节点(上下文简称, 目标, "__builtin:auditcheck");
    });
    机器人.command("model", async (上下文简称) => {
        const 参数 = (上下文简称.match ?? "").trim();
        const 当前覆盖 = 中枢存储实例.获取模型覆盖(上下文简称.chat.id);
        const 活跃模型 = 当前覆盖 || 默认模型;
        const 当前节点 = 中枢存储实例.获取活跃节点(上下文简称.chat.id);
        if (!参数) {
            await 发送已格式化(上下文简称, `🤖 <b>Konfigurasi Model AI</b>\n` +
                `• Aktif: <code>${转义超文本标记(活跃模型)}</code> ${当前覆盖 ? "(override chat ini)" : "(default)"}\n\n` +
                `Ganti model: <code>/model &lt;id_model&gt;</code>\n` +
                `Kembali ke default: <code>/model reset</code>`, "html");
            if (当前节点 && 中枢.获取节点(当前节点)) {
                await 执行当节点(上下文简称, 当前节点, "__builtin:models");
            }
            return;
        }
        if (参数 === "reset" || 参数 === "default") {
            中枢存储实例.设置模型覆盖(上下文简称.chat.id, null);
            await 发送已格式化(上下文简称, `↩️ Model dikembalikan ke default: <code>${转义超文本标记(默认模型)}</code>`, "html");
            return;
        }
        中枢存储实例.设置模型覆盖(上下文简称.chat.id, 参数);
        await 发送已格式化(上下文简称, `✅ Model AI untuk chat ini disetel ke: <code>${转义超文本标记(参数)}</code>`, "html");
    });
    机器人.command("usage", async (上下文简称) => {
        const 统计 = 中枢存储实例.获取用量(上下文简称.chat.id);
        await 发送已格式化(上下文简称, `📊 <b>Statistik Token Chat Ini</b>\n` +
            `• Request AI: <code>${统计.请求列表}</code>\n` +
            `• Prompt tokens: <code>${统计.提示词令牌列表}</code>\n` +
            `• Completion tokens: <code>${统计.补全令牌列表}</code>\n` +
            `• Total tokens: <code>${统计.提示词令牌列表 + 统计.补全令牌列表}</code>`, "html");
    });
    机器人.command("reset", async (上下文简称) => {
        const 当前 = 中枢存储实例.获取活跃节点(上下文简称.chat.id);
        中枢存储实例.重置聊天(上下文简称.chat.id, 当前);
        if (当前 && 中枢.获取节点(当前)) {
            try {
                中枢.启动运行(当前, 上下文简称.chat.id, "__builtin:reset", {
                    当块: () => { },
                    当审批请求: () => { },
                    当完成: () => { },
                });
            }
            catch {
                // 若节点忙/离线则忽略
            }
        }
        await 发送已格式化(上下文简称, `🧠 Riwayat percakapan ${当前 ? `untuk node <b>${转义超文本标记(当前)}</b> ` : ""}dan statistik token telah direset.`, "html");
    });
    机器人.callbackQuery(/^select_node:(.+)$/, async (上下文简称) => {
        const 目标 = 上下文简称.match[1]!;
        const 节点 = 中枢.获取节点(目标);
        if (!节点) {
            await 上下文简称.answerCallbackQuery({ text: `Node "${目标}" sedang offline.` });
            return;
        }
        中枢存储实例.设置活跃节点(上下文简称.chat!.id, 目标);
        await 上下文简称.answerCallbackQuery({ text: `Dipilih: ${目标}` });
        await 上下文简称.editMessageText(`✅ Node aktif disetel ke: <b>${转义超文本标记(目标)}</b> (<code>${转义超文本标记(节点.信息.主机名)}</code>)\n` +
            `Ketik pesan, <code>/status</code>, atau <code>$ &lt;perintah&gt;</code> untuk dieksekusi di node ini.`, { parse_mode: "HTML" });
    });
    const 处理审批回调 = async (上下文简称: Context, 是否成功: boolean, 已批准: boolean) => {
        if (!是否成功) {
            await 上下文简称.answerCallbackQuery({ text: "⚠️ Permintaan persetujuan sudah kedaluwarsa atau tidak valid." })
                .catch(() => undefined);
            return;
        }
        await 上下文简称.answerCallbackQuery({
            text: 已批准 ? "Perintah disetujui." : "Perintah ditolak.",
        })
            .catch(() => undefined);
        const 状态文本 = 已批准 ? "✅ <b>DISETUJUI</b> oleh operator."
            : "❌ <b>DITOLAK</b> oleh operator.";
        const 原始文本 = 上下文简称.callbackQuery?.message?.text ?? "";
        await 上下文简称.editMessageText(`${转义超文本标记(原始文本)}\n\n${状态文本}`, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
        })
            .catch(() => undefined);
    };
    // 简短审批回调 (<=64 字节)：ap:<approvalId>:<yes|no>
    机器人.callbackQuery(/^ap:([^:]+):(yes|no)$/, async (上下文简称) => {
        const [, 审批标识, 决策] = 上下文简称.match;
        const 已批准 = 决策 === "yes";
        const 是否成功 = 中枢.解析审批按标识(审批标识!, 已批准, 上下文简称.chat?.id);
        await 处理审批回调(上下文简称, 是否成功, 已批准);
    });
    // 旧版审批回调：appr:<nodeId>:<runId>:<approvalId>:<yes|no>
    机器人.callbackQuery(/^appr:([^:]+):([^:]+):([^:]+):(yes|no)$/, async (上下文简称) => {
        const [, 节点标识, 运行标识, 审批标识, 决策] = 上下文简称.match;
        const 已批准 = 决策 === "yes";
        const 是否成功 = 中枢.发送审批(节点标识!, 运行标识!, 审批标识!, 已批准, 上下文简称.chat?.id);
        await 处理审批回调(上下文简称, 是否成功, 已批准);
    });
    // 普通文本消息/群组 mention 处理器
    机器人.on("message:text", async (上下文简称) => {
        let 提示词 = 上下文简称.message.text.trim();
        if (提示词.startsWith("/"))
            return;
        // 若在群组且设置了 botName，支持 @botName mention
        if (上下文简称.chat.type !== "private" && 配置.机器人名称) {
            const 提及 = `@${配置.机器人名称}`.toLowerCase();
            if (!提示词.toLowerCase().includes(提及) && !提示词.startsWith("$ ")) {
                return;
            }
            提示词 = 提示词.replace(new RegExp(转义正则指数(`@${配置.机器人名称}`), "gi"), "").trim();
        }
        if (!提示词)
            return;
        const 当前 = await 要求活跃节点(上下文简称);
        if (!当前)
            return;
        const 是否直接Shell = 提示词.startsWith("$ ");
        await 执行当节点(上下文简称, 当前, 提示词, { 记住输入历史: !是否直接Shell });
    });
    机器人.catch((错误对象) => {
        console.error("[hub:bot] Unhandled error:", 错误对象.error);
    });
    return 机器人;
}


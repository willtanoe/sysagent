import * as dotenv from "dotenv";
import { run } from "@grammyjs/runner";
import { 中枢服务器, 解析节点令牌列表 } from "./server";
import { 创建中枢机器人, 中枢机器人命令列表 } from "./bot";
import { 中枢存储类 } from "./store";
dotenv.config();
function 列出标识列表(原始: string | undefined): number[] {
    return (原始 || "")
        .split(",")
        .map((字符串) => Number(字符串.trim()))
        .filter((数量索引) => Number.isFinite(数量索引) && 数量索引 !== 0);
}
const 主机 = process.env.HUB_HOST || "0.0.0.0";
const 端口 = Number(process.env.HUB_PORT || 8765);
const 密钥令牌 = process.env.HUB_TOKEN || "";
const 节点令牌列表 = 解析节点令牌列表(process.env.NODE_TOKENS);
const 机器人令牌 = process.env.TELEGRAM_BOT_TOKEN;
const 机器人名称 = process.env.BOT_NAME;
const 允许用户列表 = 列出标识列表(process.env.ALLOWED_USER_ID).filter((数量索引) => 数量索引 > 0);
const 允许聊天列表 = 列出标识列表(process.env.ALLOWED_CHAT_ID);
const 状态文件 = process.env.HUB_STATE_FILE || "./hub-state.json";
if (!密钥令牌 && Object.keys(节点令牌列表).length === 0) {
    console.error("[fatal] HUB_TOKEN atau NODE_TOKENS wajib diisi di .env sebelum menjalankan Hub.");
    process.exit(1);
}
async function 主程序() {
    console.log(`[boot] Memulai Aster Hub Fleet Manager...`);
    const 存储 = new 中枢存储类(状态文件);
    const 中枢 = new 中枢服务器(端口, 密钥令牌, {
        主机,
        节点令牌列表,
        传输层安全证书路径: process.env.TLS_CERT_PATH,
        传输层安全键路径: process.env.TLS_KEY_PATH,
    });
    await 中枢.启动();
    if (机器人令牌) {
        if (允许用户列表.length === 0) {
            console.warn("[warn] ALLOWED_USER_ID kosong! Sangat disarankan mengisi ALLOWED_USER_ID di .env untuk produksi.");
        }
        console.log(`[boot] Mengaktifkan Telegram Bot (concurrent runner)...`);
        const 机器人 = 创建中枢机器人({
            令牌: 机器人令牌,
            机器人名称,
            允许用户列表,
            允许聊天列表,
            默认模型: process.env.MODEL_NAME || process.env.OPENAI_MODEL,
            通知节点事件列表: process.env.NOTIFY_NODE_EVENTS !== "false",
        }, 中枢, 存储);
        await 机器人.api.setMyCommands(中枢机器人命令列表).catch((错误对象) => {
            console.warn("[boot] Gagal mendaftarkan daftar command Telegram:", 错误对象.message);
        });
        await 机器人.api.deleteWebhook({ drop_pending_updates: true }).catch(() => undefined);
        const 运行器 = run(机器人);
        console.log(`[boot] Telegram Bot aktif dan siap melayani fleet.`);
        let 正在停止 = false;
        const 关闭 = async (签名: string) => {
            if (正在停止)
                return;
            正在停止 = true;
            console.log(`\n[stop] Signal ${签名} diterima, mematikan Aster Hub...`);
            存储.刷新();
            await Promise.allSettled([运行器.stop(), 中枢.停止()]);
            process.exit(0);
        };
        process.on("SIGINT", () => void 关闭("SIGINT"));
        process.on("SIGTERM", () => void 关闭("SIGTERM"));
    }
    else {
        console.log(`[boot] TELEGRAM_BOT_TOKEN tidak diset. Hub berjalan dalam mode headless WSS Coordinator.`);
        const 关闭 = async () => {
            存储.刷新();
            await 中枢.停止();
            process.exit(0);
        };
        process.on("SIGINT", () => void 关闭());
        process.on("SIGTERM", () => void 关闭());
    }
}
主程序().catch((错误对象) => {
    console.error("[fatal] Gagal memulai Aster Hub:", 错误对象);
    process.exit(1);
});


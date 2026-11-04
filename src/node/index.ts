import * as dotenv from "dotenv";
import * as path from "path";
import { 节点执行器, 是否根 } from "./executor";
import { 节点引擎 } from "./engine";
import { 节点客户端 } from "./client";
import { 节点告警监控器 } from "./alerts";
import { isManagedOpenCode, ManagedOpenCodeServer } from "./opencode-server";
dotenv.config();
function 整数环境(值: string | undefined, 回退: number): number {
    const 已解析 = Number(值);
    return Number.isFinite(已解析) && 已解析 > 0 ? 已解析 : 回退;
}
function 列出环境(值: string | undefined): string[] {
    return (值 || "")
        .split(",")
        .map((字符串) => 字符串.trim())
        .filter(Boolean);
}
const 节点标识 = process.env.NODE_ID || "node-default";
const 中枢地址 = process.env.HUB_URL || "ws://127.0.0.1:8765";
const 中枢令牌 = process.env.NODE_TOKEN || process.env.HUB_TOKEN || "";
const 审计路径 = process.env.AUDIT_PATH || path.join(process.cwd(), `audit-${节点标识}.jsonl`);
const 引擎模式 = (process.env.ENGINE || "local").toLowerCase() === "opencode" ? "opencode" : "local";
if (!中枢令牌) {
    console.error("[fatal] HUB_TOKEN atau NODE_TOKEN wajib diisi di .env sebelum menjalankan node agent.");
    process.exit(1);
}
const 执行器 = new 节点执行器(节点标识, 审计路径, {
    提权密码: process.env.SUDO_PASSWORD,
    Shell超时毫秒: 整数环境(process.env.SHELL_TIMEOUT_MS, 120000),
    软件包超时毫秒: 整数环境(process.env.PACKAGE_TIMEOUT_MS, 900000),
    最大命令列表每分钟: 整数环境(process.env.MAX_COMMANDS_PER_MINUTE, 30),
});
const 引擎 = new 节点引擎(节点标识, 执行器, {
    引擎模式,
    模型: 引擎模式 === "opencode"
        ? process.env.OPENCODE_MODEL || "opencode/glm-5.3-flash-free"
        : process.env.MODEL_NAME || process.env.OPENAI_MODEL || "ag/gemini-3.8-flash",
    回退模型列表: 列出环境(process.env.MODEL_FALLBACK),
    接口键: process.env.GATEWAY_API_KEY || process.env.OPENAI_API_KEY,
    基础地址: process.env.GATEWAY_URL || process.env.GATEWAY_BASE_URL || process.env.OPENAI_BASE_URL,
    人工智能超时毫秒: 整数环境(process.env.AI_TIMEOUT_MS, 90000),
    最大工具循环: 整数环境(process.env.MAX_TOOL_LOOPS, 12),
    最大读取仅步骤: 整数环境(process.env.MAX_READ_ONLY_STEPS, 6),
    状态服务列表: 列出环境(process.env.STATUS_SERVICES),
});
let 客户端引用: 节点客户端 | null = null;
let 托管打开代码: ManagedOpenCodeServer | null = null;
const 告警监控器 = new 节点告警监控器(节点标识, 执行器, (事件对象) => (客户端引用 ? 客户端引用.发送告警(事件对象.键, 事件对象.严重度, 事件对象.超文本标记) : false), {
    间隔毫秒: 整数环境(process.env.ALERT_INTERVAL_MS, 300000),
    冷却毫秒: 整数环境(process.env.ALERT_COOLDOWN_MS, 1800000),
    磁盘百分比: 整数环境(process.env.ALERT_DISK_PCT, 90),
    内存百分比: 整数环境(process.env.ALERT_MEM_PCT, 92),
    忽略单元列表: 列出环境(process.env.ALERT_IGNORE_UNITS),
});
const 客户端 = new 节点客户端({
    中枢地址,
    节点标识,
    令牌: 中枢令牌,
    心跳间隔毫秒: 整数环境(process.env.HEARTBEAT_INTERVAL_MS, 15000),
    审批超时毫秒: 整数环境(process.env.APPROVAL_TIMEOUT_MS, 300000),
    传输层安全证书颁发机构路径: process.env.TLS_CA_PATH,
    传输层安全拒绝未授权: process.env.TLS_REJECT_UNAUTHORIZED !== "false",
}, 引擎, 告警监控器);
客户端引用 = 客户端;
async function 主程序() {
    const 捆绑 = isManagedOpenCode(引擎模式, process.env.OPENCODE_URL);
    console.log(`[boot] Memulai Aster Node Agent: id="${节点标识}" uid=${process.getuid?.() ?? "?"} root=${是否根} engine=${引擎模式}${引擎模式 === "opencode" ? (捆绑 ? "(bundled)" : "(external)") : ""}`);
    if (捆绑) {
        const 默认数据目录 = path.join(path.dirname(path.resolve(审计路径)), `opencode-${节点标识}`);
        托管打开代码 = new ManagedOpenCodeServer({
            bin: process.env.OPENCODE_BIN,
            port: 整数环境(process.env.OPENCODE_PORT, 0),
            password: process.env.OPENCODE_PASSWORD,
            dataDir: process.env.OPENCODE_DATA_DIR || 默认数据目录,
        });
        const { url: 地址, password: 密码 } = await 托管打开代码.start();
        引擎.设置打开代码端点(地址, 密码);
    }
    客户端.启动();
}
let 正在停止 = false;
const 关闭 = (信号: string) => {
    if (正在停止)
        return;
    正在停止 = true;
    console.log(`\n[stop] Signal ${信号} diterima, menghentikan node ${节点标识}...`);
    客户端.停止();
    void Promise.allSettled([托管打开代码 ? 托管打开代码.stop() : Promise.resolve()]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 6000).unref();
};
process.on("SIGINT", () => 关闭("SIGINT"));
process.on("SIGTERM", () => 关闭("SIGTERM"));
主程序().catch((错误对象) => {
    console.error(`[fatal:${节点标识}] Gagal memulai node agent:`, 错误对象);
    process.exit(1);
});


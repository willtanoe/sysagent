import { 节点执行器 } from "./executor";
import { 发行版 } from "./distro";
const 单元正则 = /^[A-Za-z0-9@_.:-]+\.service$/;
const 规则常量 = "─".repeat(34);
interface 服务状态 {
    名称: string;
    状态值: "up" | "down" | "fail";
}
function 人类字节(字节: number): string {
    const 单元列表 = ["B", "K", "M", "G", "T"];
    let 值内容 = 字节;
    let 索引 = 0;
    while (值内容 >= 1024 && 索引 < 单元列表.length - 1) {
        值内容 /= 1024;
        索引 += 1;
    }
    return `${值内容.toFixed(值内容 >= 10 || 索引 === 0 ? 0 : 1)}${单元列表[索引]}`;
}
export function 短运行时长(原始: string): string {
    const 值内容 = (匹配模式: RegExp): string => 匹配模式.exec(原始)?.[1] ?? "0";
    const 周 = 值内容(/(\d+)\s+week/);
    const 天数 = 值内容(/(\d+)\s+day/);
    const 小时 = 值内容(/(\d+)\s+hour/);
    const 分钟 = 值内容(/(\d+)\s+minute/);
    if (周 !== "0")
        return `${周}w${天数}d${小时}h`;
    if (天数 !== "0")
        return `${天数}d${小时}h`;
    if (小时 !== "0")
        return `${小时}h${分钟}m`;
    return `${分钟}m`;
}
export function 条(百分比: number, 宽度 = 10): string {
    const 钳制 = Math.max(0, Math.min(100, 百分比));
    const 已填充 = Math.round((钳制 / 100) * 宽度);
    return `[${"█".repeat(已填充)}${"░".repeat(宽度 - 已填充)}]`;
}
function 首个行(输出内容: string): string {
    return 输出内容.split("\n")[0]?.trim() ?? "";
}
function 数量(输出内容: string): number {
    const 已解析 = Number(首个行(输出内容));
    return Number.isFinite(已解析) ? 已解析 : 0;
}
function 缩短(文本: string, 最大: number): string {
    return 文本.length <= 最大 ? 文本 : `${文本.slice(0, 最大 - 1)}…`;
}
function 服务行(服务: 服务状态): string {
    const 图标 = 服务.状态值 === "up" ? "●" : 服务.状态值 === "fail" ? "✕" : "○";
    const 标签 = 服务.状态值 === "up" ? "up" : 服务.状态值 === "fail" ? "FAILED" : "down";
    return `  ${缩短(服务.名称, 18).padEnd(18)} ${图标} ${标签}`;
}
async function 解析状态单元列表(执行器: 节点执行器, 已配置单元列表?: string[]): Promise<string[]> {
    if (已配置单元列表 && 已配置单元列表.length > 0) {
        return 已配置单元列表.map((用户) => (用户.endsWith(".service") ? 用户 : `${用户}.service`))
            .filter((用户) => 单元正则.test(用户));
    }
    const 已列出 = await 执行器.执行原始("find /etc/systemd/system -maxdepth 1 -name '*.service' -printf '%f\\n' 2>/dev/null | sort", 5000);
    return 已列出.输出内容
        .split("\n")
        .map((行) => 行.trim())
        .filter((单元) => 单元正则.test(单元) && !单元.startsWith("dbus-org."))
        .slice(0, 8);
}
async function 收集服务列表(执行器: 节点执行器, 已配置单元列表?: string[]): Promise<服务状态[]> {
    const 单元列表 = await 解析状态单元列表(执行器, 已配置单元列表);
    if (单元列表.length === 0)
        return [];
    const 命令 = 单元列表.map((单元) => `printf '%s=%s\\n' '${单元}' "$(systemctl is-active '${单元}' 2>/dev/null)"`)
        .join("; ");
    const 结果 = await 执行器.执行原始(命令, 8000);
    return 结果.输出内容
        .split("\n")
        .map((行) => 行.trim())
        .filter((行) => 行.includes("="))
        .map((行) => {
        const [单元原始, 状态原始] = 行.split("=");
        const 状态值 = 状态原始 === "active" ? "up" : 状态原始 === "failed" ? "fail" : "down";
        return {
            名称: (单元原始 ?? "").replace(/\.service$/, ""),
            状态值: 状态值 as 服务状态["\u72B6\u6001\u503C"],
        };
    });
}
async function 收集进程管理二(执行器: 节点执行器): Promise<服务状态[]> {
    const 结果 = await 执行器.执行原始("command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null || true", 6000);
    const 原始 = 结果.输出内容.trim();
    if (原始 === "" || 原始 === "(tidak ada output)" || !原始.startsWith("["))
        return [];
    try {
        const 应用列表 = JSON.parse(原始) as Array<{
            名称?: string;
            进程管理二环境?: {
                状态?: string;
            };
        }>;
        return 应用列表.filter((应用) => (应用.名称 ?? "") !== "")
            .map((应用) => {
            const 状态 = 应用.进程管理二环境?.状态 ?? "";
            return {
                名称: 应用.名称 ?? "?",
                状态值: (状态 === "online" ? "up" : 状态 === "errored" ? "fail" : "down") as 服务状态["\u72B6\u6001\u503C"],
            };
        });
    }
    catch {
        return [];
    }
}
/** 为本节点构建 netdata 风格的 monospace 仪表盘。 */
export async function 构建节点状态文本(执行器: 节点执行器, 已配置单元列表?: string[]): Promise<string> {
    const [主机输出, 内核输出, 上升输出, 加载输出, 核心输出, 内存输出, 磁盘输出, 失败输出, 顶部输出, 端口列表输出, 进程输出, 网络输出, 服务列表, 进程管理二,] = await Promise.all([
        执行器.执行原始("hostname", 5000),
        执行器.执行原始("uname -r", 5000),
        执行器.执行原始("uptime -p", 5000),
        执行器.执行原始("cat /proc/loadavg", 5000),
        执行器.执行原始("nproc", 5000),
        执行器.执行原始("free -b | awk '/Mem:/{print $2, $3}'", 5000),
        执行器.执行原始("df -PB1 / | awk 'NR==2{print $2, $3, $5}'", 5000),
        执行器.执行原始("systemctl --failed --no-legend --no-pager 2>/dev/null | awk '{print $1}'", 5000),
        执行器.执行原始("ps -eo pcpu=,comm= --sort=-pcpu | awk '$2 !~ /^(ps|ss|awk|sed|bash|sh|cat|wc|head|tail|sort|nproc|df|free|uname|hostname|uptime|systemctl|command)$/ {print; n++; if (n==2) exit}'", 5000),
        执行器.执行原始("ss -ltn 2>/dev/null | tail -n +2 | wc -l", 5000),
        执行器.执行原始("ps -e --no-headers | wc -l", 5000),
        执行器.执行原始("awk 'NR>2 {gsub(/:/,\"\",$1); if ($1 != \"lo\") {rx+=$2; tx+=$10}} END {print rx+0, tx+0}' /proc/net/dev", 5000),
        收集服务列表(执行器, 已配置单元列表),
        收集进程管理二(执行器),
    ]);
    const 加载 = 加载输出.输出内容
        .trim()
        .split(/\s+/)
        .slice(0, 3)
        .map((值变量) => Number(值变量).toFixed(2))
        .join(" ");
    const 核心计数 = 数量(核心输出.输出内容);
    const [内存总计, 内存已使用] = 内存输出.输出内容.trim().split(/\s+/).map(Number);
    const 内存百分比 = 内存总计 && 内存已使用 ? Math.round((内存已使用 / 内存总计) * 100) : 0;
    const [磁盘大小原始, 磁盘已使用原始, 磁盘百分比原始] = 磁盘输出.输出内容.trim().split(/\s+/);
    const 磁盘大小 = Number(磁盘大小原始) || 0;
    const 磁盘已使用 = Number(磁盘已使用原始) || 0;
    const 磁盘百分比 = Number((磁盘百分比原始 ?? "0").replace("%", "")) || 0;
    const [接收原始, 事务原始] = 网络输出.输出内容.trim().split(/\s+/);
    const 接收 = Number(接收原始) || 0;
    const 事务 = Number(事务原始) || 0;
    const 失败单元列表 = 失败输出.输出内容
        .split("\n")
        .map((行) => 行.trim())
        .filter((行) => 行 !== "" && 行 !== "(tidak ada output)")
        .filter((单元) => 单元正则.test(单元));
    const 顶部 = 顶部输出.输出内容
        .split("\n")
        .map((行) => 行.trim())
        .filter((行) => 行 !== "" && 行 !== "(tidak ada output)")
        .map((行) => {
        const [处理器, ...名称] = 行.split(/\s+/);
        return { 名称: 名称.join(" ") || "?", 处理器: Math.round(Number(处理器) || 0) };
    });
    const 行列表: string[] = [];
    const 发行版标签 = `${发行版.标识.charAt(0).toUpperCase()}${发行版.标识.slice(1)} ${发行版.版本}`.trim();
    行列表.push(`${缩短(首个行(主机输出.输出内容), 14)} · ${缩短(发行版标签, 18)}`);
    行列表.push(`${缩短(首个行(内核输出.输出内容), 22)} · ${核心计数}c`);
    行列表.push(规则常量);
    行列表.push(`up    ${短运行时长(首个行(上升输出.输出内容))}`);
    行列表.push(`load  ${加载}`);
    行列表.push(`mem   ${条(内存百分比)} ${String(内存百分比).padStart(3)}%  ${人类字节(内存已使用 || 0)}/${人类字节(内存总计 || 0)}`);
    行列表.push(`disk  ${条(磁盘百分比)} ${String(磁盘百分比).padStart(3)}%  ${人类字节(磁盘已使用)}/${人类字节(磁盘大小)}`);
    行列表.push(`net   rx ${人类字节(接收)} tx ${人类字节(事务)}`);
    行列表.push(`proc  ${数量(进程输出.输出内容)} · port ${数量(端口列表输出.输出内容)}`);
    行列表.push(规则常量);
    行列表.push("services");
    if (失败单元列表.length > 0) {
        const 已列出 = new Set(服务列表.map((字符串) => 字符串.名称));
        for (const 单元 of 失败单元列表.slice(0, 3)) {
            const 名称 = 单元.replace(/\.service$/, "");
            if (!已列出.has(名称))
                行列表.push(服务行({ 名称, 状态值: "fail" }));
        }
    }
    if (服务列表.length > 0) {
        for (const 服务 of 服务列表)
            行列表.push(服务行(服务));
    }
    else if (失败单元列表.length === 0) {
        行列表.push("  (tidak ada unit terdaftar)");
    }
    if (进程管理二.length > 0) {
        行列表.push("pm2");
        for (const 应用 of 进程管理二)
            行列表.push(服务行(应用));
    }
    if (顶部.length > 0) {
        行列表.push(规则常量);
        行列表.push(`top   ${顶部.map((项目) => `${缩短(项目.名称, 12)} ${项目.处理器}%`).join(" · ")}`);
    }
    return 行列表.join("\n");
}


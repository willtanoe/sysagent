import { 节点执行器 } from "./executor";
import { 转义超文本标记, 预阻断 } from "../shared/format";
export interface 告警快照 {
    磁盘百分比: number | null;
    磁盘详情: string;
    内存百分比: number | null;
    内存详情: string;
    失败单元列表: string[];
    失败详情: string;
}
export interface 节点告警事件 {
    键: string;
    严重度: "warn" | "ok";
    超文本标记: string;
}
export interface 告警评估器依赖 {
    节点标识: string;
    发送: (事件: 节点告警事件) => Promise<boolean> | boolean;
    获取: (键: string) => string | null;
    设置: (键: string, 值内容: string | null) => void;
    当前时间: () => number;
    冷却毫秒: number;
    磁盘百分比: number;
    内存百分比: number;
}
const 恢复过程边距 = 3;
/**
 * 每节点主动告警评估器：
 * - 仅在状况恶化时发送告警（5% bucket 上升或出现新的失败单元）。
 * - 当降至阈值 - 3% 以下或所有单元恢复健康时，发送 1 条恢复通知。
 */
export function 创建节点告警评估器(依赖: 告警评估器依赖): (快照: 告警快照) => Promise<void> {
    const 最后已发送 = new Map<string, number>();
    const 通知 = async (键: string, 严重度: "warn" | "ok", 超文本标记: string): Promise<boolean> => {
        const 上一个 = 最后已发送.get(键) ?? 0;
        if (依赖.当前时间() - 上一个 < 依赖.冷却毫秒)
            return false;
        最后已发送.set(键, 依赖.当前时间());
        try {
            const 是否成功 = await 依赖.发送({ 键, 严重度, 超文本标记 });
            if (!是否成功)
                最后已发送.delete(键);
            return 是否成功;
        }
        catch {
            最后已发送.delete(键);
            return false;
        }
    };
    const 百分比告警 = async (键: "disk" | "mem", 标签: string, 百分比: number | null, 阈值: number, 详情: string): Promise<void> => {
        if (百分比 === null || !Number.isFinite(百分比))
            return;
        const 已存储 = 依赖.获取(键);
        if (百分比 >= 阈值) {
            const 桶 = Math.floor(百分比 / 5) * 5;
            if (已存储 !== null && 桶 <= Number(已存储))
                return;
            const 超文本标记 = `⚠️ <b>[${转义超文本标记(依赖.节点标识)}] ${标签} ${百分比}%</b>\n${预阻断(详情)}`;
            if (await 通知(键, "warn", 超文本标记)) {
                依赖.设置(键, String(桶));
            }
            return;
        }
        if (已存储 !== null && 百分比 < 阈值 - 恢复过程边距) {
            依赖.设置(键, null);
            await 通知(`${键}-ok`, "ok", `✅ <b>[${转义超文本标记(依赖.节点标识)}] ${标签} pulih</b> (${百分比}%)`);
        }
    };
    return async (快照: 告警快照): Promise<void> => {
        await 百分比告警("disk", "Disk / sudah", 快照.磁盘百分比, 依赖.磁盘百分比, 快照.磁盘详情);
        await 百分比告警("mem", "Memory terpakai", 快照.内存百分比, 依赖.内存百分比, 快照.内存详情);
        const 当前 = [...new Set(快照.失败单元列表)].sort();
        const 已存储原始 = 依赖.获取("failed-units");
        const 上一个 = 已存储原始 === null || 已存储原始 === "" ? [] : 已存储原始.split(",");
        const 新建 = 当前.filter((单元) => !上一个.includes(单元));
        if (新建.length > 0) {
            const 超文本标记 = `⚠️ <b>[${转义超文本标记(依赖.节点标识)}] ${新建.length} service gagal baru</b>\n${预阻断(快照.失败详情)}`;
            if (await 通知("failed-units", "warn", 超文本标记)) {
                依赖.设置("failed-units", 当前.join(","));
            }
            return;
        }
        if (当前.length === 0) {
            if (已存储原始 !== null) {
                依赖.设置("failed-units", null);
                await 通知("failed-units-ok", "ok", `✅ <b>[${转义超文本标记(依赖.节点标识)}] Semua service kembali normal</b>`);
            }
            return;
        }
        if (当前.join(",") !== 已存储原始) {
            依赖.设置("failed-units", 当前.join(","));
        }
    };
}
export interface 节点告警配置 {
    间隔毫秒?: number;
    冷却毫秒?: number;
    磁盘百分比?: number;
    内存百分比?: number;
    忽略单元列表?: string[];
}
export class 节点告警监控器 {
    private 节点标识: string;
    private 执行器: 节点执行器;
    private 配置: Required<节点告警配置>;
    private 状态值 = new Map<string, string>();
    private 执行评估: (快照: 告警快照) => Promise<void>;
    private 定时器: NodeJS.Timeout | null = null;
    private 运行中 = false;
    constructor(节点标识: string, 执行器: 节点执行器, 当告警: (事件: 节点告警事件) => boolean, 配置?: 节点告警配置) {
        this.节点标识 = 节点标识;
        this.执行器 = 执行器;
        this.配置 = {
            间隔毫秒: 配置?.间隔毫秒 ?? 300000,
            冷却毫秒: 配置?.冷却毫秒 ?? 1800000,
            磁盘百分比: 配置?.磁盘百分比 ?? 90,
            内存百分比: 配置?.内存百分比 ?? 92,
            忽略单元列表: 配置?.忽略单元列表 ?? [],
        };
        this.执行评估 = 创建节点告警评估器({
            节点标识: this.节点标识,
            发送: 当告警,
            获取: (键索引) => this.状态值.get(键索引) ?? null,
            设置: (键索引, 值变量) => {
                if (值变量 === null)
                    this.状态值.delete(键索引);
                else
                    this.状态值.set(键索引, 值变量);
            },
            当前时间: Date.now,
            冷却毫秒: this.配置.冷却毫秒,
            磁盘百分比: this.配置.磁盘百分比,
            内存百分比: this.配置.内存百分比,
        });
    }
    async 测量(): Promise<告警快照> {
        const 解析数量 = (输出文本: string): number | null => {
            const 值 = Number(输出文本.trim());
            return Number.isFinite(值) ? 值 : null;
        };
        const 磁盘 = await this.执行器.执行原始("df -P / | awk 'NR==2 {gsub(/%/,\"\",$5); print $5}'", 10000);
        const 磁盘百分比 = 解析数量(磁盘.输出内容);
        const 磁盘详情 = 磁盘百分比 !== null && 磁盘百分比 >= this.配置.磁盘百分比
            ? (await this.执行器.执行原始("df -h /", 10000)).输出内容
            : "";
        const 内存 = await this.执行器.执行原始("free | awk '/Mem:/{printf \"%.0f\", $3/$2*100}'", 10000);
        const 内存百分比 = 解析数量(内存.输出内容);
        const 内存详情 = 内存百分比 !== null && 内存百分比 >= this.配置.内存百分比
            ? (await this.执行器.执行原始("free -h", 10000)).输出内容
            : "";
        const 失败 = await this.执行器.执行原始("systemctl --failed --no-legend --no-pager 2>/dev/null", 10000);
        const 已忽略 = new Set(this.配置.忽略单元列表);
        const 行列表 = 失败.输出内容
            .split("\n")
            .map((行) => 行.replace(/^[●*]\s*/, "").trim())
            .filter((行) => 行 !== "" && 行 !== "(tidak ada output)")
            .filter((行) => !已忽略.has(行.split(/\s+/)[0] ?? ""));
        return {
            磁盘百分比,
            磁盘详情,
            内存百分比,
            内存详情,
            失败单元列表: 行列表.map((行) => 行.split(/\s+/)[0] ?? 行),
            失败详情: 行列表.join("\n"),
        };
    }
    async 时钟(): Promise<void> {
        if (this.运行中)
            return;
        this.运行中 = true;
        try {
            const 快照简称 = await this.测量();
            await this.执行评估(快照简称);
        }
        catch (错误对象: any) {
            console.error(`[alert:${this.节点标识}] Tick gagal:`, 错误对象.message);
        }
        finally {
            this.运行中 = false;
        }
    }
    启动(): void {
        this.停止();
        if (this.配置.间隔毫秒 <= 0)
            return;
        this.定时器 = setInterval(() => void this.时钟(), this.配置.间隔毫秒);
        this.定时器.unref();
    }
    停止(): void {
        if (this.定时器) {
            clearInterval(this.定时器);
            this.定时器 = null;
        }
    }
}


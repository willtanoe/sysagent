import WebSocket, { RawData } from "ws";
import * as os from "os";
import * as fs from "fs";
import { 节点信息, 节点到中枢消息, 中枢到节点消息, 令牌用量, } from "../shared/protocol";
import { 节点引擎, 中止状态 } from "./engine";
import { 发行版 } from "./distro";
import { 是否根 } from "./executor";
import { 节点告警监控器, 节点告警配置 } from "./alerts";
export interface 节点客户端配置 {
    中枢地址: string;
    节点标识: string;
    令牌: string;
    心跳间隔毫秒?: number;
    重连延迟毫秒?: number;
    审批超时毫秒?: number;
    传输层安全证书颁发机构路径?: string;
    传输层安全拒绝未授权?: boolean;
    告警列表?: 节点告警配置;
}
export class 节点客户端 {
    private 配置: 节点客户端配置;
    private 引擎: 节点引擎;
    private 网络套接字: WebSocket | null = null;
    private 心跳定时器: NodeJS.Timeout | null = null;
    private 重连定时器: NodeJS.Timeout | null = null;
    private 告警监控器: 节点告警监控器 | null = null;
    private 是否已关闭: boolean = false;
    private 待处理审批列表 = new Map<string, (已批准: boolean) => void>();
    private 活跃运行列表 = new Map<string, AbortController>();
    constructor(配置: 节点客户端配置, 引擎: 节点引擎, 告警监控器?: 节点告警监控器) {
        this.配置 = 配置;
        this.引擎 = 引擎;
        this.告警监控器 = 告警监控器 ?? null;
    }
    private 收集节点信息(): 节点信息 {
        const 总计内存 = Math.round(os.totalmem() / (1024 * 1024));
        const 空闲内存 = Math.round(os.freemem() / (1024 * 1024));
        return {
            主机名: os.hostname(),
            平台: os.platform(),
            架构: os.arch(),
            运行时长: Math.round(os.uptime()),
            加载平均值: os.loadavg(),
            记忆: {
                总计兆字节: 总计内存,
                空闲兆字节: 空闲内存,
            },
            发行版,
            内核: os.release(),
            处理器数量: os.cpus().length,
            是否根,
        };
    }
    启动(): void {
        this.是否已关闭 = false;
        this.连接();
        this.告警监控器?.启动();
    }
    停止(): void {
        this.是否已关闭 = true;
        this.告警监控器?.停止();
        if (this.心跳定时器) {
            clearInterval(this.心跳定时器);
            this.心跳定时器 = null;
        }
        if (this.重连定时器) {
            clearTimeout(this.重连定时器);
            this.重连定时器 = null;
        }
        for (const [, 控制器] of this.活跃运行列表) {
            控制器.abort();
        }
        this.活跃运行列表.clear();
        for (const [, 解析器] of this.待处理审批列表) {
            解析器(false);
        }
        this.待处理审批列表.clear();
        if (this.网络套接字) {
            this.网络套接字.close();
            this.网络套接字 = null;
        }
    }
    发送告警(键: string, 严重度: "warn" | "ok", 超文本标记: string): boolean {
        if (!this.网络套接字 || this.网络套接字.readyState !== WebSocket.OPEN)
            return false;
        this.发送({
            类型: "node_alert",
            节点标识: this.配置.节点标识,
            键,
            严重度,
            超文本标记,
        });
        return true;
    }
    private 连接(): void {
        if (this.是否已关闭)
            return;
        console.log(`[node:${this.配置.节点标识}] Konek ke Hub di ${this.配置.中枢地址}...`);
        const 网络套接字选项: WebSocket.ClientOptions = {};
        if (this.配置.传输层安全证书颁发机构路径 && fs.existsSync(this.配置.传输层安全证书颁发机构路径)) {
            网络套接字选项.ca = fs.readFileSync(this.配置.传输层安全证书颁发机构路径);
        }
        if (this.配置.传输层安全拒绝未授权 !== undefined) {
            网络套接字选项.rejectUnauthorized = this.配置.传输层安全拒绝未授权;
        }
        const 网络套接字 = new WebSocket(this.配置.中枢地址, 网络套接字选项);
        this.网络套接字 = 网络套接字;
        网络套接字.on("open", () => {
            console.log(`[node:${this.配置.节点标识}] Terhubung ke Hub. Mengirim handshake hello...`);
            const 你好: 节点到中枢消息 = {
                类型: "node_hello",
                节点标识: this.配置.节点标识,
                令牌: this.配置.令牌,
                信息: this.收集节点信息(),
            };
            网络套接字.send(JSON.stringify(你好));
            if (this.心跳定时器)
                clearInterval(this.心跳定时器);
            this.心跳定时器 = setInterval(() => {
                if (网络套接字.readyState === WebSocket.OPEN) {
                    const 信息 = this.收集节点信息();
                    const 心跳: 节点到中枢消息 = {
                        类型: "node_heartbeat",
                        节点标识: this.配置.节点标识,
                        运行时长: 信息.运行时长,
                        加载平均值: 信息.加载平均值,
                        记忆: 信息.记忆,
                    };
                    网络套接字.send(JSON.stringify(心跳));
                }
            }, this.配置.心跳间隔毫秒 || 15000);
            this.心跳定时器.unref?.();
        });
        网络套接字.on("message", async (原始: RawData) => {
            try {
                const 消息文本 = JSON.parse(原始.toString()) as 中枢到节点消息;
                await this.处理中枢消息(消息文本);
            }
            catch (错误对象: any) {
                console.error(`[node:${this.配置.节点标识}] Gagal parse pesan hub:`, 错误对象.message);
            }
        });
        网络套接字.on("close", () => {
            if (this.心跳定时器) {
                clearInterval(this.心跳定时器);
                this.心跳定时器 = null;
            }
            console.log(`[node:${this.配置.节点标识}] Sambungan ke Hub terputus.`);
            if (!this.是否已关闭) {
                const 延迟 = this.配置.重连延迟毫秒 ?? 3000;
                this.重连定时器 = setTimeout(() => this.连接(), 延迟);
            }
        });
        网络套接字.on("error", (错误对象) => {
            console.error(`[node:${this.配置.节点标识}] Socket error:`, 错误对象.message);
        });
    }
    private async 处理中枢消息(消息文本: 中枢到节点消息): Promise<void> {
        if (消息文本.类型 === "hub_welcome") {
            if (消息文本.成功) {
                console.log(`[node:${this.配置.节点标识}] Handshake sukses: ${消息文本.消息内容}`);
            }
            else {
                console.error(`[node:${this.配置.节点标识}] Handshake DITOLAK: ${消息文本.消息内容}`);
                this.停止();
            }
            return;
        }
        if (消息文本.类型 === "hub_approval_res") {
            const 解析器 = this.待处理审批列表.get(消息文本.审批标识);
            if (解析器) {
                解析器(消息文本.已批准);
                this.待处理审批列表.delete(消息文本.审批标识);
            }
            return;
        }
        if (消息文本.类型 === "hub_cancel") {
            const 控制器 = this.活跃运行列表.get(消息文本.运行标识);
            if (控制器) {
                console.log(`[node:${this.配置.节点标识}] Membatalkan run [${消息文本.运行标识}]...`);
                控制器.abort();
                this.活跃运行列表.delete(消息文本.运行标识);
            }
            return;
        }
        if (消息文本.类型 === "hub_ping") {
            this.发送({ 类型: "node_pong", 时间戳: Date.now() });
            return;
        }
        if (消息文本.类型 === "hub_run") {
            const { 运行标识, 提示词, 模型, 历史, 聊天标识, 用户标识 } = 消息文本;
            console.log(`[node:${this.配置.节点标识}] Menerima run [${运行标识}]: "${提示词.slice(0, 60)}"`);
            const 控制器 = new AbortController();
            this.活跃运行列表.set(运行标识, 控制器);
            const 审批超时毫秒 = this.配置.审批超时毫秒 ?? 300000;
            const 请求审批 = (命令: string, 原因: string): Promise<boolean> => {
                return new Promise<boolean>((解析) => {
                    if (控制器.signal.aborted) {
                        解析(false);
                        return;
                    }
                    const 审批标识 = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                    const 当中止 = () => {
                        if (this.待处理审批列表.has(审批标识)) {
                            this.待处理审批列表.delete(审批标识);
                            解析(false);
                        }
                    };
                    控制器.signal.addEventListener("abort", 当中止, { once: true });
                    this.待处理审批列表.set(审批标识, (已批准: boolean) => {
                        控制器.signal.removeEventListener("abort", 当中止);
                        解析(已批准);
                    });
                    this.发送({
                        类型: "node_approval_req",
                        运行标识,
                        审批标识,
                        命令,
                        原因,
                    });
                    const 定时器 = setTimeout(() => {
                        if (this.待处理审批列表.has(审批标识)) {
                            this.待处理审批列表.delete(审批标识);
                            控制器.signal.removeEventListener("abort", 当中止);
                            解析(false);
                        }
                    }, 审批超时毫秒);
                    定时器.unref?.();
                });
            };
            let 用量: 令牌用量 | undefined;
            try {
                const 完整文本 = await this.引擎.运行(提示词, (数据块) => {
                    this.发送({ 类型: "node_chunk", 运行标识, 数据块 });
                }, 请求审批, 模型, {
                    信号: 控制器.signal,
                    历史,
                    聊天标识,
                    用户标识,
                    当用量: (用户) => {
                        用量 = 用户;
                    },
                });
                this.发送({
                    类型: "node_done",
                    运行标识,
                    完整文本,
                    ...(用量 ? { 用量 } : {}),
                });
            }
            catch (错误对象: any) {
                const 是否已中止 = 错误对象?.message === 中止状态 || 控制器.signal.aborted;
                this.发送({
                    类型: "node_done",
                    运行标识,
                    完整文本: 是否已中止 ? `[${this.配置.节点标识}] ⏹ Tugas dihentikan oleh operator.` : `Error di node: ${错误对象.message}`,
                    错误: 是否已中止 ? 中止状态 : 错误对象.message,
                });
            }
            finally {
                this.活跃运行列表.delete(运行标识);
            }
        }
    }
    private 发送(消息文本: 节点到中枢消息): void {
        if (this.网络套接字 && this.网络套接字.readyState === WebSocket.OPEN) {
            this.网络套接字.send(JSON.stringify(消息文本));
        }
    }
}


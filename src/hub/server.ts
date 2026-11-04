import WebSocket, { WebSocketServer, RawData } from "ws";
import * as https from "https";
import * as fs from "fs";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import { 节点信息, 节点到中枢消息, 中枢到节点消息, 聊天历史项目, 令牌用量, } from "../shared/protocol";
const 节点标识正则 = /^[A-Za-z0-9._-]{1,64}$/;
export interface 已连接节点 {
    节点标识: string;
    网络套接字: WebSocket;
    信息: 节点信息;
    已连接位于: number;
    最后已见: number;
}
export interface 活跃运行 {
    运行标识: string;
    节点标识: string;
    聊天标识: number;
    已启动位于: number;
    当块: (数据块: string) => void;
    当审批请求: (审批标识: string, 命令: string, 原因: string) => void;
    当完成: (完整文本: string, 错误?: string, 用量?: 令牌用量) => void;
}
export interface 中枢服务器选项 {
    主机?: string;
    节点令牌列表?: Record<string, string>;
    传输层安全证书路径?: string;
    传输层安全键路径?: string;
    认证超时毫秒?: number;
    最大负载字节?: number;
}
/** 使用 SHA-256 摘要进行常量时间 token 比较，以防止时序攻击。 */
export function 验证密钥令牌(已提供: string, 预期: string): boolean {
    if (!已提供 || !预期)
        return false;
    const 哈希甲 = crypto.createHash("sha256").update(已提供).digest();
    const 哈希乙 = crypto.createHash("sha256").update(预期).digest();
    return crypto.timingSafeEqual(哈希甲, 哈希乙);
}
/** 将字符串 "hongyun:tok1,hongchen:tok2" 解析为按节点分组的 token 映射。 */
export function 解析节点令牌列表(原始: string | undefined): Record<string, string> {
    const 映射: Record<string, string> = {};
    if (!原始)
        return 映射;
    for (const 配对 of 原始.split(",")) {
        const 下标 = 配对.indexOf(":");
        if (下标 <= 0)
            continue;
        const 节点标识 = 配对.slice(0, 下标).trim();
        const 令牌 = 配对.slice(下标 + 1).trim();
        if (节点标识 && 令牌)
            映射[节点标识] = 令牌;
    }
    return 映射;
}
export class 中枢服务器 extends EventEmitter {
    private 端口: number;
    private 主机: string;
    private 密钥令牌: string;
    private 节点令牌列表: Record<string, string>;
    private 传输层安全证书路径?: string;
    private 传输层安全键路径?: string;
    private 认证超时毫秒: number;
    private 最大负载字节: number;
    private 安全超文本传输服务器: https.Server | null = null;
    private 安全网络套接字: WebSocketServer | null = null;
    private 节点列表 = new Map<string, 已连接节点>();
    private 运行列表 = new Map<string, 活跃运行>();
    private 审批列表 = new Map<string, {
        节点标识: string;
        运行标识: string;
        聊天标识: number;
    }>();
    constructor(端口: number, 密钥令牌: string, 选项集?: 中枢服务器选项) {
        super();
        this.端口 = 端口;
        this.主机 = 选项集?.主机 || "0.0.0.0";
        this.密钥令牌 = 密钥令牌;
        this.节点令牌列表 = 选项集?.节点令牌列表 ?? {};
        this.传输层安全证书路径 = 选项集?.传输层安全证书路径;
        this.传输层安全键路径 = 选项集?.传输层安全键路径;
        this.认证超时毫秒 = 选项集?.认证超时毫秒 ?? 5000;
        this.最大负载字节 = 选项集?.最大负载字节 ?? 2 * 1024 * 1024;
    }
    private 是否有效令牌用于节点(节点标识: string, 令牌: string): boolean {
        const 特定令牌 = this.节点令牌列表[节点标识];
        if (特定令牌) {
            return 验证密钥令牌(令牌, 特定令牌);
        }
        return 验证密钥令牌(令牌, this.密钥令牌);
    }
    启动(): Promise<void> {
        return new Promise((解析, 拒绝) => {
            try {
                let 安全网络套接字: WebSocketServer;
                if (this.传输层安全证书路径 && this.传输层安全键路径) {
                    const 证书 = fs.readFileSync(this.传输层安全证书路径);
                    const 键 = fs.readFileSync(this.传输层安全键路径);
                    this.安全超文本传输服务器 = https.createServer({ cert: 证书, key: 键 });
                    安全网络套接字 = new WebSocketServer({
                        server: this.安全超文本传输服务器,
                        maxPayload: this.最大负载字节,
                    });
                    this.安全超文本传输服务器.listen(this.端口, this.主机, () => {
                        console.log(`[hub] WSS (TLS) Server listening di ${this.主机}:${this.端口}`);
                        解析();
                    });
                }
                else {
                    安全网络套接字 = new WebSocketServer({
                        port: this.端口,
                        host: this.主机,
                        maxPayload: this.最大负载字节,
                    }, () => {
                        console.log(`[hub] WS Server listening di ${this.主机}:${this.端口}`);
                        解析();
                    });
                }
                this.安全网络套接字 = 安全网络套接字;
                安全网络套接字.on("connection", (网络套接字: WebSocket) => {
                    let 已认证节点标识: string | null = null;
                    // 若新连接在时限内未发送 node_hello 则超时
                    const 认证定时器 = setTimeout(() => {
                        if (!已认证节点标识 && 网络套接字.readyState === WebSocket.OPEN) {
                            网络套接字.close(4001, "Authentication timeout");
                        }
                    }, this.认证超时毫秒);
                    认证定时器.unref?.();
                    网络套接字.on("message", (原始: RawData) => {
                        try {
                            const 消息文本 = JSON.parse(原始.toString()) as 节点到中枢消息;
                            if (消息文本.类型 === "node_hello") {
                                clearTimeout(认证定时器);
                                if (!消息文本.节点标识 || !节点标识正则.test(消息文本.节点标识)) {
                                    const 拒绝消息: 中枢到节点消息 = {
                                        类型: "hub_welcome",
                                        成功: false,
                                        消息内容: "Format nodeId tidak valid.",
                                    };
                                    网络套接字.send(JSON.stringify(拒绝消息));
                                    网络套接字.close();
                                    return;
                                }
                                if (!this.是否有效令牌用于节点(消息文本.节点标识, 消息文本.令牌)) {
                                    const 拒绝消息: 中枢到节点消息 = {
                                        类型: "hub_welcome",
                                        成功: false,
                                        消息内容: "Token autentikasi salah.",
                                    };
                                    网络套接字.send(JSON.stringify(拒绝消息));
                                    网络套接字.close();
                                    return;
                                }
                                // 若相同节点在旧 socket 超时前重连，则关闭旧连接
                                const 已有 = this.节点列表.get(消息文本.节点标识);
                                if (已有 && 已有.网络套接字 !== 网络套接字) {
                                    try {
                                        已有.网络套接字.close();
                                    }
                                    catch {
                                        // 忽略
                                    }
                                }
                                已认证节点标识 = 消息文本.节点标识;
                                const 当前时间 = Date.now();
                                this.节点列表.set(消息文本.节点标识, {
                                    节点标识: 消息文本.节点标识,
                                    网络套接字,
                                    信息: 消息文本.信息,
                                    已连接位于: 当前时间,
                                    最后已见: 当前时间,
                                });
                                console.log(`[hub] Node terdaftar: "${消息文本.节点标识}" (${消息文本.信息.主机名}, ${消息文本.信息.发行版?.名称 || 消息文本.信息.平台})`);
                                const 欢迎: 中枢到节点消息 = {
                                    类型: "hub_welcome",
                                    成功: true,
                                    消息内容: `Selamat datang di Aster Hub, node ${消息文本.节点标识}!`,
                                };
                                网络套接字.send(JSON.stringify(欢迎));
                                this.emit("node_joined", 消息文本.节点标识, 消息文本.信息);
                                return;
                            }
                            if (!已认证节点标识) {
                                网络套接字.close();
                                return;
                            }
                            const 节点 = this.节点列表.get(已认证节点标识);
                            if (节点)
                                节点.最后已见 = Date.now();
                            if (消息文本.类型 === "node_heartbeat") {
                                if (节点) {
                                    节点.信息.运行时长 = 消息文本.运行时长;
                                    节点.信息.加载平均值 = 消息文本.加载平均值;
                                    节点.信息.记忆 = 消息文本.记忆;
                                    if (消息文本.磁盘百分比 !== undefined)
                                        节点.信息.磁盘百分比 = 消息文本.磁盘百分比;
                                }
                                return;
                            }
                            if (消息文本.类型 === "node_chunk") {
                                const 运行 = this.运行列表.get(消息文本.运行标识);
                                if (运行)
                                    运行.当块(消息文本.数据块);
                                return;
                            }
                            if (消息文本.类型 === "node_approval_req") {
                                const 运行 = this.运行列表.get(消息文本.运行标识);
                                if (运行 && 运行.节点标识 === 已认证节点标识) {
                                    this.审批列表.set(消息文本.审批标识, {
                                        节点标识: 已认证节点标识,
                                        运行标识: 消息文本.运行标识,
                                        聊天标识: 运行.聊天标识,
                                    });
                                    Promise.resolve(运行.当审批请求(消息文本.审批标识, 消息文本.命令, 消息文本.原因)).catch((错误对象: any) => {
                                        console.error("[hub] Gagal mengirim permintaan approval:", 错误对象?.message ?? 错误对象);
                                    });
                                }
                                return;
                            }
                            if (消息文本.类型 === "node_done") {
                                const 运行 = this.运行列表.get(消息文本.运行标识);
                                if (运行 && 运行.节点标识 === 已认证节点标识) {
                                    this.清除审批列表用于运行(消息文本.运行标识);
                                    this.运行列表.delete(消息文本.运行标识);
                                    Promise.resolve(运行.当完成(消息文本.完整文本, 消息文本.错误, 消息文本.用量)).catch((错误对象: any) => {
                                        console.error("[hub] Gagal menyelesaikan callback onDone:", 错误对象?.message ?? 错误对象);
                                    });
                                }
                                return;
                            }
                            if (消息文本.类型 === "node_alert") {
                                this.emit("node_alert", 已认证节点标识, 消息文本.键, 消息文本.严重度, 消息文本.超文本标记);
                                return;
                            }
                        }
                        catch (错误对象: any) {
                            console.error("[hub] Gagal memproses pesan socket:", 错误对象.message);
                        }
                    });
                    网络套接字.on("close", () => {
                        clearTimeout(认证定时器);
                        if (已认证节点标识) {
                            const 当前 = this.节点列表.get(已认证节点标识);
                            if (当前 && 当前.网络套接字 === 网络套接字) {
                                console.log(`[hub] Node disconnect: "${已认证节点标识}"`);
                                this.节点列表.delete(已认证节点标识);
                                for (const [运行标识, 运行] of this.运行列表.entries()) {
                                    if (运行.节点标识 === 已认证节点标识) {
                                        this.清除审批列表用于运行(运行标识);
                                        this.运行列表.delete(运行标识);
                                        Promise.resolve(运行.当完成(`[${已认证节点标识}] Koneksi node terputus.`, "NODE_DISCONNECTED")).catch(() => undefined);
                                    }
                                }
                                this.emit("node_left", 已认证节点标识);
                            }
                        }
                    });
                });
            }
            catch (错误对象) {
                拒绝(错误对象);
            }
        });
    }
    停止(): Promise<void> {
        return new Promise((解析) => {
            for (const [, 节点] of this.节点列表) {
                try {
                    节点.网络套接字.close();
                }
                catch {
                    // 忽略
                }
            }
            this.节点列表.clear();
            this.运行列表.clear();
            this.审批列表.clear();
            const 关闭安全超文本传输 = () => {
                if (this.安全超文本传输服务器) {
                    this.安全超文本传输服务器.close(() => 解析());
                    this.安全超文本传输服务器 = null;
                }
                else {
                    解析();
                }
            };
            if (this.安全网络套接字) {
                this.安全网络套接字.close(() => 关闭安全超文本传输());
                this.安全网络套接字 = null;
            }
            else {
                关闭安全超文本传输();
            }
        });
    }
    列出节点列表(): 已连接节点[] {
        return Array.from(this.节点列表.values());
    }
    获取节点(节点标识: string): 已连接节点 | undefined {
        return this.节点列表.get(节点标识);
    }
    启动运行(节点标识: string, 聊天标识: number, 提示词: string, 处理器列表: {
        当块: (数据块: string) => void;
        当审批请求: (审批标识: string, 命令: string, 原因: string) => void;
        当完成: (完整文本: string, 错误?: string, 用量?: 令牌用量) => void;
    }, 模型?: string, 选项集?: {
        用户标识?: number;
        历史?: 聊天历史项目[];
    }): string {
        const 节点 = this.节点列表.get(节点标识);
        if (!节点 || 节点.网络套接字.readyState !== WebSocket.OPEN) {
            throw new Error(`Node "${节点标识}" tidak terhubung atau sedang offline.`);
        }
        const 运行标识 = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        this.运行列表.set(运行标识, {
            运行标识,
            节点标识,
            聊天标识,
            已启动位于: Date.now(),
            ...处理器列表,
        });
        const 消息文本: 中枢到节点消息 = {
            类型: "hub_run",
            运行标识,
            聊天标识,
            用户标识: 选项集?.用户标识,
            提示词,
            模型,
            历史: 选项集?.历史,
        };
        节点.网络套接字.send(JSON.stringify(消息文本));
        return 运行标识;
    }
    取消运行(运行标识: string): boolean {
        const 运行 = this.运行列表.get(运行标识);
        if (!运行)
            return false;
        const 节点 = this.节点列表.get(运行.节点标识);
        if (节点 && 节点.网络套接字.readyState === WebSocket.OPEN) {
            const 消息文本: 中枢到节点消息 = {
                类型: "hub_cancel",
                运行标识,
            };
            节点.网络套接字.send(JSON.stringify(消息文本));
        }
        else {
            运行.当完成("[dibatalkan]", "ABORTED");
            this.运行列表.delete(运行标识);
        }
        return true;
    }
    取消聊天运行列表(聊天标识: number): number {
        let 计数 = 0;
        for (const [运行标识, 运行] of this.运行列表.entries()) {
            if (运行.聊天标识 === 聊天标识) {
                if (this.取消运行(运行标识))
                    计数 += 1;
            }
        }
        return 计数;
    }
    private 清除审批列表用于运行(运行标识: string): void {
        for (const [审批标识, 元数据] of this.审批列表.entries()) {
            if (元数据.运行标识 === 运行标识)
                this.审批列表.delete(审批标识);
        }
    }
    发送审批(节点标识: string, 运行标识: string, 审批标识: string, 已批准: boolean, 聊天标识?: number): boolean {
        const 已跟踪 = this.审批列表.get(审批标识);
        if (聊天标识 !== undefined && 已跟踪 && 已跟踪.聊天标识 !== 聊天标识) {
            return false;
        }
        this.审批列表.delete(审批标识);
        const 目标节点标识 = 已跟踪?.节点标识 ?? 节点标识;
        const 目标运行标识 = 已跟踪?.运行标识 ?? 运行标识;
        const 节点 = this.节点列表.get(目标节点标识);
        if (!节点 || 节点.网络套接字.readyState !== WebSocket.OPEN)
            return false;
        const 消息文本: 中枢到节点消息 = {
            类型: "hub_approval_res",
            运行标识: 目标运行标识,
            审批标识,
            已批准,
        };
        节点.网络套接字.send(JSON.stringify(消息文本));
        return true;
    }
    解析审批按标识(审批标识: string, 已批准: boolean, 聊天标识?: number): boolean {
        const 已跟踪 = this.审批列表.get(审批标识);
        if (!已跟踪)
            return false;
        return this.发送审批(已跟踪.节点标识, 已跟踪.运行标识, 审批标识, 已批准, 聊天标识);
    }
}


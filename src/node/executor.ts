import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { 评估风险, 判定结果 } from "../shared/risk";
import { 审计日志器, 审计验证结果 } from "../shared/audit";
const 最大缓冲区 = 8 * 1024 * 1024;
const 最大模型输出 = 12000;
const 软件包命令 = /\b(apt|apt-get|dpkg|dnf|yum|pacman|apk|snap|zypper|rpm|add-apt-repository)\b/;
const 提权调用 = /(^|[\n;&|(]\s*)sudo(?!\s+-[An])/gm;
const 冗余根提权 = /(^|[\n;&|(]\s*)sudo(?:\s+-[AnEHKPSv]+)*(?=\s+(?![-]))\s+/gm;
export const 是否根: boolean = typeof process.getuid === "function" && process.getuid() === 0;
/** 当进程已以 root (uid=0) 运行时，移除不改变目标用户 (-u/-g) 的 sudo 前缀。 */
export function 剥离冗余提权(命令: string): string {
    return 命令.replace(冗余根提权, "$1");
}
export interface 执行结果 {
    输出内容: string;
    退出代码: number;
    时长毫秒: number;
    定时输出?: boolean;
    已中止?: boolean;
    已阻断?: boolean;
    已拒绝?: boolean;
    原因?: string;
}
export interface 执行器选项 {
    提权密码?: string;
    Shell超时毫秒?: number;
    软件包超时毫秒?: number;
    最大命令列表每分钟?: number;
}
export type 请求审批函数 = (命令: string, 原因: string) => Promise<boolean>;
function 单引用(值内容: string): string {
    return `'${值内容.replace(/'/g, `'\\''`)}'`;
}
/** 从传递给子进程 shell 的 env 中移除敏感变量。 */
export function 净化环境(源: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const 结果: NodeJS.ProcessEnv = { ...源 };
    const 敏感 = /(TOKEN|PASSWORD|PASSWD|SECRET|API|KEY|PRIVATE|CREDENTIAL|AUTH|JWT|DSN|DATABASE_URL|ASKPASS)/i;
    for (const 键 of Object.keys(结果)) {
        if (键 === "SUDO_ASKPASS")
            continue;
        if (敏感.test(键))
            delete 结果[键];
    }
    return 结果;
}
export function 截断用于模型(输出内容: string): string {
    if (输出内容.length <= 最大模型输出)
        return 输出内容;
    const 已丢弃 = 输出内容.length - 最大模型输出;
    return `${输出内容.slice(0, 最大模型输出)}\n[...dipotong ${已丢弃} karakter]`;
}
export class 节点执行器 {
    private 节点标识: string;
    private 审计: 审计日志器;
    private 密码询问路径: string | null = null;
    private Shell超时毫秒: number;
    private 软件包超时毫秒: number;
    private 最大命令列表每分钟: number;
    private 执行过程时间戳: number[] = [];
    constructor(节点标识: string, 审计路径: string, 选项集?: 执行器选项) {
        this.节点标识 = 节点标识;
        this.审计 = new 审计日志器(审计路径);
        this.Shell超时毫秒 = Math.min(选项集?.Shell超时毫秒 ?? 120000, 1800000);
        this.软件包超时毫秒 = Math.min(选项集?.软件包超时毫秒 ?? 900000, 1800000);
        this.最大命令列表每分钟 = 选项集?.最大命令列表每分钟 ?? 30;
        if (选项集?.提权密码) {
            this.初始化提权(选项集.提权密码);
        }
    }
    初始化提权(密码: string): void {
        if (是否根)
            return;
        if (!密码)
            return;
        const 候选列表 = [
            path.join(os.homedir(), ".config", "aster"),
            path.join(path.dirname(path.resolve(this.审计.获取日志路径())), ".aster-askpass"),
        ];
        const 安全标识 = this.节点标识.replace(/[^A-Za-z0-9_-]/g, "_");
        let 最后错误: any = null;
        for (const 目录 of 候选列表) {
            try {
                fs.mkdirSync(目录, { recursive: true, mode: 0o700 });
                fs.chmodSync(目录, 0o700);
                const 文件 = path.join(目录, `askpass-${安全标识}.sh`);
                fs.writeFileSync(文件, `#!/bin/sh\nprintf '%s\\n' ${单引用(密码)}\n`, { mode: 0o700 });
                fs.chmodSync(文件, 0o700);
                this.密码询问路径 = 文件;
                return;
            }
            catch (错误对象: any) {
                最后错误 = 错误对象;
            }
        }
        if (最后错误) {
            console.error(`[executor:${this.节点标识}] Gagal menyiapkan sudo askpass:`, 最后错误.message);
        }
    }
    private 准备命令(命令: string): string {
        if (是否根) {
            return 剥离冗余提权(命令);
        }
        const 标志 = this.密码询问路径 === null ? "sudo -n" : "sudo -A";
        return 命令.replace(提权调用, (私有匹配: string, 前缀: string) => `${前缀}${标志}`);
    }
    超时用于(命令: string): number {
        return 软件包命令.test(命令) ? this.软件包超时毫秒 : this.Shell超时毫秒;
    }
    /** 原始 shell 执行，支持 process-group kill 与 env 清洗（内部与 runCommand 共用）。 */
    执行原始(命令: string, 超时毫秒?: number, 信号?: AbortSignal): Promise<执行结果> {
        const 有效超时 = 超时毫秒 ?? this.超时用于(命令);
        const 已准备 = this.准备命令(命令);
        return new Promise((解析) => {
            const 已启动位于 = Date.now();
            let 已结算 = false;
            let 已中止 = false;
            let 定时输出 = false;
            let 定时器: NodeJS.Timeout | null = null;
            let 当中止: (() => void) | null = null;
            const 完成 = (结果: 执行结果): void => {
                if (已结算)
                    return;
                已结算 = true;
                if (定时器 !== null)
                    clearTimeout(定时器);
                if (当中止 !== null)
                    信号?.removeEventListener("abort", 当中止);
                解析(结果);
            };
            if (信号?.aborted) {
                完成({
                    输出内容: "[dibatalkan]",
                    退出代码: 130,
                    时长毫秒: 0,
                    定时输出: false,
                    已中止: true,
                });
                return;
            }
            const 环境: NodeJS.ProcessEnv = 净化环境(process.env);
            环境.DEBIAN_FRONTEND = "noninteractive";
            环境.APT_LISTCHANGES_FRONTEND = "none";
            环境.NEEDRESTART_MODE = "a";
            if (this.密码询问路径 !== null) {
                环境.SUDO_ASKPASS = this.密码询问路径;
                环境.SUDO_ASKPASS_REQUIRE = "force";
            }
            const 子进程 = spawn("/bin/bash", ["-c", 已准备], {
                env: 环境,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let 标准输出 = "";
            let 标准错误 = "";
            let 已截断 = false;
            const 收集 = (目标: "out" | "err", 数据块: Buffer): void => {
                const 文本 = 数据块.toString("utf8");
                if (目标 === "out") {
                    if (标准输出.length < 最大缓冲区)
                        标准输出 += 文本;
                    else
                        已截断 = true;
                }
                else if (标准错误.length < 最大缓冲区) {
                    标准错误 += 文本;
                }
                else {
                    已截断 = true;
                }
            };
            子进程.stdout?.on("data", (数据块: Buffer) => 收集("out", 数据块));
            子进程.stderr?.on("data", (数据块: Buffer) => 收集("err", 数据块));
            const 终止树 = (): void => {
                try {
                    if (子进程.pid !== undefined)
                        process.kill(-子进程.pid, "SIGKILL");
                    else
                        子进程.kill("SIGKILL");
                }
                catch {
                    try {
                        子进程.kill("SIGKILL");
                    }
                    catch {
                        // 已停止
                    }
                }
            };
            定时器 = setTimeout(() => {
                定时输出 = true;
                终止树();
            }, 有效超时);
            当中止 = (): void => {
                已中止 = true;
                终止树();
            };
            信号?.addEventListener("abort", 当中止, { once: true });
            子进程.on("error", (错误对象: Error) => {
                完成({
                    输出内容: `[error] ${错误对象.message}`,
                    退出代码: 1,
                    时长毫秒: Date.now() - 已启动位于,
                    定时输出: false,
                    已中止,
                });
            });
            子进程.on("close", (代码: number | null) => {
                let 输出内容 = 标准输出;
                if (标准错误.trim() !== "") {
                    输出内容 += `${输出内容.trim() ? "\n[stderr]\n" : ""}${标准错误}`;
                }
                if (已中止)
                    输出内容 += "\n[dibatalkan oleh operator]";
                else if (定时输出)
                    输出内容 += `\n[error] timeout setelah ${Math.round(有效超时 / 1000)}s`;
                if (已截断)
                    输出内容 += "\n[output dipotong: melebihi batas buffer]";
                const 已修剪 = 输出内容.trim();
                完成({
                    输出内容: 已修剪 === "" ? "(tidak ada output)" : 已修剪,
                    退出代码: 已中止 ? 130 : 定时输出 ? 124 : (代码 ?? 0),
                    时长毫秒: Date.now() - 已启动位于,
                    定时输出,
                    已中止,
                });
            });
        });
    }
    async 运行命令(命令: string, 请求审批?: 请求审批函数, 超时毫秒?: number, 信号?: AbortSignal, 元数据?: {
        聊天标识?: number;
        用户标识?: number;
    }): Promise<执行结果> {
        const 判定: 判定结果 = 评估风险(命令);
        if (判定.级别 === "block") {
            this.审计.日志({
                节点标识: this.节点标识,
                命令,
                退出代码: 126,
                时长毫秒: 0,
                风险: "block",
                已批准: false,
                输出预览: 判定.原因,
                聊天标识: 元数据?.聊天标识,
                用户标识: 元数据?.用户标识,
            });
            return {
                输出内容: `[BLOCKED] Perintah dilarang: ${判定.原因}`,
                退出代码: 126,
                时长毫秒: 0,
                已阻断: true,
                原因: 判定.原因,
            };
        }
        let 已批准 = true;
        if (判定.级别 === "approve") {
            if (!请求审批) {
                return {
                    输出内容: `[APPROVAL REQUIRED] Butuh persetujuan admin: ${判定.原因}`,
                    退出代码: 126,
                    时长毫秒: 0,
                    已拒绝: true,
                    原因: 判定.原因,
                };
            }
            已批准 = await 请求审批(命令, 判定.原因);
            if (!已批准) {
                this.审计.日志({
                    节点标识: this.节点标识,
                    命令,
                    退出代码: 125,
                    时长毫秒: 0,
                    风险: "approve",
                    已批准: false,
                    输出预览: "Ditolak oleh operator",
                    聊天标识: 元数据?.聊天标识,
                    用户标识: 元数据?.用户标识,
                });
                return {
                    输出内容: `[REJECTED] Ditolak oleh operator.`,
                    退出代码: 125,
                    时长毫秒: 0,
                    已拒绝: true,
                    原因: "Ditolak oleh operator",
                };
            }
        }
        // 每分钟速率限制
        const 当前时间 = Date.now();
        while (this.执行过程时间戳.length > 0 && 当前时间 - (this.执行过程时间戳[0] ?? 0) > 60000) {
            this.执行过程时间戳.shift();
        }
        if (this.执行过程时间戳.length >= this.最大命令列表每分钟) {
            return {
                输出内容: `[RATE LIMIT] Melebihi batas ${this.最大命令列表每分钟} perintah per menit di node ${this.节点标识}.`,
                退出代码: 129,
                时长毫秒: 0,
                已拒绝: true,
                原因: "Rate limit tercapai",
            };
        }
        this.执行过程时间戳.push(当前时间);
        const 响应对象 = await this.执行原始(命令, 超时毫秒, 信号);
        this.审计.日志({
            节点标识: this.节点标识,
            命令,
            退出代码: 响应对象.退出代码,
            时长毫秒: 响应对象.时长毫秒,
            风险: 判定.级别,
            已批准,
            定时输出: 响应对象.定时输出,
            输出预览: 响应对象.输出内容.slice(0, 500),
            聊天标识: 元数据?.聊天标识,
            用户标识: 元数据?.用户标识,
        });
        return 响应对象;
    }
    验证审计(): 审计验证结果 {
        return this.审计.验证();
    }
    日志审计(条目: {
        命令: string;
        退出代码: number | null;
        时长毫秒: number;
        风险: string;
        已批准: boolean;
        输出预览?: string;
        聊天标识?: number;
        用户标识?: number;
    }): void {
        this.审计.日志({
            节点标识: this.节点标识,
            ...条目,
        });
    }
    获取审计路径(): string {
        return this.审计.获取日志路径();
    }
}


export const sanitizeEnv = 净化环境;

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
export interface 审计条目 {
    时间戳值: string;
    节点标识: string;
    命令: string;
    退出代码: number | null;
    时长毫秒: number;
    风险: string;
    已批准: boolean;
    定时输出?: boolean;
    输出预览?: string;
    聊天标识?: number;
    用户标识?: number;
    上一个哈希: string;
    哈希: string;
}
export interface 审计验证结果 {
    是否成功: boolean;
    总计: number;
    损坏位于?: number;
    原因?: string;
}
/** 对密码、token 或敏感 secret 的模式进行脱敏，避免泄露到明文审计追踪中。 */
export function 脱敏密钥列表(文本: string): string {
    if (!文本)
        return 文本;
    return 文本.replace(/(?:printf|echo)\s+(['"])[^\n]*?\1\s*([;|]\s*sudo)/gi, "printf '[REDACTED]' $2")
        .replace(/sudo\s+-S\s+-p\s+(['"])[^\n]*?\1/gi, "sudo -S -p '[REDACTED]'")
        .replace(/\b(password|passwd|token|secret|api[_-]?key|hub[_-]?token)=([^\s&;'"]+)/gi, "$1=[REDACTED]")
        .replace(/(?:--password|--token|-p)\s+(['"]?)[^\s'"]+\1/gi, "--password [REDACTED]")
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}
function 计算条目哈希(条目不带哈希: Omit<审计条目, "\u54C8\u5E0C">): string {
    const 负载 = [
        条目不带哈希.时间戳值,
        条目不带哈希.节点标识,
        条目不带哈希.命令,
        String(条目不带哈希.退出代码 ?? ""),
        String(条目不带哈希.时长毫秒),
        条目不带哈希.风险,
        String(条目不带哈希.已批准),
        String(条目不带哈希.定时输出 ?? false),
        条目不带哈希.输出预览 ?? "",
        String(条目不带哈希.聊天标识 ?? ""),
        String(条目不带哈希.用户标识 ?? ""),
        条目不带哈希.上一个哈希,
    ].join("|");
    return crypto.createHash("sha256").update(负载).digest("hex");
}
export class 审计日志器 {
    private 最后哈希: string = "GENESIS";
    private 日志路径: string;
    constructor(日志路径: string) {
        this.日志路径 = 日志路径;
        this.初始化();
    }
    private 初始化(): void {
        try {
            const 目录 = path.dirname(path.resolve(this.日志路径));
            if (!fs.existsSync(目录)) {
                fs.mkdirSync(目录, { recursive: true, mode: 0o700 });
            }
            if (!fs.existsSync(this.日志路径)) {
                return;
            }
            try {
                fs.chmodSync(this.日志路径, 0o600);
            }
            catch {
                // 若文件系统不支持 chmod 则忽略
            }
            const 行列表 = fs.readFileSync(this.日志路径, "utf8").trim().split("\n");
            for (let 循环索引 = 行列表.length - 1; 循环索引 >= 0; 循环索引--) {
                const 行 = 行列表[循环索引]?.trim();
                if (!行)
                    continue;
                try {
                    const 已解析 = JSON.parse(行) as Partial<审计条目>;
                    if (typeof 已解析.哈希 === "string" && 已解析.哈希.length > 0) {
                        this.最后哈希 = 已解析.哈希;
                        break;
                    }
                }
                catch {
                    // 初始化时跳过损坏行
                }
            }
        }
        catch {
            // 文件不存在或无法访问
        }
    }
    日志(数据: {
        节点标识: string;
        命令: string;
        退出代码: number | null;
        时长毫秒: number;
        风险: string;
        已批准: boolean;
        定时输出?: boolean;
        输出预览?: string;
        聊天标识?: number;
        用户标识?: number;
    }): 审计条目 {
        // 若有其他进程写入，则从磁盘重新同步 lastHash
        this.初始化();
        const 时间戳值 = new Date().toISOString();
        const 安全命令 = 脱敏密钥列表(数据.命令);
        const 安全预览 = 数据.输出预览 ? 脱敏密钥列表(数据.输出预览.slice(0, 500)) : undefined;
        const 基础条目: Omit<审计条目, "\u54C8\u5E0C"> = {
            时间戳值,
            节点标识: 数据.节点标识,
            命令: 安全命令,
            退出代码: 数据.退出代码,
            时长毫秒: 数据.时长毫秒,
            风险: 数据.风险,
            已批准: 数据.已批准,
            ...(数据.定时输出 !== undefined ? { 定时输出: 数据.定时输出 } : {}),
            ...(安全预览 !== undefined ? { 输出预览: 安全预览 } : {}),
            ...(数据.聊天标识 !== undefined ? { 聊天标识: 数据.聊天标识 } : {}),
            ...(数据.用户标识 !== undefined ? { 用户标识: 数据.用户标识 } : {}),
            上一个哈希: this.最后哈希,
        };
        const 哈希 = 计算条目哈希(基础条目);
        const 条目: 审计条目 = { ...基础条目, 哈希 };
        this.最后哈希 = 哈希;
        try {
            fs.appendFileSync(this.日志路径, JSON.stringify(条目) + "\n", { encoding: "utf8", mode: 0o600 });
            try {
                fs.chmodSync(this.日志路径, 0o600);
            }
            catch {
                // 忽略
            }
        }
        catch (错误对象: any) {
            console.error(`[audit:${数据.节点标识}] Gagal menulis audit log:`, 错误对象.message);
        }
        return 条目;
    }
    验证(): 审计验证结果 {
        if (!fs.existsSync(this.日志路径)) {
            return { 是否成功: true, 总计: 0 };
        }
        let 原始 = "";
        try {
            原始 = fs.readFileSync(this.日志路径, "utf8");
        }
        catch (错误对象: any) {
            return { 是否成功: false, 总计: 0, 原因: `gagal membaca file: ${错误对象.message}` };
        }
        const 行列表 = 原始.trim().split("\n").filter(Boolean);
        let 预期上一个 = "GENESIS";
        for (let 循环索引 = 0; 循环索引 < 行列表.length; 循环索引++) {
            let 已解析: 审计条目;
            try {
                已解析 = JSON.parse(行列表[循环索引]!) as 审计条目;
            }
            catch {
                return { 是否成功: false, 总计: 行列表.length, 损坏位于: 循环索引 + 1, 原因: "baris bukan JSON valid" };
            }
            if (已解析.上一个哈希 !== 预期上一个) {
                return {
                    是否成功: false,
                    总计: 行列表.length,
                    损坏位于: 循环索引 + 1,
                    原因: `prevHash tidak cocok (ekspektasi ${预期上一个.slice(0, 12)}..., dapat ${String(已解析.上一个哈希).slice(0, 12)}...)`,
                };
            }
            const { 哈希, ...剩余 } = 已解析;
            const 预期哈希 = 计算条目哈希(剩余);
            if (哈希 !== 预期哈希) {
                return {
                    是否成功: false,
                    总计: 行列表.length,
                    损坏位于: 循环索引 + 1,
                    原因: "hash SHA-256 tidak cocok (data baris telah diubah)",
                };
            }
            预期上一个 = 哈希;
        }
        return { 是否成功: true, 总计: 行列表.length };
    }
    获取日志路径(): string {
        return this.日志路径;
    }
}


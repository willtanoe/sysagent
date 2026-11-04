import * as fs from "fs";
import * as path from "path";
import { 聊天历史项目, 令牌用量 } from "../shared/protocol";
export interface 用量统计 {
    请求列表: number;
    提示词令牌列表: number;
    补全令牌列表: number;
}
export interface 中枢已持久化状态 {
    活跃节点列表: Record<string, string>;
    历史列表: Record<string, 聊天历史项目[]>;
    模型列表: Record<string, string>;
    用量: Record<string, 用量统计>;
}
export class 中枢存储类 {
    private 文件路径: string;
    private 状态值: 中枢已持久化状态 = {
        活跃节点列表: {},
        历史列表: {},
        模型列表: {},
        用量: {},
    };
    private 保存定时器: NodeJS.Timeout | null = null;
    private 记忆轮次: number;
    private 记忆字符: number;
    constructor(文件路径: string, 选项集?: {
        记忆轮次?: number;
        记忆字符?: number;
    }) {
        this.文件路径 = 文件路径;
        this.记忆轮次 = 选项集?.记忆轮次 ?? 4;
        this.记忆字符 = 选项集?.记忆字符 ?? 400;
        this.加载();
    }
    private 加载(): void {
        try {
            if (!fs.existsSync(this.文件路径))
                return;
            const 原始 = fs.readFileSync(this.文件路径, "utf8");
            const 已解析 = JSON.parse(原始) as Partial<中枢已持久化状态>;
            this.状态值 = {
                活跃节点列表: 已解析.活跃节点列表 ?? {},
                历史列表: 已解析.历史列表 ?? {},
                模型列表: 已解析.模型列表 ?? {},
                用量: 已解析.用量 ?? {},
            };
        }
        catch {
            this.状态值 = { 活跃节点列表: {}, 历史列表: {}, 模型列表: {}, 用量: {} };
        }
    }
    private 调度保存(): void {
        if (this.保存定时器 !== null)
            return;
        this.保存定时器 = setTimeout(() => {
            this.保存定时器 = null;
            this.刷新();
        }, 1000);
        this.保存定时器.unref?.();
    }
    刷新(): void {
        try {
            if (this.保存定时器) {
                clearTimeout(this.保存定时器);
                this.保存定时器 = null;
            }
            const 目录 = path.dirname(path.resolve(this.文件路径));
            fs.mkdirSync(目录, { recursive: true, mode: 0o700 });
            const 临时 = `${this.文件路径}.tmp`;
            fs.writeFileSync(临时, JSON.stringify(this.状态值, null, 2), { mode: 0o600 });
            try {
                fs.chmodSync(临时, 0o600);
            }
            catch {
                // 忽略
            }
            fs.renameSync(临时, this.文件路径);
        }
        catch (错误对象: any) {
            console.error("[hub:store] Gagal menyimpan state:", 错误对象.message);
        }
    }
    获取活跃节点(聊天标识: number): string | undefined {
        return this.状态值.活跃节点列表[String(聊天标识)];
    }
    设置活跃节点(聊天标识: number, 节点标识: string | null): void {
        if (节点标识 === null) {
            delete this.状态值.活跃节点列表[String(聊天标识)];
        }
        else {
            this.状态值.活跃节点列表[String(聊天标识)] = 节点标识;
        }
        this.调度保存();
    }
    获取历史(聊天标识: number, 节点标识: string): 聊天历史项目[] {
        return this.状态值.历史列表[`${聊天标识}:${节点标识}`] ?? [];
    }
    记住(聊天标识: number, 节点标识: string, 提示词: string, 回复: string): void {
        const 键 = `${聊天标识}:${节点标识}`;
        const 列出 = [...(this.状态值.历史列表[键] ?? [])];
        const 简洁回复 = 回复.replace(/\s+/g, " ").trim().slice(0, this.记忆字符);
        列出.push({ 角色: "user", 内容: 提示词.slice(0, this.记忆字符) }, { 角色: "assistant", 内容: 简洁回复 });
        const 最大项目列表 = Math.max(2, this.记忆轮次 * 2);
        while (列出.length > 最大项目列表)
            列出.shift();
        this.状态值.历史列表[键] = 列出;
        this.调度保存();
    }
    重置聊天(聊天标识: number, 节点标识?: string): void {
        if (节点标识) {
            delete this.状态值.历史列表[`${聊天标识}:${节点标识}`];
        }
        else {
            for (const 键 of Object.keys(this.状态值.历史列表)) {
                if (键.startsWith(`${聊天标识}:`))
                    delete this.状态值.历史列表[键];
            }
        }
        delete this.状态值.用量[String(聊天标识)];
        this.调度保存();
    }
    获取模型覆盖(聊天标识: number): string | undefined {
        return this.状态值.模型列表[String(聊天标识)];
    }
    设置模型覆盖(聊天标识: number, 模型: string | null): void {
        if (模型 === null) {
            delete this.状态值.模型列表[String(聊天标识)];
        }
        else {
            this.状态值.模型列表[String(聊天标识)] = 模型;
        }
        this.调度保存();
    }
    添加用量(聊天标识: number, 用量: 令牌用量): void {
        const 键 = String(聊天标识);
        const 当前 = this.状态值.用量[键] ?? { 请求列表: 0, 提示词令牌列表: 0, 补全令牌列表: 0 };
        当前.请求列表 += 1;
        当前.提示词令牌列表 += 用量.提示词令牌列表;
        当前.补全令牌列表 += 用量.补全令牌列表;
        this.状态值.用量[键] = 当前;
        this.调度保存();
    }
    获取用量(聊天标识: number): 用量统计 {
        return this.状态值.用量[String(聊天标识)] ?? { 请求列表: 0, 提示词令牌列表: 0, 补全令牌列表: 0 };
    }
}


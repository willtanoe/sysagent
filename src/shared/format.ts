const 块限制 = 3400;
export function 转义超文本标记(文本: string): string {
    return 文本.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function 转义正则指数(文本: string): string {
    return 文本.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function 预阻断(代码: string, 语言 = "text"): string {
    return `<pre><code class="language-${语言}">${转义超文本标记(代码)}</code></pre>`;
}
/** 轻量级 Markdown -> Telegram HTML。先转义，再加标签。 */
export function 标记文本到超文本标记(输入: string): string {
    const 代码块列表: string[] = [];
    let 文本 = 输入.replace(/\r\n/g, "\n");
    文本 = 文本.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g, (私有匹配, 语言: string, 请求体: string) => {
        const 索引 = 代码块列表.push(预阻断(请求体.replace(/\n$/, ""), 语言 || "text")) - 1;
        return `\u0000CB${索引}\u0000`;
    });
    文本 = 转义超文本标记(文本);
    文本 = 文本.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/(^|\s)__([^_\n]+)__/g, "$1<b>$2</b>")
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/^\s*[-*]\s+/gm, "• ")
        .replace(/^\s*(\d+)\.\s+/gm, "$1. ");
    return 文本.replace(/\u0000CB(\d+)\u0000/g, (私有匹配, 索引: string) => 代码块列表[Number(索引)] ?? "");
}
/** 将 HTML 分割为多条消息，不破坏 <pre> 块且不丢失内容。 */
export function 块超文本标记(超文本标记: string, 限制 = 块限制): string[] {
    const 消息块列表: string[] = [];
    let 缓冲区 = "";
    let 输入预 = false;
    const 刷新 = (): void => {
        if (缓冲区.trim() === "") {
            缓冲区 = "";
            return;
        }
        消息块列表.push(输入预 ? `${缓冲区}</code></pre>` : 缓冲区);
        缓冲区 = 输入预 ? '<pre><code class="language-text">' : "";
    };
    const 追加 = (片段: string): void => {
        if (缓冲区.length + 片段.length + 1 > 限制)
            刷新();
        缓冲区 += (缓冲区 ? "\n" : "") + 片段;
        const 打开 = (片段.match(/<pre><code/g) ?? []).length;
        const 关闭列表 = (片段.match(/<\/code><\/pre>/g) ?? []).length;
        if (打开 > 关闭列表)
            输入预 = true;
        else if (关闭列表 > 打开)
            输入预 = false;
    };
    const 拆分长行 = (行: string, 大小: number): string[] => {
        const 部分: string[] = [];
        let 索引 = 0;
        while (索引 < 行.length) {
            let 结束 = Math.min(索引 + 大小, 行.length);
            if (结束 < 行.length) {
                const 最后打开 = 行.lastIndexOf("<", 结束);
                const 最后关闭 = 行.lastIndexOf(">", 结束);
                if (最后打开 > 最后关闭 && 结束 - 最后打开 < 200)
                    结束 = 最后打开;
                const 最后空格 = 行.lastIndexOf(" ", 结束);
                if (最后空格 > 索引 + 大小 / 2)
                    结束 = 最后空格;
            }
            if (结束 <= 索引)
                结束 = Math.min(索引 + 大小, 行.length);
            部分.push(行.slice(索引, 结束));
            索引 = 结束;
        }
        return 部分;
    };
    for (const 原始行 of 超文本标记.split("\n")) {
        if (原始行.length <= 限制) {
            追加(原始行);
            continue;
        }
        for (const 片段 of 拆分长行(原始行, 限制 - 100))
            追加(片段);
    }
    刷新();
    return 消息块列表.length > 0 ? 消息块列表 : ["(kosong)"];
}
export function 渲染标记文本(输入: string): string[] {
    return 块超文本标记(标记文本到超文本标记(输入));
}


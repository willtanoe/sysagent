export interface 节点发行版信息 {
    标识: string;
    名称: string;
    版本: string;
    软件包管理器: string;
}
export interface 节点信息 {
    主机名: string;
    平台: string;
    架构: string;
    运行时长: number;
    加载平均值: number[];
    记忆: {
        总计兆字节: number;
        空闲兆字节: number;
    };
    发行版?: 节点发行版信息;
    内核?: string;
    处理器数量?: number;
    磁盘百分比?: number;
    是否根?: boolean;
}
export interface 聊天历史项目 {
    角色: "user" | "assistant";
    内容: string;
}
export interface 令牌用量 {
    提示词令牌列表: number;
    补全令牌列表: number;
}
// 节点 -> 中枢
export interface 节点你好消息 {
    类型: "node_hello";
    节点标识: string;
    令牌: string;
    信息: 节点信息;
}
export interface 节点心跳消息 {
    类型: "node_heartbeat";
    节点标识: string;
    运行时长: number;
    加载平均值: number[];
    记忆: {
        总计兆字节: number;
        空闲兆字节: number;
    };
    磁盘百分比?: number;
}
export interface 节点运行块消息 {
    类型: "node_chunk";
    运行标识: string;
    数据块: string;
}
export interface 节点审批请求消息 {
    类型: "node_approval_req";
    运行标识: string;
    审批标识: string;
    命令: string;
    原因: string;
}
export interface 节点运行完成消息 {
    类型: "node_done";
    运行标识: string;
    完整文本: string;
    错误?: string;
    用量?: 令牌用量;
}
export interface 节点告警消息 {
    类型: "node_alert";
    节点标识: string;
    键: string;
    严重度: "warn" | "ok";
    超文本标记: string;
}
export interface 节点探活响应消息 {
    类型: "node_pong";
    时间戳: number;
}
export type 节点到中枢消息 = 节点你好消息 | 节点心跳消息 | 节点运行块消息 | 节点审批请求消息 | 节点运行完成消息 | 节点告警消息 | 节点探活响应消息;
// 中枢 -> 节点
export interface 中枢欢迎消息 {
    类型: "hub_welcome";
    成功: boolean;
    消息内容: string;
}
export interface 中枢运行提示词消息 {
    类型: "hub_run";
    运行标识: string;
    聊天标识: number;
    用户标识?: number;
    提示词: string;
    模型?: string;
    历史?: 聊天历史项目[];
}
export interface 中枢审批响应消息 {
    类型: "hub_approval_res";
    运行标识: string;
    审批标识: string;
    已批准: boolean;
}
export interface 中枢运行取消消息 {
    类型: "hub_cancel";
    运行标识: string;
}
export interface 中枢探活消息 {
    类型: "hub_ping";
    时间戳: number;
}
export type 中枢到节点消息 = 中枢欢迎消息 | 中枢运行提示词消息 | 中枢审批响应消息 | 中枢运行取消消息 | 中枢探活消息;


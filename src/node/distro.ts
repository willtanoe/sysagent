import * as fs from "fs";
import { 节点发行版信息 } from "../shared/protocol";
const RHEL家族 = ["almalinux", "rocky", "centos", "rhel", "fedora", "ol", "amzn"];
const Debian家族 = ["debian", "ubuntu", "raspbian", "linuxmint", "pop"];
function 解析操作系统发布(): Record<string, string> {
    try {
        const 原始 = fs.readFileSync("/etc/os-release", "utf8");
        const 已解析: Record<string, string> = {};
        for (const 行 of 原始.split("\n")) {
            const 匹配 = /^([A-Z_]+)=(.*)$/.exec(行.trim());
            if (!匹配)
                continue;
            const 键 = 匹配[1] ?? "";
            已解析[键] = (匹配[2] ?? "").replace(/^"|"$/g, "");
        }
        return 已解析;
    }
    catch {
        return {};
    }
}
function 软件包管理器用于(标识: string): string {
    if (RHEL家族.includes(标识))
        return "dnf/yum (rpm)";
    if (Debian家族.includes(标识))
        return "apt/dpkg";
    if (["arch", "manjaro", "endeavouros"].includes(标识))
        return "pacman";
    if (标识 === "alpine")
        return "apk";
    if (标识.startsWith("opensuse") || 标识 === "sles" || 标识 === "sled")
        return "zypper";
    return "tidak diketahui — periksa dulu sebelum mengubah paket";
}
export const 发行版: 节点发行版信息 = (() => {
    const 数据 = 解析操作系统发布();
    const 标识 = (数据.ID ?? "unknown").toLowerCase();
    return {
        标识,
        名称: 数据.PRETTY_NAME ?? 数据.NAME ?? "Linux",
        版本: 数据.VERSION_ID ?? "",
        软件包管理器: 软件包管理器用于(标识),
    };
})();
export function 是否RHEL家族(): boolean {
    return RHEL家族.includes(发行版.标识);
}
/** 为系统 prompt 提供 distro 上下文，避免模型猜测包管理器。 */
export function 发行版上下文(): string {
    const SELinux = 是否RHEL家族()
        ? " SELinux aktif secara default: cek pakai getenforce; jangan mematikannya tanpa diminta."
        : "";
    return `Server ini ${发行版.名称} (id=${发行版.标识} ${发行版.版本}), package manager ${发行版.软件包管理器}.${SELinux}`;
}


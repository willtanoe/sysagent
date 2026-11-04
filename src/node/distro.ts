import * as fs from "fs";
import { NodeDistroInfo } from "../shared/protocol";

const RHEL_FAMILY = ["almalinux", "rocky", "centos", "rhel", "fedora", "ol", "amzn"];
const DEBIAN_FAMILY = ["debian", "ubuntu", "raspbian", "linuxmint", "pop"];

function parseOsRelease(): Record<string, string> {
  try {
    const raw = fs.readFileSync("/etc/os-release", "utf8");
    const parsed: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const key = match[1] ?? "";
      parsed[key] = (match[2] ?? "").replace(/^"|"$/g, "");
    }
    return parsed;
  } catch {
    return {};
  }
}

function packageManagerFor(id: string): string {
  if (RHEL_FAMILY.includes(id)) return "dnf/yum (rpm)";
  if (DEBIAN_FAMILY.includes(id)) return "apt/dpkg";
  if (["arch", "manjaro", "endeavouros"].includes(id)) return "pacman";
  if (id === "alpine") return "apk";
  if (id.startsWith("opensuse") || id === "sles" || id === "sled") return "zypper";
  return "tidak diketahui — periksa dulu sebelum mengubah paket";
}

export const distro: NodeDistroInfo = (() => {
  const data = parseOsRelease();
  const id = (data.ID ?? "unknown").toLowerCase();
  return {
    id,
    name: data.PRETTY_NAME ?? data.NAME ?? "Linux",
    version: data.VERSION_ID ?? "",
    packageManager: packageManagerFor(id),
  };
})();

export function isRhelFamily(): boolean {
  return RHEL_FAMILY.includes(distro.id);
}

/** 为系统 prompt 提供 distro 上下文，避免模型猜测包管理器。 */
export function distroContext(): string {
  const selinux = isRhelFamily()
    ? " SELinux aktif secara default: cek pakai getenforce; jangan mematikannya tanpa diminta."
    : "";
  return `Server ini ${distro.name} (id=${distro.id} ${distro.version}), package manager ${distro.packageManager}.${selinux}`;
}

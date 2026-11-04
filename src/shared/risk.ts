export type 判定级别 = "allow" | "approve" | "block";
export interface 判定结果 {
    级别: 判定级别;
    原因: string;
}
interface 规则类 {
    匹配模式?: RegExp;
    检查?: (命令: string) => boolean;
    原因: string;
}
/** 检测命令是否对文件进行重定向（不包括 /dev/null 或 2>&1）。 */
export function 是否具有文件重定向(命令: string): boolean {
    // 移除引号内的字符串，避免引号内字符串（如 awk '$1 > 2'）触发重定向
    const 未加引号 = 命令.replace(/'[^']*'|"[^"]*"/g, " ");
    // 剔除安全重定向：>/dev/null、2>/dev/null、&>/dev/null、2>&1、1>&2、>&2 等
    const 已清理 = 未加引号.replace(/(?:&>|[0-9]+>|>>|>)\s*\/dev\/null\b/g, " ")
        .replace(/[0-9]*>&[0-9]+/g, " ")
        .replace(/[0-9]*<&[0-9]+/g, " ");
    // 是否仍存在重定向操作符 > 或 <（不包括进程替换 <(...) 或 heredoc <<）？
    return /(?:^|[^<])<{1,2}(?![<(])|>{1,2}/.test(已清理);
}
/** 不允许读取或触碰的敏感目标文件。 */
export function 是否密钥访问(原始: string): boolean {
    // 移除引号、反斜杠和花括号，防止混淆（如 .e""nv、.e\nv、/etc/{shadow}）
    const 命令文本 = 原始.replace(/["'\\{}]/g, "");
    const 密钥 = /(?:^|[\s/])\.(?:env|en\?|en\*)(?!\.example\b)|(?:\/etc\/(?:g?shad(?:ow|[\w?*]*)|sudoers(?:\.d)?\b|ssl\/private\b|letsencrypt\/live\b|wireguard\b|openvpn\b|ipsec\.secrets\b|ppp\/[^\s]*secrets|kubernetes\/[^\s]*\.conf|rancher\/k3s\/k3s\.yaml))|id_(?:rsa|ed25519|ecdsa|dsa)\b|privkey[^\s]*\.pem\b|\.ssh\/|\.kube\/config\b|\.docker\/config\.json\b|\.config\/aster|askpass(?:[-_A-Za-z0-9.]*\.sh)?|hub-state\.json|wp-config(?:\.php)?|\.aws\/(?:credentials|config)|\.git-credentials|\.netrc|\.my\.cnf|\.pgpass|\/proc\/(?:[^\s]*\/)?envi[^\s]*/i;
    return 密钥.test(命令文本);
}
/** 始终拒绝，不提供确认选项。 */
const 阻断状态: 规则类[] = [
    { 匹配模式: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&/, 原因: "fork bomb" },
    { 匹配模式: /\brm\s+(-[A-Za-z]+\s+)*-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+\/(\s|$|\*)/, 原因: "rm -rf /" },
    { 匹配模式: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/, 原因: "menulis mentah ke block device" },
    { 匹配模式: />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, 原因: "redirect ke block device" },
    { 匹配模式: /\bmkfs(\.[A-Za-z0-9]+)?\b/, 原因: "memformat filesystem" },
    { 匹配模式: /\b(cat|dd|head)\b[^\n]*\/dev\/(urandom|zero|random)[^\n]*>\s*\/dev\/(sd|nvme|vd|hd)/, 原因: "mengacak block device" },
    { 检查: 是否密钥访问, 原因: "mengakses file rahasia (kredensial)" },
    { 匹配模式: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|\brm\b[^\n]*\.bash_history/, 原因: "menghapus jejak perintah" },
    // 独立的环境变量泄露（可能包含 token/secret）。
    { 匹配模式: /\b(printenv|compgen)\b/, 原因: "menampilkan environment (bisa berisi secret)" },
    { 匹配模式: /\b(env|set|declare)\s*($|[;&|])/, 原因: "menampilkan environment (bisa berisi secret)" },
    { 匹配模式: /\bexport\s*($|[;&|])/, 原因: "menampilkan environment (bisa berisi secret)" },
    // 执行 agent 的秘密脚本/文件（askpass）。
    { 匹配模式: /\b(bash|sh|zsh|dash|ksh)\b[^\n]*\.config\/aster/, 原因: "mengeksekusi file rahasia agent" },
    { 匹配模式: /\b(bash|sh|zsh|dash|ksh)\b[^\n]*askpass/, 原因: "mengeksekusi askpass (password sudo)" },
    { 匹配模式: /\.\s+[^\n]*\.config\/aster/, 原因: "mengeksekusi file rahasia agent" },
    { 匹配模式: /\.\s+[^\n]*askpass/, 原因: "mengeksekusi askpass (password sudo)" },
    { 匹配模式: /\bsource\b[^\n]*askpass/, 原因: "mengeksekusi askpass (password sudo)" },
    // 通过 stdin/pipe 以明文注入密码。
    { 匹配模式: /\bsudo\s+-[A-Za-z0-9]*S\b/, 原因: "menyuntikkan password ke sudo via stdin (-S)" },
    { 匹配模式: /\b(?:printf|echo)\b[^\n]*\|\s*(?:sudo|su)\b/, 原因: "pipe password ke sudo/su" },
    // 在根文件系统上删除（flag 变体）。
    { 匹配模式: /\brm\b[^\n]*\s\/(\s|$|\*|\/)/, 原因: "rm pada root filesystem" },
];
/** 需要用户通过内联键盘确认。 */
const 需要审批: 规则类[] = [
    {
        检查: (命令文本) => /\bsudo\b|\bdoas\b/.test(命令文本) &&
            (typeof process.getuid !== "function" ||
                process.getuid() !== 0 ||
                /\b(?:sudo|doas)\s+-[A-Za-z]*[ug]\b/.test(命令文本) ||
                !是否读取仅命令(命令文本)),
        原因: "eksekusi dengan privilege",
    },
    { 匹配模式: /\brm\b/, 原因: "menghapus file" },
    { 匹配模式: /\bmv\b/, 原因: "memindahkan atau menimpa path" },
    { 匹配模式: /\bdd\b/, 原因: "operasi disk mentah" },
    { 匹配模式: /\bshred\b|\btruncate\b|\bfallocate\b/, 原因: "menghancurkan atau mengubah ukuran file" },
    { 匹配模式: /\bchmod\b|\bchown\b|\bchattr\b|\bsetfacl\b|\bsetfattr\b/, 原因: "mengubah permission atau ownership" },
    { 匹配模式: /\bfind\b[^\n]*-(?:delete|exec|execdir|ok|okdir)\b/, 原因: "hapus atau eksekusi massal via find" },
    { 匹配模式: /\b(?:mkdir|rmdir|touch|mktemp)\b/, 原因: "membuat atau menghapus direktori/file" },
    { 匹配模式: /\b(?:tar|zip|unzip|gzip|gunzip|bzip2|xz|patch)\b/, 原因: "manipulasi arsip atau patch file" },
    { 匹配模式: /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b/, 原因: "mengubah state service" },
    { 匹配模式: /\bservice\s+\S+\s+(start|stop|restart|reload)\b/, 原因: "mengubah state service" },
    { 匹配模式: /\b(reboot|shutdown|halt|poweroff)\b|\binit\s+[06]\b/, 原因: "mematikan atau reboot server" },
    { 匹配模式: /(?:^|[;&|()]\s*|\b(?:sudo|doas)\s+)\s*(useradd|userdel|usermod|passwd|chpasswd|visudo|su\s+-)\b/, 原因: "mengubah user atau password" },
    { 匹配模式: /\b(iptables|nft|ufw|firewall-cmd)\b/, 原因: "mengubah firewall" },
    { 匹配模式: /\b(mount|umount|fdisk|parted|pvcreate|vgcreate|lvcreate|zpool)\b/, 原因: "mengubah storage" },
    { 匹配模式: /\b(apt|apt-get|dpkg|dnf|yum|pacman|apk|zypper)\b/, 原因: "mengubah paket sistem" },
    { 匹配模式: /\brpm\s+-[eiU]/, 原因: "mengubah paket sistem" },
    { 匹配模式: /\b(setenforce|semanage|restorecon|chcon|audit2allow|semodule)\b/, 原因: "mengubah kebijakan SELinux" },
    { 匹配模式: /\b(authselect|grubby|grub2-mkconfig|update-grub|subscription-manager)\b/, 原因: "mengubah konfigurasi sistem/boot" },
    { 匹配模式: /\b(nmcli|hostnamectl\s+set|timedatectl\s+set|localectl\s+set)\b/, 原因: "mengubah konfigurasi host atau jaringan" },
    { 匹配模式: /\bdocker\s+(rm|rmi|prune|stop|kill|system\s+prune)\b|\bdocker\s+compose\s+(down|rm)\b/, 原因: "menghapus atau menghentikan container" },
    { 匹配模式: /\bcrontab\b|>\s*\/etc\/cron/, 原因: "mengubah cron" },
    { 匹配模式: /\|\s*(sudo\s+)?(bash|sh|zsh|python3?|node)\b/, 原因: "mengeksekusi script dari pipe" },
    { 匹配模式: /\bcurl\b[^\n]*\|\s*(sudo\s+)?(bash|sh|zsh)\b|\bwget\b[^\n]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/, 原因: "menjalankan script dari internet" },
    { 匹配模式: /\beval\b|\bbase64\s+-d[^\n]*\|\s*(sudo\s+)?(bash|sh)\b/, 原因: "eksekusi kode dinamis" },
    { 匹配模式: /\b(kill|pkill|killall)\b/, 原因: "mematikan proses" },
    { 匹配模式: />\s*\/(etc|boot|usr|bin|sbin|lib|var\/lib)\//, 原因: "menulis ke direktori sistem" },
    { 匹配模式: /\btee\s+\/(etc|boot|usr|bin|sbin|lib)\//, 原因: "menulis ke direktori sistem" },
    { 匹配模式: /\bgit\s+(reset\s+--hard|clean\s+-[A-Za-z]*f|push\s+(--force|-f))\b/, 原因: "operasi git destruktif" },
    { 匹配模式: /\bprintenv\b/, 原因: "menampilkan environment proses" },
    { 匹配模式: /\bsystemctl\s+(cat|show)\s+aster-(?:sys|node|hub)/, 原因: "membaca konfigurasi service agent" },
    { 匹配模式: /\$\(|`/, 原因: "command substitution dinamis (tidak bisa dinilai statis)" },
    { 匹配模式: /\b(bash|sh|zsh|dash|ksh)\s+-c\b/, 原因: "eksekusi string shell" },
    {
        匹配模式: /\b(bash|sh|zsh|python3?|node|perl|ruby)\s+\/(tmp|var\/tmp|dev\/shm)\//,
        原因: "mengeksekusi script dari direktori sementara",
    },
    // 不经重定向直接写入/放置文件到系统目录。
    {
        匹配模式: /\b(cp|install|ln|rsync|mv)\b[^\n]+\s\/(etc|boot|usr|bin|sbin|lib|var\/lib)(\/|\b)/,
        原因: "menaruh file ke direktori sistem",
    },
    {
        匹配模式: /\b(curl|wget)\b[^\n]*\s(-o|-O|--output|-P|--directory-prefix)\s*\/?(etc|boot|usr|bin|sbin|lib)\//,
        原因: "mengunduh file langsung ke direktori sistem",
    },
    // 通过包管理器/解释器执行任意代码。
    {
        匹配模式: /\b(npm|pnpm|yarn|pip|pip3|gem|cargo|go)\s+(i|install|add|get)\b/,
        原因: "memasang paket (eksekusi kode pihak ketiga)",
    },
    { 匹配模式: /\b(modprobe|insmod|rmmod|systemd-run|nsenter|unshare|chroot)\b/, 原因: "memuat modul / mengubah namespace" },
    { 匹配模式: /\bsysctl\s+-w\b/, 原因: "mengubah parameter kernel" },
    { 匹配模式: /\b(swapoff|swapon|mkswap)\b/, 原因: "mengubah swap" },
    { 匹配模式: /\b(nc|netcat|ncat|socat)\b/, 原因: "transfer data via socket mentah" },
    { 匹配模式: /\b(scp|rsync|sftp)\b/, 原因: "transfer file ke/dari host lain" },
    { 匹配模式: /\b(at|batch)\s/, 原因: "menjadwalkan job" },
    { 匹配模式: /\b(python3?|perl|node|ruby|php|lua)\b[^\n]*\s(-c|-e|--eval|-r)\b/, 原因: "eksekusi kode via interpreter" },
    // 文件写入/修改（不仅限于系统目录）。
    { 匹配模式: /\bcp\b/, 原因: "menyalin file" },
    { 匹配模式: /\binstall\b/, 原因: "menaruh file (install)" },
    { 匹配模式: /\bln\b/, 原因: "membuat link (ubah filesystem)" },
    { 匹配模式: /\btee\b/, 原因: "menulis output ke file" },
    { 检查: 是否具有文件重定向, 原因: "redirection output/input ke file" },
    { 匹配模式: /\bsed\b[^\n]*\s-i\b/, 原因: "edit in-place (sed -i)" },
    { 匹配模式: /\bperl\b[^\n]*\s-i\b/, 原因: "edit in-place (perl -i)" },
    { 匹配模式: /\bawk\b[^\n]*\b(?:print|printf)\b[^;\n}]*(?:>>?|\|)/i, 原因: "redirection/pipe output dari dalam awk" },
    { 匹配模式: /\bsed\b[^\n]*(?:\/[gIim]*e\b|(?:^|['";\s])w\s+\S)/i, 原因: "eksekusi atau tulis file dari dalam sed" },
    // 通过解释器/shell 执行本地脚本/文件（仅当解释器位于可执行位置时）。
    {
        匹配模式: /(?:^|[;&|()]\s*|\b(?:sudo|doas|exec|nohup|time|env)\s+)\s*(?:python3?|node|perl|ruby|php|lua|bash|sh|zsh|dash|ksh)\s+[^\s-]/i,
        原因: "mengeksekusi script/file lokal via interpreter",
    },
    {
        匹配模式: /(?:^|[;&|()]\s*|\b(?:sudo|doas)\s+)\s*source\s+\S/i,
        原因: "mengeksekusi script via source",
    },
    {
        匹配模式: /(?:^|[;&|()]\s*|\b(?:sudo|doas)\s+)\s*\.\s+[^\s-]/i,
        原因: "mengeksekusi script via dot (.)",
    },
    { 匹配模式: /\bsystem\s*\(|\bexec\s*\(|\bpopen\s*\(/, 原因: "eksekusi kode dinamis" },
    // 网络出站与下载
    {
        匹配模式: /\bcurl\b[^\n]*\s(-[dFT]|--data\b|--data-\w+|--form\b|--upload-file\b|-X\s*(POST|PUT|PATCH|DELETE)\b)/i,
        原因: "mengirim/mengunggah data ke jaringan (curl)",
    },
    {
        匹配模式: /\bcurl\b[^\n]*\s(-[oOJ]|--output\b|--remote-name\b)/i,
        原因: "mengunduh dan menyimpan file (curl)",
    },
    { 匹配模式: /\bwget\b/i, 原因: "mengunduh file dari jaringan (wget)" },
];
/** 将管道拆分为独立阶段，不拆分引号内的管道。 */
function 拆分流水线(分段: string): string[] {
    const 阶段列表: string[] = [];
    let 当前 = "";
    let 输入单 = false;
    let 输入双 = false;
    for (let 循环索引 = 0; 循环索引 < 分段.length; 循环索引++) {
        const 字符 = 分段[循环索引];
        if (字符 === "'" && !输入双) {
            输入单 = !输入单;
            当前 += 字符;
        }
        else if (字符 === '"' && !输入单) {
            输入双 = !输入双;
            当前 += 字符;
        }
        else if (字符 === "|" && !输入单 && !输入双) {
            阶段列表.push(当前.trim());
            当前 = "";
        }
        else {
            当前 += 字符;
        }
    }
    if (当前.trim() !== "") {
        阶段列表.push(当前.trim());
    }
    return 阶段列表;
}
/** 启发式：该命令是否仅读取（不改变状态）？ */
export function 是否读取仅命令(命令: string): boolean {
    const 分段列表 = 命令.split(/[\n;]+|&&|\|\|/).map((字符串) => 字符串.trim()).filter(Boolean);
    if (分段列表.length === 0)
        return false;
    const 是否具有变更中 = (分段: string): boolean => {
        // 重定向到真实文件（非 /dev/null 或 2>&1）
        if (是否具有文件重定向(分段))
            return true;
        // 原地编辑与脚本内部文件写入/执行
        if (/\b(?:sed|perl)\b[^\n]*\s-i\b/i.test(分段))
            return true;
        if (/\bawk\b[^\n]*\b(?:print|printf)\b[^;\n}]*(?:>>?|\|)/i.test(分段))
            return true;
        if (/\bsed\b[^\n]*(?:\/[gIim]*e\b|(?:^|['";\s])w\s+\S)/i.test(分段))
            return true;
        // 脚本中的动态执行
        if (/\b(?:system|exec|popen|eval)\s*\(/i.test(分段))
            return true;
        // 命令替换
        if (/`|\$\(/.test(分段))
            return true;
        // 网络上传/下载
        if (/\bwget\b/i.test(分段))
            return true;
        if (/\bcurl\b[^\n]*\s(-[dFToOJ]|--data|--form|--upload|--output)/i.test(分段))
            return true;
        // 移除引号字符串，避免 echo/grep 内文本触发误报。
        const 低 = 分段.toLowerCase().replace(/'[^']*'|"[^"]*"/g, " ");
        // 变更类命令 token（作为命令，而非 /etc/passwd 这类文本子串）。
        if (/(?<![\/.-])\b(rm|rmdir|mv|cp|install|remove|purge|update|restart|stop|start|enable|disable|kill|pkill|killall|shutdown|poweroff|halt|mkfs|dd|chmod|chown|chattr|truncate|shred|useradd|userdel|usermod|passwd)\b/.test(低)) {
            return true;
        }
        if (/\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b/.test(低)) {
            return true;
        }
        if (/\b(apt|apt-get|dnf|yum|pacman|apk|zypper)\s+(install|remove|purge|autoremove|add|del)\b/.test(低)) {
            return true;
        }
        // apt upgrade/dist-upgrade（dry-run 除外）
        if (/\b(apt|apt-get)\s+(\S+\s+)*(upgrade|dist-upgrade|full-upgrade)\b/.test(低)) {
            if (!/\s(-s|--simulate|--dry-run)\b/.test(低))
                return true;
        }
        if (/>\s*\/(etc|boot|usr|bin|sbin|lib|var\/lib)\//.test(低)) {
            return true;
        }
        // reboot 作为变更命令（仅在段首）
        if (/^\s*(sudo\s+|doas\s+)*reboot(\s|$)/.test(低)) {
            return true;
        }
        return false;
    };
    const 是否流水线阶段读取仅 = (阶段: string): boolean => {
        const 已修剪 = 阶段.trim();
        if (已修剪 === "")
            return false;
        // 获取第一条命令 token（忽略 sudo、doas、env、time、nohup）
        const 已规范化 = 已修剪.replace(/^\s*(?:sudo|doas|nohup|time|env)\s+/, "");
        // 第一个 token 是可执行文件/命令名称
        const 首个单词匹配 = /^[A-Za-z0-9_.-]+/.exec(已规范化);
        if (!首个单词匹配)
            return false;
        const 命令文本 = 首个单词匹配[0].toLowerCase();
        // 明显的只读命令
        const 基本读取仅 = new Set([
            "uname", "hostname", "uptime", "nproc", "whoami", "id", "arch", "pwd", "date", "sleep",
            "df", "free", "ps", "ss", "netstat", "top", "htop", "vmstat", "iostat", "ip", "ifconfig", "route", "arp",
            "journalctl", "dmesg", "lsof", "lsmod", "getenforce", "sestatus", "last", "w", "who", "groups",
            "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "awk", "sed", "lsattr", "getfacl",
            "wc", "sort", "uniq", "cut", "tr", "echo", "printf", "stat", "file", "md5sum", "sha1sum", "sha256sum",
            "which", "whereis", "type", "readlink", "realpath", "basename", "dirname", "diff", "cmp", "comm",
            "lscpu", "lsblk", "lspci", "lsusb", "ping", "traceroute", "dig", "nslookup", "host", "true", "false",
        ]);
        if (基本读取仅.has(命令文本))
            return true;
        // 特殊子命令
        if (命令文本 === "systemctl") {
            return /\bsystemctl\s+(status|list-units|list-unit-files|is-active|is-enabled|is-failed|show|cat|--failed|--type)\b/i.test(已规范化);
        }
        if (命令文本 === "pm2") {
            return /\bpm2\s+(list|status|jlist|show|describe)\b/i.test(已规范化);
        }
        if (命令文本 === "dpkg") {
            return /\bdpkg\s+-[lsLS]\b/i.test(已规范化);
        }
        if (命令文本 === "apt-cache" || 命令文本 === "apt-file")
            return true;
        if (命令文本 === "apt") {
            return /\bapt\s+(list|policy|show)\b/i.test(已规范化);
        }
        if (命令文本 === "apt-get") {
            return /\bapt-get\b.*(-s|--simulate|--dry-run)\b/i.test(已规范化);
        }
        if (命令文本 === "rpm") {
            return /\brpm\s+-(?:q|qa|qi|ql|qf)\b/i.test(已规范化);
        }
        if (命令文本 === "dnf" || 命令文本 === "yum") {
            return /\b(?:dnf|yum)\s+(list|info)\b/i.test(已规范化);
        }
        if (命令文本 === "find") {
            // find 只读（除非使用 -delete 或 -exec）
            return !/\b-(?:delete|exec|execdir)\b/i.test(已规范化);
        }
        if (命令文本 === "curl") {
            // 仅 curl inspect/head 为只读
            return /\bcurl\b[^\n]*\s(-I|--head|-sI|-Is)\b/i.test(已规范化);
        }
        if (命令文本 === "[" || 命令文本 === "test")
            return true;
        return false;
    };
    for (const 分段 of 分段列表) {
        if (是否具有变更中(分段))
            return false;
        const 流水线阶段列表 = 拆分流水线(分段);
        if (流水线阶段列表.length === 0)
            return false;
        for (const 阶段 of 流水线阶段列表) {
            if (!是否流水线阶段读取仅(阶段))
                return false;
        }
    }
    return true;
}
export function 评估(命令: string): 判定结果 {
    const 候选 = 命令.trim();
    if (候选 === "")
        return { 级别: "allow", 原因: "" };
    const 匹配项规则 = (规则: 规则类): boolean => {
        if (规则.匹配模式 && 规则.匹配模式.test(候选))
            return true;
        if (规则.检查 && 规则.检查(候选))
            return true;
        return false;
    };
    for (const 规则 of 阻断状态) {
        if (匹配项规则(规则))
            return { 级别: "block", 原因: 规则.原因 };
    }
    for (const 规则 of 需要审批) {
        if (匹配项规则(规则))
            return { 级别: "approve", 原因: 规则.原因 };
    }
    if (!是否读取仅命令(候选)) {
        return { 级别: "approve", 原因: "perintah di luar daftar aman read-only" };
    }
    return { 级别: "allow", 原因: "" };
}
/** 用于 PoC 代码兼容性的别名。 */
export const 评估风险 = 评估;


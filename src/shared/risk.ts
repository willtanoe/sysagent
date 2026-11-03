export type VerdictLevel = "allow" | "approve" | "block";

export interface Verdict {
  level: VerdictLevel;
  reason: string;
}

interface Rule {
  pattern?: RegExp;
  check?: (command: string) => boolean;
  reason: string;
}

/** Deteksi apakah perintah melakukan redirection ke/dari file (bukan /dev/null atau 2>&1). */
export function hasFileRedirection(command: string): boolean {
  // Hapus string terquote supaya string dalam quote (mis. awk '$1 > 2') tidak memicu redirect
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, " ");
  // Buang redirect aman: >/dev/null, 2>/dev/null, &>/dev/null, 2>&1, 1>&2, >&2, dll.
  const cleaned = unquoted
    .replace(/(?:&>|[0-9]+>|>>|>)\s*\/dev\/null\b/g, " ")
    .replace(/[0-9]*>&[0-9]+/g, " ")
    .replace(/[0-9]*<&[0-9]+/g, " ");
  // Apakah masih ada redirect operator > atau < (bukan process substitution <(...) atau heredoc <<)?
  return /(?:^|[^<])<{1,2}(?![<(])|>{1,2}/.test(cleaned);
}

/** Target file rahasia yang tidak boleh dibaca atau disentuh. */
export function isSecretAccess(raw: string): boolean {
  // Hapus tanda kutip, backslash, dan kurung kurawal untuk mencegah obfuscation (mis. .e""nv, .e\nv, /etc/{shadow})
  const cmd = raw.replace(/["'\\{}]/g, "");

  const SECRET =
    /(?:^|[\s/])\.(?:env|en\?|en\*)(?!\.example\b)|(?:\/etc\/(?:g?shad(?:ow|[\w?*]*)|sudoers(?:\.d)?\b|ssl\/private\b|letsencrypt\/live\b|wireguard\b|openvpn\b|ipsec\.secrets\b|ppp\/[^\s]*secrets|kubernetes\/[^\s]*\.conf|rancher\/k3s\/k3s\.yaml))|id_(?:rsa|ed25519|ecdsa|dsa)\b|privkey[^\s]*\.pem\b|\.ssh\/|\.kube\/config\b|\.docker\/config\.json\b|\.config\/aster|askpass(?:[-_A-Za-z0-9.]*\.sh)?|hub-state\.json|wp-config(?:\.php)?|\.aws\/(?:credentials|config)|\.git-credentials|\.netrc|\.my\.cnf|\.pgpass|\/proc\/(?:[^\s]*\/)?envi[^\s]*/i;

  return SECRET.test(cmd);
}

/** Selalu ditolak, tanpa opsi konfirmasi. */
const BLOCKED: Rule[] = [
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&/, reason: "fork bomb" },
  { pattern: /\brm\s+(-[A-Za-z]+\s+)*-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+\/(\s|$|\*)/, reason: "rm -rf /" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: "menulis mentah ke block device" },
  { pattern: />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: "redirect ke block device" },
  { pattern: /\bmkfs(\.[A-Za-z0-9]+)?\b/, reason: "memformat filesystem" },
  { pattern: /\b(cat|dd|head)\b[^\n]*\/dev\/(urandom|zero|random)[^\n]*>\s*\/dev\/(sd|nvme|vd|hd)/, reason: "mengacak block device" },
  { check: isSecretAccess, reason: "mengakses file rahasia (kredensial)" },
  { pattern: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|\brm\b[^\n]*\.bash_history/, reason: "menghapus jejak perintah" },
  // Env leak standalone (bisa berisi token/secret).
  { pattern: /\b(printenv|compgen)\b/, reason: "menampilkan environment (bisa berisi secret)" },
  { pattern: /\b(env|set|declare)\s*($|[;&|])/, reason: "menampilkan environment (bisa berisi secret)" },
  { pattern: /\bexport\s*($|[;&|])/, reason: "menampilkan environment (bisa berisi secret)" },
  // Eksekusi script/file rahasia agent (askpass).
  { pattern: /\b(bash|sh|zsh|dash|ksh)\b[^\n]*\.config\/aster/, reason: "mengeksekusi file rahasia agent" },
  { pattern: /\b(bash|sh|zsh|dash|ksh)\b[^\n]*askpass/, reason: "mengeksekusi askpass (password sudo)" },
  { pattern: /\.\s+[^\n]*\.config\/aster/, reason: "mengeksekusi file rahasia agent" },
  { pattern: /\.\s+[^\n]*askpass/, reason: "mengeksekusi askpass (password sudo)" },
  { pattern: /\bsource\b[^\n]*askpass/, reason: "mengeksekusi askpass (password sudo)" },
  // Menyuntikkan password secara plaintext via stdin/pipe.
  { pattern: /\bsudo\s+-[A-Za-z0-9]*S\b/, reason: "menyuntikkan password ke sudo via stdin (-S)" },
  { pattern: /\b(?:printf|echo)\b[^\n]*\|\s*(?:sudo|su)\b/, reason: "pipe password ke sudo/su" },
  // Hapus pada root filesystem (varian flag).
  { pattern: /\brm\b[^\n]*\s\/(\s|$|\*|\/)/, reason: "rm pada root filesystem" },
];

/** Butuh konfirmasi user lewat inline keyboard. */
const NEEDS_APPROVAL: Rule[] = [
  {
    check: (cmd) =>
      /\bsudo\b|\bdoas\b/.test(cmd) &&
      (typeof process.getuid !== "function" ||
        process.getuid() !== 0 ||
        /\b(?:sudo|doas)\s+-[A-Za-z]*[ug]\b/.test(cmd) ||
        !isReadOnlyCommand(cmd)),
    reason: "eksekusi dengan privilege",
  },
  { pattern: /\brm\b/, reason: "menghapus file" },
  { pattern: /\bmv\b/, reason: "memindahkan atau menimpa path" },
  { pattern: /\bdd\b/, reason: "operasi disk mentah" },
  { pattern: /\bshred\b|\btruncate\b|\bfallocate\b/, reason: "menghancurkan atau mengubah ukuran file" },
  { pattern: /\bchmod\b|\bchown\b|\bchattr\b|\bsetfacl\b|\bsetfattr\b/, reason: "mengubah permission atau ownership" },
  { pattern: /\bfind\b[^\n]*-(?:delete|exec|execdir|ok|okdir)\b/, reason: "hapus atau eksekusi massal via find" },
  { pattern: /\b(?:mkdir|rmdir|touch|mktemp)\b/, reason: "membuat atau menghapus direktori/file" },
  { pattern: /\b(?:tar|zip|unzip|gzip|gunzip|bzip2|xz|patch)\b/, reason: "manipulasi arsip atau patch file" },
  { pattern: /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b/, reason: "mengubah state service" },
  { pattern: /\bservice\s+\S+\s+(start|stop|restart|reload)\b/, reason: "mengubah state service" },
  { pattern: /\b(reboot|shutdown|halt|poweroff)\b|\binit\s+[06]\b/, reason: "mematikan atau reboot server" },
  { pattern: /(?:^|[;&|()]\s*|\b(?:sudo|doas)\s+)\s*(useradd|userdel|usermod|passwd|chpasswd|visudo|su\s+-)\b/, reason: "mengubah user atau password" },
  { pattern: /\b(iptables|nft|ufw|firewall-cmd)\b/, reason: "mengubah firewall" },
  { pattern: /\b(mount|umount|fdisk|parted|pvcreate|vgcreate|lvcreate|zpool)\b/, reason: "mengubah storage" },
  { pattern: /\b(apt|apt-get|dpkg|dnf|yum|pacman|apk|zypper)\b/, reason: "mengubah paket sistem" },
  { pattern: /\brpm\s+-[eiU]/, reason: "mengubah paket sistem" },
  { pattern: /\b(setenforce|semanage|restorecon|chcon|audit2allow|semodule)\b/, reason: "mengubah kebijakan SELinux" },
  { pattern: /\b(authselect|grubby|grub2-mkconfig|update-grub|subscription-manager)\b/, reason: "mengubah konfigurasi sistem/boot" },
  { pattern: /\b(nmcli|hostnamectl\s+set|timedatectl\s+set|localectl\s+set)\b/, reason: "mengubah konfigurasi host atau jaringan" },
  { pattern: /\bdocker\s+(rm|rmi|prune|stop|kill|system\s+prune)\b|\bdocker\s+compose\s+(down|rm)\b/, reason: "menghapus atau menghentikan container" },
  { pattern: /\bcrontab\b|>\s*\/etc\/cron/, reason: "mengubah cron" },
  { pattern: /\|\s*(sudo\s+)?(bash|sh|zsh|python3?|node)\b/, reason: "mengeksekusi script dari pipe" },
  { pattern: /\bcurl\b[^\n]*\|\s*(sudo\s+)?(bash|sh|zsh)\b|\bwget\b[^\n]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/, reason: "menjalankan script dari internet" },
  { pattern: /\beval\b|\bbase64\s+-d[^\n]*\|\s*(sudo\s+)?(bash|sh)\b/, reason: "eksekusi kode dinamis" },
  { pattern: /\b(kill|pkill|killall)\b/, reason: "mematikan proses" },
  { pattern: />\s*\/(etc|boot|usr|bin|sbin|lib|var\/lib)\//, reason: "menulis ke direktori sistem" },
  { pattern: /\btee\s+\/(etc|boot|usr|bin|sbin|lib)\//, reason: "menulis ke direktori sistem" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[A-Za-z]*f|push\s+(--force|-f))\b/, reason: "operasi git destruktif" },
  { pattern: /\bprintenv\b/, reason: "menampilkan environment proses" },
  { pattern: /\bsystemctl\s+(cat|show)\s+aster-(?:sys|node|hub)/, reason: "membaca konfigurasi service agent" },
  { pattern: /\$\(|`/, reason: "command substitution dinamis (tidak bisa dinilai statis)" },
  { pattern: /\b(bash|sh|zsh|dash|ksh)\s+-c\b/, reason: "eksekusi string shell" },
  {
    pattern: /\b(bash|sh|zsh|python3?|node|perl|ruby)\s+\/(tmp|var\/tmp|dev\/shm)\//,
    reason: "mengeksekusi script dari direktori sementara",
  },
  // Menulis/menaruh file ke direktori sistem tanpa lewat redirect.
  {
    pattern: /\b(cp|install|ln|rsync|mv)\b[^\n]+\s\/(etc|boot|usr|bin|sbin|lib|var\/lib)(\/|\b)/,
    reason: "menaruh file ke direktori sistem",
  },
  {
    pattern: /\b(curl|wget)\b[^\n]*\s(-o|-O|--output|-P|--directory-prefix)\s*\/?(etc|boot|usr|bin|sbin|lib)\//,
    reason: "mengunduh file langsung ke direktori sistem",
  },
  // Eksekusi kode arbitrer dari package manager / interpreter.
  {
    pattern: /\b(npm|pnpm|yarn|pip|pip3|gem|cargo|go)\s+(i|install|add|get)\b/,
    reason: "memasang paket (eksekusi kode pihak ketiga)",
  },
  { pattern: /\b(modprobe|insmod|rmmod|systemd-run|nsenter|unshare|chroot)\b/, reason: "memuat modul / mengubah namespace" },
  { pattern: /\bsysctl\s+-w\b/, reason: "mengubah parameter kernel" },
  { pattern: /\b(swapoff|swapon|mkswap)\b/, reason: "mengubah swap" },
  { pattern: /\b(nc|netcat|ncat|socat)\b/, reason: "transfer data via socket mentah" },
  { pattern: /\b(scp|rsync|sftp)\b/, reason: "transfer file ke/dari host lain" },
  { pattern: /\b(at|batch)\s/, reason: "menjadwalkan job" },
  { pattern: /\b(python3?|perl|node|ruby|php|lua)\b[^\n]*\s(-c|-e|--eval|-r)\b/, reason: "eksekusi kode via interpreter" },
  // Penulisan/mutasi file (tidak hanya direktori sistem).
  { pattern: /\bcp\b/, reason: "menyalin file" },
  { pattern: /\binstall\b/, reason: "menaruh file (install)" },
  { pattern: /\bln\b/, reason: "membuat link (ubah filesystem)" },
  { pattern: /\btee\b/, reason: "menulis output ke file" },
  { check: hasFileRedirection, reason: "redirection output/input ke file" },
  { pattern: /\bsed\b[^\n]*\s-i\b/, reason: "edit in-place (sed -i)" },
  { pattern: /\bperl\b[^\n]*\s-i\b/, reason: "edit in-place (perl -i)" },
  { pattern: /\bawk\b[^\n]*\b(?:print|printf)\b[^;\n}]*(?:>>?|\|)/i, reason: "redirection/pipe output dari dalam awk" },
  { pattern: /\bsed\b[^\n]*(?:\/[gIim]*e\b|(?:^|['";\s])w\s+\S)/i, reason: "eksekusi atau tulis file dari dalam sed" },
  // Menjalankan script/file lokal via interpreter/shell (hanya saat interpreter ada di posisi executable).
  {
    pattern: /(?:^|[;&|()]\s*|\b(?:sudo|doas|exec|nohup|time|env)\s+)\s*(?:python3?|node|perl|ruby|php|lua|bash|sh|zsh|dash|ksh)\s+[^\s-]/i,
    reason: "mengeksekusi script/file lokal via interpreter",
  },
  {
    pattern: /(?:^|[;&|()]\s*|\b(?:sudo|doas)\s+)\s*source\s+\S/i,
    reason: "mengeksekusi script via source",
  },
  {
    pattern: /(?:^|[;&|()]\s*|\b(?:sudo|doas)\s+)\s*\.\s+[^\s-]/i,
    reason: "mengeksekusi script via dot (.)",
  },
  { pattern: /\bsystem\s*\(|\bexec\s*\(|\bpopen\s*\(/, reason: "eksekusi kode dinamis" },
  // Network egress & download
  {
    pattern: /\bcurl\b[^\n]*\s(-[dFT]|--data\b|--data-\w+|--form\b|--upload-file\b|-X\s*(POST|PUT|PATCH|DELETE)\b)/i,
    reason: "mengirim/mengunggah data ke jaringan (curl)",
  },
  {
    pattern: /\bcurl\b[^\n]*\s(-[oOJ]|--output\b|--remote-name\b)/i,
    reason: "mengunduh dan menyimpan file (curl)",
  },
  { pattern: /\bwget\b/i, reason: "mengunduh file dari jaringan (wget)" },
];

/** Pecah pipeline menjadi tahapan terpisah tanpa memecah pipe di dalam kutip. */
function splitPipeline(seg: string): string[] {
  const stages: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < seg.length; i++) {
    const char = seg[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
    } else if (char === "|" && !inSingle && !inDouble) {
      stages.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") {
    stages.push(current.trim());
  }
  return stages;
}

/** Heuristik: apakah perintah ini hanya membaca (tidak mengubah state)? */
export function isReadOnlyCommand(command: string): boolean {
  const segments = command.split(/[\n;]+|&&|\|\|/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;

  const hasMutating = (seg: string): boolean => {
    // Redirection ke file asli (bukan /dev/null atau 2>&1)
    if (hasFileRedirection(seg)) return true;
    // In-place edits & script-internal file writes/exec
    if (/\b(?:sed|perl)\b[^\n]*\s-i\b/i.test(seg)) return true;
    if (/\bawk\b[^\n]*\b(?:print|printf)\b[^;\n}]*(?:>>?|\|)/i.test(seg)) return true;
    if (/\bsed\b[^\n]*(?:\/[gIim]*e\b|(?:^|['";\s])w\s+\S)/i.test(seg)) return true;
    // Dynamic exec in scripts
    if (/\b(?:system|exec|popen|eval)\s*\(/i.test(seg)) return true;
    // Command substitution
    if (/`|\$\(/.test(seg)) return true;
    // Network uploads / downloads
    if (/\bwget\b/i.test(seg)) return true;
    if (/\bcurl\b[^\n]*\s(-[dFToOJ]|--data|--form|--upload|--output)/i.test(seg)) return true;

    // Hapus string terquote supaya teks di dalam echo/grep tidak memicu false positive.
    const low = seg.toLowerCase().replace(/'[^']*'|"[^"]*"/g, " ");
    // Mutating command tokens (sebagai command, bukan substring teks seperti /etc/passwd).
    if (/(?<![\/.-])\b(rm|rmdir|mv|cp|install|remove|purge|update|restart|stop|start|enable|disable|kill|pkill|killall|shutdown|poweroff|halt|mkfs|dd|chmod|chown|chattr|truncate|shred|useradd|userdel|usermod|passwd)\b/.test(low)) {
      return true;
    }
    if (/\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b/.test(low)) {
      return true;
    }
    if (/\b(apt|apt-get|dnf|yum|pacman|apk|zypper)\s+(install|remove|purge|autoremove|add|del)\b/.test(low)) {
      return true;
    }
    // apt upgrade/dist-upgrade kecuali dry-run
    if (/\b(apt|apt-get)\s+(\S+\s+)*(upgrade|dist-upgrade|full-upgrade)\b/.test(low)) {
      if (!/\s(-s|--simulate|--dry-run)\b/.test(low)) return true;
    }
    if (/>\s*\/(etc|boot|usr|bin|sbin|lib|var\/lib)\//.test(low)) {
      return true;
    }
    // reboot sebagai command mutasi (hanya di awal segment)
    if (/^\s*(sudo\s+|doas\s+)*reboot(\s|$)/.test(low)) {
      return true;
    }
    return false;
  };

  const isPipelineStageReadOnly = (stage: string): boolean => {
    const trimmed = stage.trim();
    if (trimmed === "") return false;
    // Ambil token perintah pertama (abaikan sudo, doas, env, time, nohup)
    const normalized = trimmed.replace(/^\s*(?:sudo|doas|nohup|time|env)\s+/, "");
    // Token pertama adalah nama executable / command
    const firstWordMatch = /^[A-Za-z0-9_.-]+/.exec(normalized);
    if (!firstWordMatch) return false;
    const cmd = firstWordMatch[0].toLowerCase();

    // Command read-only yang jelas
    const basicReadOnly = new Set([
      "uname", "hostname", "uptime", "nproc", "whoami", "id", "arch", "pwd", "date", "sleep",
      "df", "free", "ps", "ss", "netstat", "top", "htop", "vmstat", "iostat", "ip", "ifconfig", "route", "arp",
      "journalctl", "dmesg", "lsof", "lsmod", "getenforce", "sestatus", "last", "w", "who", "groups",
      "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "awk", "sed", "lsattr", "getfacl",
      "wc", "sort", "uniq", "cut", "tr", "echo", "printf", "stat", "file", "md5sum", "sha1sum", "sha256sum",
      "which", "whereis", "type", "readlink", "realpath", "basename", "dirname", "diff", "cmp", "comm",
      "lscpu", "lsblk", "lspci", "lsusb", "ping", "traceroute", "dig", "nslookup", "host", "true", "false",
    ]);

    if (basicReadOnly.has(cmd)) return true;

    // Subcommand khusus
    if (cmd === "systemctl") {
      return /\bsystemctl\s+(status|list-units|list-unit-files|is-active|is-enabled|is-failed|show|cat|--failed|--type)\b/i.test(normalized);
    }
    if (cmd === "pm2") {
      return /\bpm2\s+(list|status|jlist|show|describe)\b/i.test(normalized);
    }
    if (cmd === "dpkg") {
      return /\bdpkg\s+-[lsLS]\b/i.test(normalized);
    }
    if (cmd === "apt-cache" || cmd === "apt-file") return true;
    if (cmd === "apt") {
      return /\bapt\s+(list|policy|show)\b/i.test(normalized);
    }
    if (cmd === "apt-get") {
      return /\bapt-get\b.*(-s|--simulate|--dry-run)\b/i.test(normalized);
    }
    if (cmd === "rpm") {
      return /\brpm\s+-(?:q|qa|qi|ql|qf)\b/i.test(normalized);
    }
    if (cmd === "dnf" || cmd === "yum") {
      return /\b(?:dnf|yum)\s+(list|info)\b/i.test(normalized);
    }
    if (cmd === "find") {
      // find read-only kecuali memakai -delete atau -exec
      return !/\b-(?:delete|exec|execdir)\b/i.test(normalized);
    }
    if (cmd === "curl") {
      // Hanya curl inspect / head yang read-only
      return /\bcurl\b[^\n]*\s(-I|--head|-sI|-Is)\b/i.test(normalized);
    }
    if (cmd === "[" || cmd === "test") return true;

    return false;
  };

  for (const seg of segments) {
    if (hasMutating(seg)) return false;
    const pipelineStages = splitPipeline(seg);
    if (pipelineStages.length === 0) return false;
    for (const stage of pipelineStages) {
      if (!isPipelineStageReadOnly(stage)) return false;
    }
  }
  return true;
}

export function assess(command: string): Verdict {
  const candidate = command.trim();
  if (candidate === "") return { level: "allow", reason: "" };

  const matchesRule = (rule: Rule): boolean => {
    if (rule.pattern && rule.pattern.test(candidate)) return true;
    if (rule.check && rule.check(candidate)) return true;
    return false;
  };

  for (const rule of BLOCKED) {
    if (matchesRule(rule)) return { level: "block", reason: rule.reason };
  }
  for (const rule of NEEDS_APPROVAL) {
    if (matchesRule(rule)) return { level: "approve", reason: rule.reason };
  }
  if (!isReadOnlyCommand(candidate)) {
    return { level: "approve", reason: "perintah di luar daftar aman read-only" };
  }
  return { level: "allow", reason: "" };
}

/** Alias untuk kompatibilitas dengan kode PoC. */
export const assessRisk = assess;

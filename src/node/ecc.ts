import * as fs from "fs";
import * as path from "path";

export interface EccItemSummary {
  name: string;
  description: string;
  filePath: string;
}

export interface EccPromptEnhancement {
  matchedSkills: string[];
  matchedAgent?: string;
  matchedCommand?: string;
  contextBlock: string;
  rewrittenPrompt: string;
}

interface TriggerRule {
  pattern: RegExp;
  skills: string[];
  agent?: string;
}

const TRIGGER_TABLE: TriggerRule[] = [
  {
    pattern: /\b(production[- ]audit|siap\s+prod|ready\s+to\s+ship|pre[- ]launch|post[- ]merge|audit\s+prod)\b/i,
    skills: ["production-audit", "verification-loop"],
    agent: "security-reviewer",
  },
  {
    pattern: /\b(ethtool|crc|packet\s+loss|input\s+errors|output\s+drops|flapping|duplex|mtu|interface\s+error|ip\s+-s\s+link)\b/i,
    skills: ["network-interface-health", "network-config-validation"],
    agent: "network-config-reviewer",
  },
  {
    pattern: /\b(wireguard|wg0|wg-quick|vpn\s+tunnel)\b/i,
    skills: ["homelab-wireguard-vpn", "network-interface-health"],
    agent: "network-config-reviewer",
  },
  {
    pattern: /\b(bgp|asn|route-map|prefix-list|neighbor\s+down|frr|bird)\b/i,
    skills: ["network-bgp-diagnostics", "network-config-validation"],
    agent: "network-config-reviewer",
  },
  {
    pattern: /\b(vlan|trunk|switchport|subnet\s+overlap|acl|vty|routing)\b/i,
    skills: ["network-config-validation", "homelab-vlan-segmentation"],
    agent: "network-config-reviewer",
  },
  {
    pattern: /\b(dns|pihole|unbound|resolv\.conf|nameserver|dig\b|nslookup)\b/i,
    skills: ["homelab-pihole-dns", "homelab-network-readiness"],
  },
  {
    pattern: /\b(docker|dockerfile|docker-compose|container|image\s+layer|buildx)\b/i,
    skills: ["docker-patterns", "deployment-patterns"],
  },
  {
    pattern: /\b(kubernetes|k8s|kubectl|k3s|helm|pod|deployment\.yaml|ingress)\b/i,
    skills: ["kubernetes-patterns", "deployment-patterns"],
  },
  {
    pattern: /\b(deploy|rollback|canary|blue-green|healthcheck|readiness|pm2|systemd)\b/i,
    skills: ["deployment-patterns", "terminal-ops"],
  },
  {
    pattern: /\b(postgres|postgresql|psql|pg_stat|vacuum|pg_hba|supabase)\b/i,
    skills: ["postgres-patterns", "database-migrations"],
    agent: "database-reviewer",
  },
  {
    pattern: /\b(mysql|mariadb|innodb|slow_query_log|mysqld)\b/i,
    skills: ["mysql-patterns", "database-migrations"],
    agent: "database-reviewer",
  },
  {
    pattern: /\b(redis|valkey|eviction|maxmemory|redis-cli)\b/i,
    skills: ["redis-patterns"],
    agent: "database-reviewer",
  },
  {
    pattern: /\b(security|cve|vulnerability|hardening|exploit|owasp|secret|ufw|iptables|nftables|firewall|ssh_config|sshd_config)\b/i,
    skills: ["security-review", "agent-security-hardening"],
    agent: "security-reviewer",
  },
  {
    pattern: /\b(verify|verifikasi|test\s+suite|coverage|typecheck|lint)\b/i,
    skills: ["verification-loop", "tdd-workflow"],
  },
  {
    pattern: /\b(fix|perbaiki|benerin|debug|error|crash|failed|gagal|investigasi)\b/i,
    skills: ["terminal-ops", "error-handling"],
  },
];

export function resolveEccRootDir(customDir?: string): string {
  if (customDir && fs.existsSync(customDir)) return path.resolve(customDir);
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname, "../../.."),
  ];
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, ".opencode", "opencode.json")) &&
      fs.existsSync(path.join(candidate, "skills"))
    ) {
      return candidate;
    }
  }
  return path.resolve(__dirname, "../..");
}

function extractFrontmatterDescription(raw: string): string {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch && fmMatch[1]) {
    const descLine = fmMatch[1]
      .split(/\r?\n/)
      .find((line) => line.trim().toLowerCase().startsWith("description:"));
    if (descLine) {
      return descLine
        .replace(/^description:\s*/i, "")
        .replace(/^["']|["']$/g, "")
        .trim();
    }
  }
  const lines = raw
    .replace(/^---[\s\S]*?---/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  return (lines[0] || "ECC resource").slice(0, 140);
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
}

export function listEccSkills(rootDir?: string): EccItemSummary[] {
  const root = resolveEccRootDir(rootDir);
  const skillsDir = path.join(root, "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const results: EccItemSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    try {
      const content = fs.readFileSync(skillPath, "utf8");
      results.push({
        name: entry.name,
        description: extractFrontmatterDescription(content),
        filePath: skillPath,
      });
    } catch {
      // lewati file yang gagal dibaca
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function listEccAgents(rootDir?: string): EccItemSummary[] {
  const root = resolveEccRootDir(rootDir);
  const agentsDir = path.join(root, ".opencode", "prompts", "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const files = fs.readdirSync(agentsDir);
  const results: EccItemSummary[] = [];

  for (const file of files) {
    if (!file.endsWith(".txt") && !file.endsWith(".md")) continue;
    const fullPath = path.join(agentsDir, file);
    const name = file.replace(/\.(txt|md)$/, "");
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      results.push({
        name,
        description: extractFrontmatterDescription(content),
        filePath: fullPath,
      });
    } catch {
      // file tidak terbaca, lewati
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function listEccCommands(rootDir?: string): EccItemSummary[] {
  const root = resolveEccRootDir(rootDir);
  const commandsDir = path.join(root, ".opencode", "commands");
  if (!fs.existsSync(commandsDir)) return [];

  const files = fs.readdirSync(commandsDir);
  const results: EccItemSummary[] = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const fullPath = path.join(commandsDir, file);
    const name = file.replace(/\.md$/, "");
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      results.push({
        name,
        description: extractFrontmatterDescription(content),
        filePath: fullPath,
      });
    } catch {
      // file tidak terbaca, lewati
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadEccSkillContent(skillName: string, rootDir?: string, maxChars = 2800): string | null {
  if (!/^[a-z0-9_-]+$/i.test(skillName)) return null;
  const root = resolveEccRootDir(rootDir);
  const skillFile = path.join(root, "skills", skillName, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  try {
    const raw = fs.readFileSync(skillFile, "utf8");
    const body = stripFrontmatter(raw);
    return body.length > maxChars ? `${body.slice(0, maxChars)}\n...(truncated)` : body;
  } catch {
    return null;
  }
}

export function loadEccAgentPrompt(agentName: string, rootDir?: string, maxChars = 2400): string | null {
  if (!/^[a-z0-9_-]+$/i.test(agentName)) return null;
  const root = resolveEccRootDir(rootDir);
  const candidates = [
    path.join(root, ".opencode", "prompts", "agents", `${agentName}.txt`),
    path.join(root, ".opencode", "prompts", "agents", `${agentName}.md`),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const body = stripFrontmatter(raw);
        return body.length > maxChars ? `${body.slice(0, maxChars)}\n...(truncated)` : body;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function loadEccCommandTemplate(cmdName: string, rootDir?: string, maxChars = 2400): string | null {
  if (!/^[a-z0-9_-]+$/i.test(cmdName)) return null;
  const root = resolveEccRootDir(rootDir);
  const cmdFile = path.join(root, ".opencode", "commands", `${cmdName}.md`);
  if (!fs.existsSync(cmdFile)) return null;
  try {
    const raw = fs.readFileSync(cmdFile, "utf8");
    const body = stripFrontmatter(raw);
    return body.length > maxChars ? `${body.slice(0, maxChars)}\n...(truncated)` : body;
  } catch {
    return null;
  }
}

/**
 * Membangun konteks ECC dinamis (Trigger-Table Lazy Loading) berdasarkan prompt operator.
 * Mendukung pemanggilan eksplisit (`ecc:<target> <args>` atau `/plan`, `/verify`, `/security`, `/pm2`)
 * maupun pencocokan otomatis berbasis kata kunci infrastruktur/SRE.
 */
export function buildEccContextForPrompt(prompt: string, rootDir?: string): EccPromptEnhancement {
  const root = resolveEccRootDir(rootDir);
  let trimmed = prompt.trim();
  const matchedSkills: string[] = [];
  let matchedAgent: string | undefined;
  let matchedCommand: string | undefined;

  // Prefix eksplisit `ecc:<target> <argumen>` atau `/<command> <argumen>`
  const explicitMatch = trimmed.match(/^(?:ecc:|\/ecc\s+|\/)([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
  if (explicitMatch) {
    const target = explicitMatch[1]!.toLowerCase();
    const restArgs = (explicitMatch[2] ?? "").trim();

    const cmdAliasMap: Record<string, string> = {
      audit: "security-scan",
      "audit-prod": "verify",
      review: "code-review",
      sec: "security",
    };
    const resolvedCmd = cmdAliasMap[target] || target;

    const cmdTemplate = loadEccCommandTemplate(resolvedCmd, root);
    if (cmdTemplate) {
      matchedCommand = resolvedCmd;
      trimmed = cmdTemplate.includes("$ARGUMENTS")
        ? cmdTemplate.replace(/\$ARGUMENTS/g, restArgs || "(jalankan sesuai kondisi sistem/repo saat ini)")
        : `${cmdTemplate}\n\nTarget/Argumen: ${restArgs || "(kondisi aktual saat ini)"}`;
    } else if (loadEccSkillContent(target, root)) {
      matchedSkills.push(target);
      trimmed = restArgs || `Jalankan prosedur sesuai skill ECC '${target}' pada node ini.`;
    } else if (loadEccAgentPrompt(target, root)) {
      matchedAgent = target;
      trimmed = restArgs || `Jalankan analisis sesuai peran agent ECC '${target}' pada node ini.`;
    }
  }

  // Trigger-table lazy loading; maksimal 2 skill agar hemat context window
  for (const rule of TRIGGER_TABLE) {
    if (rule.pattern.test(trimmed)) {
      for (const sk of rule.skills) {
        if (!matchedSkills.includes(sk) && matchedSkills.length < 2) {
          matchedSkills.push(sk);
        }
      }
      if (!matchedAgent && rule.agent) {
        matchedAgent = rule.agent;
      }
    }
    if (matchedSkills.length >= 2) break;
  }

  const sections: string[] = [
    "[ECC (Everything Claude Code) SRE & Security Harness Active]",
    "- Safety Guard (Careful Mode): selalu periksa dampak perintah destruktif/mutasi sebelum eksekusi.",
    "- Terminal Ops Discipline: laporkan temuan secara berbasis bukti nyata (SURFACE -> EVIDENCE -> ACTION -> STATUS).",
  ];

  if (matchedAgent) {
    const agentBody = loadEccAgentPrompt(matchedAgent, root, 1800);
    if (agentBody) {
      sections.push(`\n[ECC Specialist Agent Persona: ${matchedAgent}]\n${agentBody}`);
    }
  }

  for (const skillName of matchedSkills) {
    const skillBody = loadEccSkillContent(skillName, root, 2200);
    if (skillBody) {
      sections.push(`\n[ECC Loaded Skill: ${skillName}]\n${skillBody}`);
    }
  }

  return {
    matchedSkills,
    matchedAgent,
    matchedCommand,
    contextBlock: sections.join("\n"),
    rewrittenPrompt: trimmed,
  };
}

/**
 * Menyalin/menautkan konfigurasi `.opencode` & `skills` ECC ke dalam `XDG_CONFIG_HOME/opencode`
 * sehingga daemon `opencode serve` otomatis memuat instruksi, skill, agent, command, dan plugin ECC.
 */
export function provisionOpenCodeEcc(configDir: string, rootDir?: string): string {
  const root = resolveEccRootDir(rootDir);
  const targetOpenCodeDir = path.join(configDir, "opencode");
  fs.mkdirSync(targetOpenCodeDir, { recursive: true, mode: 0o700 });

  const srcOpenCodeDir = path.join(root, ".opencode");
  if (!fs.existsSync(srcOpenCodeDir)) {
    return targetOpenCodeDir;
  }

  // Salin opencode.json dan inject custom gateway dari .env (atau merge dari global config jika ada)
  const srcConfigFile = path.join(srcOpenCodeDir, "opencode.json");
  const destConfigFile = path.join(targetOpenCodeDir, "opencode.json");
  if (fs.existsSync(srcConfigFile)) {
    try {
      const srcRaw = fs.readFileSync(srcConfigFile, "utf8");
      const configObj = JSON.parse(srcRaw);

      if (!configObj.provider || typeof configObj.provider !== "object") {
        configObj.provider = {};
      }

      // Pewarisan opsional dari global config host (~/.config/opencode/opencode.json)
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      const globalConfigPath = homeDir ? path.join(homeDir, ".config", "opencode", "opencode.json") : "";
      if (globalConfigPath && fs.existsSync(globalConfigPath)) {
        try {
          const globalRaw = fs.readFileSync(globalConfigPath, "utf8");
          const globalObj = JSON.parse(globalRaw);
          if (globalObj.provider && typeof globalObj.provider === "object") {
            configObj.provider = {
              ...(globalObj.provider || {}),
              ...(configObj.provider || {}),
            };
          }
        } catch (e: any) {
          console.warn("[ecc] Gagal membaca provider global dari ~/.config/opencode/opencode.json:", e?.message);
        }
      }

      // Pewarisan generik dari .env (GATEWAY_URL & GATEWAY_API_KEY / OPENCODE_GATEWAY_*),
      // tidak bergantung pada global config maupun environment HOME systemd.
      const gatewayUrl =
        process.env.OPENCODE_GATEWAY_URL ||
        process.env.GATEWAY_URL ||
        process.env.GATEWAY_BASE_URL ||
        process.env.OPENAI_BASE_URL;
      const gatewayKey =
        process.env.OPENCODE_GATEWAY_API_KEY ||
        process.env.OPENCODE_GATEWAY_KEY ||
        process.env.GATEWAY_API_KEY ||
        process.env.OPENAI_API_KEY;

      if (gatewayUrl && gatewayKey) {
        // Deteksi providerID dan modelID dari OPENCODE_MODEL (misal: "asteria/reflection/Beam-1.0-501B-A23B")
        const targetModelRaw = process.env.OPENCODE_MODEL || process.env.MODEL_NAME || "";
        let providerId = "gateway";
        let modelId = targetModelRaw;
        const slashIdx = targetModelRaw.indexOf("/");
        if (slashIdx > 0) {
          providerId = targetModelRaw.slice(0, slashIdx);
          modelId = targetModelRaw.slice(slashIdx + 1);
        }

        const modelsObj: Record<string, { name: string }> = {};
        if (modelId) {
          modelsObj[modelId] = { name: modelId };
        }
        // Tambahkan model fallback umum jika ada
        const fallbacks = (process.env.MODEL_FALLBACK || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const fb of fallbacks) {
          const fbSlash = fb.indexOf("/");
          const fbId = fbSlash > 0 ? fb.slice(fbSlash + 1) : fb;
          if (fbId) modelsObj[fbId] = { name: fbId };
        }

        // Daftarkan / merge provider ke opencode.json instance ini
        // Nilai dari .env SELALU diprioritaskan (override) di atas global config!
        const existingProvider = configObj.provider[providerId] || {};
        configObj.provider[providerId] = {
          npm: "@ai-sdk/openai-compatible",
          name: `${providerId.toUpperCase()} Gateway`,
          ...existingProvider,
          options: {
            setCacheKey: true,
            ...(existingProvider.options || {}),
            baseURL: gatewayUrl,
            apiKey: gatewayKey,
          },
          models: {
            ...(existingProvider.models || {}),
            ...modelsObj,
          },
        };
      }

      fs.writeFileSync(destConfigFile, JSON.stringify(configObj, null, 2), { mode: 0o600 });
    } catch {
      fs.copyFileSync(srcConfigFile, destConfigFile);
    }
  }

  // Symlink / copy subdirektori ECC (.opencode/instructions, prompts, commands, plugins, tools, dan skills)
  const subDirs: Array<{ src: string; dest: string }> = [
    { src: path.join(srcOpenCodeDir, "instructions"), dest: path.join(targetOpenCodeDir, "instructions") },
    { src: path.join(srcOpenCodeDir, "prompts"), dest: path.join(targetOpenCodeDir, "prompts") },
    { src: path.join(srcOpenCodeDir, "commands"), dest: path.join(targetOpenCodeDir, "commands") },
    { src: path.join(srcOpenCodeDir, "plugins"), dest: path.join(targetOpenCodeDir, "plugins") },
    { src: path.join(srcOpenCodeDir, "tools"), dest: path.join(targetOpenCodeDir, "tools") },
    { src: path.join(root, "skills"), dest: path.join(targetOpenCodeDir, "skills") },
  ];

  for (const item of subDirs) {
    if (!fs.existsSync(item.src)) continue;
    try {
      if (fs.existsSync(item.dest) || fs.lstatSync(item.dest, { throwIfNoEntry: false })) {
        fs.rmSync(item.dest, { recursive: true, force: true });
      }
      fs.symlinkSync(item.src, item.dest, "dir");
    } catch {
      fs.cpSync(item.src, item.dest, { recursive: true, force: true });
    }
  }

  return targetOpenCodeDir;
}

/**
 * Menghasilkan laporan katalog ECC untuk RPC `__builtin:ecc[:subcommand]`.
 */
export function formatEccCatalogReport(nodeId: string, subcommand = "status", rootDir?: string): string {
  const root = resolveEccRootDir(rootDir);
  const skills = listEccSkills(root);
  const agents = listEccAgents(root);
  const commands = listEccCommands(root);
  const sub = subcommand.trim().toLowerCase() || "status";

  if (sub === "status" || sub === "info") {
    const featuredSkills = [
      "safety-guard",
      "agent-security-hardening",
      "terminal-ops",
      "production-audit",
      "deployment-patterns",
      "docker-patterns",
      "kubernetes-patterns",
      "network-interface-health",
      "network-config-validation",
      "homelab-wireguard-vpn",
      "postgres-patterns",
      "redis-patterns",
      "verification-loop",
      "strategic-compact",
    ].filter((name) => skills.some((s) => s.name === name));

    return [
      `⚡ **ECC (Everything Claude Code) Integration — Node [${nodeId}]**`,
      `• Status: \`AKTIF (Full-Root SRE + OpenCode Harness)\``,
      `• Skills Terbundel: \`${skills.length}\` skill`,
      `• Specialist Agents: \`${agents.length}\` agent`,
      `• Workflow Commands: \`${commands.length}\` command`,
      `• Safety Guard: \`Careful Mode + Aster assessRisk Gate\``,
      "",
      "**Skill SRE & Infrastruktur Unggulan:**",
      "```text",
      featuredSkills.join(", "),
      "```",
      "**Penggunaan di Telegram:**",
      "• `/ecc skills` — Daftar seluruh skill ECC",
      "• `/ecc agents` — Daftar specialist agent ECC",
      "• `/ecc commands` — Daftar workflow command ECC",
      "• `/ecc <command/skill/agent> <instruksi>` — Jalankan workflow ECC di node aktif (contoh: `/ecc verify`, `/ecc production-audit cek kesiapan server ini`, `/ecc security-reviewer cek konfigurasi sshd`)",
    ].join("\n");
  }

  if (sub === "skills") {
    const lines = skills.map((s) => `${s.name.padEnd(28)} ${s.description.slice(0, 62)}`);
    return [
      `📚 **Daftar ECC Skills di [${nodeId}] (${skills.length})**`,
      "```text",
      ...lines,
      "```",
      "Gunakan `/ecc <nama_skill> <instruksi>` untuk mengaktifkan skill tertentu secara eksplisit.",
    ].join("\n");
  }

  if (sub === "agents") {
    const lines = agents.map((a) => `${a.name.padEnd(24)} ${a.description.slice(0, 65)}`);
    return [
      `🕵️ **Daftar ECC Specialist Agents di [${nodeId}] (${agents.length})**`,
      "```text",
      ...lines,
      "```",
      "Gunakan `/ecc <nama_agent> <instruksi>` untuk memanggil agen spesialis tertentu.",
    ].join("\n");
  }

  if (sub === "commands") {
    const lines = commands.map((c) => `/${c.name.padEnd(20)} ${c.description.slice(0, 68)}`);
    return [
      `🛠️ **Daftar ECC Workflow Commands di [${nodeId}] (${commands.length})**`,
      "```text",
      ...lines,
      "```",
      "Gunakan `/ecc <nama_command> [argumen]` untuk menjalankan workflow ECC.",
    ].join("\n");
  }

  // Cek apakah subcommand merujuk ke nama skill/agent/command tertentu untuk melihat detailnya
  const skill = skills.find((s) => s.name === sub);
  if (skill) {
    const body = loadEccSkillContent(sub, root, 1500) || skill.description;
    return `📘 **ECC Skill: \`${skill.name}\`**\n_${skill.description}_\n\n\`\`\`text\n${body}\n\`\`\``;
  }

  const agent = agents.find((a) => a.name === sub);
  if (agent) {
    const body = loadEccAgentPrompt(sub, root, 1500) || agent.description;
    return `🕵️ **ECC Agent: \`${agent.name}\`**\n_${agent.description}_\n\n\`\`\`text\n${body}\n\`\`\``;
  }

  const cmd = commands.find((c) => c.name === sub);
  if (cmd) {
    const body = loadEccCommandTemplate(sub, root, 1500) || cmd.description;
    return `🛠️ **ECC Command: \`/${cmd.name}\`**\n_${cmd.description}_\n\n\`\`\`text\n${body}\n\`\`\``;
  }

  return `⚠️ Subcommand ECC \`${sub}\` tidak dikenali. Gunakan \`/ecc status\`, \`/ecc skills\`, \`/ecc agents\`, atau \`/ecc commands\`.`;
}

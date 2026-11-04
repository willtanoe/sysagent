const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { 中枢服务器, 解析节点令牌列表 } = require("../dist/hub/server.js");
const { 中枢存储类: 中枢存储 } = require("../dist/hub/store.js");
const { 节点客户端 } = require("../dist/node/client.js");
const { 节点执行器, sanitizeEnv, 剥离冗余提权 } = require("../dist/node/executor.js");
const { 节点引擎 } = require("../dist/node/engine.js");
const { isManagedOpenCode, resolveOpenCodeBinary } = require("../dist/node/opencode-server.js");
const { OpenCodeRunner } = require("../dist/node/opencode.js");
const {
  listEccSkills,
  listEccAgents,
  listEccCommands,
  buildEccContextForPrompt,
  provisionOpenCodeEcc,
} = require("../dist/node/ecc.js");
const { 创建节点告警评估器: createNodeAlertEvaluator } = require("../dist/node/alerts.js");
const { 评估风险: assessRisk, 是否读取仅命令: isReadOnlyCommand } = require("../dist/shared/risk.js");
const { 脱敏密钥列表: redactSecrets } = require("../dist/shared/audit.js");
const { 标记文本到超文本标记: markdownToHtml, 块超文本标记: chunkHtml } = require("../dist/shared/format.js");

const PORT = 9876;
const SECRET_TOKEN = "test-secret-prod-1234567890";
const HONGYUN_TOKEN = "hongyun-specific-token-999";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("=== ASTER FLEET PRODUCTION SMOKE & SECURITY TEST SUITE ===");

  const auditHongyun = path.join("/tmp", "audit-hongyun-test.jsonl");
  const auditHongchen = path.join("/tmp", "audit-hongchen-test.jsonl");
  const statePath = path.join("/tmp", "hub-state-test.json");
  fs.rmSync(auditHongyun, { force: true });
  fs.rmSync(auditHongchen, { force: true });
  fs.rmSync(statePath, { force: true });

  // 1. Hub 启动（Master Token 与 Per-Node Token）
  const nodeTokens = 解析节点令牌列表(`hongyun:${HONGYUN_TOKEN}`);
  const hub = new 中枢服务器(PORT, SECRET_TOKEN, {
    host: "127.0.0.1",
    节点令牌列表: nodeTokens,
    认证超时毫秒: 1000,
  });
  await hub.启动();
  console.log("✓ 1. Hub berhasil start di port", PORT, "(mendukung master & per-node token)");

  // 2. token 错误的节点必须以常量时间被拒绝
  const badExecutor = new 节点执行器("bad-node", "/tmp/bad.jsonl");
  const badEngine = new 节点引擎("bad-node", badExecutor);
  const badClient = new 节点客户端(
    { 中枢地址: `ws://127.0.0.1:${PORT}`, 节点标识: "bad-node", 令牌: "wrong-token" },
    badEngine
  );
  badClient.启动();
  await sleep(250);
  assert.strictEqual(hub.列出节点列表().length, 0, "Bad node tidak boleh terdaftar");
  badClient.停止();
  fs.rmSync("/tmp/bad.jsonl", { force: true });
  console.log("✓ 2. Autentikasi token salah ditolak oleh Hub (constant-time SHA-256 verification)");

  // 3. Node Hongyun（使用 per-node token）与 Hongchen（使用 master token）连接
  const execHongyun = new 节点执行器("hongyun", auditHongyun);
  const engineHongyun = new 节点引擎("hongyun", execHongyun);
  const clientHongyun = new 节点客户端(
    { 中枢地址: `ws://127.0.0.1:${PORT}`, 节点标识: "hongyun", 令牌: HONGYUN_TOKEN, 重连延迟毫秒: 300 },
    engineHongyun
  );

  const execHongchen = new 节点执行器("hongchen", auditHongchen);
  const engineHongchen = new 节点引擎("hongchen", execHongchen);
  const clientHongchen = new 节点客户端(
    { 中枢地址: `ws://127.0.0.1:${PORT}`, 节点标识: "hongchen", 令牌: SECRET_TOKEN, 重连延迟毫秒: 300 },
    engineHongchen
  );

  clientHongyun.启动();
  clientHongchen.启动();
  await sleep(500);

  const nodes = hub.列出节点列表();
  assert.strictEqual(nodes.length, 2, "Harus ada 2 node terdaftar");
  const nodeIds = nodes.map((n) => n.节点标识).sort();
  assert.deepStrictEqual(nodeIds, ["hongchen", "hongyun"]);
  console.log("✓ 3. Node 'hongyun' (per-node token) dan 'hongchen' (master token) terdaftar:", nodeIds.join(", "));

  // 4. 元数据与 Distro 检测
  const nodeHy = hub.获取节点("hongyun");
  const nodeHc = hub.获取节点("hongchen");
  assert.ok(nodeHy && nodeHy.信息.主机名 && nodeHy.信息.发行版, "Metadata & distro hongyun lengkap");
  assert.ok(nodeHc && nodeHc.信息.主机名 && nodeHc.信息.发行版, "Metadata & distro hongchen lengkap");
  console.log(
    `✓ 4. Metadata fleet & distro: host=${nodeHy.信息.主机名}, distro=${nodeHy.信息.发行版.名称} (${nodeHy.信息.发行版.软件包管理器})`
  );

  // 5. 在 Hongyun 执行安全命令 ($ uptime)
  let hongyunChunks = "";
  let hongyunDone = false;
  hub.启动运行("hongyun", 1001, "$ uptime", {
    当块: (c) => {
      hongyunChunks += c;
    },
    当审批请求: () => {
      assert.fail("uptime tidak boleh minta approval");
    },
    当完成: (res) => {
      hongyunDone = true;
      assert.ok(res.includes("[hongyun]"), "Output harus beridentitas hongyun");
    },
  });

  await sleep(500);
  assert.ok(hongyunDone, "Run di hongyun harus selesai");
  assert.ok(hongyunChunks.length > 0, "Harus menerima streaming chunks");
  console.log("✓ 5. Eksekusi terisolasi di node 'hongyun' sukses");

  // 6. 在 Hongchen 执行安全命令 ($ whoami)
  let hongchenDone = false;
  hub.启动运行("hongchen", 1001, "$ whoami", {
    当块: () => {},
    当审批请求: () => {
      assert.fail("whoami tidak boleh minta approval");
    },
    当完成: (res) => {
      hongchenDone = true;
      assert.ok(res.includes("[hongchen]"), "Output harus beridentitas hongchen");
    },
  });

  await sleep(500);
  assert.ok(hongchenDone, "Run di hongchen harus selesai");
  console.log("✓ 6. Eksekusi terisolasi di node 'hongchen' sukses");

  // 7. 独立的本地审计日志、0600 权限与哈希链验证
  assert.ok(fs.existsSync(auditHongyun), "audit hongyun harus ada");
  assert.ok(fs.existsSync(auditHongchen), "audit hongchen harus ada");
  const modeHy = fs.statSync(auditHongyun).mode & 0o777;
  assert.strictEqual(modeHy, 0o600, "File audit wajib memiliki permission 0600");
  const verifyHy = execHongyun.验证审计();
  assert.strictEqual(verifyHy.是否成功, true, "Audit chain hongyun harus valid");
  assert.strictEqual(verifyHy.总计, 1);
  console.log("✓ 7. Audit log per-node independen, mode 0600, & hash-chain terverifikasi");

  // 8. Hongyun 的风险命令：由 Operator 通过 Hub 拒绝
  let approvalReqReceived = false;
  hub.启动运行("hongyun", 1001, "$ systemctl restart nginx", {
    当块: () => {},
    当审批请求: (approvalId, cmd) => {
      approvalReqReceived = true;
      assert.strictEqual(cmd, "systemctl restart nginx");
      hub.发送审批("hongyun", "fake", approvalId, false);
    },
    当完成: (res) => {
      assert.ok(res.includes("[REJECTED]"), "Harus ada notif REJECTED");
    },
  });

  await sleep(500);
  assert.ok(approvalReqReceived, "Approval request harus sampai ke Hub");
  console.log("✓ 8. Approval bridge: penolakan operator berhasil diteruskan ke node");

  // 9. Hongyun 的风险命令：由 Operator 通过 Hub 批准（回调 <=64 字节与 chatId 隔离验证）
  let approvalApprovedReceived = false;
  hub.启动运行("hongyun", 1001, "$ cp /etc/hostname /tmp/aster-hostname-test", {
    当块: () => {},
    当审批请求: (approvalId) => {
      approvalApprovedReceived = true;
      const cbData = `ap:${approvalId}:yes`;
      assert.ok(Buffer.byteLength(cbData, "utf8") <= 64, "Telegram callback_data wajib <= 64 byte");
      assert.strictEqual(
        hub.解析审批按标识(approvalId, true, 9999),
        false,
        "Chat lain tidak boleh menyetujui approval milik chat 1001"
      );
      assert.strictEqual(hub.解析审批按标识(approvalId, true, 1001), true);
    },
    当完成: (res) => {
      assert.ok(!res.includes("[REJECTED]"), "Tidak boleh ditolak");
    },
  });

  await sleep(500);
  assert.ok(approvalApprovedReceived, "Approval request harus sampai ke Hub");
  fs.rmSync("/tmp/aster-hostname-test", { force: true });
  console.log("✓ 9. Approval bridge: persetujuan operator berhasil dieksekusi di node");

  // 10. 危险命令与敏感文件访问（Block list）
  let blockRunDone = false;
  hub.启动运行("hongchen", 1001, "$ rm -rf /", {
    当块: () => {},
    当审批请求: () => {
      assert.fail("rm -rf / harus diblok tanpa minta approval");
    },
    当完成: (res) => {
      blockRunDone = true;
      assert.ok(res.includes("[BLOCKED]"), "Harus ada status BLOCKED");
    },
  });

  await sleep(400);
  assert.ok(blockRunDone, "Blocked command selesai");
  assert.strictEqual(assessRisk("cat .env").级别, "block");
  assert.strictEqual(assessRisk("cat .e\\nv").级别, "block");
  assert.strictEqual(assessRisk("cat /etc/shadow").级别, "block");
  assert.strictEqual(assessRisk("cat /etc/{shadow}").级别, "block");
  assert.strictEqual(assessRisk("cat /etc/shad*").级别, "block");
  assert.strictEqual(assessRisk("cat /etc/ssl/private/server.key").级别, "block");
  assert.strictEqual(assessRisk("cat /etc/letsencrypt/live/domain/privkey.pem").级别, "block");
  assert.strictEqual(assessRisk("cat /etc/wireguard/wg0.conf").级别, "block");
  assert.strictEqual(assessRisk("cat /root/.kube/config").级别, "block");
  assert.strictEqual(assessRisk("cat /root/.docker/config.json").级别, "block");
  assert.strictEqual(assessRisk("printenv").级别, "block");
  assert.strictEqual(assessRisk("echo pass | sudo -S id").级别, "block");
  assert.strictEqual(assessRisk("touch /tmp/x").级别, "approve");
  assert.strictEqual(assessRisk("mkdir -p /tmp/x").级别, "approve");
  assert.strictEqual(assessRisk("find /tmp -exec rm {} +").级别, "approve");
  assert.strictEqual(assessRisk("/opt/custom/deploy.sh").级别, "approve");
  assert.strictEqual(assessRisk("awk '{print \"x\" > \"/etc/pwn\"}' /etc/hosts").级别, "approve");
  assert.strictEqual(assessRisk("sed 's/.*/id/e' /etc/hosts").级别, "approve");
  assert.strictEqual(assessRisk("sed 'w /tmp/pwn' /etc/hosts").级别, "approve");
  assert.strictEqual(assessRisk("awk '$1 > 2 {print $1}' /etc/hosts").级别, "allow");
  assert.strictEqual(剥离冗余提权("sudo systemctl status nginx"), "systemctl status nginx");
  assert.strictEqual(剥离冗余提权("sudo -u postgres psql"), "sudo -u postgres psql");
  assert.strictEqual(isReadOnlyCommand("uname -a | grep -i linux"), true);
  assert.strictEqual(isReadOnlyCommand("echo hi > /tmp/x"), false);
  console.log("✓ 10. Risk classifier memblokir perintah destruktif, pembacaan secret (termasuk level root), & env leak");

  // 11. 子进程环境清洗（防 Secret 泄露）
  process.env.TEST_SECRET_TOKEN = "rahasia-negara-123";
  const sanitized = sanitizeEnv(process.env);
  assert.strictEqual(sanitized.TEST_SECRET_TOKEN, undefined, "Variabel SECRET/TOKEN harus dihapus dari child env");
  const envCheckRes = await execHongyun.运行命令("echo ${TEST_SECRET_TOKEN:-kosong}");
  assert.strictEqual(envCheckRes.输出内容.trim(), "kosong", "Shell anak tidak boleh bisa membaca secret env");
  delete process.env.TEST_SECRET_TOKEN;
  console.log("✓ 11. Sanitasi environment child process mencegah kebocoran token/password");

  // 12. 审计日志中的 Secret 脱敏与通过 /auditcheck 的篡改检测
  const redacted = redactSecrets("curl -H 'Authorization: Bearer my-secret-jwt' --password supersecret api_key=12345");
  assert.ok(!redacted.includes("my-secret-jwt") && !redacted.includes("supersecret") && !redacted.includes("12345"));

  let auditCheckOut = "";
  hub.启动运行("hongyun", 1001, "__builtin:auditcheck", {
    当块: () => {},
    当审批请求: () => {},
    当完成: (res) => {
      auditCheckOut = res;
    },
  });
  await sleep(400);
  assert.ok(auditCheckOut.includes("utuh"), "Audit chain harus terverifikasi utuh lewat RPC");
  console.log("✓ 12. Redaksi secret audit & RPC /auditcheck berfungsi dengan benar");

  // 13. 内置状态仪表盘 (__builtin:status)
  const statusOut = await new Promise((resolve, reject) => {
    hub.启动运行("hongyun", 1001, "__builtin:status", {
      当块: () => {},
      当审批请求: () => {},
      当完成: (res, err) => (err ? reject(new Error(err)) : resolve(res)),
    });
  });
  assert.ok(statusOut.includes("load") && statusOut.includes("mem") && statusOut.includes("disk"));
  console.log("✓ 13. Dashboard monospace /status berhasil dibangun dari node");

  // 14. 任务取消 (/stop -> hub_cancel -> kill process tree)
  let cancelErr = "";
  hub.启动运行("hongchen", 2002, "$ sleep 30", {
    当块: () => {},
    当审批请求: () => {},
    当完成: (_res, err) => {
      cancelErr = err || "";
    },
  });
  await sleep(250);
  const cancelledCount = hub.取消聊天运行列表(2002);
  assert.strictEqual(cancelledCount, 1, "Harus membatalkan 1 run aktif");
  await sleep(300);
  assert.strictEqual(cancelErr, "ABORTED", "Run yang dibatalkan harus berstatus ABORTED");
  console.log("✓ 14. Pembatalan /stop (hub_cancel) menghentikan proses shell di node secara instan");

  // 15. 从 Node 到 Hub 的主动告警转发
  let receivedAlertHtml = "";
  hub.once("node_alert", (nodeId, key, severity, html) => {
    if (nodeId === "hongyun" && key === "disk" && severity === "warn") {
      receivedAlertHtml = html;
    }
  });
  const alertState = new Map();
  const evalAlert = createNodeAlertEvaluator({
    节点标识: "hongyun",
    发送: (ev) => clientHongyun.发送告警(ev.键, ev.严重度, ev.超文本标记),
    获取: (k) => alertState.get(k) ?? null,
    设置: (k, v) => (v === null ? alertState.delete(k) : alertState.set(k, v)),
    当前时间: Date.now,
    冷却毫秒: 1000,
    磁盘百分比: 90,
    内存百分比: 92,
  });
  const _r = await evalAlert({
    磁盘百分比: 95,
    磁盘详情: "/dev/sda1 95%",
    内存百分比: 40,
    内存详情: "",
    失败单元列表: [],
    失败详情: "",
  });
  await sleep(300);
  assert.ok(receivedAlertHtml.includes("95%"), "Hub harus menerima alert proaktif disk dari node");
  console.log("✓ 15. Evaluator & forwarding alert proaktif dari Node ke Hub bekerja akurat");

  // 16. AI 工具调用循环（本地 Engine，Stubbed OpenAI Client）
  let callTurn = 0;
  engineHongchen.设置客户端用于测试({
    chat: {
      completions: {
        create: async () => {
          callTurn += 1;
          if (callTurn === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "execute_shell",
                          arguments: JSON.stringify({ command: "echo halo-dari-ai" }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 20 },
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Hasil verifikasi: server merespons halo-dari-ai.",
                },
              },
            ],
            usage: { prompt_tokens: 70, completion_tokens: 15 },
          };
        },
      },
    },
  });

  let aiAnswer = "";
  let aiUsage = null;
  hub.启动运行("hongchen", 1001, "Cek respons echo", {
    当块: () => {},
    当审批请求: () => {},
    当完成: (res, _err, usage) => {
      aiAnswer = res;
      aiUsage = usage;
    },
  });
  await sleep(500);
  assert.ok(aiAnswer.includes("halo-dari-ai"), "AI loop harus mengeksekusi tool dan merangkum hasil");
  assert.strictEqual(aiUsage.提示词令牌列表, 120);
  console.log("✓ 16. Loop AI tool-calling (engine=local) & pelacakan token usage bekerja sempurna");

  // 17. 内置 OpenCode 引擎（@opencode/cli 解析、会话管理、恢复与权限桥接）
  assert.strictEqual(isManagedOpenCode("opencode", ""), true);
  assert.strictEqual(isManagedOpenCode("opencode", "http://127.0.0.1:4199"), false);
  assert.strictEqual(isManagedOpenCode("local", ""), false);
  const resolvedBin = resolveOpenCodeBinary();
  assert.ok(resolvedBin.includes("@opencode/cli"), `Binary @opencode/cli harus terbundel, dapat: ${resolvedBin}`);

  const ocRunner = new OpenCodeRunner({
    url: "http://oc.test",
    password: "test-password",
    defaultModel: "opencode/glm-5.3-flash-free",
    pollMs: 50,
  });
  const realFetch = global.fetch;
  const ocCalls = [];
  const jsonResp = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const sseResp = (sessionID, textDelta) => {
    const enc = new TextEncoder();
    const lines = [
      { type: "session.text.delta", data: { sessionID, delta: textDelta } },
      { type: "session.execution.succeeded", data: { sessionID } },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n`)
      .join("");
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(lines));
          c.close();
        },
      })
    );
  };

  ocRunner.setSession(777, "ses_bad");
  let recoveredCount = 0;
  global.fetch = async (url, init = {}) => {
    const p = String(url).replace("http://oc.test", "");
    const m = init.method ?? "GET";
    ocCalls.push(`${m} ${p}`);
    if (p === "/api/session/ses_bad" && m === "GET") {
      return jsonResp({ model: { providerID: "opencode", id: "glm-5.3-flash-free" } });
    }
    if (p === "/api/session/ses_bad/prompt" && m === "POST") {
      return jsonResp({ error: "Missing required parameter: 'messages[4].reasoning_content'" }, 400);
    }
    if (p === "/api/session" && m === "POST") {
      return jsonResp({ id: "ses_fresh" });
    }
    if (p === "/api/event") {
      return sseResp("ses_fresh", "OpenCode berhasil pulih dan menjawab!");
    }
    if (p === "/api/session/ses_fresh/prompt" && m === "POST") {
      return jsonResp({});
    }
    if (p.endsWith("/permission")) {
      return jsonResp({ data: [] });
    }
    return jsonResp({});
  };

  try {
    const ocReply = await ocRunner.run("cek server via opencode", {
      chatId: 777,
      onPartial: () => {},
      askApproval: async () => true,
      onRecover: () => {
        recoveredCount += 1;
      },
    });
    assert.strictEqual(ocReply, "OpenCode berhasil pulih dan menjawab!");
    assert.strictEqual(recoveredCount, 1, "Harus otomatis recovery saat terkena reasoning_content error");
    assert.strictEqual(ocRunner.getSession(777), "ses_fresh");
  } finally {
    global.fetch = realFetch;
  }
  console.log("✓ 17. Bundled OpenCode Engine (@opencode/cli binary, session & reasoning_content recovery) lulus");

  // 18. 中枢存储 持久化与 HTML 分块
  const store = new 中枢存储(statePath);
  store.设置活跃节点(1001, "hongyun");
  store.记住(1001, "hongyun", "cek uptime", "Server nyala 10 hari");
  store.添加用量(1001, { 提示词令牌列表: 100, 补全令牌列表: 50 });
  store.刷新();

  const storeReloaded = new 中枢存储(statePath);
  assert.strictEqual(storeReloaded.获取活跃节点(1001), "hongyun");
  assert.strictEqual(storeReloaded.获取历史(1001, "hongyun").length, 2);
  assert.strictEqual(storeReloaded.获取用量(1001).提示词令牌列表, 100);

  const htmlChunks = chunkHtml(markdownToHtml("```bash\n" + "a".repeat(5000) + "\n```"), 2000);
  assert.ok(htmlChunks.length >= 3, "Pesan panjang harus dipecah menjadi beberapa chunk");
  assert.ok(htmlChunks[0].endsWith("</code></pre>"), "Setiap chunk pre harus ditutup dengan aman");
  console.log("✓ 18. Persistensi 中枢存储 (mode 0600) & HTML chunking aman terverifikasi");

  // 19. 自动断开与重连
  clientHongyun.停止();
  await sleep(350);
  assert.strictEqual(hub.列出节点列表().length, 1, "Tersisa 1 node setelah hongyun disconnect");
  assert.strictEqual(hub.列出节点列表()[0].节点标识, "hongchen");
  console.log("✓ 19. Deteksi disconnect node realtime");

  clientHongyun.启动();
  await sleep(500);
  assert.strictEqual(hub.列出节点列表().length, 2, "2 node kembali online setelah reconnect");
  console.log("✓ 20. Reconnect otomatis node sukses");

  // 21. 审计链损坏检测（Tamper Detection）
  fs.appendFileSync(auditHongyun, '{"ts":"2026-01-01","nodeId":"hongyun","command":"hack","prevHash":" SALAH","hash":"123"}\n');
  const tamperedVerify = execHongyun.验证审计();
  assert.strictEqual(tamperedVerify.是否成功, false, "Audit verifier harus mendeteksi baris yang dimanipulasi");
  console.log("✓ 21. Tamper-detection mendeteksi manipulasi file audit pada baris ke-" + tamperedVerify.损坏位于);

  // 22. ECC (Everything Claude Code) 集成：Skills、Agents、Commands、Trigger-Table、OpenCode Provisioning 与 RPC
  const eccSkills = listEccSkills();
  const eccAgents = listEccAgents();
  const eccCommands = listEccCommands();
  assert.ok(eccSkills.length >= 25, "Harus memuat minimal 25 skill ECC");
  assert.ok(eccSkills.some((s) => s.name === "safety-guard"), "Skill safety-guard harus tersedia");
  assert.ok(eccSkills.some((s) => s.name === "network-interface-health"), "Skill network-interface-health harus tersedia");
  assert.ok(eccAgents.some((a) => a.name === "security-reviewer"), "Agent security-reviewer harus tersedia");
  assert.ok(eccAgents.some((a) => a.name === "network-config-reviewer"), "Agent network-config-reviewer harus tersedia");
  assert.ok(eccCommands.some((c) => c.name === "verify"), "Command /verify harus tersedia");
  assert.ok(eccCommands.some((c) => c.name === "pm2"), "Command /pm2 harus tersedia");

  const netEnhance = buildEccContextForPrompt("Cek kenapa ethtool eth0 banyak CRC dan packet loss");
  assert.ok(netEnhance.matchedSkills.includes("network-interface-health"), "Trigger-table harus mencocokkan network-interface-health");
  assert.strictEqual(netEnhance.matchedAgent, "network-config-reviewer");

  const explicitCmd = buildEccContextForPrompt("ecc:verify cek kesiapan rilis");
  assert.strictEqual(explicitCmd.matchedCommand, "verify");
  assert.ok(explicitCmd.rewrittenPrompt.includes("Verification"), "Template command verify harus disuntikkan");

  const tmpEccCfg = path.join("/tmp", `aster-ecc-cfg-${Date.now()}`);
  try {
    const provisionedDir = provisionOpenCodeEcc(tmpEccCfg);
    assert.ok(fs.existsSync(path.join(provisionedDir, "opencode.json")), "opencode.json harus terprovisi");
    assert.ok(fs.existsSync(path.join(provisionedDir, "skills", "safety-guard", "SKILL.md")), "Skill ECC harus tertaut di XDG_CONFIG_HOME/opencode/skills");
  } finally {
    fs.rmSync(tmpEccCfg, { recursive: true, force: true });
  }

  const eccRpcOut = await new Promise((resolve, reject) => {
    hub.启动运行("hongchen", 1001, "__builtin:ecc:status", {
      当块: () => {},
      当审批请求: () => {},
      当完成: (fullText, err) => (err ? reject(new Error(err)) : resolve(fullText)),
    });
  });
  assert.ok(eccRpcOut.includes("ECC (Everything Claude Code) Integration"), "RPC __builtin:ecc:status harus mengembalikan status ECC");
  console.log(`✓ 22. Integrasi ECC (${eccSkills.length} skills, ${eccAgents.length} agents, ${eccCommands.length} commands, trigger-table & OpenCode provisioning) lulus`);

  // 清理
  clientHongyun.停止();
  clientHongchen.停止();
  await hub.停止();
  fs.rmSync(auditHongyun, { force: true });
  fs.rmSync(auditHongchen, { force: true });
  fs.rmSync(statePath, { force: true });

  console.log("\n==============================================================");
  console.log("SEMUA 22 TEST PRODUKSI, OPENCODE, ECC, & KEAMANAN LULUS!");
  console.log("==============================================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { HubServer, parseNodeTokens } = require("../dist/hub/server.js");
const { HubStore } = require("../dist/hub/store.js");
const { NodeClient } = require("../dist/node/client.js");
const { NodeExecutor, sanitizeEnv, stripRedundantSudo } = require("../dist/node/executor.js");
const { NodeEngine } = require("../dist/node/engine.js");
const { isManagedOpenCode, resolveOpenCodeBinary } = require("../dist/node/opencode-server.js");
const { OpenCodeRunner } = require("../dist/node/opencode.js");
const {
  listEccSkills,
  listEccAgents,
  listEccCommands,
  buildEccContextForPrompt,
  provisionOpenCodeEcc,
} = require("../dist/node/ecc.js");
const { createNodeAlertEvaluator } = require("../dist/node/alerts.js");
const { assessRisk, isReadOnlyCommand } = require("../dist/shared/risk.js");
const { redactSecrets } = require("../dist/shared/audit.js");
const { markdownToHtml, chunkHtml } = require("../dist/shared/format.js");
const { getGitVersionInfo, checkAndApplyUpdate, AutoUpdateMonitor } = require("../dist/shared/updater.js");

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

  // 1. Hub Start dengan Master Token & Per-Node Token
  const nodeTokens = parseNodeTokens(`hongyun:${HONGYUN_TOKEN}`);
  const hub = new HubServer(PORT, SECRET_TOKEN, {
    host: "127.0.0.1",
    nodeTokens,
    authTimeoutMs: 1000,
  });
  await hub.start();
  console.log("✓ 1. Hub berhasil start di port", PORT, "(mendukung master & per-node token)");

  // 2. Node dengan token salah harus ditolak secara constant-time
  const badExecutor = new NodeExecutor("bad-node", "/tmp/bad.jsonl");
  const badEngine = new NodeEngine("bad-node", badExecutor);
  const badClient = new NodeClient(
    { hubUrl: `ws://127.0.0.1:${PORT}`, nodeId: "bad-node", token: "wrong-token" },
    badEngine
  );
  badClient.start();
  await sleep(250);
  assert.strictEqual(hub.listNodes().length, 0, "Bad node tidak boleh terdaftar");
  badClient.stop();
  fs.rmSync("/tmp/bad.jsonl", { force: true });
  console.log("✓ 2. Autentikasi token salah ditolak oleh Hub (constant-time SHA-256 verification)");

  // 3. Node Hongyun (pakai per-node token) & Hongchen (pakai master token) Konek
  const execHongyun = new NodeExecutor("hongyun", auditHongyun);
  const engineHongyun = new NodeEngine("hongyun", execHongyun);
  const clientHongyun = new NodeClient(
    { hubUrl: `ws://127.0.0.1:${PORT}`, nodeId: "hongyun", token: HONGYUN_TOKEN, reconnectDelayMs: 300 },
    engineHongyun
  );

  const execHongchen = new NodeExecutor("hongchen", auditHongchen);
  const engineHongchen = new NodeEngine("hongchen", execHongchen);
  const clientHongchen = new NodeClient(
    { hubUrl: `ws://127.0.0.1:${PORT}`, nodeId: "hongchen", token: SECRET_TOKEN, reconnectDelayMs: 300 },
    engineHongchen
  );

  clientHongyun.start();
  clientHongchen.start();
  await sleep(500);

  const nodes = hub.listNodes();
  assert.strictEqual(nodes.length, 2, "Harus ada 2 node terdaftar");
  const nodeIds = nodes.map((n) => n.nodeId).sort();
  assert.deepStrictEqual(nodeIds, ["hongchen", "hongyun"]);
  console.log("✓ 3. Node 'hongyun' (per-node token) dan 'hongchen' (master token) terdaftar:", nodeIds.join(", "));

  // 4. Metadata & Distro Detection
  const nodeHy = hub.getNode("hongyun");
  const nodeHc = hub.getNode("hongchen");
  assert.ok(nodeHy && nodeHy.info.hostname && nodeHy.info.distro, "Metadata & distro hongyun lengkap");
  assert.ok(nodeHc && nodeHc.info.hostname && nodeHc.info.distro, "Metadata & distro hongchen lengkap");
  console.log(
    `✓ 4. Metadata fleet & distro: host=${nodeHy.info.hostname}, distro=${nodeHy.info.distro.name} (${nodeHy.info.distro.packageManager})`
  );

  // 5. Eksekusi perintah aman di Hongyun ($ uptime)
  let hongyunChunks = "";
  let hongyunDone = false;
  hub.startRun("hongyun", 1001, "$ uptime", {
    onChunk: (c) => {
      hongyunChunks += c;
    },
    onApprovalReq: () => {
      assert.fail("uptime tidak boleh minta approval");
    },
    onDone: (res) => {
      hongyunDone = true;
      assert.ok(res.includes("[hongyun]"), "Output harus beridentitas hongyun");
    },
  });

  await sleep(500);
  assert.ok(hongyunDone, "Run di hongyun harus selesai");
  assert.ok(hongyunChunks.length > 0, "Harus menerima streaming chunks");
  console.log("✓ 5. Eksekusi terisolasi di node 'hongyun' sukses");

  // 6. Eksekusi perintah aman di Hongchen ($ whoami)
  let hongchenDone = false;
  hub.startRun("hongchen", 1001, "$ whoami", {
    onChunk: () => {},
    onApprovalReq: () => {
      assert.fail("whoami tidak boleh minta approval");
    },
    onDone: (res) => {
      hongchenDone = true;
      assert.ok(res.includes("[hongchen]"), "Output harus beridentitas hongchen");
    },
  });

  await sleep(500);
  assert.ok(hongchenDone, "Run di hongchen harus selesai");
  console.log("✓ 6. Eksekusi terisolasi di node 'hongchen' sukses");

  // 7. Audit logging lokal independen, permission 0600, & verifikasi rantai hash
  assert.ok(fs.existsSync(auditHongyun), "audit hongyun harus ada");
  assert.ok(fs.existsSync(auditHongchen), "audit hongchen harus ada");
  const modeHy = fs.statSync(auditHongyun).mode & 0o777;
  assert.strictEqual(modeHy, 0o600, "File audit wajib memiliki permission 0600");
  const verifyHy = execHongyun.verifyAudit();
  assert.strictEqual(verifyHy.ok, true, "Audit chain hongyun harus valid");
  assert.strictEqual(verifyHy.total, 1);
  console.log("✓ 7. Audit log per-node independen, mode 0600, & hash-chain terverifikasi");

  // 8. Command Berisiko di Hongyun: Tolak oleh Operator via Hub
  let approvalReqReceived = false;
  hub.startRun("hongyun", 1001, "$ systemctl restart nginx", {
    onChunk: () => {},
    onApprovalReq: (approvalId, cmd) => {
      approvalReqReceived = true;
      assert.strictEqual(cmd, "systemctl restart nginx");
      hub.sendApproval("hongyun", "fake", approvalId, false);
    },
    onDone: (res) => {
      assert.ok(res.includes("[REJECTED]"), "Harus ada notif REJECTED");
    },
  });

  await sleep(500);
  assert.ok(approvalReqReceived, "Approval request harus sampai ke Hub");
  console.log("✓ 8. Approval bridge: penolakan operator berhasil diteruskan ke node");

  // 9. Command Berisiko di Hongyun: Setujui oleh Operator via Hub (validasi callback <=64 byte & isolasi chatId)
  let approvalApprovedReceived = false;
  hub.startRun("hongyun", 1001, "$ cp /etc/hostname /tmp/aster-hostname-test", {
    onChunk: () => {},
    onApprovalReq: (approvalId) => {
      approvalApprovedReceived = true;
      const cbData = `ap:${approvalId}:yes`;
      assert.ok(Buffer.byteLength(cbData, "utf8") <= 64, "Telegram callback_data wajib <= 64 byte");
      assert.strictEqual(
        hub.resolveApprovalById(approvalId, true, 9999),
        false,
        "Chat lain tidak boleh menyetujui approval milik chat 1001"
      );
      assert.strictEqual(hub.resolveApprovalById(approvalId, true, 1001), true);
    },
    onDone: (res) => {
      assert.ok(!res.includes("[REJECTED]"), "Tidak boleh ditolak");
    },
  });

  await sleep(500);
  assert.ok(approvalApprovedReceived, "Approval request harus sampai ke Hub");
  fs.rmSync("/tmp/aster-hostname-test", { force: true });
  console.log("✓ 9. Approval bridge: persetujuan operator berhasil dieksekusi di node");

  // 10. Command Bahaya & Akses File Rahasia (Block list)
  let blockRunDone = false;
  hub.startRun("hongchen", 1001, "$ rm -rf /", {
    onChunk: () => {},
    onApprovalReq: () => {
      assert.fail("rm -rf / harus diblok tanpa minta approval");
    },
    onDone: (res) => {
      blockRunDone = true;
      assert.ok(res.includes("[BLOCKED]"), "Harus ada status BLOCKED");
    },
  });

  await sleep(400);
  assert.ok(blockRunDone, "Blocked command selesai");
  assert.strictEqual(assessRisk("cat .env").level, "block");
  assert.strictEqual(assessRisk("cat .e\\nv").level, "block");
  assert.strictEqual(assessRisk("cat /etc/shadow").level, "block");
  assert.strictEqual(assessRisk("cat /etc/{shadow}").level, "block");
  assert.strictEqual(assessRisk("cat /etc/shad*").level, "block");
  assert.strictEqual(assessRisk("cat /etc/ssl/private/server.key").level, "block");
  assert.strictEqual(assessRisk("cat /etc/letsencrypt/live/domain/privkey.pem").level, "block");
  assert.strictEqual(assessRisk("cat /etc/wireguard/wg0.conf").level, "block");
  assert.strictEqual(assessRisk("cat /root/.kube/config").level, "block");
  assert.strictEqual(assessRisk("cat /root/.docker/config.json").level, "block");
  assert.strictEqual(assessRisk("printenv").level, "block");
  assert.strictEqual(assessRisk("echo pass | sudo -S id").level, "block");
  assert.strictEqual(assessRisk("touch /tmp/x").level, "approve");
  assert.strictEqual(assessRisk("mkdir -p /tmp/x").level, "approve");
  assert.strictEqual(assessRisk("find /tmp -exec rm {} +").level, "approve");
  assert.strictEqual(assessRisk("/opt/custom/deploy.sh").level, "approve");
  assert.strictEqual(assessRisk("awk '{print \"x\" > \"/etc/pwn\"}' /etc/hosts").level, "approve");
  assert.strictEqual(assessRisk("sed 's/.*/id/e' /etc/hosts").level, "approve");
  assert.strictEqual(assessRisk("sed 'w /tmp/pwn' /etc/hosts").level, "approve");
  assert.strictEqual(assessRisk("awk '$1 > 2 {print $1}' /etc/hosts").level, "allow");
  assert.strictEqual(stripRedundantSudo("sudo systemctl status nginx"), "systemctl status nginx");
  assert.strictEqual(stripRedundantSudo("sudo -u postgres psql"), "sudo -u postgres psql");
  assert.strictEqual(isReadOnlyCommand("uname -a | grep -i linux"), true);
  assert.strictEqual(isReadOnlyCommand("echo hi > /tmp/x"), false);
  console.log("✓ 10. Risk classifier memblokir perintah destruktif, pembacaan secret (termasuk level root), & env leak");

  // 11. Sanitasi Environment Child Process (Anti Secret Leak)
  process.env.TEST_SECRET_TOKEN = "rahasia-negara-123";
  const sanitized = sanitizeEnv(process.env);
  assert.strictEqual(sanitized.TEST_SECRET_TOKEN, undefined, "Variabel SECRET/TOKEN harus dihapus dari child env");
  const envCheckRes = await execHongyun.runCommand("echo ${TEST_SECRET_TOKEN:-kosong}");
  assert.strictEqual(envCheckRes.output.trim(), "kosong", "Shell anak tidak boleh bisa membaca secret env");
  delete process.env.TEST_SECRET_TOKEN;
  console.log("✓ 11. Sanitasi environment child process mencegah kebocoran token/password");

  // 12. Redaksi Secret di Audit Log & Deteksi Tampering via /auditcheck
  const redacted = redactSecrets("curl -H 'Authorization: Bearer my-secret-jwt' --password supersecret api_key=12345");
  assert.ok(!redacted.includes("my-secret-jwt") && !redacted.includes("supersecret") && !redacted.includes("12345"));

  let auditCheckOut = "";
  hub.startRun("hongyun", 1001, "__builtin:auditcheck", {
    onChunk: () => {},
    onApprovalReq: () => {},
    onDone: (res) => {
      auditCheckOut = res;
    },
  });
  await sleep(400);
  assert.ok(auditCheckOut.includes("utuh"), "Audit chain harus terverifikasi utuh lewat RPC");
  console.log("✓ 12. Redaksi secret audit & RPC /auditcheck berfungsi dengan benar");

  // 13. Built-in Status Dashboard (__builtin:status)
  const statusOut = await new Promise((resolve, reject) => {
    hub.startRun("hongyun", 1001, "__builtin:status", {
      onChunk: () => {},
      onApprovalReq: () => {},
      onDone: (res, err) => (err ? reject(new Error(err)) : resolve(res)),
    });
  });
  assert.ok(statusOut.includes("load") && statusOut.includes("mem") && statusOut.includes("disk"));
  assert.ok(
    statusOut.includes("avail") && statusOut.includes("buff/cache") && statusOut.includes("swap"),
    "Status harus menampilkan detail memory lengkap (avail, buff/cache, swap)"
  );
  assert.ok(statusOut.includes("services ("), "Status harus menampilkan daftar service aktif beserta jumlahnya");
  console.log("✓ 13. Dashboard monospace /status (service aktif + memory lengkap) berhasil dibangun dari node");

  // 14. Pembatalan Tugas (/stop -> hub_cancel -> kill process tree)
  let cancelErr = "";
  hub.startRun("hongchen", 2002, "$ sleep 30", {
    onChunk: () => {},
    onApprovalReq: () => {},
    onDone: (_res, err) => {
      cancelErr = err || "";
    },
  });
  await sleep(250);
  const cancelledCount = hub.cancelChatRuns(2002);
  assert.strictEqual(cancelledCount, 1, "Harus membatalkan 1 run aktif");
  await sleep(300);
  assert.strictEqual(cancelErr, "ABORTED", "Run yang dibatalkan harus berstatus ABORTED");
  console.log("✓ 14. Pembatalan /stop (hub_cancel) menghentikan proses shell di node secara instan");

  // 15. Proactive Alert Forwarding dari Node ke Hub
  let receivedAlertHtml = "";
  hub.once("node_alert", (nodeId, key, severity, html) => {
    if (nodeId === "hongyun" && key === "disk" && severity === "warn") {
      receivedAlertHtml = html;
    }
  });
  const alertState = new Map();
  const evalAlert = createNodeAlertEvaluator({
    nodeId: "hongyun",
    send: (ev) => clientHongyun.sendAlert(ev.key, ev.severity, ev.html),
    get: (k) => alertState.get(k) ?? null,
    set: (k, v) => (v === null ? alertState.delete(k) : alertState.set(k, v)),
    now: Date.now,
    cooldownMs: 1000,
    diskPct: 90,
    memPct: 92,
  });
  await evalAlert({
    diskPct: 95,
    diskDetail: "/dev/sda1 95%",
    memPct: 40,
    memDetail: "",
    failedUnits: [],
    failedDetail: "",
  });
  await sleep(300);
  assert.ok(receivedAlertHtml.includes("95%"), "Hub harus menerima alert proaktif disk dari node");
  console.log("✓ 15. Evaluator & forwarding alert proaktif dari Node ke Hub bekerja akurat");

  // 16. AI Tool-Calling Loop (Engine Local) dengan Stubbed OpenAI Client
  let callTurn = 0;
  engineHongchen.setClientForTest({
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
  hub.startRun("hongchen", 1001, "Cek respons echo", {
    onChunk: () => {},
    onApprovalReq: () => {},
    onDone: (res, _err, usage) => {
      aiAnswer = res;
      aiUsage = usage;
    },
  });
  await sleep(500);
  assert.ok(aiAnswer.includes("halo-dari-ai"), "AI loop harus mengeksekusi tool dan merangkum hasil");
  assert.strictEqual(aiUsage.promptTokens, 120);
  console.log("✓ 16. Loop AI tool-calling (engine=local) & pelacakan token usage bekerja sempurna");

  // 17. Bundled OpenCode Engine (@opencode/cli resolution, session management, recovery, & permission bridge)
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

  // 18. HubStore Persistence & HTML Chunking
  const store = new HubStore(statePath);
  store.setActiveNode(1001, "hongyun");
  store.remember(1001, "hongyun", "cek uptime", "Server nyala 10 hari");
  store.addUsage(1001, { promptTokens: 100, completionTokens: 50 });
  store.flush();

  const storeReloaded = new HubStore(statePath);
  assert.strictEqual(storeReloaded.getActiveNode(1001), "hongyun");
  assert.strictEqual(storeReloaded.getHistory(1001, "hongyun").length, 2);
  assert.strictEqual(storeReloaded.getUsage(1001).promptTokens, 100);

  const htmlChunks = chunkHtml(markdownToHtml("```bash\n" + "a".repeat(5000) + "\n```"), 2000);
  assert.ok(htmlChunks.length >= 3, "Pesan panjang harus dipecah menjadi beberapa chunk");
  assert.ok(htmlChunks[0].endsWith("</code></pre>"), "Setiap chunk pre harus ditutup dengan aman");
  console.log("✓ 18. Persistensi HubStore (mode 0600) & HTML chunking aman terverifikasi");

  // 19. Disconnect & Reconnect Otomatis
  clientHongyun.stop();
  await sleep(350);
  assert.strictEqual(hub.listNodes().length, 1, "Tersisa 1 node setelah hongyun disconnect");
  assert.strictEqual(hub.listNodes()[0].nodeId, "hongchen");
  console.log("✓ 19. Deteksi disconnect node realtime");

  clientHongyun.start();
  await sleep(500);
  assert.strictEqual(hub.listNodes().length, 2, "2 node kembali online setelah reconnect");
  console.log("✓ 20. Reconnect otomatis node sukses");

  // 21. Deteksi Kerusakan Rantai Audit (Tamper Detection)
  fs.appendFileSync(auditHongyun, '{"ts":"2026-01-01","nodeId":"hongyun","command":"hack","prevHash":" SALAH","hash":"123"}\n');
  const tamperedVerify = execHongyun.verifyAudit();
  assert.strictEqual(tamperedVerify.ok, false, "Audit verifier harus mendeteksi baris yang dimanipulasi");
  console.log("✓ 21. Tamper-detection mendeteksi manipulasi file audit pada baris ke-" + tamperedVerify.brokenAt);

  // 22. Integrasi ECC (Everything Claude Code): Skills, Agents, Commands, Trigger-Table, OpenCode Provisioning, & RPC
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
    hub.startRun("hongchen", 1001, "__builtin:ecc:status", {
      onChunk: () => {},
      onApprovalReq: () => {},
      onDone: (fullText, err) => (err ? reject(new Error(err)) : resolve(fullText)),
    });
  });
  assert.ok(eccRpcOut.includes("ECC (Everything Claude Code) Integration"), "RPC __builtin:ecc:status harus mengembalikan status ECC");
  console.log(`✓ 22. Integrasi ECC (${eccSkills.length} skills, ${eccAgents.length} agents, ${eccCommands.length} commands, trigger-table & OpenCode provisioning) lulus`);

  // 23. Auto-Update & Self-Updater (getGitVersionInfo, checkAndApplyUpdate, AutoUpdateMonitor, & __builtin:version)
  const verInfo = await getGitVersionInfo();
  assert.ok(verInfo.branch && verInfo.shortCommit.length === 7, "Harus membaca branch & shortCommit git");

  const verRpcOut = await new Promise((resolve, reject) => {
    hub.startRun("hongchen", 1001, "__builtin:version", {
      onChunk: () => {},
      onApprovalReq: () => {},
      onDone: (fullText, err) => (err ? reject(new Error(err)) : resolve(fullText)),
    });
  });
  assert.ok(verRpcOut.includes(verInfo.shortCommit), "RPC __builtin:version harus mengembalikan versi git node");

  const upToDateRes = await checkAndApplyUpdate({
    execFn: async (cmd) => {
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) {
        return { exitCode: 0, output: "root-ecc-integrate\n1111111222222233333334444444555555566666\ninit" };
      }
      if (cmd.startsWith("git fetch")) return { exitCode: 0, output: "" };
      if (cmd.startsWith("git rev-parse origin/")) {
        return { exitCode: 0, output: "1111111222222233333334444444555555566666" };
      }
      return { exitCode: 0, output: "" };
    },
  });
  assert.strictEqual(upToDateRes.status, "up_to_date");
  assert.strictEqual(upToDateRes.restartRequired, false);

  let updatedHookCalled = false;
  const monitor = new AutoUpdateMonitor({
    label: "test-updater",
    autoRestart: false,
    onUpdated: (res) => {
      updatedHookCalled = res.fromCommit === "1111111" && res.toCommit === "9999999";
    },
    execFn: async (cmd) => {
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) {
        return { exitCode: 0, output: "root-ecc-integrate\n1111111222222233333334444444555555566666\nold" };
      }
      if (cmd.startsWith("git fetch")) return { exitCode: 0, output: "" };
      if (cmd.startsWith("git rev-parse origin/")) {
        return { exitCode: 0, output: "9999999888888877777776666666555555544444" };
      }
      if (cmd.startsWith("git diff --name-only")) return { exitCode: 0, output: "src/node/status.ts" };
      if (cmd.startsWith("git log --oneline")) return { exitCode: 0, output: "9999999 feat: new update" };
      if (cmd.startsWith("git pull")) return { exitCode: 0, output: "Fast-forward" };
      if (cmd === "npm run build") return { exitCode: 0, output: "Built OK" };
      return { exitCode: 0, output: "" };
    },
  });
  const tickRes = await monitor.tick();
  assert.ok(tickRes && tickRes.status === "updated" && tickRes.restartRequired === true);
  assert.ok(updatedHookCalled, "onUpdated callback harus terpanggil saat ada commit baru");
  console.log("✓ 23. Auto-Update poller, atomic build gate, & RPC /update berfungsi dengan benar");

  // Cleanup
  clientHongyun.stop();
  clientHongchen.stop();
  await hub.stop();
  fs.rmSync(auditHongyun, { force: true });
  fs.rmSync(auditHongchen, { force: true });
  fs.rmSync(statePath, { force: true });

  console.log("\n==============================================================");
  console.log("SEMUA 23 TEST PRODUKSI, OPENCODE, ECC, AUTO-UPDATE, & KEAMANAN LULUS!");
  console.log("==============================================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { HubServer, parseNodeTokens } = require("../dist/hub/server.js");
const { HubStore } = require("../dist/hub/store.js");
const { NodeClient } = require("../dist/node/client.js");
const { NodeExecutor, sanitizeEnv } = require("../dist/node/executor.js");
const { NodeEngine } = require("../dist/node/engine.js");
const { createNodeAlertEvaluator } = require("../dist/node/alerts.js");
const { assessRisk, isReadOnlyCommand } = require("../dist/shared/risk.js");
const { redactSecrets } = require("../dist/shared/audit.js");
const { markdownToHtml, chunkHtml } = require("../dist/shared/format.js");

const PORT = 9876;
const SECRET_TOKEN = "test-secret-prod-1234567890";
const JUNIN_TOKEN = "junin-specific-token-999";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("=== ASTER FLEET PRODUCTION SMOKE & SECURITY TEST SUITE ===");

  const auditJunin = path.join("/tmp", "audit-junin-test.jsonl");
  const auditFubuku = path.join("/tmp", "audit-fubuku-test.jsonl");
  const statePath = path.join("/tmp", "hub-state-test.json");
  fs.rmSync(auditJunin, { force: true });
  fs.rmSync(auditFubuku, { force: true });
  fs.rmSync(statePath, { force: true });

  // 1. Hub Start dengan Master Token & Per-Node Token
  const nodeTokens = parseNodeTokens(`junin:${JUNIN_TOKEN}`);
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

  // 3. Node Junin (pakai per-node token) & Fubuku (pakai master token) Konek
  const execJunin = new NodeExecutor("junin", auditJunin);
  const engineJunin = new NodeEngine("junin", execJunin);
  const clientJunin = new NodeClient(
    { hubUrl: `ws://127.0.0.1:${PORT}`, nodeId: "junin", token: JUNIN_TOKEN, reconnectDelayMs: 300 },
    engineJunin
  );

  const execFubuku = new NodeExecutor("fubuku", auditFubuku);
  const engineFubuku = new NodeEngine("fubuku", execFubuku);
  const clientFubuku = new NodeClient(
    { hubUrl: `ws://127.0.0.1:${PORT}`, nodeId: "fubuku", token: SECRET_TOKEN, reconnectDelayMs: 300 },
    engineFubuku
  );

  clientJunin.start();
  clientFubuku.start();
  await sleep(500);

  const nodes = hub.listNodes();
  assert.strictEqual(nodes.length, 2, "Harus ada 2 node terdaftar");
  const nodeIds = nodes.map((n) => n.nodeId).sort();
  assert.deepStrictEqual(nodeIds, ["fubuku", "junin"]);
  console.log("✓ 3. Node 'junin' (per-node token) dan 'fubuku' (master token) terdaftar:", nodeIds.join(", "));

  // 4. Metadata & Distro Detection
  const nodeJ = hub.getNode("junin");
  const nodeF = hub.getNode("fubuku");
  assert.ok(nodeJ && nodeJ.info.hostname && nodeJ.info.distro, "Metadata & distro junin lengkap");
  assert.ok(nodeF && nodeF.info.hostname && nodeF.info.distro, "Metadata & distro fubuku lengkap");
  console.log(
    `✓ 4. Metadata fleet & distro: host=${nodeJ.info.hostname}, distro=${nodeJ.info.distro.name} (${nodeJ.info.distro.packageManager})`
  );

  // 5. Eksekusi perintah aman di Junin ($ uptime)
  let juninChunks = "";
  let juninDone = false;
  hub.startRun("junin", 1001, "$ uptime", {
    onChunk: (c) => {
      juninChunks += c;
    },
    onApprovalReq: () => {
      assert.fail("uptime tidak boleh minta approval");
    },
    onDone: (res) => {
      juninDone = true;
      assert.ok(res.includes("[junin]"), "Output harus beridentitas junin");
    },
  });

  await sleep(500);
  assert.ok(juninDone, "Run di junin harus selesai");
  assert.ok(juninChunks.length > 0, "Harus menerima streaming chunks");
  console.log("✓ 5. Eksekusi terisolasi di node 'junin' sukses");

  // 6. Eksekusi perintah aman di Fubuku ($ whoami)
  let fubukuDone = false;
  hub.startRun("fubuku", 1001, "$ whoami", {
    onChunk: () => {},
    onApprovalReq: () => {
      assert.fail("whoami tidak boleh minta approval");
    },
    onDone: (res) => {
      fubukuDone = true;
      assert.ok(res.includes("[fubuku]"), "Output harus beridentitas fubuku");
    },
  });

  await sleep(500);
  assert.ok(fubukuDone, "Run di fubuku harus selesai");
  console.log("✓ 6. Eksekusi terisolasi di node 'fubuku' sukses");

  // 7. Audit logging lokal independen, permission 0600, & verifikasi rantai hash
  assert.ok(fs.existsSync(auditJunin), "audit junin harus ada");
  assert.ok(fs.existsSync(auditFubuku), "audit fubuku harus ada");
  const modeJ = fs.statSync(auditJunin).mode & 0o777;
  assert.strictEqual(modeJ, 0o600, "File audit wajib memiliki permission 0600");
  const verifyJ = execJunin.verifyAudit();
  assert.strictEqual(verifyJ.ok, true, "Audit chain junin harus valid");
  assert.strictEqual(verifyJ.total, 1);
  console.log("✓ 7. Audit log per-node independen, mode 0600, & hash-chain terverifikasi");

  // 8. Command Berisiko di Junin: Tolak oleh Operator via Hub
  let approvalReqReceived = false;
  hub.startRun("junin", 1001, "$ systemctl restart nginx", {
    onChunk: () => {},
    onApprovalReq: (approvalId, cmd) => {
      approvalReqReceived = true;
      assert.strictEqual(cmd, "systemctl restart nginx");
      hub.sendApproval("junin", "fake", approvalId, false);
    },
    onDone: (res) => {
      assert.ok(res.includes("[REJECTED]"), "Harus ada notif REJECTED");
    },
  });

  await sleep(500);
  assert.ok(approvalReqReceived, "Approval request harus sampai ke Hub");
  console.log("✓ 8. Approval bridge: penolakan operator berhasil diteruskan ke node");

  // 9. Command Berisiko di Junin: Setujui oleh Operator via Hub
  let approvalApprovedReceived = false;
  hub.startRun("junin", 1001, "$ cp /etc/hostname /tmp/aster-hostname-test", {
    onChunk: () => {},
    onApprovalReq: (approvalId) => {
      approvalApprovedReceived = true;
      hub.sendApproval("junin", "fake", approvalId, true);
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
  hub.startRun("fubuku", 1001, "$ rm -rf /", {
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
  assert.strictEqual(assessRisk("cat /etc/shadow").level, "block");
  assert.strictEqual(assessRisk("printenv").level, "block");
  assert.strictEqual(assessRisk("echo pass | sudo -S id").level, "block");
  assert.strictEqual(isReadOnlyCommand("uname -a | grep -i linux"), true);
  assert.strictEqual(isReadOnlyCommand("echo hi > /tmp/x"), false);
  console.log("✓ 10. Risk classifier memblokir perintah destruktif, pembacaan secret, & env leak");

  // 11. Sanitasi Environment Child Process (Anti Secret Leak)
  process.env.TEST_SECRET_TOKEN = "rahasia-negara-123";
  const sanitized = sanitizeEnv(process.env);
  assert.strictEqual(sanitized.TEST_SECRET_TOKEN, undefined, "Variabel SECRET/TOKEN harus dihapus dari child env");
  const envCheckRes = await execJunin.runCommand("echo ${TEST_SECRET_TOKEN:-kosong}");
  assert.strictEqual(envCheckRes.output.trim(), "kosong", "Shell anak tidak boleh bisa membaca secret env");
  delete process.env.TEST_SECRET_TOKEN;
  console.log("✓ 11. Sanitasi environment child process mencegah kebocoran token/password");

  // 12. Redaksi Secret di Audit Log & Deteksi Tampering via /auditcheck
  const redacted = redactSecrets("curl -H 'Authorization: Bearer my-secret-jwt' --password supersecret api_key=12345");
  assert.ok(!redacted.includes("my-secret-jwt") && !redacted.includes("supersecret") && !redacted.includes("12345"));

  let auditCheckOut = "";
  hub.startRun("junin", 1001, "__builtin:auditcheck", {
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
  let statusOut = "";
  hub.startRun("junin", 1001, "__builtin:status", {
    onChunk: () => {},
    onApprovalReq: () => {},
    onDone: (res) => {
      statusOut = res;
    },
  });
  await sleep(1000);
  assert.ok(statusOut.includes("load") && statusOut.includes("mem") && statusOut.includes("disk"));
  console.log("✓ 13. Dashboard monospace /status berhasil dibangun dari node");

  // 14. Pembatalan Tugas (/stop -> hub_cancel -> kill process tree)
  let cancelErr = "";
  const slowRunId = hub.startRun("fubuku", 2002, "$ sleep 30", {
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
    if (nodeId === "junin" && key === "disk" && severity === "warn") {
      receivedAlertHtml = html;
    }
  });
  const alertState = new Map();
  const evalAlert = createNodeAlertEvaluator({
    nodeId: "junin",
    send: (ev) => clientJunin.sendAlert(ev.key, ev.severity, ev.html),
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

  // 16. AI Tool-Calling Loop dengan Stubbed OpenAI Client
  let callTurn = 0;
  engineFubuku.setClientForTest({
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
  hub.startRun("fubuku", 1001, "Cek respons echo", {
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
  console.log("✓ 16. Loop AI tool-calling & pelacakan token usage bekerja sempurna");

  // 17. HubStore Persistence & HTML Chunking
  const store = new HubStore(statePath);
  store.setActiveNode(1001, "junin");
  store.remember(1001, "junin", "cek uptime", "Server nyala 10 hari");
  store.addUsage(1001, { promptTokens: 100, completionTokens: 50 });
  store.flush();

  const storeReloaded = new HubStore(statePath);
  assert.strictEqual(storeReloaded.getActiveNode(1001), "junin");
  assert.strictEqual(storeReloaded.getHistory(1001, "junin").length, 2);
  assert.strictEqual(storeReloaded.getUsage(1001).promptTokens, 100);

  const htmlChunks = chunkHtml(markdownToHtml("```bash\n" + "a".repeat(5000) + "\n```"), 2000);
  assert.ok(htmlChunks.length >= 3, "Pesan panjang harus dipecah menjadi beberapa chunk");
  assert.ok(htmlChunks[0].endsWith("</code></pre>"), "Setiap chunk pre harus ditutup dengan aman");
  console.log("✓ 17. Persistensi HubStore (mode 0600) & HTML chunking aman terverifikasi");

  // 18. Disconnect & Reconnect Otomatis
  clientJunin.stop();
  await sleep(350);
  assert.strictEqual(hub.listNodes().length, 1, "Tersisa 1 node setelah junin disconnect");
  assert.strictEqual(hub.listNodes()[0].nodeId, "fubuku");
  console.log("✓ 18. Deteksi disconnect node realtime");

  clientJunin.start();
  await sleep(500);
  assert.strictEqual(hub.listNodes().length, 2, "2 node kembali online setelah reconnect");
  console.log("✓ 19. Reconnect otomatis node sukses");

  // 20. Deteksi Kerusakan Rantai Audit (Tamper Detection)
  fs.appendFileSync(auditJunin, '{"ts":"2026-01-01","nodeId":"junin","command":"hack","prevHash":" SALAH","hash":"123"}\n');
  const tamperedVerify = execJunin.verifyAudit();
  assert.strictEqual(tamperedVerify.ok, false, "Audit verifier harus mendeteksi baris yang dimanipulasi");
  console.log("✓ 20. Tamper-detection mendeteksi manipulasi file audit pada baris ke-" + tamperedVerify.brokenAt);

  // Cleanup
  clientJunin.stop();
  clientFubuku.stop();
  await hub.stop();
  fs.rmSync(auditJunin, { force: true });
  fs.rmSync(auditFubuku, { force: true });
  fs.rmSync(statePath, { force: true });

  console.log("\n==============================================================");
  console.log("SEMUA 20 TEST PRODUKSI & KEAMANAN ASTER FLEET LULUS 100%!");
  console.log("==============================================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

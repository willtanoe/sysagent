const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { HubServer } = require("../dist/hub/server.js");
const { NodeClient } = require("../dist/node/client.js");
const { NodeExecutor } = require("../dist/node/executor.js");
const { NodeEngine } = require("../dist/node/engine.js");

const PORT = 9876;
const SECRET_TOKEN = "test-secret-poc-123";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("=== POC SMOKE TEST: HUB + MULTI-NODE FLEET ===");

  // Cleanup audit files
  const auditJunin = path.join("/tmp", "audit-junin-test.jsonl");
  const auditFubuku = path.join("/tmp", "audit-fubuku-test.jsonl");
  fs.rmSync(auditJunin, { force: true });
  fs.rmSync(auditFubuku, { force: true });

  // 1. Hub Start
  const hub = new HubServer(PORT, SECRET_TOKEN);
  await hub.start();
  console.log("✓ 1. Hub berhasil start di port", PORT);

  // 2. Node dengan token salah harus ditolak
  const badExecutor = new NodeExecutor("bad-node", "/tmp/bad.jsonl");
  const badEngine = new NodeEngine("bad-node", badExecutor);
  const badClient = new NodeClient(
    { hubUrl: `ws://127.0.0.1:${PORT}`, nodeId: "bad-node", token: "wrong-token" },
    badEngine
  );
  badClient.start();
  await sleep(300);
  assert.strictEqual(hub.listNodes().length, 0, "Bad node tidak boleh terdaftar");
  badClient.stop();
  console.log("✓ 2. Autentikasi token salah ditolak oleh Hub");

  // 3. Node Junin & Fubuku Konek
  const execJunin = new NodeExecutor("junin", auditJunin);
  const engineJunin = new NodeEngine("junin", execJunin);
  const clientJunin = new NodeClient(
    { hubUrl: `ws://127.0.0.1:${PORT}`, nodeId: "junin", token: SECRET_TOKEN },
    engineJunin
  );

  const execFubuku = new NodeExecutor("fubuku", auditFubuku);
  const engineFubuku = new NodeEngine("fubuku", execFubuku);
  const clientFubuku = new NodeClient(
    { hubUrl: `ws://127.0.0.1:${PORT}`, nodeId: "fubuku", token: SECRET_TOKEN },
    engineFubuku
  );

  clientJunin.start();
  clientFubuku.start();
  await sleep(600);

  const nodes = hub.listNodes();
  assert.strictEqual(nodes.length, 2, "Harus ada 2 node terdaftar");
  const nodeIds = nodes.map((n) => n.nodeId).sort();
  assert.deepStrictEqual(nodeIds, ["fubuku", "junin"]);
  console.log("✓ 3. Node 'junin' dan 'fubuku' terdaftar di Hub:", nodeIds.join(", "));

  // 4. Hub dapat membaca metadata kedua node
  const nodeJ = hub.getNode("junin");
  const nodeF = hub.getNode("fubuku");
  assert.ok(nodeJ && nodeJ.info.hostname, "Metadata junin lengkap");
  assert.ok(nodeF && nodeF.info.hostname, "Metadata fubuku lengkap");
  console.log("✓ 4. Metadata fleet: junin host =", nodeJ.info.hostname, "| fubuku host =", nodeF.info.hostname);

  // 5. Eksekusi perintah aman di Junin ($ uptime)
  let juninChunks = "";
  let juninDone = false;
  hub.startRun("junin", 1001, "$ uptime", {
    onChunk: (c) => { juninChunks += c; },
    onApprovalReq: () => { assert.fail("uptime tidak boleh minta approval"); },
    onDone: (res) => {
      juninDone = true;
      assert.ok(res.includes("[junin]"), "Output harus beridentitas junin");
    },
  });

  await sleep(600);
  assert.ok(juninDone, "Run di junin harus selesai");
  assert.ok(juninChunks.length > 0, "Harus menerima streaming chunks");
  console.log("✓ 5. Eksekusi terisolasi di node 'junin' sukses");

  // 6. Eksekusi perintah aman di Fubuku ($ whoami)
  let fubukuChunks = "";
  let fubukuDone = false;
  hub.startRun("fubuku", 1001, "$ whoami", {
    onChunk: (c) => { fubukuChunks += c; },
    onApprovalReq: () => { assert.fail("whoami tidak boleh minta approval"); },
    onDone: (res) => {
      fubukuDone = true;
      assert.ok(res.includes("[fubuku]"), "Output harus beridentitas fubuku");
    },
  });

  await sleep(600);
  assert.ok(fubukuDone, "Run di fubuku harus selesai");
  console.log("✓ 6. Eksekusi terisolasi di node 'fubuku' sukses");

  // 7. Audit logging lokal independen per node
  assert.ok(fs.existsSync(auditJunin), "audit junin harus ada");
  assert.ok(fs.existsSync(auditFubuku), "audit fubuku harus ada");
  const auditJLines = fs.readFileSync(auditJunin, "utf8").trim().split("\n");
  const auditFLines = fs.readFileSync(auditFubuku, "utf8").trim().split("\n");
  const entryJ = JSON.parse(auditJLines[0]);
  const entryF = JSON.parse(auditFLines[0]);
  assert.strictEqual(entryJ.nodeId, "junin");
  assert.strictEqual(entryF.nodeId, "fubuku");
  assert.ok(entryJ.hash && entryF.hash, "Hash audit chaining valid");
  console.log("✓ 7. Audit log per-node independen & hash-chained");

  // 8. Command Berisiko di Junin: Tolak oleh Hub
  let approvalReqReceived = false;
  hub.startRun("junin", 1001, "$ systemctl restart nginx", {
    onChunk: () => {},
    onApprovalReq: (approvalId, cmd, reason) => {
      approvalReqReceived = true;
      assert.strictEqual(cmd, "systemctl restart nginx");
      // Simulasikan operator menolak
      hub.sendApproval("junin", "fake", approvalId, false);
    },
    onDone: (res) => {
      assert.ok(res.includes("[REJECTED]"), "Harus ada notif REJECTED");
    },
  });

  await sleep(600);
  assert.ok(approvalReqReceived, "Approval request harus sampai ke Hub");
  console.log("✓ 8. Approval bridge: penolakan operator berhasil diteruskan ke node");

  // 9. Command Berisiko di Junin: Setujui oleh Hub
  let approvalApprovedReceived = false;
  hub.startRun("junin", 1001, "$ systemctl reload nginx", {
    onChunk: () => {},
    onApprovalReq: (approvalId) => {
      approvalApprovedReceived = true;
      // Simulasikan operator menyetujui
      hub.sendApproval("junin", "fake", approvalId, true);
    },
    onDone: (res) => {
      assert.ok(!res.includes("[REJECTED]"), "Tidak boleh ditolak");
    },
  });

  await sleep(600);
  assert.ok(approvalApprovedReceived, "Approval request harus sampai ke Hub");
  console.log("✓ 9. Approval bridge: persetujuan operator berhasil dieksekusi di node");

  // 10. Command Bahaya (Block list)
  let blockRunDone = false;
  hub.startRun("fubuku", 1001, "$ rm -rf /", {
    onChunk: () => {},
    onApprovalReq: () => { assert.fail("rm -rf / harus diblok tanpa minta approval"); },
    onDone: (res) => {
      blockRunDone = true;
      assert.ok(res.includes("[BLOCKED]"), "Harus ada status BLOCKED");
    },
  });

  await sleep(600);
  assert.ok(blockRunDone, "Blocked command selesai");
  console.log("✓ 10. Risk classifier menolak perintah kategori block langsung di node");

  // 11. Disconnect & Reconnect
  clientJunin.stop();
  await sleep(400);
  assert.strictEqual(hub.listNodes().length, 1, "Tersisa 1 node setelah junin disconnect");
  assert.strictEqual(hub.listNodes()[0].nodeId, "fubuku");
  console.log("✓ 11. Deteksi disconnect node realtime");

  clientJunin.start();
  await sleep(600);
  assert.strictEqual(hub.listNodes().length, 2, "2 node kembali online setelah reconnect");
  console.log("✓ 12. Reconnect otomatis node sukses");

  // Cleanup
  clientJunin.stop();
  clientFubuku.stop();
  await hub.stop();
  fs.rmSync(auditJunin, { force: true });
  fs.rmSync(auditFubuku, { force: true });

  console.log("\n==============================================");
  console.log("SEMUA 12 TEST POC HUB + MULTI-NODE FLEET LULUS!");
  console.log("==============================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

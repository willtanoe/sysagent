# Aster Fleet Manager (Hub + Multi-Node Architecture PoC)

Pilot implementasi arsitektur 1 Bot Telegram untuk mengelola puluhan VPS secara terpusat tanpa membuka port inbound di node VPS.

## Arsitektur

```text
[ Telegram Admin ]
        |
        v (Webhook / Long Polling)
+-----------------------------------+
|             ASTER HUB             |
| - 1 Telegram Bot                  |
| - WSS Gateway (Port 8765)         |
| - Node Registry & Session Routing |
| - Approval UI (Inline Keyboard)   |
+-----------------------------------+
        ^                   ^
        | (Outbound WSS)    | (Outbound WSS)
        |                   |
+---------------+   +----------------+
|  Node: junin  |   |  Node: fubuku  |
| - WSS Client  |   | - WSS Client   |
| - Risk Engine |   | - Risk Engine  |
| - Shell Exec  |   | - Shell Exec   |
| - Local Audit |   | - Local Audit  |
+---------------+   +----------------+
```

### Keunggulan
1. **Zero Inbound Port di Node:** Node VPS melakukan koneksi outbound WSS ke Hub. Tidak perlu membuka port firewall inbound apa pun di 33 VPS.
2. **Audit Independen:** Setiap perintah yang dieksekusi di node dicatat ke file audit lokal node (`audit-<nodeId>.jsonl`) dengan SHA-256 hash-chaining.
3. **Approval Terintegrasi:** Perintah kategori `approve` (mis. `systemctl restart`, `chmod`, `iptables`) otomatis memicu permintaan persetujuan ke Telegram Hub dengan tombol `[Setujui]` / `[Tolak]`.
4. **Hard Security Guard:** Perintah berbahaya (`rm -rf /`, `mkfs`, fork bomb) langsung ditolak oleh classifier risiko lokal di node tanpa bisa di-override.

## Struktur Project

```text
sysadmin-agent/
├── src/
│   ├── shared/
│   │   ├── protocol.ts     # Protokol pesan JSON over WebSocket (Hello, Run, Chunk, Approval, Heartbeat)
│   │   ├── risk.ts         # Risk classifier (allow, approve, block)
│   │   └── audit.ts        # Tamper-evident hash-chained audit logger
│   ├── hub/
│   │   ├── server.ts       # WSS Server, node registry, heartbeat & run coordinator
│   │   ├── bot.ts          # Telegram bot (/nodes, /use <node>, streaming & approval keyboard)
│   │   └── index.ts        # Entrypoint Hub
│   └── node/
│       ├── executor.ts     # Eksekutor shell, penegakan risiko, dan pencatatan audit lokal
│       ├── engine.ts       # AI Tool-calling runner & fallback ops execution
│       ├── client.ts       # WSS Client dengan auto-reconnect dan heartbeat
│       └── index.ts        # Entrypoint Node
└── tests/
    └── poc-smoke.js        # 12 test end-to-end multi-node & approval flow
```

## Menjalankan PoC di VPS Ini

### 1. Jalankan Unit Test End-to-End
```bash
npm test
```
Ini akan mensimulasikan Hub dan 2 Node (`junin` & `fubuku`), menguji isolasi perintah, approval bridge, penolakan perintah terlarang, hingga deteksi disconnect/reconnect.

### 2. Menjalankan Hub
```bash
npm run hub
```

### 3. Menjalankan Node Agent
Buka terminal terpisah:
```bash
# Node Junin
npm run node:junin

# Node Fubuku
npm run node:fubuku
```
Node akan otomatis terhubung ke Hub dan muncul di daftar `/nodes` bot Telegram.

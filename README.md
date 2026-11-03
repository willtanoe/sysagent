# Aster Fleet Manager

Sistem manajemen **Server & VPS Multi-Node (SRE Agent Fleet)** berbasis Telegram dengan arsitektur **1 Hub Terpusat + Banyak Node Agent**. Dirancang untuk operasional server kantor dan produksi tanpa membuka port *inbound* di server target, dilengkapi *approval gate* interaktif, sanitasi *environment*, serta *audit trail* lokal *tamper-evident* (rantai hash SHA-256).

---

## Arsitektur Sistem

```text
                        [ Operator / Tim SRE ]
                                  │
                                  ▼ (Telegram Long Polling)
              ┌───────────────────────────────────────┐
              │            ASTER FLEET HUB            │
              │  • 1 Bot Telegram Terpusat            │
              │  • WSS Coordinator (Port 8765 / TLS)  │
              │  • Constant-Time Auth & Node Registry │
              │  • Persisted State & Approval Router  │
              │  • Proactive Alert Forwarder          │
              └───────────────────▲───────────────────┘
                                  │
            ┌─────────────────────┴─────────────────────┐
            │ (Outbound WSS)                            │ (Outbound WSS)
            │                                           │
┌───────────┴───────────────┐               ┌───────────┴───────────────┐
│   Node: hongyun           │               │   Node: hongchen          │
│  • Outbound WSS Client    │               │  • Outbound WSS Client    │
│  • AI SRE Agent / Shell   │               │  • AI SRE Agent / Shell   │
│  • 3-Tier Risk Classifier │               │  • 3-Tier Risk Classifier │
│  • Process-Tree Executor  │               │  • Process-Tree Executor  │
│  • Hash-Chained Audit Log │               │  • Hash-Chained Audit Log │
│  • Proactive Health Alert │               │  • Proactive Health Alert │
└───────────────────────────┘               └───────────────────────────┘
```

### Keunggulan Utama
1. **Zero Inbound Port di Server Target**: Seluruh node menginisiasi koneksi *outbound* WebSocket (`ws://` atau `wss://`) ke Hub. Firewall server produksi kantor tidak perlu membuka port *inbound* tambahan.
2. **Bundled OpenCode Engine (`@opencode/cli`) & Dual-Engine AI**:
   - **`ENGINE=opencode` (Default)**: Membundel binary resmi `@opencode/cli` langsung di dalam paket (`node_modules/@opencode/cli`) dan otomatis menyalakan daemon `opencode serve` lokal (`127.0.0.1`) yang diproteksi password acak per sesi. Mendukung model gratis bawaan (`opencode/glm-5.3-flash-free`, `opencode/minimax-m2.5-free`, dll.) tanpa perlu API key eksternal.
   - **`ENGINE=local`**: Mode alternatif menggunakan loop *tool-calling* internal dengan endpoint yang kompatibel dengan OpenAI API (`GATEWAY_URL` + `GATEWAY_API_KEY`).
3. **Defense-in-Depth & Hardening**:
   - Verifikasi token *constant-time* (`crypto.timingSafeEqual` di atas SHA-256 digest) dengan dukungan token master maupun token unik per-node (`NODE_TOKENS`).
   - Sanitasi *environment* (`sanitizeEnv`) sehingga *child process* shell tidak dapat membocorkan token/kredensial dari variabel *environment*.
   - Eksekusi non-interaktif (`sudo -n` atau `sudo -A` via *askpass* mode `0700`) dan penghentian seluruh *process group* (`-pid` `SIGKILL`) saat *timeout* atau dibatalkan lewat `/stop`.
4. **3-Tier Risk Classifier & Default-Approve Allowlist Gate (di OpenCode maupun Local Engine)**:
   - `allow`: Hanya perintah inspeksi *read-only* yang terdaftar di *allowlist* `isReadOnlyCommand` (atau pembacaan file non-rahasia di OpenCode) yang langsung dieksekusi tanpa mengganggu operator.
   - `approve`: Perintah mutasi (`sudo`, `systemctl restart`, `rm`, `mkdir`, `touch`, `chmod`, `apt`/`dnf`, `tar`, `find -exec`, modifikasi firewall, redirection file, `edit`/`write` file di OpenCode, maupun *binary* kustom di luar daftar *read-only*) wajib disetujui operator via tombol inline Telegram yang terikat ke `chatId` peminta.
   - `block`: Perintah destruktif (`rm -rf /`, `mkfs`, fork bomb) dan pembacaan file rahasia (`.env`, `/etc/shadow`, `.ssh/*`, `hub-state.json`, `askpass`, bocoran `printenv`, termasuk *obfuscation* backslash/kurung kurawal maupun tool `read` OpenCode) langsung ditolak di level node tanpa opsi *override*, serta `subagent`/`question` di OpenCode dinonaktifkan (`deny`).
5. **Tamper-Evident Audit Trail**: Setiap eksekusi di node dicatat ke file JSONL lokal (`0600`) dengan redaksi *secret* otomatis dan rantai hash SHA-256 yang dapat diverifikasi kapan saja lewat `/auditcheck`.
6. **Alert Kesehatan Proaktif**: Setiap node memantau penggunaan Disk, Memory, dan unit `systemd` yang gagal, lalu meneruskan notifikasi *alert* dan pemulihan (*recovery*) secara *real-time* ke Telegram admin melalui Hub.

---

## Struktur Repositori

```text
.
├── src/
│   ├── shared/
│   │   ├── protocol.ts        # Kontrak pesan JSON WebSocket antara Hub & Node
│   │   ├── risk.ts            # Classifier risiko (allow / approve / block) & heuristik read-only
│   │   ├── audit.ts           # Hash-chained audit logger + redaksi secret + verifier
│   │   └── format.ts          # Konversi Markdown -> HTML Telegram & safe <pre> chunking
│   ├── hub/
│   │   ├── index.ts           # Entrypoint Hub & concurrent Telegram runner
│   │   ├── server.ts          # WS/WSS server, constant-time auth, registry, run coordinator
│   │   ├── bot.ts             # Handler command Telegram, inline approval, alert forwarder
│   │   └── store.ts           # Persistensi atomik state Hub (mode 0600)
│   └── node/
│       ├── index.ts           # Entrypoint Node Agent & lifecycle ManagedOpenCodeServer
│       ├── client.ts          # Outbound WS/WSS client, heartbeat, reconnect, abort handler
│       ├── engine.ts          # Dual-engine router (opencode / local), permission guard, & RPC
│       ├── opencode.ts        # Client HTTP/SSE OpenCode, session manager, & reasoning recovery
│       ├── opencode-server.ts # Spawner & watchdog binary bundled @opencode/cli (127.0.0.1)
│       ├── executor.ts        # Hardened shell spawner, env sanitizer, sudo askpass, rate limit
│       ├── status.ts          # Generator dashboard monospace bergaya netdata
│       ├── alerts.ts          # Monitor proaktif Disk, RAM, & failed systemd units
│       └── distro.ts          # Deteksi distro Linux (/etc/os-release) & package manager
├── deploy/systemd/            # Unit systemd produksi (Full-Root & Isolated)
├── Dockerfile                 # Multi-stage Docker image (Hub & Node dengan nsenter)
├── docker-compose.yml         # Profile deployment Docker untuk Hub (--profile hub) & Node (--profile node)
├── docs/                      # Dokumentasi lengkap arsitektur, deploy, keamanan, & operasi
├── tests/
│   └── poc-smoke.js           # 21 skenario pengujian otomatis end-to-end, OpenCode, nsenter, & keamanan
├── .env.example               # Template konfigurasi Hub & Node
├── .npmrc                     # Konfigurasi npm (omit=optional) untuk instalasi lintas platform
└── package.json
```

---

## Mulai Cepat (Quickstart)

### Prasyarat
- **Mode Container (Disarankan di `stg-container`)**: Docker & Docker Compose v2 (tidak perlu menginstal Node.js di host VPS).
- **Mode Host-Native (`systemd`)**: Linux dengan `systemd` dan Node.js `>= 20.3.0`.
- Token Bot Telegram dari [@BotFather](https://t.me/BotFather) dan Telegram User ID admin (opsional saat fase *staging* intranet sebelum internet Hub dibuka).

### 1. Instalasi & Konfigurasi (`stg-container`)
```bash
mkdir -p /opt/aster-fleet
git clone -b stg-container git@github.com:willtanoe/sysagent.git /opt/aster-fleet
cd /opt/aster-fleet
cp .env.example .env
chmod 600 .env
```

### 2. Menjalankan Hub & Node via Docker Compose (Utama)
```bash
# A. Di VPS Hub (Container Terisolasi Penuh / Read-Only Rootfs):
docker compose --profile hub up -d --build
docker logs -f aster-hub

# B. Di Setiap VPS Node Target (Host-Namespace + Auto-nsenter ke PID 1 VPS):
NODE_ID=hongyun docker compose --profile node up -d --build
docker logs -f aster-node-hongyun
```

### 3. Alternatif: Instalasi Host-Native & Pengujian Otomatis
Jika dijalankan langsung di host tanpa Docker:
```bash
npm ci
npm run build
npm test
```
`npm test` menjalankan 21 skenario pengujian tanpa ketergantungan jaringan luar: autentikasi token master & per-node, eksekusi multi-node terisolasi, *approval gate*, pemblokiran perintah destruktif & *secret* level `root`, pelucutan `sudo` redundan (`stripRedundantSudo`), jembatan container `nsenter -t 1` (`buildSpawnSpec`), sanitasi *environment*, redaksi *secret* audit, deteksi manipulasi rantai hash (`/auditcheck`), pembatalan proses (`/stop`), *proactive alert*, integrasi binary bundled `@opencode/cli` (`OpenCodeRunner` + pemulihan `reasoning_content`), dan *auto-reconnect*.

Untuk panduan lengkap arsitektur jembatan `nsenter`, konfigurasi `.env`, TLS/WSS, serta operasional multi-server, lihat **[docs/deployment.md](docs/deployment.md)**.

---

## Daftar Perintah Telegram

| Perintah | Fungsi |
|---|---|
| `/nodes` | Menampilkan daftar server node yang terhubung beserta status *load*, RAM, *uptime*, dan tombol pilih cepat |
| `/use <node>` | Memilih server node aktif untuk sesi chat ini |
| `/unuse` | Melepas pilihan server node aktif |
| `/status [node\|all]` | Dashboard monospace bergaya netdata untuk node aktif (atau ringkasan seluruh *fleet* dengan `/status all`) |
| `/disk` `/mem` `/ps` `/ports` | Diagnosa cepat disk, memori, proses CPU tertinggi, dan port TCP yang *listening* di node aktif |
| `/logs <unit> [baris]` | Menampilkan *tail* log `journalctl` untuk unit `systemd` tertentu (maks 500 baris) |
| `/svc <aksi> <unit>` | Mengelola service `systemd`: `status`, `start`, `stop`, `restart`, `reload`, `enable`, `disable` |
| `/exec <perintah>` | Menjalankan perintah shell langsung di node aktif (atau gunakan awalan `$ <perintah>`) |
| `/chat <prompt>` | Konsultasi & investigasi interaktif bersama AI SRE Agent (atau kirim pesan teks biasa) |
| `/stop` | Menghentikan tugas yang sedang berjalan dan membunuh seluruh *process tree* shell di node |
| `/auditcheck [node]` | Memverifikasi keutuhan rantai hash SHA-256 pada file audit lokal di node |
| `/model [id\|reset]` | Melihat atau mengganti model AI untuk chat ini |
| `/usage` | Menampilkan statistik pemakaian token AI pada chat ini |
| `/reset` | Menghapus riwayat percakapan, sesi OpenCode, dan statistik token untuk node aktif |
| `/id` | Menampilkan Telegram User ID dan Chat ID |
| `/help` | Menampilkan panduan perintah lengkap |

---

## Dokumentasi Lengkap

- **[Arsitektur Sistem](docs/architecture.md)**: Protokol WebSocket Hub-Node, siklus hidup eksekusi, manajemen memori AI, dan struktur modul.
- **[Panduan Deployment](docs/deployment.md)**: Langkah instalasi di server kantor, konfigurasi TLS/Nginx, manajemen token per-node, dan pemasangan unit `systemd`.
- **[Model Keamanan & Hardening](docs/security.md)**: Pertahanan berlapis, sanitasi *environment*, penanganan `sudo`, isolasi `systemd`, dan *tamper-evident* audit.
- **[Panduan Operasional (Runbook)](docs/operations.md)**: Penggunaan harian, *proactive alerting*, dukungan multi-distro, dan *troubleshooting*.

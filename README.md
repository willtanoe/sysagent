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
2. **Bundled OpenCode Engine (`@opencode/cli`) + Integrasi ECC ([Everything Claude Code](https://github.com/affaan-m/ECC))**:
   - **`ENGINE=opencode` (Default)**: Membundel binary resmi `@opencode/cli` langsung di dalam paket (`node_modules/@opencode/cli`) dan otomatis menyalakan daemon `opencode serve` lokal (`127.0.0.1`) yang diproteksi password acak per sesi serta diprovisi otomatis dengan konfigurasi `.opencode/opencode.json` milik **ECC** (31 *curated SRE & security skills*, 27 *specialist agents*, 36 *workflow commands*, dan *plugin hooks* yang telah di-*harden*). Mendukung model gratis bawaan (`opencode/glm-5.3-flash-free`, `opencode/minimax-m2.5-free`, dll.) tanpa perlu API key eksternal.
   - **`ENGINE=local` + Trigger-Table Lazy Loading ECC**: Mode alternatif menggunakan loop *tool-calling* internal (`GATEWAY_URL` + `GATEWAY_API_KEY`) yang juga diperkaya oleh pencocokan *Trigger-Table* ECC (`src/node/ecc.ts`) untuk menyuntikkan panduan skill & agen spesialis secara hemat token.
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
7. **Batch Approval Multi-Node**: Permintaan persetujuan untuk perintah identik dari beberapa node digabung menjadi satu pesan dengan tombol `Setujui Semua` / `Tolak Semua`. Keputusan diingat 5 menit (hanya di memori Hub, per chat dan pengguna) agar node yang terlambat tidak memicu pesan berulang. Detail dan batasannya ada di [docs/security.md](docs/security.md).
8. **Embedded Hub Node**: Secara default Hub juga menjalankan satu node internal (`HUB_EMBED_NODE=true`) sehingga operator bisa berdiskusi dengan agen di Hub, yang dapat mengoordinasikan node lain. Host Hub ikut menjadi target eksekusi di bawah aturan risiko yang sama. Set `HUB_EMBED_NODE=false` bila tidak diperlukan.

---

## Struktur Repositori

```text
.
├── src/
│   ├── shared/
│   │   ├── protocol.ts        # Kontrak pesan JSON WebSocket antara Hub & Node
│   │   ├── risk.ts            # Classifier risiko (allow / approve / block) & heuristik read-only
│   │   ├── audit.ts           # Hash-chained audit logger + redaksi secret + verifier
│   │   ├── format.ts          # Konversi Markdown -> HTML Telegram & safe <pre> chunking
│   │   └── updater.ts         # Auto-update Git (pull, npm ci, build gate, self-restart)
│   ├── hub/
│   │   ├── index.ts           # Entrypoint Hub, embedded node, & concurrent Telegram runner
│   │   ├── server.ts          # WS/WSS server, constant-time auth, registry, run coordinator, loopback /internal/fleet
│   │   ├── bot.ts             # Handler command Telegram, inline approval, alert forwarder
│   │   ├── approval.ts        # ApprovalBatcher: batch approval multi-node & memori keputusan 5 menit
│   │   ├── progress.ts        # Indikator progres live (typing, fase, timer, langkah tool)
│   │   ├── fleet-ctl.ts       # CLI loopback agen Hub untuk mengendalikan node lain
│   │   └── store.ts           # Persistensi atomik state Hub (mode 0600)
│   └── node/
│       ├── index.ts           # Entrypoint Node Agent & lifecycle ManagedOpenCodeServer
│       ├── client.ts          # Outbound WS/WSS client, heartbeat, reconnect, abort handler
│       ├── engine.ts          # Dual-engine router (opencode / local), permission guard, & RPC
│       ├── opencode.ts        # Client HTTP/SSE OpenCode, session manager, & reasoning recovery
│       ├── opencode-server.ts # Spawner & watchdog binary bundled @opencode/cli + ECC provisioner
│       ├── ecc.ts             # Integrasi ECC (31 skills, 27 agents, 36 commands, trigger-table)
│       ├── executor.ts        # Hardened shell spawner, env sanitizer, sudo askpass, rate limit
│       ├── status.ts          # Generator dashboard monospace bergaya netdata
│       ├── alerts.ts          # Monitor proaktif Disk, RAM, & failed systemd units
│       └── distro.ts          # Deteksi distro Linux (/etc/os-release) & package manager
├── .opencode/                 # Konfigurasi OpenCode ECC (opencode.json, agents, commands, plugins, tools)
├── skills/                    # 31 Curated ECC Skills (SRE, Network, Docker/K8s, DB, Security, Safety Guard)
├── contexts/                  # Konteks mode operasional ECC (dev, review, research)
├── rules/common/              # Aturan standar keamanan, coding style, & verifikasi ECC
├── deploy/systemd/            # Unit systemd produksi (Full-Root & Isolated)
├── docs/                      # Dokumentasi lengkap arsitektur, deploy, keamanan, & operasi
├── tests/
│   └── poc-smoke.js           # 30 skenario pengujian otomatis end-to-end, OpenCode, ECC, fleet, approval, & keamanan
├── .env.example               # Template konfigurasi Hub & Node
├── .npmrc                     # Konfigurasi npm (omit=optional) untuk instalasi lintas platform
└── package.json
```

---

## Mulai Cepat (Quickstart)

### Prasyarat
- Linux dengan `systemd` (Ubuntu/Debian, RHEL/AlmaLinux/Rocky, Arch, Alpine, openSUSE).
- Node.js `>= 20.3.0`.
- Token Bot Telegram dari [@BotFather](https://t.me/BotFather) dan Telegram User ID admin.

### 1. Instalasi & Build (Mode Full-Root + ECC Integration)
```bash
mkdir -p /opt/aster-fleet
git clone -b root-ecc-integrate git@github.com:willtanoe/sysagent.git /opt/aster-fleet
cd /opt/aster-fleet
npm ci
cp .env.example .env
chmod 600 .env
npm run build
```

### 2. Jalankan Pengujian Otomatis
```bash
npm test
```
Menjalankan 30 skenario pengujian tanpa ketergantungan jaringan luar:
- **Keamanan & audit**: autentikasi token master & per-node, *approval gate*, pemblokiran perintah destruktif, sanitasi *environment*, redaksi *secret* audit, deteksi manipulasi rantai hash (`/auditcheck`).
- **Eksekusi & fleet**: eksekusi multi-node terisolasi, pembatalan proses (`/stop`), *proactive alert*, `/status all`, `/broadcast`, *embedded Hub node* beserta `fleet-ctl`, *auto-reconnect*.
- **Engine AI**: integrasi binary bundled `@opencode/cli` (`OpenCodeRunner` + pemulihan `reasoning_content`), **ECC (Everything Claude Code)** (`listEccSkills`, `buildEccContextForPrompt`, `provisionOpenCodeEcc`, RPC `__builtin:ecc`), serta injeksi provider Gateway dari `.env`.
- **Bot & UX**: auto-update poller, penguncian Topic (`/topic`), sesi per-user di grup, indikator progres live, dan **batch approval** (deduplikasi multi-node, tombol Setujui/Tolak Semua, memori keputusan).

### 3. Menjalankan Hub & Node
- **Menjalankan Hub**:
  ```bash
  npm run start:hub
  ```
- **Menjalankan Node Agent**:
  ```bash
  NODE_ID=hongyun npm run start:node
  ```

Untuk pemasangan permanen menggunakan `systemd` (termasuk TLS/WSS dan konfigurasi *multi-server*), lihat panduan lengkap di **[docs/deployment.md](docs/deployment.md)**.

> **Catatan Custom Working Directory & Systemd Auto-Update (`/update`)**:
> - Jika Anda menempatkan folder aplikasi di luar `/opt/aster-fleet` (misalnya `/root/services/agentnode` atau `~/services/...`), pastikan Anda menyesuaikan `WorkingDirectory`, `EnvironmentFile`, `ExecStart`, `ReadWritePaths`, dan `ReadOnlyPaths` di `/etc/systemd/system/*.service`:
>   ```ini
>   ReadWritePaths=/var/lib/<service-name> <working-directory>
>   ReadOnlyPaths=-<working-directory>/.env
>   ```
>   *(Jika menggunakan path di bawah `/root` atau `/home`, pastikan `ProtectHome=true` dihapus/dinonaktifkan).*
> - Pastikan branch lokal sudah di-track ke branch remote (contoh: `git branch --set-upstream-to=origin/root-ecc-integrate root-ecc-integrate`).
> - Setiap selesai mengubah file `.service`, jalankan:
>   ```bash
>   systemctl daemon-reload && systemctl restart <service>
>   ```

---

## Daftar Perintah Telegram

| Perintah | Fungsi |
|---|---|
| `/start` | Informasi singkat bot dan perintah dasar |
| `/nodes` | Menampilkan daftar server node yang terhubung beserta status *load*, RAM, *uptime*, dan tombol pilih cepat |
| `/hub [prompt]` | Memilih OpenCode Hub (*embedded node*) sebagai target aktif; dengan `prompt`, menjalankannya sekali di Hub tanpa mengganti pilihan. Agen Hub dapat melihat dan menjalankan perintah di node lain (tetap lewat *approval gate*) |
| `/use <node>` | Memilih server node aktif untuk sesi Anda (contoh: `/use student` atau `/use hub`) |
| `/unuse` | Melepas pilihan server node cabang (otomatis kembali ke OpenCode Hub) |
| `/status [node\|all]` | Dashboard lengkap node aktif, atau ringkasan compact seluruh *fleet* di chat dengan `/status all` |
| `/broadcast <prompt>` | Menjalankan konsultasi AI SRE atau perintah shell (`$ <cmd>`) secara serentak ke seluruh node yang terhubung |
| `/disk` `/mem` `/ps` `/ports` | Diagnosa cepat disk, memori, proses CPU tertinggi, dan port TCP yang *listening* di node aktif |
| `/logs <unit> [baris]` | Menampilkan *tail* log `journalctl` untuk unit `systemd` tertentu (maks 500 baris) |
| `/svc <aksi> <unit>` | Mengelola service `systemd`: `status`, `start`, `stop`, `restart`, `reload`, `enable`, `disable` |
| `/exec <perintah>` | Menjalankan perintah shell langsung di node aktif (atau gunakan awalan `$ <perintah>`) |
| `/chat <prompt>` | Konsultasi & investigasi interaktif bersama AI SRE Agent (atau kirim pesan teks biasa) |
| `/ecc [sub\|workflow]` | Melihat katalog ECC (`status`, `skills`, `agents`, `commands`) atau menjalankan workflow/skill/agent ECC di node aktif |
| `/stop` | Menghentikan tugas yang sedang berjalan dan membunuh seluruh *process tree* shell di node |
| `/update [all\|hub\|<node>\|status]` | Menarik update terbaru dari Git (`git pull` + `npm run build`) dan me-restart Node/Hub secara otomatis |
| `/auditcheck [node]` | Memverifikasi keutuhan rantai hash SHA-256 pada file audit lokal di node |
| `/model [id\|reset]` | Melihat atau mengganti model AI untuk chat ini |
| `/usage` | Menampilkan statistik pemakaian token AI pada chat ini |
| `/reset` | Menghapus riwayat percakapan, sesi OpenCode, dan statistik token untuk node aktif |
| `/topic [here\|off\|menu off]` | Mengunci bot agar hanya aktif di 1 Topic / Thread grup (serta opsi menyembunyikan popup `/` di grup) |
| `/id` | Menampilkan Telegram User ID, Chat ID, dan Topic / Thread ID |
| `/help` | Menampilkan panduan perintah lengkap |

---

## Dokumentasi Lengkap

- **[Arsitektur Sistem](docs/architecture.md)**: Protokol WebSocket Hub-Node, siklus hidup eksekusi, embedded Hub node, indikator progres, auto-update, dan struktur modul.
- **[Panduan Deployment](docs/deployment.md)**: Langkah instalasi di server kantor, konfigurasi TLS/Nginx, manajemen token per-node, dan pemasangan unit `systemd`.
- **[Model Keamanan & Hardening](docs/security.md)**: Pertahanan berlapis, klasifikasi risiko, batch approval & memori keputusan, *tamper-evident* audit, dan hardening `systemd`.
- **[Panduan Operasional (Runbook)](docs/operations.md)**: Penggunaan harian, *proactive alerting*, dukungan multi-distro, dan *troubleshooting*.

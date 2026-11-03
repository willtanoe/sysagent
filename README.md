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
│   Node: srv-kantor-01     │               │   Node: srv-db-02         │
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
2. **Defense-in-Depth & Hardening**:
   - Verifikasi token *constant-time* (`crypto.timingSafeEqual` di atas SHA-256 digest) dengan dukungan token master maupun token unik per-node (`NODE_TOKENS`).
   - Sanitasi *environment* (`sanitizeEnv`) sehingga *child process* shell tidak dapat membocorkan token/kredensial dari variabel *environment*.
   - Eksekusi non-interaktif (`sudo -n` atau `sudo -A` via *askpass* mode `0700`) dan penghentian seluruh *process group* (`-pid` `SIGKILL`) saat *timeout* atau dibatalkan lewat `/stop`.
3. **3-Tier Risk Classifier & Approval Gate**:
   - `allow`: Perintah inspeksi *read-only* langsung dieksekusi.
   - `approve`: Perintah mutasi (`sudo`, `systemctl restart`, `rm`, `chmod`, `apt`/`dnf`, modifikasi firewall, redirection file) wajib disetujui operator via tombol inline Telegram.
   - `block`: Perintah destruktif (`rm -rf /`, `mkfs`, fork bomb) dan pembacaan file rahasia (`.env`, `/etc/shadow`, `.ssh/*`, bocoran `printenv`) langsung ditolak di level node tanpa opsi *override*.
4. **Tamper-Evident Audit Trail**: Setiap eksekusi di node dicatat ke file JSONL lokal (`0600`) dengan redaksi *secret* otomatis dan rantai hash SHA-256 yang dapat diverifikasi kapan saja lewat `/auditcheck`.
5. **Alert Kesehatan Proaktif**: Setiap node memantau penggunaan Disk, Memory, dan unit `systemd` yang gagal, lalu meneruskan notifikasi *alert* dan pemulihan (*recovery*) secara *real-time* ke Telegram admin melalui Hub.

---

## Struktur Repositori

```text
.
├── src/
│   ├── shared/
│   │   ├── protocol.ts      # Kontrak pesan JSON WebSocket antara Hub & Node
│   │   ├── risk.ts          # Classifier risiko (allow / approve / block) & heuristik read-only
│   │   ├── audit.ts         # Hash-chained audit logger + redaksi secret + verifier
│   │   └── format.ts        # Konversi Markdown -> HTML Telegram & safe <pre> chunking
│   ├── hub/
│   │   ├── index.ts         # Entrypoint Hub & concurrent Telegram runner
│   │   ├── server.ts        # WS/WSS server, constant-time auth, registry, run coordinator
│   │   ├── bot.ts           # Handler command Telegram, inline approval, alert forwarder
│   │   └── store.ts         # Persistensi atomik state Hub (mode 0600)
│   └── node/
│       ├── index.ts         # Entrypoint Node Agent
│       ├── client.ts        # Outbound WS/WSS client, heartbeat, reconnect, abort handler
│       ├── engine.ts        # AI tool-calling loop, fallback model, & built-in RPC
│       ├── executor.ts      # Hardened shell spawner, env sanitizer, sudo askpass, rate limit
│       ├── status.ts        # Generator dashboard monospace bergaya netdata
│       ├── alerts.ts        # Monitor proaktif Disk, RAM, & failed systemd units
│       └── distro.ts        # Deteksi distro Linux (/etc/os-release) & package manager
├── deploy/systemd/          # Unit systemd produksi (Hub, Node non-root, root, isolated)
├── docs/                    # Dokumentasi lengkap arsitektur, deploy, keamanan, & operasi
├── tests/
│   └── poc-smoke.js         # 20 skenario pengujian otomatis end-to-end & keamanan
├── .env.example             # Template konfigurasi Hub & Node
└── package.json
```

---

## Mulai Cepat (Quickstart)

### Prasyarat
- Linux dengan `systemd` (Ubuntu/Debian, RHEL/AlmaLinux/Rocky, Arch, Alpine, openSUSE).
- Node.js `>= 20.3.0`.
- Token Bot Telegram dari [@BotFather](https://t.me/BotFather) dan Telegram User ID admin.

### 1. Instalasi & Build
```bash
sudo mkdir -p /opt/aster-fleet
sudo chown "$USER" /opt/aster-fleet
git clone git@github.com:willtanoe/sysagent.git /opt/aster-fleet
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
Menjalankan 20 skenario pengujian tanpa ketergantungan jaringan luar: autentikasi token master & per-node, eksekusi multi-node terisolasi, *approval gate*, pemblokiran perintah destruktif, sanitasi *environment*, redaksi *secret* audit, deteksi manipulasi rantai hash (`/auditcheck`), pembatalan proses (`/stop`), *proactive alert*, dan *auto-reconnect*.

### 3. Menjalankan Hub & Node
- **Menjalankan Hub**:
  ```bash
  npm run start:hub
  ```
- **Menjalankan Node Agent**:
  ```bash
  NODE_ID=srv-kantor-01 npm run start:node
  ```

Untuk pemasangan permanen menggunakan `systemd` (termasuk TLS/WSS dan konfigurasi *multi-server*), lihat panduan lengkap di **[docs/deployment.md](docs/deployment.md)**.

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
| `/reset` | Menghapus riwayat percakapan dan statistik token untuk node aktif |
| `/id` | Menampilkan Telegram User ID dan Chat ID |
| `/help` | Menampilkan panduan perintah lengkap |

---

## Dokumentasi Lengkap

- **[Arsitektur Sistem](docs/architecture.md)**: Protokol WebSocket Hub-Node, siklus hidup eksekusi, manajemen memori AI, dan struktur modul.
- **[Panduan Deployment](docs/deployment.md)**: Langkah instalasi di server kantor, konfigurasi TLS/Nginx, manajemen token per-node, dan pemasangan unit `systemd`.
- **[Model Keamanan & Hardening](docs/security.md)**: Pertahanan berlapis, sanitasi *environment*, penanganan `sudo`, isolasi `systemd`, dan *tamper-evident* audit.
- **[Panduan Operasional (Runbook)](docs/operations.md)**: Penggunaan harian, *proactive alerting*, dukungan multi-distro, dan *troubleshooting*.

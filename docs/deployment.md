# Panduan Deployment Server Kantor (Containerized & Full-Root)

Panduan ini mencakup instalasi produksi untuk **Aster Hub** (server koordinasi pusat) dan **Aster Node Agent** (di setiap server/VPS kantor yang dikelola) pada branch `stg-container`, baik menggunakan **Docker Compose + Host-Bridge `nsenter`** (disarankan agar tidak perlu menginstal Node.js di host VPS) maupun menggunakan **Systemd Full-Root** secara langsung.

---

## 1. Persiapan Awal (Di Hub maupun Node)

Siapkan direktori instalasi `/opt/aster-fleet` langsung sebagai `root`:

```bash
mkdir -p /opt/aster-fleet
git clone -b stg-container git@github.com:willtanoe/sysagent.git /opt/aster-fleet
cd /opt/aster-fleet
cp .env.example .env
chmod 600 .env
```

---

## 2. Deployment Aster Hub (VPS Pusat)

Hub dijalankan di satu VPS/VM koordinasi yang dapat dijangkau oleh seluruh node melalui port TCP `8765` (atau `443` di balik reverse proxy).

### 2.1 Buat Token Autentikasi
Buat token kriptografis acak minimal 32 byte untuk masing-masing node (disarankan) atau satu token master:

```bash
openssl rand -hex 32
```

### 2.2 Konfigurasi `/opt/aster-fleet/.env` di Server Hub
```bash
cp /opt/aster-fleet/.env.example /opt/aster-fleet/.env
chmod 600 /opt/aster-fleet/.env
```

Isi konfigurasi Hub di `.env`:
```env
HUB_HOST=0.0.0.0
HUB_PORT=8765
HUB_TOKEN=token_master_acak_minimal_32_byte

# Opsional (Disarankan): Token spesifik per-node
NODE_TOKENS=hongyun:token_khusus_hongyun,hongchen:token_khusus_hongchen

# Opsional: Aktifkan TLS langsung di Hub (jika tidak memakai Nginx/Caddy di depannya)
TLS_CERT_PATH=/etc/ssl/aster/fullchain.pem
TLS_KEY_PATH=/etc/ssl/aster/privkey.pem

# Konfigurasi Bot Telegram
# CATATAN: Kosongkan TELEGRAM_BOT_TOKEN jika VPS Hub masih menunggu pembukaan akses internet
# agar Hub berjalan dalam mode Headless WSS Coordinator untuk uji konektivitas intranet Node.
TELEGRAM_BOT_TOKEN=123456789:ABCDEF...
BOT_NAME=aster_kantor_bot
ALLOWED_USER_ID=111222333,444555666
# Opsional: Kunci hanya pada grup ops kantor atau DM tertentu
ALLOWED_CHAT_ID=

HUB_STATE_FILE=/var/lib/aster-hub/hub-state.json
NOTIFY_NODE_EVENTS=true
```

### 2.3 Pasang Service Systemd Hub (Full-Root)
```bash
cp /opt/aster-fleet/deploy/systemd/aster-hub.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aster-hub
```

Verifikasi status Hub:
```bash
systemctl status aster-hub
journalctl -u aster-hub -n 30 --no-pager
```

---

## 3. Deployment Aster Node Agent (Di Setiap Server Target)

Setiap server kantor yang ingin dikelola cukup menjalankan service `aster-node`. **Tidak ada port inbound yang perlu dibuka pada firewall server node.**

### 3.1 Konfigurasi `/opt/aster-fleet/.env` di Server Node
```bash
cp /opt/aster-fleet/.env.example /opt/aster-fleet/.env
chmod 600 /opt/aster-fleet/.env
```

Isi konfigurasi Node di `.env`:
```env
NODE_ID=hongyun
HUB_URL=wss://hub.kantor.internal:8765
NODE_TOKEN=token_khusus_hongyun
AUDIT_PATH=/var/lib/aster-node/audit-hongyun.jsonl

# Jika Hub menggunakan sertifikat CA internal kantor:
TLS_CA_PATH=/etc/ssl/certs/kantor-root-ca.crt
TLS_REJECT_UNAUTHORIZED=true

# Mode Engine AI di Node: "opencode" (default, menggunakan binary bundled @opencode/cli) atau "local"
ENGINE=opencode
# Kosongkan OPENCODE_URL agar node otomatis menyalakan daemon bundled @opencode/cli di 127.0.0.1
OPENCODE_URL=
OPENCODE_BIN=
OPENCODE_MODEL=opencode/glm-5.3-flash-free

# Opsional: Kredensial AI Gateway jika menggunakan ENGINE=local
GATEWAY_URL=https://gateway.asteria.im/v1
GATEWAY_API_KEY=sk-...
MODEL_NAME=ag/gemini-3.8-flash
MODEL_FALLBACK=

# Alert Proaktif Node
ALERT_INTERVAL_MS=300000
ALERT_DISK_PCT=90
ALERT_MEM_PCT=92
ALERT_IGNORE_UNITS=
```

> **Catatan Bundled OpenCode Engine (`@opencode/cli`)**:
> Saat `npm ci` dijalankan, paket `@opencode/cli` otomatis mengunduh binary Linux yang sesuai untuk arsitektur server (`linux-x64` / `linux-arm64`) berkat konfigurasi `allowScripts` di `package.json`. Untuk memperbarui versi binary OpenCode di kemudian hari, cukup jalankan `npm run update:opencode`.

### 3.2 Pilih Varian Unit Systemd Node (Full-Root)

Seluruh unit `systemd` di `deploy/systemd/` pada branch `full-root` telah dikonfigurasi untuk berjalan langsung sebagai `root` tanpa membutuhkan user tambahan:

| File Unit | Peruntukan | Karakteristik Hardening |
|---|---|---|
| `aster-node.service` | **Default Full-Root** | Berjalan sebagai `root` di `/opt/aster-fleet` dengan `ReadOnlyPaths=/opt/aster-fleet`, `NoNewPrivileges=yes`, dan `UMask=0077`. |
| `aster-node-isolated.service` | **Server Web / Multi-Tenant (Full-Root)** | Berjalan sebagai `root` di `/agent/aster-fleet` namun menyembunyikan `/home`, `/var/www`, dan `/srv` (`ProtectHome=true`, `InaccessiblePaths`) dari pandangan agent. |
| `aster-node-root.service` | **Alias Identik Full-Root** | Identik dengan `aster-node.service` untuk kompatibilitas penamaan skrip otomasi. |

Contoh pemasangan di server Node (`aster-node.service`):
```bash
cp /opt/aster-fleet/deploy/systemd/aster-node.service /etc/systemd/system/aster-node.service
systemctl daemon-reload
systemctl enable --now aster-node
```

### 3.3 Penanganan Otomatis `sudo` pada Mode Full-Root
Karena proses Node berjalan sebagai `root` (`uid=0`), `NodeExecutor` secara otomatis:
- Melewati pembuatan file `askpass` (`SUDO_PASSWORD` tidak diperlukan).
- Menghapus prefix `sudo` yang redundan (`stripRedundantSudo`, misalnya `sudo systemctl status nginx` $\rightarrow$ `systemctl status nginx`) sehingga perintah tetap berjalan mulus meskipun paket `sudo` tidak terpasang di OS minimal, sembari tetap mempertahankan `sudo -u <user>` jika operator ingin menjalankan perintah sebagai user aplikasi tertentu.

---

## 4. Deployment via Docker & Docker Compose (Tanpa Install Node.js di VPS Target)

Jika Anda tidak ingin memasang Node.js 20 di setiap VPS kantor, Anda dapat menjalankan **Aster Hub** maupun **Aster Node Agent** menggunakan Docker (`Dockerfile` dan `docker-compose.yml` bawaan):

### 4.1 Cara Kerja Jembatan Container-ke-Host (`HOST_NSENTER=auto`)
- **Pada VPS Hub (`--profile hub`)**: Container berjalan secara **terisolasi penuh** (`read_only: true`, `no-new-privileges:true`) karena Hub tidak pernah menjalankan perintah shell ke host.
- **Pada VPS Node Target (`--profile node`)**: Container dijalankan dengan `--pid=host --net=host --ipc=host --uts=host --privileged`.
  - [`NodeExecutor`](file:///home/willtanoe/project/sysadmin-agent/src/node/executor.ts) dan [`ManagedOpenCodeServer`](file:///home/willtanoe/project/sysadmin-agent/src/node/opencode-server.ts) otomatis mendeteksi bahwa proses berada di dalam container (`/.dockerenv`) dengan *mount namespace* yang berbeda dari PID 1 host, lalu membungkus setiap eksekusi shell dengan:
    ```bash
    nsenter -t 1 -m -u -i -n -p -- /bin/bash -c "<perintah>"
    ```
  - Deteksi distro Linux di [`distro.ts`](file:///home/willtanoe/project/sysadmin-agent/src/node/distro.ts) juga membaca `/proc/1/root/etc/os-release` milik VPS asli (bukan OS image container).
  - **Hasilnya**: Runtime Node.js dan binary `@opencode/cli` terbungkus rapi di dalam container, namun seluruh perintah `systemctl`, `journalctl`, `apt`/`dnf`, `df`, `ps`, `ss`, dan modifikasi `/etc` dieksekusi langsung di **OS VPS host asli**!

### 4.2 Menjalankan Hub via Docker Compose (Di VPS Hub)
```bash
git clone -b stg-container git@github.com:willtanoe/sysagent.git /opt/aster-fleet
cd /opt/aster-fleet
cp .env.example .env && chmod 600 .env
# Edit .env (isi HUB_TOKEN, NODE_TOKENS, TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID)

docker compose --profile hub up -d --build
docker logs -f aster-hub
```

### 4.3 Menjalankan Node Agent via Docker Compose (Di Tiap VPS Target: `hongyun`, `hongchen`, dll.)
```bash
git clone -b stg-container git@github.com:willtanoe/sysagent.git /opt/aster-fleet
cd /opt/aster-fleet
cp .env.example .env && chmod 600 .env
# Edit .env (isi NODE_ID=hongyun, HUB_URL, NODE_TOKEN)

docker compose --profile node up -d --build
docker logs -f aster-node-hongyun
```

---

## 5. Prosedur Update Produksi

Untuk memperbarui Hub maupun Node ke rilis terbaru di branch `stg-container`:

### A. Jika Menggunakan Docker Compose
```bash
cd /opt/aster-fleet
git pull origin stg-container

# Di VPS Hub:
docker compose --profile hub up -d --build

# Di VPS Node Target:
docker compose --profile node up -d --build
```

### B. Jika Menggunakan Systemd Langsung di Host
```bash
cd /opt/aster-fleet
git pull origin stg-container
npm ci
npm run build
npm test

# Restart service yang sesuai di mesin tersebut:
systemctl restart aster-hub   # di server Hub
systemctl restart aster-node  # di server Node
```
*(Catatan: karena unit systemd mengaktifkan `ReadOnlyPaths=/opt/aster-fleet`, perintah `git pull` dan `npm run build` dijalankan dari shell root di luar proses service).*

# Panduan Deployment Server Kantor

Panduan ini mencakup instalasi produksi untuk **Aster Hub** (server koordinasi pusat) dan **Aster Node Agent** (di setiap server/VPS kantor yang dikelola).

---

## 1. Persiapan Awal (Di Hub maupun Node)

Pastikan Node.js `>= 20.3` telah terpasang di server. Buat user sistem khusus `aster` dan direktori instalasi `/opt/aster-fleet`:

```bash
sudo useradd -r -m -d /home/aster -s /usr/sbin/nologin aster || true
sudo mkdir -p /opt/aster-fleet
sudo chown "$USER":"$USER" /opt/aster-fleet

git clone git@github.com:willtanoe/sysagent.git /opt/aster-fleet
cd /opt/aster-fleet
npm ci
npm run build
```

---

## 2. Deployment Aster Hub (Server Pusat)

Hub dapat dijalankan di satu VM internal kantor atau VPS gateway yang dapat dijangkau oleh seluruh node melalui port TCP `8765` (atau `443` di balik reverse proxy).

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
TELEGRAM_BOT_TOKEN=123456789:ABCDEF...
BOT_NAME=aster_kantor_bot
ALLOWED_USER_ID=111222333,444555666
# Opsional: Kunci hanya pada grup ops kantor atau DM tertentu
ALLOWED_CHAT_ID=

HUB_STATE_FILE=/var/lib/aster-hub/hub-state.json
NOTIFY_NODE_EVENTS=true
```

### 2.3 Pasang Service Systemd Hub
```bash
sudo chown -R aster:aster /opt/aster-fleet
sudo cp /opt/aster-fleet/deploy/systemd/aster-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aster-hub
```

Verifikasi status Hub:
```bash
sudo systemctl status aster-hub
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

### 3.2 Pilih Varian Unit Systemd Node

Tersedia 3 varian unit `systemd` di `deploy/systemd/` sesuai profil keamanan server:

| File Unit | Peruntukan | Karakteristik Hardening |
|---|---|---|
| `aster-node.service` | **Rekomendasi Umum (Non-Root)** | Berjalan sebagai user `aster`, direktori kode `ReadOnlyPaths=/opt/aster-fleet`, mendukung eskalasi `sudo` terkontrol saat disetujui operator. |
| `aster-node-isolated.service` | **Server Web / Multi-Tenant** | Menyembunyikan `/home`, `/var/www`, dan `/srv` (`ProtectHome=true`, `InaccessiblePaths`) agar agent hanya mengelola level sistem tanpa menyentuh kode aplikasi web. |
| `aster-node-root.service` | **Server Khusus Root** | Berjalan sebagai `root` dengan `ReadOnlyPaths=/opt/aster-fleet` dan `NoNewPrivileges=yes`. Gunakan hanya jika server tidak memiliki user non-root. |

Contoh pemasangan mode Non-Root (`aster-node.service`):
```bash
sudo chown -R aster:aster /opt/aster-fleet
sudo cp /opt/aster-fleet/deploy/systemd/aster-node.service /etc/systemd/system/aster-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now aster-node
```

### 3.3 Konfigurasi Sudo untuk Mode Non-Root (Opsional)
Agar user `aster` dapat menjalankan perintah administrasi sistem setelah Anda menekan tombol **Setujui** di Telegram tanpa menyimpan password di `.env`, tambahkan aturan `sudoers` terbatas di `/etc/sudoers.d/aster`:

```sudoers
aster ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/journalctl, /usr/bin/apt-get, /usr/bin/dnf, /usr/sbin/ufw
```
Atau jika menggunakan `SUDO_PASSWORD` di `.env`, `NodeExecutor` otomatis membuat skrip `askpass` dengan izin `0700` di `~/.config/aster/askpass-<nodeId>.sh`.

---

## 4. Prosedur Update Produksi

Untuk memperbarui Hub maupun Node ke rilis terbaru:

```bash
cd /opt/aster-fleet
sudo -u aster git pull
sudo -u aster npm ci
sudo -u aster npm run build
sudo -u aster npm test

# Restart service yang sesuai di mesin tersebut:
sudo systemctl restart aster-hub   # di server Hub
sudo systemctl restart aster-node  # di server Node
```
*(Catatan: karena unit systemd mengaktifkan `ReadOnlyPaths=/opt/aster-fleet`, perintah `git pull` dan `npm run build` dijalankan dari shell admin di luar proses service).*

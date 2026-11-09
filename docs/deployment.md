# Panduan Deployment Server Kantor (Mode Full-Root)

Panduan ini mencakup instalasi produksi untuk **Aster Hub** (server koordinasi pusat) dan **Aster Node Agent** (di setiap server/VPS kantor yang dikelola) dalam lingkungan **Full-Root** (seluruh server berjalan langsung sebagai `root` tanpa perlu membuat user OS tambahan).

---

## 1. Persiapan Awal (Di Hub maupun Node)

Pastikan Node.js `>= 20.3` telah terpasang di server. Siapkan direktori instalasi `/opt/aster-fleet` langsung sebagai `root`:

```bash
mkdir -p /opt/aster-fleet
git clone -b root-ecc-integrate git@github.com:willtanoe/sysagent.git /opt/aster-fleet
cd /opt/aster-fleet
npm ci
npm run build
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

# Embedded OpenCode Hub (aktif secara default). Hub menjalankan satu node internal sehingga
# proses Hub dapat mengeksekusi perintah setelah approval. Set false untuk Hub murni koordinator.
HUB_EMBED_NODE=true
HUB_NODE_ID=hub
HUB_ENGINE=opencode
```

> **Catatan keamanan**: dengan `HUB_EMBED_NODE=true`, host Hub ikut menjadi target eksekusi (tetap di bawah `assessRisk` dan *approval gate*). Jika Hub tidak perlu dikelola, set `HUB_EMBED_NODE=false`. Port `8765` pada Hub menerima koneksi dari luar; autentikasi hanya berupa token, jadi batasi aksesnya dengan firewall atau TLS.

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
> Saat `npm ci` dijalankan, skrip `postinstall` milik `@opencode/cli` memilih dan memasang binary yang sesuai dengan server (glibc/musl, `x64`/`arm64`, dengan varian *baseline* untuk CPU tanpa AVX2). Karena itu **jangan** memakai `npm ci --ignore-scripts`, dan pastikan server dapat mengakses registry npm saat instalasi. `.npmrc` berisi `omit=optional`; bila binary tidak ditemukan setelah instalasi, jalankan ulang `npm ci` dan periksa pesan error dari `postinstall`. Untuk memperbarui versi binary OpenCode di kemudian hari, jalankan `npm run update:opencode`.

### 3.2 Pilih Varian Unit Systemd Node (Full-Root)

Seluruh unit `systemd` di `deploy/systemd/` telah dikonfigurasi untuk berjalan langsung sebagai `root` tanpa membutuhkan user tambahan, serta mendukung fitur **Auto-Update (`/update`)**:

| File Unit | Peruntukan | Karakteristik Hardening |
|---|---|---|
| `aster-node.service` | **Default Full-Root** | Berjalan sebagai `root` di `/opt/aster-fleet` dengan `ReadWritePaths=/var/lib/aster-node /opt/aster-fleet`, `ReadOnlyPaths=-/opt/aster-fleet/.env`, `NoNewPrivileges=yes`, dan `UMask=0077`. |
| `aster-node-isolated.service` | **Server Web / Multi-Tenant (Full-Root)** | Berjalan sebagai `root` di `/agent/aster-fleet` dengan `ReadWritePaths=/var/lib/aster-node /agent/aster-fleet` dan `ReadOnlyPaths=-/agent/aster-fleet/.env`, serta menyembunyikan `/home`, `/var/www`, dan `/srv` (`ProtectHome=true`, `InaccessiblePaths`) dari pandangan agent. |
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

## 4. Prosedur Update Produksi & Auto-Update (`/update`)

### 4.1 Otomatis via Git Poller atau Perintah `/update` di Telegram
Secara bawaan (`AUTO_UPDATE=true`), Hub dan seluruh Node otomatis mengecek commit baru di branch remote setiap 2 menit (`AUTO_UPDATE_INTERVAL_MS=120000`), atau dapat dipicu kapan saja lewat Telegram:
- `/update` atau `/update all`: menarik commit terbaru (`git pull --ff-only`), menjalankan `npm run build`, dan me-restart seluruh Node serta Hub.
- `/update <node>`: update & restart satu node tertentu.
- `/update hub`: update & restart Hub saja.
- `/update status`: mengecek branch & commit yang sedang berjalan di Hub dan seluruh Node.

### 4.2 Penyesuaian `WorkingDirectory` Kustom pada Systemd
Agar `git fetch`, `git pull`, dan `npm run build` tidak gagal karena error `Read-only file system`, pastikan unit `systemd` di `/etc/systemd/system/*.service` menempatkan working directory aplikasi di `ReadWritePaths` dan hanya mengunci file `.env` di `ReadOnlyPaths`:

```ini
ReadWritePaths=/var/lib/<service-name> <working-directory>
ReadOnlyPaths=-<working-directory>/.env
```

- **Jika Anda menggunakan lokasi direktori kustom** (misalnya `/root/services/agentnode` atau `~/services/...`):
  1. Sesuaikan `WorkingDirectory`, `EnvironmentFile`, `ExecStart`, `ReadWritePaths`, dan `ReadOnlyPaths` di `/etc/systemd/system/<service>.service`.
  2. Jika direktori berada di dalam `/root` atau `/home`, pastikan `ProtectHome=true` **tidak** diaktifkan (hapus atau ubah menjadi `ProtectHome=false`), karena `ProtectHome=true` membuat `/root` dan `/home` tidak dapat diakses oleh proses `systemd`.
  3. Pastikan direktori tersebut adalah git repository yang melacak (*tracking*) branch remote yang sesuai (contoh: `root-ecc-integrate`):
     ```bash
     cd <working-directory>
     git checkout root-ecc-integrate
     git branch --set-upstream-to=origin/root-ecc-integrate root-ecc-integrate
     ```
  4. Terapkan perubahan konfigurasi unit `systemd`:
     ```bash
     systemctl daemon-reload && systemctl restart <service>
     ```

### 4.3 Update Manual dari Terminal
Jika Anda ingin memperbarui secara manual dari shell server:

```bash
cd /opt/aster-fleet
git pull
npm ci
npm run build
npm test

# Restart service yang sesuai di mesin tersebut:
systemctl daemon-reload
systemctl restart aster-hub   # di server Hub
systemctl restart aster-node  # di server Node
```

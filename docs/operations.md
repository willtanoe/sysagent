# Panduan Operasional (SRE Runbook)

Dokumen ini merupakan panduan operasional harian bagi tim Sysadmin / SRE dalam menggunakan **Aster Fleet Manager** melalui Telegram.

---

## 1. Manajemen Fleet & Pemilihan Node

- **Melihat Daftar Server Online**:
  Kirim `/nodes` untuk melihat seluruh server yang sedang terhubung ke Hub beserta informasi hostname, distro OS, *load average*, sisa RAM, dan *uptime*. Anda dapat menekan tombol nama node di bawah pesan untuk langsung memilihnya.
- **Memilih Node Aktif**:
  Kirim `/use <nodeId>` (misal `/use hongyun`). Pilihan ini disimpan secara persisten untuk ruang chat Anda hingga Anda menggantinya atau mengirim `/unuse`.
- **Dashboard Kesehatan (`/status`)**:
  - `/status`: Menampilkan dashboard monospace bergaya netdata untuk node yang sedang aktif (mencakup *progress bar* RAM & Disk, trafik jaringan RX/TX, jumlah proses & port TCP, daftar service `systemd`, `pm2`, serta proses dengan CPU tertinggi).
  - `/status <nodeId>`: Menampilkan dashboard detail untuk node tertentu tanpa harus mengubah node aktif.
  - `/status all`: Menampilkan tabel ringkas kondisi seluruh server yang sedang terhubung ke Hub.

---

## 2. Diagnosa Cepat & Manajemen Service

Seluruh perintah berikut dijalankan pada node yang sedang aktif di chat Anda:

| Perintah | Deskripsi |
|---|---|
| `/disk` | Menampilkan kapasitas dan persentase pemakaian *filesystem* (`df -h -x tmpfs -x devtmpfs`) |
| `/mem` | Menampilkan pemakaian RAM dan Swap (`free -h`) |
| `/ps` | Menampilkan 12 proses dengan pemakaian CPU tertinggi |
| `/ports` | Menampilkan daftar port TCP yang sedang *listening* beserta prosesnya (`ss -ltnp`) |
| `/logs <unit> [baris]` | Menampilkan *tail* log `journalctl` untuk unit `systemd` (contoh: `/logs nginx 100`, batas maks 500 baris) |
| `/svc <aksi> <unit>` | Mengelola unit `systemd`. Aksi `status` langsung berjalan; aksi mutasi (`start`, `stop`, `restart`, `reload`, `enable`, `disable`) akan memunculkan tombol persetujuan |

---

## 3. Eksekusi Shell Langsung vs Konsultasi AI SRE

1. **Shell Langsung (`$ <perintah>` atau `/exec <perintah>`)**:
   Gunakan awalan `$ ` (contoh: `$ uptime` atau `$ systemctl restart redis`) ketika Anda sudah tahu persis perintah yang ingin dijalankan tanpa melalui penalaran LLM. Perintah tetap melewati *Risk Classifier* dan *Approval Gate*.
2. **Konsultasi & Investigasi AI (`/chat <prompt>` atau teks biasa)**:
   Gunakan untuk investigasi bertahap (contoh: *"Cek kenapa penggunaan disk di /var penuh dan bersihkan log journal yang lebih tua dari 7 hari"*). Baik dalam mode default `ENGINE=opencode` (bundled `@opencode/cli`) maupun `ENGINE=local`, agen AI otomatis memuat skill **ECC (Everything Claude Code)** yang relevan melalui *Trigger-Table Lazy Loading* (`src/node/ecc.ts`), menjalankan perintah inspeksi *read-only* secara mandiri, dan meminta persetujuan tombol inline sebelum menjalankan perintah pembersihan/perubahan.
3. **Katalog & Workflow ECC (`/ecc`)**:
   - `/ecc` atau `/ecc status`: Menampilkan status integrasi ECC di node aktif beserta ringkasan *skills*, *agents*, dan *commands*.
   - `/ecc skills`: Menampilkan daftar 31 skill SRE, jaringan, database, kontainer, dan keamanan dari ECC.
   - `/ecc agents`: Menampilkan daftar 27 agen spesialis ECC (`security-reviewer`, `network-config-reviewer`, `database-reviewer`, `architect`, `planner`, dll.).
   - `/ecc commands`: Menampilkan daftar 36 workflow command ECC (`/verify`, `/plan`, `/security`, `/security-scan`, `/code-review`, `/pm2`, dll.).
   - `/ecc <nama_skill_atau_agent_atau_command> <instruksi>`: Menjalankan tugas di node aktif menggunakan template command, agen spesialis, atau skill ECC tersebut (contoh: `/ecc network-interface-health cek error CRC di eth0`, `/ecc production-audit evaluasi kesiapan server ini`, atau `/ecc verify`).
4. **Mengganti Model AI (`/model`)**:
   - Kirim `/model` tanpa argumen untuk melihat model aktif saat ini beserta daftar model gratis yang tersedia dari engine OpenCode di node aktif (misal `opencode/glm-5.3-flash-free`, `opencode/minimax-m2.5-free`, dll.).
   - Kirim `/model <provider/model>` untuk mengganti model pada sesi chat ini (otomatis membuat sesi OpenCode baru agar terhindar dari konflik riwayat `reasoning_content`).
   - Kirim `/model reset` untuk kembali ke model default node.
4. **Mereset Sesi & Riwayat (`/reset`)**:
   Kirim `/reset` untuk menghapus riwayat percakapan dan statistik token pada node aktif di Hub sekaligus mereset sesi aktif OpenCode (`__builtin:reset`) di node tersebut.
5. **Menghentikan Tugas (`/stop`)**:
   Jika suatu perintah atau sesi AI berjalan terlalu lama, kirim `/stop`. Hub akan mengirim sinyal `hub_cancel` ke node untuk membatalkan sesi OpenCode / loop AI dan membunuh seluruh *process group* shell (`SIGKILL`).

---

## 4. Alert Proaktif Kesehatan Server

Setiap node menjalankan `NodeAlertMonitor` di latar belakang setiap `ALERT_INTERVAL_MS` (default 5 menit) untuk memeriksa:
- **Pemakaian Disk `/` (`ALERT_DISK_PCT`, default 90%)**
- **Pemakaian Memory (`ALERT_MEM_PCT`, default 92%)**
- **Unit `systemd` berstatus `failed`**

**Aturan Pengiriman Alert**:
- **Anti-Spam (Bucket & Deduplikasi)**: Alert disk/RAM hanya dikirim ulang jika pemakaian naik ke kelipatan *bucket* 5% berikutnya (misal dari 90% ke 95%). Alert service gagal hanya dikirim jika ada unit gagal **baru** yang belum dilaporkan sebelumnya.
- **Notifikasi Pemulihan (Recovery)**: Ketika pemakaian disk/RAM turun minimal 3% di bawah ambang batas, atau seluruh unit `systemd` kembali normal, node otomatis mengirim satu notifikasi `✅ ... pulih`.
- **Abaikan Unit Tertentu**: Jika ada service lama yang sengaja dimatikan namun berstatus *failed*, bersihkan dengan `systemctl reset-failed <unit>` atau tambahkan namanya ke `ALERT_IGNORE_UNITS` di `.env` node.

---

## 5. Verifikasi Audit (`/auditcheck`)

Untuk memastikan file log audit lokal di suatu node tidak pernah dimodifikasi atau dihapus secara manual:
```text
/auditcheck
```
atau untuk node tertentu:
```text
/auditcheck hongyun
```
Node akan menghitung ulang rantai hash SHA-256 dari entri pertama (`GENESIS`) hingga entri terakhir dan melaporkan jumlah baris yang terverifikasi utuh (atau nomor baris pertama yang rusak bila terjadi manipulasi).

---

## 6. Troubleshooting Umum

| Gejala | Penyebab | Solusi |
|---|---|---|
| Node tidak muncul di `/nodes` | `HUB_URL` salah, port firewall Hub tertutup, atau token tidak cocok | Cek `journalctl -u aster-node -n 50` di server node; pastikan `NODE_TOKEN` / `HUB_TOKEN` sesuai dengan konfigurasi Hub |
| Perintah `sudo` langsung gagal dengan pesan *password is required* | Node berjalan non-root tanpa `SUDO_PASSWORD` dan belum diatur `NOPASSWD` di sudoers | Tambahkan aturan `NOPASSWD` di `/etc/sudoers.d/aster` (disarankan) atau isi `SUDO_PASSWORD` di `.env` node |
| Tombol *Setujui* tidak merespons | User yang menekan tidak ada di `ALLOWED_USER_ID` atau *approval* sudah kedaluwarsa | Cek `/id` dan pastikan ID Anda terdaftar di `ALLOWED_USER_ID` pada `.env` Hub |
| Error `409 Conflict` di log Hub | Ada dua proses Hub yang menjalankan `TELEGRAM_BOT_TOKEN` yang sama | Hentikan salah satu proses Hub yang duplikat |
| `/auditcheck` melaporkan rantai rusak | File `.jsonl` diedit manual atau ditimpa | Arsipkan/rotasi file audit lama agar node memulai rantai `GENESIS` baru, lalu periksa akses ke server tersebut |

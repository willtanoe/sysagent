# Model Keamanan & Hardening

Aster Fleet Manager dirancang dengan prinsip **Defense-in-Depth** untuk lingkungan server kantor dan produksi.

---

## 1. Lapisan Pertahanan Utama

1. **Arsitektur Zero Inbound Port di Node**:
   - Server target (Node) tidak membuka port *listening* apa pun. Seluruh komunikasi diinisiasi dari dalam Node menuju Hub melalui WebSocket (`ws://` / `wss://`).
2. **Autentikasi Kriptografis Constant-Time**:
   - Saat *handshake* `node_hello`, Hub memverifikasi token menggunakan `crypto.timingSafeEqual` di atas *digest* SHA-256 (`verifySecretToken` di `src/hub/server.ts`), sehingga tahan terhadap *timing side-channel attack*.
   - Mendukung isolasi kredensial per server melalui `NODE_TOKENS` (`nodeA:tokA,nodeB:tokB`). Jika satu node dicurigai kompromi, cukup cabut token node tersebut tanpa mengganggu node lain.
   - Koneksi TCP/WebSocket yang tidak menyelesaikan autentikasi dalam 5 detik (`authTimeoutMs`) langsung diputus untuk mencegah *connection exhaustion*.
3. **Otorisasi Operator Berlapis di Telegram**:
   - Hanya pengguna dengan Telegram User ID yang terdaftar di `ALLOWED_USER_ID` yang dapat berinteraksi dengan bot atau menekan tombol *approval*.
   - `ALLOWED_CHAT_ID` memungkinkan penguncian operasional bot hanya pada ruang obrolan tertentu (misalnya DM pribadi atau grup *engineering* internal).
4. **Sanitasi Environment Child Process (`sanitizeEnv`)**:
   - Sebelum mengeksekusi perintah shell di node, `NodeExecutor` menghapus seluruh variabel *environment* yang mengandung pola sensitif (`TOKEN`, `PASSWORD`, `PASSWD`, `SECRET`, `API`, `KEY`, `PRIVATE`, `CREDENTIAL`, `AUTH`, `JWT`, `DSN`, `DATABASE_URL`, `ASKPASS`).
   - Perintah seperti `echo $HUB_TOKEN` atau `echo $GATEWAY_API_KEY` di dalam shell anak selalu menghasilkan string kosong.
5. **Isolasi Process Group & Penghentian Paksa (`killTree`)**:
   - Setiap perintah dijalankan di dalam *process group* terpisah (`detached: true`, `stdio: ["ignore", "pipe", "pipe"]`).
   - Saat *timeout* tercapai atau operator mengirim `/stop`, sinyal `SIGKILL` dikirimkan ke seluruh *process group* (`process.kill(-child.pid, "SIGKILL")`), memastikan tidak ada proses anak (*orphan/zombie*) yang tertinggal.

---

## 2. Klasifikasi Risiko 3 Tingkat (`src/shared/risk.ts`)

Setiap perintah shell—baik yang diketik langsung oleh operator maupun yang diajukan oleh AI tool-calling—wajib melewati `assessRisk(command)` di node sebelum dieksekusi:

### A. Kategori `block` (Ditolak Keras Tanpa Opsi Override)
- Penghapusan filesystem root (`rm -rf /` dan variasinya).
- Penulisan mentah atau pemformatan *block device* (`dd of=/dev/sd*`, `mkfs.*`, redirect `> /dev/nvme*`).
- *Fork bomb* (`:(){ :|:& };:`).
- Pembacaan atau akses ke file rahasia/kredensial (`isSecretAccess`): `.env`, `/etc/shadow`, `/etc/gshadow`, `/etc/sudoers`, kunci privat SSH (`id_rsa`, `id_ed25519`, `.ssh/`), `.aws/credentials`, `.git-credentials`, `.netrc`, `.pgpass`, `.my.cnf`, `wp-config.php`, `/proc/*/environ`, serta skrip internal `.config/aster` / `askpass`.
- Kebocoran *environment* (`printenv`, `compgen`, `env`, `set`, `declare`, `export` tanpa argumen).
- Penyuntikan password via *stdin* (`sudo -S`, `echo ... | sudo`).
- Penghapusan jejak histori (`history -c`, `unset HISTFILE`, `rm .bash_history`).

### B. Kategori `approve` (Wajib Konfirmasi Tombol Inline Telegram)
- Eskalasi *privilege* (`sudo`, `doas`).
- Penghapusan, pemindahan, penyalinan, atau pengubahan atribut file (`rm`, `mv`, `cp`, `install`, `ln`, `shred`, `truncate`, `chmod`, `chown`, `chattr`, `find -delete`, `sed -i`, `perl -i`, `tee`, serta segala bentuk *file redirection* `>` / `>>`).
- Manajemen layanan & daya (`systemctl start|stop|restart|reload|enable|disable|mask`, `service`, `reboot`, `shutdown`, `kill`, `pkill`, `killall`).
- Manajemen paket & kode pihak ketiga (`apt`, `dpkg`, `dnf`, `yum`, `rpm`, `pacman`, `apk`, `zypper`, `npm install`, `pip install`, `cargo`, `go get`).
- Konfigurasi jaringan, firewall, & kernel (`iptables`, `nft`, `ufw`, `firewall-cmd`, `nmcli`, `sysctl -w`, `modprobe`, `insmod`, `mount`, `umount`, `fdisk`, `parted`).
- Eksekusi dinamis & skrip (`eval`, `$(...)`, backtick, `bash -c`, `python -c`, `node -e`, eksekusi skrip dari `/tmp` atau `/dev/shm`, *pipe-to-shell* `| sh`).
- Transfer jaringan keluar/masuk (`curl -d/-F/-T/-o/-O`, `wget`, `scp`, `rsync`, `sftp`, `nc`, `socat`).

### C. Kategori `allow` (Eksekusi Langsung)
- Perintah observasi dan diagnosa *read-only* yang tidak memodifikasi state sistem (`uptime`, `uname`, `df`, `free`, `ps`, `ss`, `systemctl status`, `journalctl`, `cat` file non-rahasia, `grep`, `awk`, dll.).

---

## 3. Tamper-Evident Audit Trail (`src/shared/audit.ts`)

Setiap perintah yang masuk ke `NodeExecutor` dicatat ke file JSONL lokal dengan izin `0600`:
- **Redaksi Otomatis (`redactSecrets`)**: Pola password, token, argumen `--password`, dan header `Bearer` disensor menjadi `[REDACTED]` sebelum ditulis ke disk.
- **Hash Chaining SHA-256**: Setiap baris menyimpan `prevHash` (hash baris sebelumnya, dimulai dari `"GENESIS"`) dan `hash` SHA-256 atas seluruh kolom baris tersebut.
- **Verifikasi Integritas (`/auditcheck`)**: Jika seseorang memodifikasi atau menghapus satu baris pun di dalam file audit, verifikasi rantai hash akan langsung mendeteksi nomor baris yang rusak.

---

## 4. Hardening Systemd (`deploy/systemd/`)

- **Pada Hub (`aster-hub.service`)**: Karena Hub tidak pernah menjalankan shell lokal, unit systemd Hub mengaktifkan isolasi penuh: `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `PrivateDevices=true`, `ProtectKernelTunables=true`, `NoNewPrivileges=yes`, dan `ReadOnlyPaths=/opt/aster-fleet`.
- **Pada Node (`aster-node*.service`)**: Mengaktifkan `ReadOnlyPaths` pada direktori instalasi agen sehingga agen (bahkan jika berjalan sebagai `root`) tidak dapat memodifikasi kode atau konfigurasi `.env` miliknya sendiri, ditambah `UMask=0077`, `StateDirectoryMode=0700`, `RestrictRealtime=yes`, `LockPersonality=yes`, `SystemCallArchitectures=native`, serta batas sumber daya `TasksMax=4096` dan `MemoryMax=2G`.

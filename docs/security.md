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
3. **Otorisasi Operator Berlapis & Isolasi Approval di Telegram**:
   - Hanya pengguna dengan Telegram User ID yang terdaftar di `ALLOWED_USER_ID` yang dapat berinteraksi dengan bot atau menekan tombol *approval*.
   - `ALLOWED_CHAT_ID` memungkinkan penguncian operasional bot hanya pada ruang obrolan tertentu (misalnya DM pribadi atau grup *engineering* internal).
   - Setiap permintaan *approval* dipetakan di memori `HubServer` terhadap `(nodeId, runId, chatId)` dan hanya dapat diputuskan melalui tombol batch `apb:<batchId>:yes|no` milik `ApprovalBatcher`, divalidasi agar *chat* lain tidak dapat menyetujui *approval* milik *chat* berbeda.
   - Jika koneksi node terputus di tengah eksekusi, seluruh *run* dan *pending approval* untuk node tersebut otomatis dibatalkan dan dibersihkan.
   - **Throttle Auth Failure**: handshake dengan `nodeId`/token salah dibatasi per pasangan (IP sumber, `nodeId`) — melewati ambang (default 10, `HUB_AUTH_BAN_THRESHOLD`) memicu penolakan sementara (default 60 detik, `HUB_AUTH_BAN_MS`) yang direset otomatis. Kunci per-pasangan menjaga node legitimate di belakang NAT yang sama tidak ikut terdampak, dan koneksi yang sudah ter-autentikasi tidak pernah diputus oleh ban.
   - **Idle-Run Watchdog**: run yang tidak mengirim aktivitas apa pun (chunk, permintaan approval) selama `HUB_RUN_IDLE_TIMEOUT_MS` (default 15 menit, `0` = nonaktif) diakhiri paksa oleh Hub dengan error — node tetap menerima `hub_cancel` agar process tree-nya ikut dihentikan. Ambang sengaja lebih besar dari timeout node terpanjang agar run panjang yang legitimate tidak terpotong.
   - Permintaan *approval* untuk perintah identik dari beberapa node digabung oleh `ApprovalBatcher` (`src/hub/approval.ts`). Lihat bagian 3 untuk batasan keamanannya.
4. **Sanitasi Environment Child Process (`sanitizeEnv`)**:
   - Sebelum mengeksekusi perintah shell di node, `NodeExecutor` menghapus seluruh variabel *environment* yang mengandung pola sensitif (`TOKEN`, `PASSWORD`, `PASSWD`, `SECRET`, `API`, `KEY`, `PRIVATE`, `CREDENTIAL`, `AUTH`, `JWT`, `DSN`, `DATABASE_URL`, `ASKPASS`, `COOKIE`).
   - Perintah seperti `echo $HUB_TOKEN` atau `echo $GATEWAY_API_KEY` di dalam shell anak selalu menghasilkan string kosong.
5. **Isolasi Process Group & Penghentian Paksa (`killTree`)**:
   - Setiap perintah dijalankan di dalam *process group* terpisah (`detached: true`, `stdio: ["ignore", "pipe", "pipe"]`).
   - Saat *timeout* tercapai atau operator mengirim `/stop`, sinyal `SIGKILL` dikirimkan ke seluruh *process group* (`process.kill(-child.pid, "SIGKILL")`), memastikan tidak ada proses anak (*orphan/zombie*) yang tertinggal.
6. **Hardening Permission Bridge pada Engine OpenCode (`src/node/opencode.ts` & `src/node/engine.ts`)**:
   - Setiap sesi OpenCode dibuat dengan `RULESET` ketat: `shell: ask`, `edit: ask`, `write: ask`, `read: ask`, `subagent: deny`, dan `question: deny`.
   - Menonaktifkan `subagent` memastikan agen tidak dapat mendelegasikan eksekusi ke sub-agen internal yang memiliki izin `shell: allow`, dan mengaktifkan `read: ask` memastikan pembacaan file langsung oleh OpenCode tetap melewati pemeriksaan `isSecretAccess` di `assessRisk`.

---

## 2. Klasifikasi Risiko 3 Tingkat (`src/shared/risk.ts`)

Setiap perintah shell maupun permintaan akses sumber daya—baik yang diketik langsung oleh operator maupun yang diajukan oleh AI tool-calling—wajib melewati `assessRisk(command)` di node sebelum dieksekusi:

### A. Kategori `block` (Ditolak Keras Tanpa Opsi Override)
- Penghapusan filesystem root (`rm -rf /` dan variasinya).
- Penulisan mentah atau pemformatan *block device* (`dd of=/dev/sd*`, `mkfs.*`, redirect `> /dev/nvme*`).
- *Fork bomb* (`:(){ :|:& };:`).
- Pembacaan atau akses ke file rahasia/kredensial (`isSecretAccess` dengan normalisasi anti-*obfuscation* terhadap tanda kutip, *backslash* `\`, kurung kurawal `{}`, dan *glob*): `.env`, `/etc/shadow` (`/etc/shad*`), `/etc/gshadow`, `/etc/sudoers`, kunci privat SSH (`id_rsa`, `id_ed25519`, `.ssh/`), kunci privat TLS/VPN/Kubernetes/Docker level `root` (`/etc/ssl/private`, `/etc/letsencrypt/live`, `privkey*.pem`, `/etc/wireguard`, `/etc/openvpn`, `/etc/ipsec.secrets`, `/etc/ppp/*secrets`, `.kube/config`, `/etc/kubernetes/*.conf`, `/etc/rancher/k3s/k3s.yaml`, `.docker/config.json`), `.aws/credentials`, `.git-credentials`, `.netrc`, `.pgpass`, `.my.cnf`, `wp-config.php`, `hub-state.json`, `/proc/*/environ`, serta skrip internal `.config/aster` / `askpass`.
- Kebocoran *environment* (`printenv`, `compgen`, `env`, `set`, `declare`, `export` tanpa argumen).
- Penyuntikan password via *stdin* (`sudo -S`, `echo ... | sudo`).
- Penghapusan jejak histori (`history -c`, `unset HISTFILE`, `rm .bash_history`).

### B. Kategori `approve` (Wajib Konfirmasi Tombol Inline Telegram)
- Eskalasi *privilege* (`sudo`, `doas`; pada mode `root`, prefix `sudo` redundan tanpa `-u`/`-g` otomatis di-*strip* oleh `stripRedundantSudo` sehingga perintah *read-only* tidak terblokir oleh ketiadaan paket `sudo`).
- Penghapusan, pembuatan, pemindahan, penyalinan, arsip, atau pengubahan atribut file (`rm`, `rmdir`, `mkdir`, `touch`, `mktemp`, `mv`, `cp`, `install`, `ln`, `shred`, `truncate`, `fallocate`, `chmod`, `chown`, `chattr`, `setfacl`, `setfattr`, `tar`, `zip`, `unzip`, `gzip`, `gunzip`, `bzip2`, `xz`, `patch`, `find -delete/-exec/-execdir/-ok`, `sed -i`, `sed '.../e'`, `sed 'w file'`, `awk '{print > "file"}'`, `perl -i`, `tee`, serta segala bentuk *file redirection* `>` / `>>`).
- Manajemen layanan & daya (`systemctl start|stop|restart|reload|enable|disable|mask`, `service`, `reboot`, `shutdown`, `kill`, `pkill`, `killall`).
- Manajemen paket & kode pihak ketiga (`apt`, `dpkg`, `dnf`, `yum`, `rpm`, `pacman`, `apk`, `zypper`, `npm install`, `pip install`, `cargo`, `go get`).
- Konfigurasi jaringan, firewall, & kernel (`iptables`, `nft`, `ufw`, `firewall-cmd`, `nmcli`, `sysctl -w`, `modprobe`, `insmod`, `mount`, `umount`, `fdisk`, `parted`).
- Eksekusi dinamis & skrip (`eval`, `$(...)`, backtick, `bash -c`, `python -c`, `node -e`, eksekusi skrip dari `/tmp` atau `/dev/shm`, *pipe-to-shell* `| sh`).
- Transfer jaringan keluar/masuk (`curl -d/-F/-T/-o/-O`, `wget`, `scp`, `rsync`, `sftp`, `nc`, `socat`).
- **Default-Approve Catch-All (`!isReadOnlyCommand`)**: Segala perintah atau *binary* kustom yang tidak terdaftar secara eksplisit di dalam *allowlist* `isReadOnlyCommand` otomatis diklasifikasikan sebagai `approve`.

### C. Kategori `allow` (Eksekusi Langsung via Strict Read-Only Allowlist)
- Hanya perintah observasi dan diagnosa *read-only* yang terverifikasi oleh `isReadOnlyCommand` dan bebas dari operator mutasi/redireksi (`uptime`, `uname`, `hostname`, `df`, `free`, `ps`, `ss`, `ip`, `systemctl status`, `journalctl`, `cat` file non-rahasia, `grep`, `awk`, `sed` tanpa `-i`, `find` tanpa `-delete/-exec`, dll.).

---

## 3. Batch Approval & Auto-Approval Memory (`src/hub/approval.ts`)

Saat beberapa node meminta persetujuan untuk perintah yang sama (misalnya dari `/broadcast`), Hub tidak mengirim satu pesan per node. `ApprovalBatcher` menggabungkannya menjadi satu pesan Telegram.

- **Kunci batch**: `chatId` + `userId` peminta + teks perintah yang dinormalisasi (`trim` dan penyeragaman `\r\n`). Perintah yang berbeda satu karakter pun tidak digabung.
- **Debounce**: permintaan yang tiba dalam 350 ms bergabung ke pesan yang sama. Daftar node pada pesan diperbarui langsung saat node baru bergabung.
- **Tombol**: `✅ Setujui` / `❌ Tolak` untuk 1 node, atau `✅ Setujui Semua (N Node)` / `❌ Tolak Semua (N Node)` untuk beberapa node. Format `callback_data` adalah `apb:<batchId>:yes|no` (satu-satunya format yang didukung; format warisan telah dihapus).
- **Otorisasi**: hanya `userId` yang menjalankan perintah yang boleh menekan tombol. Pengguna lain mendapat peringatan dan batch tetap menunggu.
- **Expiry Approval**: permintaan approval memiliki usia maksimal `APPROVAL_TIMEOUT_MS` (default 300 detik, selaras dengan timeout di sisi node). Setelah usia itu terlampaui, keputusan tidak dapat lagi dikirim ke node (`sendApproval` menolak), dan entri yang kedaluwarsa dibersihkan Hub setiap 30 detik. Tombol pada pesan lama otomatis mati secara elegan dengan toast "kedaluwarsa".
- **Auto-Approval Memory**: setelah operator memutuskan, keputusan itu disimpan di memori Hub selama **5 menit** (`cacheTtlMs`) dengan kunci yang sama dengan kunci batch. Permintaan identik dari node yang terlambat atau berurutan dalam jendela itu langsung diselesaikan dengan keputusan yang sama, tanpa pesan baru.

Hal yang perlu diperhatikan:
- Cache menyimpan **persetujuan maupun penolakan**.
- Cache hanya hidup di memori proses Hub. Cache tidak ditulis ke disk dan hilang saat Hub di-restart.
- Cache terikat pada `chatId` dan `userId`, sehingga keputusan satu operator tidak berlaku untuk operator atau chat lain.
- Cache hanya mempercepat keputusan atas permintaan yang **sudah lolos** `assessRisk`. Perintah `block` ditolak di node dan tidak pernah sampai ke tahap *approval*.
- Entri cache kedaluwarsa dan batch yang lebih dari 30 menit dibersihkan setiap 60 detik.

---

## 4. Tamper-Evident Audit Trail (`src/shared/audit.ts`)

Setiap perintah yang masuk ke `NodeExecutor` dicatat ke file JSONL lokal dengan izin `0600`:
- **Redaksi Otomatis (`redactSecrets`)**: Pola password, token, argumen `--password`, dan header `Bearer` disensor menjadi `[REDACTED]` sebelum ditulis ke disk.
- **Hash Chaining SHA-256**: Setiap baris menyimpan `prevHash` (hash baris sebelumnya, dimulai dari `"GENESIS"`) dan `hash` SHA-256 atas seluruh kolom baris tersebut.
- **Verifikasi Integritas (`/auditcheck`)**: Jika seseorang memodifikasi atau menghapus satu baris pun di dalam file audit, verifikasi rantai hash akan langsung mendeteksi nomor baris yang rusak.
- **Arsip Audit Off-Node di Hub**: Setiap entri audit yang berhasil ditulis di node otomatis di-*forward* ke Hub melalui pesan WebSocket `node_audit`. Hub memverifikasi bentuk entri, kecocokan `nodeId` dengan koneksi pengirim, dan hash SHA-256 per entri (kalkulasi ulang), lalu menyimpan salinannya apa adanya (rantai hash milik node tetap utuh) ke `<direktori HUB_STATE_FILE>/audit-central/central-<nodeId>.jsonl` (`0600`). Jika file audit node dihapus, di-reset, atau regenerasi dari nol, rantai salinan terpusat akan terputus dan Hub mengirim alert real-time ke Telegram admin (`audit-gap`); entri dengan hash yang dimanipulasi atau `nodeId` yang tidak cocok ditolak dengan alert `audit-invalid` (cooldown 60 detik per jenis). Dengan salinan ini, penghapusan total file audit di node tidak lagi lolos tanpa jejak — karena bukti rantainya tersimpan di host Hub.
- **Jalur Internal Terpisah**: Perintah internal node (dashboard status, alert disk/memori, probe service) tidak melewati *approval* operator, tetapi dijalankan lewat `execInternal` yang menolak semua verdict `block` dan mencatat setiap perintah non-read-only dengan `risk: "internal"`. Eksekusi shell mentah (`exec`) kini `private`, sehingga modul lain tidak bisa lagi memanggil jalur tanpa gate secara tidak sengaja.
- **Batasan**: arsip terpusat hidup di host Hub; jika node **dan** Hub dikompromikan bersamaan oleh root yang sama, salinan tidak memberikan perlindungan tambahan. Entri yang dihasilkan saat node terputus dari Hub tidak mungkin ada (perintah hanya berasal dari Hub), sehingga setiap gap rantai pada arsip selalu merupakan sinyal anomali, bukan artefak koneksi.

---

## 5. Hardening Systemd (`deploy/systemd/`)

Seluruh unit berjalan sebagai `root` (mode Full-Root), sehingga hardening difokuskan pada pembatasan privilege tambahan, izin file, dan sumber daya.

- **Pada Hub (`aster-hub.service`)**: Hub menjalankan *embedded node* OpenCode secara default (`HUB_EMBED_NODE=true`), sehingga proses Hub **dapat mengeksekusi perintah shell** setelah melewati `assessRisk` dan *approval gate* yang sama seperti node biasa. Unit mengaktifkan `NoNewPrivileges=yes`, `UMask=0077`, `StateDirectory=aster-hub` dengan `StateDirectoryMode=0700`, `ProtectSystem=strict`, `PrivateTmp=yes`, `PrivateDevices=yes`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `RestrictRealtime=yes`, `LockPersonality=yes`, `SystemCallArchitectures=native`, `RemoveIPC=yes`, serta batas `TasksMax=4096` dan `MemoryMax=2G`. Penulisan diizinkan ke `ReadWritePaths=/var/lib/aster-hub /opt/aster-fleet` (agar `/update` dapat menjalankan `git pull` dan `npm run build`), sedangkan kredensial dikunci dengan `ReadOnlyPaths=-/opt/aster-fleet/.env` yang diprioritaskan di atas `ReadWritePaths`. `ProtectHome` tidak diaktifkan agar agen embedded tetap dapat menginspeksi filesystem host, dan `NPM_CONFIG_CACHE` diarahkan ke `/var/lib/aster-hub/.npm` karena `ProtectSystem=strict` membuat `$HOME` read-only.
- **Pada Node (`aster-node*.service`)**: Mengizinkan penulisan ke `ReadWritePaths=/var/lib/aster-node <working-directory>` untuk pembaruan otomatis terverifikasi dan tetap mengunci file konfigurasi rahasia melalui `ReadOnlyPaths=-<working-directory>/.env`, ditambah `UMask=0077`, `StateDirectoryMode=0700`, `RestrictRealtime=yes`, `LockPersonality=yes`, `SystemCallArchitectures=native`, `RemoveIPC=yes`, serta batas sumber daya `TasksMax=4096` dan `MemoryMax=2G`.
- **Loopback Controller (`fleet-ctl`)**: Agen OpenCode di Hub mengendalikan node lain lewat endpoint HTTP internal `/internal/fleet/*`. Endpoint ini hanya menerima koneksi dari `127.0.0.1` / `::1` dan mewajibkan header `x-aster-loopback` berisi cookie acak 24-byte yang dibuat ulang setiap Hub start dan dibandingkan secara *constant-time*. Cookie **tidak** diletakkan di environment proses agen: Hub menuliskannya ke file `0600` di direktori state (`loopback-cookie-<nodeId>`) dan agen hanya menerima path-nya lewat `ASTER_HUB_LOOPBACK_COOKIE_FILE`; `fleet-ctl` membaca file itu saat dipanggil. Pola `COOKIE` ikut disaring `sanitizeEnv`, dan `isSecretAccess` memblokir pembacaan `loopback-cookie*` lewat shell. Perintah yang dikirim lewat jalur ini tetap melewati `assessRisk` dan *approval gate*.
- **Kompatibilitas `ProtectHome=true` (`aster-node-isolated.service`)**: `ManagedOpenCodeServer` mengarahkan seluruh variabel `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, dan `XDG_CONFIG_HOME` ke dalam direktori `/var/lib/aster-node/opencode-<nodeId>`, sedangkan `NodeExecutor.initSudo` memiliki *fallback* otomatis ke `/var/lib/aster-node/.aster-askpass` (`0700`) apabila `/home` dikunci oleh `ProtectHome=true`.

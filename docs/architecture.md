# Arsitektur Aster Fleet Manager

Dokumen ini menjelaskan desain internal, protokol komunikasi, dan alur kerja komponen **Aster Hub** serta **Aster Node Agent**.

---

## 1. Pembagian Peran Komponen

| Komponen | Lokasi | Tanggung Jawab Utama |
|---|---|---|
| **Aster Hub** (`src/hub/`) | 1 Server Koordinasi Pusat | Menjalankan Bot Telegram, menerima koneksi *inbound* WebSocket (`ws`/`wss`) dari seluruh node, memvalidasi token autentikasi, menyimpan state sesi chat (`HubStore`), meneruskan permintaan *approval* ke Telegram, dan mem-forward *alert* proaktif ke admin. **Hub tidak pernah mengeksekusi perintah shell di host-nya sendiri.** |
| **Aster Node** (`src/node/`) | Setiap Server / VPS Kantor | Menginisiasi koneksi *outbound* WebSocket ke Hub, mendeteksi distribusi OS (`distro.ts`), menjalankan loop AI tool-calling (`engine.ts`), menilai risiko perintah (`risk.ts`), mengeksekusi perintah dalam *process group* terisolasi (`executor.ts`), mencatat audit berantai hash (`audit.ts`), dan memantau kesehatan sistem (`alerts.ts`). |
| **Shared Core** (`src/shared/`) | Digunakan bersama | Kontrak protokol pesan (`protocol.ts`), klasifikasi risiko (`risk.ts`), pencatat & verifikator rantai audit (`audit.ts`), serta pemformatan Markdown ke HTML Telegram (`format.ts`). |

---

## 2. Protokol Komunikasi WebSocket (`src/shared/protocol.ts`)

Seluruh komunikasi antara Hub dan Node menggunakan pesan JSON terstruktur di atas satu koneksi WebSocket persisten per node:

### A. Pesan dari Node ke Hub (`NodeToHubMsg`)
1. **`node_hello`**: Dikirim segera saat koneksi terbuka. Berisi `nodeId`, `token`, dan objek `NodeInfo` (`hostname`, `platform`, `arch`, `uptime`, `loadAvg`, `memory`, `distro`, `kernel`, `cpus`, `isRoot`).
2. **`node_heartbeat`**: Dikirim berkala setiap `HEARTBEAT_INTERVAL_MS` (default 15 detik) untuk memperbarui metrik *uptime*, *load average*, dan RAM bebas di registri Hub.
3. **`node_chunk`**: Mengalirkan potongan output teks/progress secara *real-time* selama eksekusi perintah atau *streaming* AI berlangsung.
4. **`node_approval_req`**: Meminta persetujuan interaktif kepada operator di Telegram ketika perintah berstatus `approve` (`runId`, `approvalId`, `command`, `reason`).
5. **`node_done`**: Menandakan eksekusi `runId` telah selesai, membawa `fullText`, opsional `error` (termasuk `"ABORTED"`), dan statistik `usage` token AI.
6. **`node_alert`**: Mengirim notifikasi proaktif (`warn` atau `ok`) saat penggunaan Disk, RAM, atau unit `systemd` melewati ambang batas atau kembali pulih.

### B. Pesan dari Hub ke Node (`HubToNodeMsg`)
1. **`hub_welcome`**: Balasan autentikasi (`success: true/false`, `message`). Jika gagal, koneksi langsung ditutup oleh Hub.
2. **`hub_run`**: Meminta node menjalankan tugas baru (`runId`, `chatId`, `userId`, `prompt`, `model`, `history`).
3. **`hub_approval_res`**: Meneruskan keputusan operator (`approved: true/false`) atas `approvalId` tertentu.
4. **`hub_cancel`**: Memerintahkan node untuk segera membatalkan `runId` yang sedang berjalan dan menghentikan seluruh *process tree* shell terkait.

---

## 3. Siklus Hidup Eksekusi Perintah

```mermaid
sequenceDiagram
    participant Admin as Operator (Telegram)
    participant Hub as Aster Hub
    participant Node as Aster Node Agent
    participant Shell as Bash Process Group

    Admin->>Hub: Kirim perintah / prompt
    Hub->>Node: hub_run (runId, prompt, history)
    Node->>Node: Evaluasi risiko (assessRisk)
    alt Verdict = block
        Node->>Node: Catat ke Audit Log (blocked)
        Node->>Hub: node_done ([BLOCKED])
        Hub->>Admin: Tampilkan alasan pemblokiran
    else Verdict = approve
        Node->>Hub: node_approval_req (approvalId, command, reason)
        Hub->>Admin: Tampilkan Inline Keyboard [Setujui / Tolak]
        Admin->>Hub: Klik tombol keputusan
        Hub->>Node: hub_approval_res (approvalId, approved)
        alt Disetujui
            Node->>Shell: spawn("/bin/bash", ["-c", cmd]) (env tersanitasi)
            Shell-->>Node: stdout / stderr
            Node->>Node: Catat ke Audit Log (hash-chained)
            Node->>Hub: node_done (output)
            Hub->>Admin: Tampilkan hasil akhir
        else Ditolak / Timeout
            Node->>Node: Catat ke Audit Log (rejected)
            Node->>Hub: node_done ([REJECTED])
            Hub->>Admin: Notifikasi pembatalan
        end
    else Verdict = allow
        Node->>Shell: spawn("/bin/bash", ["-c", cmd])
        Shell-->>Node: stdout / stderr
        Node->>Node: Catat ke Audit Log (hash-chained)
        Node->>Hub: node_done (output)
        Hub->>Admin: Tampilkan hasil akhir
    end
```

---

## 4. Dual-Engine AI (`ENGINE=opencode` & `ENGINE=local`) serta Built-in RPC (`src/node/engine.ts`)

`NodeEngine` menangani empat jalur eksekusi di setiap node:

1. **Built-in RPC**:
   - `__builtin:status`: Mengumpulkan 14 metrik sistem secara paralel (`status.ts`) dan merender dashboard monospace bergaya netdata tanpa memicu AI atau mengotori log audit perintah operator.
   - `__builtin:auditcheck`: Memverifikasi seluruh baris pada file `audit-<nodeId>.jsonl` dari hash `GENESIS` hingga baris terakhir dan melaporkan keutuhan rantai SHA-256.
   - `__builtin:models`: Mengambil daftar model yang tersedia (`listModels()` via `/api/model`) dari daemon OpenCode pada node aktif (atau daftar `modelChain` pada mode `local`) untuk ditampilkan saat operator memanggil `/model`.
   - `__builtin:reset`: Menghapus sesi OpenCode aktif untuk `chatId` terkait di node saat operator memanggil `/reset`.
2. **Direct Shell Mode (`$ <cmd>` atau `/exec <cmd>`)**:
   - Mengeksekusi perintah langsung melalui `NodeExecutor.runCommand` dengan penilaian risiko (`assessRisk`) dan *approval gate*.
3. **Bundled OpenCode Engine Mode (`ENGINE=opencode` — Default)**:
   - Menggunakan paket resmi `@opencode/cli` yang telah dibundel di `node_modules/@opencode/cli`.
   - Saat node hidup dan `OPENCODE_URL` kosong, `ManagedOpenCodeServer` (`src/node/opencode-server.ts`) otomatis mencari port bebas di `127.0.0.1`, menghasilkan password acak 24-byte (`OPENCODE_SERVER_PASSWORD`), mengisolasi seluruh direktori `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, dan `XDG_CONFIG_HOME` di dalam direktori data node (`/var/lib/aster-node/opencode-<nodeId>`), serta menjalankan `opencode serve`.
   - `OpenCodeRunner` (`src/node/opencode.ts`) membuat sesi per `chatId` dengan aturan `RULESET` ketat (`shell: ask`, `edit: ask`, `write: ask`, `read: ask`, `subagent: deny`, `question: deny`), menyuntikkan konteks sistem/distro Linux + hak akses (`root`/`non-root`) di pesan pertama sesi baru, memulihkan sesi secara otomatis jika terjadi ketidakcocokan `reasoning_content` saat berganti model, dan mem-polling permintaan izin di `/api/session/{sessionID}/permission`.
   - Setiap permintaan izin dari OpenCode dinilai oleh `assessRisk`:
     - `block`: Langsung ditolak (`reject`) dan dicatat ke audit log node (termasuk upaya membaca file rahasia via tool `read` maupun `shell`).
     - `allow` (pembacaan file non-rahasia via `read` atau perintah `shell` *read-only*): Otomatis diizinkan (`once`) dan dicatat ke audit log node tanpa mengganggu operator.
     - `approve` (perintah mutasi `shell` atau `edit`/`write` file): Mengirim `node_approval_req` ke Hub sehingga tombol **Setujui / Tolak** muncul di Telegram.
4. **Local AI Gateway Mode (`ENGINE=local`)**:
   - Menyusun *system prompt* yang dilengkapi informasi distro Linux (`distroContext()`) dan status *privilege* (`isRoot`), lalu memanggil endpoint kompatibel OpenAI (`GATEWAY_URL`).
   - Menyertakan riwayat percakapan ringkas per `(chatId, nodeId)` yang dikirim dari `HubStore`.
   - Mencegah pengulangan perintah identik lebih dari 2 kali dalam satu siklus dan mendukung rantai *fallback* model (`MODEL_NAME` $\rightarrow$ `MODEL_FALLBACK`).

---

## 5. Persistensi State di Hub (`src/hub/store.ts`)

`HubStore` menyimpan state operasional ke file JSON (`HUB_STATE_FILE`, mode `0600`) menggunakan mekanisme *atomic write* (`.tmp` + `rename`) dengan *debounce* 1 detik dan *flush* otomatis saat menerima sinyal `SIGINT`/`SIGTERM`:
- Pilihan node aktif per `chatId`.
- Riwayat percakapan padat per kombinasi `${chatId}:${nodeId}`.
- *Override* model AI per `chatId` (dari perintah `/model`).
- Akumulasi pemakaian token (`requests`, `promptTokens`, `completionTokens`) per `chatId`.

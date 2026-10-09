# CLAUDE.md

Semua aturan proyek, model domain, konvensi, tes, dan SDLC ada di **AGENTS.md** (sumber utama, dipakai juga oleh agent
lain). File ini hanya menambah catatan khusus Claude Code.

@AGENTS.md

## Khusus Claude Code

### Setiap awal sesi
- Sebutkan branch git yang sedang aktif (`git branch --show-current`) dan apakah ada perubahan belum di-commit / stash.
- Kalau pekerjaan menyangkut Kas Operasional, ingat pekerjaan itu ada di `stash@{0}` branch `operasional`, belum di
  `development` / `main`.

### Cara kerja yang disukai pemilik
- Jawab dan jelaskan dalam Bahasa Indonesia sederhana, dari sudut pandang pengguna (operasional / finance / orang baru),
  dengan contoh nominal nyata. Kalau pemilik minta "diskusi dulu", jangan mengubah kode.
- Untuk pertanyaan bisnis yang belum jelas, ajukan pertanyaan singkat; untuk hal teknis, pilih default yang wajar lalu
  sebutkan di ringkasan.
- Setelah selesai: ringkas apa yang berubah, cara mencoba, dan apa yang perlu dilakukan pemilik (mis. restart server,
  isi `.env`, push). Jangan commit / push kecuali diminta; pemilik biasanya commit sendiri.

### Verifikasi
- `npm test` setelah setiap perubahan server / aturan.
- Perubahan UI: cek di Browser pane lewat `preview_start`. Konfigurasi `erp-amico-v2` (data/demo, port 3201) saat ini
  ada di `.claude/launch.json` folder `erp_supabase_app` (folder kerja sesi sebelumnya). Kalau sesi dibuka langsung di
  repo ini, buat `.claude/launch.json` di sini:
  `{"version":"0.0.1","configurations":[{"name":"erp-amico-v2","runtimeExecutable":"node","runtimeArgs":["server.js","--data-dir=data/demo","--port=3201"],"port":3201}]}`
  Untuk data asli, salin `data/pg` ke folder scratchpad dan jalankan server kedua dengan `--data-dir=<salinan>` di
  port lain (mis. 3202), buat user uji hanya di salinan itu, lalu hapus konfigurasi & salinannya setelah selesai.
- Server pemilik (`npm start`, port 3200, `data/pg`) bisa sedang jalan: jangan membuka `data/pg` langsung.
- Panel browser yang tersembunyi membuat `document.hidden` bernilai true (requestAnimationFrame melambat, rubah tidak
  muncul); itu bukan bug aplikasi.

### Tips teknis di mesin pemilik (Windows)
- Shell: Git Bash dan PowerShell 5.1. Path project mengandung spasi: selalu pakai tanda kutip.
- Patch besar / berisi backtick & `${}`: tulis skrip Python ke folder scratchpad dengan tool Write, lalu jalankan; heredoc
  bash sering gagal untuk isi seperti itu. Saat memakai `git show REV:path` di Git Bash, set `MSYS_NO_PATHCONV=1`.
- Saat membaca file `.env`, jangan menampilkan isinya ke chat (berisi password database).

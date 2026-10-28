# AGENTS.md: ERP AMICO v2

Panduan kerja untuk AI agent (Claude Code, Codex, Cursor, dll.) dan developer di repo ini. Baca sampai habis sebelum
mengubah apa pun. Kalau ada yang bertentangan dengan instruksi langsung dari pemilik proyek di chat, ikuti pemilik proyek.

Bahasa: UI, komentar kode, pesan error, commit, dan jawaban ke pemilik proyek memakai **Bahasa Indonesia** yang sederhana.
Nama tabel / kolom / fungsi tetap bahasa Inggris gaya Odoo (`account_move`, `job_line`, `amount_residual`).

---

## 1. Tentang proyek

ERP untuk **PT AMICO** (perusahaan logistik trucking: antar kota dan dalam kota). Menggantikan:
- **ERP AMICO v1** (repo lain, `erp_supabase_app`: HTML + JS langsung ke Supabase, aturan di SQL/RPC, sulit dirawat),
- **AMICO Lite** (prototipe model ala Odoo),
- **Excel JOB REGISTRATION** milik finance (sumber angka yang selama ini dipakai).

Tujuan: jangka panjang dan bisa dijual ke perusahaan lain, **lebih baik dari v1 di pencatatan, fitur, fleksibilitas,
dan perawatan**. Pola yang dipakai: standar **Odoo / ERPNext** (dokumen -> pembayaran, semua saldo dihitung, tidak ada angka
yang ditimpa, semua perubahan tercatat).

Pengguna: tim operasional (buat job, gate, SJ), finance (invoice, pengajuan, pembayaran), ADMIN (persetujuan, user).
Banyak pengguna baru / tidak teknis: tulisan di layar harus jelas (mis. "DP 70%", bukan "DP"), dan alur harus tetap jalan
walau ERP baru dibuka besok pagi (lihat transfer malam).

---

## 2. Stack & menjalankan

| Bagian | Teknologi |
|---|---|
| Server | Node.js (ESM, `"type": "module"`), Express 4, tanpa framework lain |
| Database | PostgreSQL. Lokal: **PGlite** (PostgreSQL tertanam, folder `data/`). Online: PostgreSQL sungguhan (Supabase) lewat `DATABASE_URL` |
| Frontend | HTML + JavaScript modul (vanilla), hash router, tanpa build step, tanpa framework |
| Excel | `exceljs` (impor JOB REG / Job List v1, semua export) |
| Dependensi | hanya `express`, `pg`, `@electric-sql/pglite`, `exceljs`. Jangan menambah dependensi tanpa alasan kuat dan persetujuan |

```bash
npm install
npm start                      # http://localhost:3200, database data/pg (atau DATABASE_URL kalau diisi)
npm run demo:seed && npm run demo   # data contoh di data/demo, http://localhost:3201
npm test                       # semua tes (lihat bagian 8)
npm run db:migrate             # jalankan migrasi saja
npm run user:add -- admin "Nama Admin" ADMIN   # user dari terminal (password diketik, tidak tampil)
npm run pindah:postgres -- --pratinjau          # pindah data data/pg -> DATABASE_URL (lihat bagian 10)
npm run import:jobreg -- "<file.xlsx>" --mulai AMC/2607/0001 [--reset] [--joblist "<export Job List v1.xlsx>"]
npm run import:joblist-v1 -- "<file.xlsx>" --pratinjau
npm run import:amico            # dari database ERP AMICO v1 (AMICO_DB_URL, hanya dibaca)
npm run export:all              # semua data ke Excel
```

Konfigurasi (`config.js`, `.env` sederhana KEY=VALUE, lihat `.env.example`):

| Variabel | Arti |
|---|---|
| `DATABASE_URL` | PostgreSQL online (Supabase). Dipakai hanya di Railway / `NODE_ENV=production` / perintah `--online` / `pindah:postgres`; di laptop diabaikan (PGlite `data/pg`). Di Railway **wajib** (server menolak jalan tanpa ini) |
| `DATABASE_SSL` | SSL otomatis untuk host non-localhost; `disable` untuk mematikan paksa |
| `PORT` | default 3200 (Railway mengisi sendiri) |
| `SESSION_DAYS` | lama login, default 7 |
| `AMICO_DB_URL` | hanya untuk `npm run import:amico` (database v1, dibaca saja) |
| `--data-dir=...`, `--port=...` | argumen baris perintah untuk server / skrip |

---

## 3. Struktur repo

```
server.js                 Express: middleware sesi, mount semua routes di /api, static public/. Saat start: migrasi + analyze (PGlite)
config.js                 baca .env, CONFIG (databaseUrl, dataDir, port, sessionDays, timezone Asia/Jakarta, onCloud)
lib/
  db.js                   openDb(): pg Pool atau PGlite dengan antarmuka sama: query(), exec(), tx(). numeric -> Number,
                          tanggal/waktu -> teks ISO. pgOptions(): SSL. PGlite: semua query diantrikan (1 koneksi)
  migrate.js              jalankan db/migrations/*.sql yang belum ada di schema_migrations, satu transaksi per file
  auth.js                 login, sesi cookie httpOnly (tabel app_session), ROLES, requireRole()
  util.js                 route(), fail(), money(), rupiah(), today(), pick(), insertRow(), updateRow(),
                          nextNumber() (nomor dokumen atomik), audit(), setting()
  import-jobreg.js        impor Excel JOB REGISTRATION + snapshot Excel untuk halaman Selisih (Excel vs ERP)
  import-joblist-v1.js    impor export Job List v1 (melengkapi job, tidak menyentuh uang)
  import-amico.js         impor dari database v1 (Supabase lama) lewat db/import/*.sql
  export-all.js           "Export semua data" (semua tabel + view penting ke satu Excel)
routes/                   satu file per area, masing-masing export default fungsi (db) => express.Router()
  auth.js                 /login /logout /me /users /audit
  master.js               CRUD generik (partners, partner-banks, banks, locations, vehicles, pricelist, route-sla, products)
                          + /settings + /price-lookup
  jobs.js                 /jobs (+ /jobs/query daftar nomor tempel), /jobs/batch (+ /check) buat banyak job dari absen,
                          detail, buat/ubah (reroute), baris order, top-up, trip
  finance.js              /moves (invoice & pengajuan), posting, persetujuan, batal, bayar, balik bayar, transfer malam,
                          selisih tanpa tujuan, /selisih/excel. Fungsi aturan: eligible(), checkMove(), loadMove(), postMove()
  reports.js              /dashboard /rekap /billing (AR/AP per job) /aging /kurang-transfer /ledger /utang-piutang
                          /titipan /bank-balance /tracker + export Excel
  sj.js                   surat jalan: tracking, input cepat, pengiriman SJ (SJD), export Job List, impor Job List v1
  units.js                unit sewa: kontrak sewa, untung rugi per unit / per trip, tagihan sewa bulanan (SWA)
  (jobs.js)               juga GET /jobs/sisihkan untuk menu Sisihkan (kode tugas dobel, trip "tidak jadi jalan" masih aktif)
  pricecheck.js           cek harga jual: job yang selling-nya beda dari price book pada tanggal job + samakan sekaligus
public/
  index.html, styles.css  kerangka + tema (krem #FEF3E2, amber #F4AE52, rust #D4621A, espresso #2A1A0E, olive #6B8E3D)
  app.js                  NAV (menu per grup), ROUTES [regex, modul, fungsi, key menu], router, login, menu user
  lib.js                  helper UI: api/get, esc, rp, tgl, jam, table, tile, openModal, askReason, action, toast,
                          label (STAGE_LABEL, PHASE_LABEL, phaseLabel, SCHEME_*), cache master (state.cache), icon(),
                          latest(), skeleton()/skelTable()/skelTiles(), pagedTable() + pager
  xlfilter.js             xlTable(): tabel dengan filter & urut per kolom ala Excel, centang baris, digambar per halaman
  wa-paste.js             parseWaJob(): baca teks WhatsApp "Label : nilai" jadi isian form Job baru; parseWaBatch(): absen
                          banyak rit (judul tujuan + RIT n) jadi satu baris per rit (fungsi murni, ada tesnya)
  fox.js                  maskot rubah 8-bit di topbar (canvas, bisa dimatikan dari menu user)
  pages/*.js              satu modul per halaman, export renderXxx() dipanggil router
db/migrations/NNN_*.sql   skema + view, berurutan, maju terus (lihat bagian 6)
db/import/*.sql           aturan impor dari v1
scripts/*.js              perintah npm (lihat bagian 2)
test/*.js                 tes ujung-ke-ujung (lihat bagian 8)
data/                     DIABAIKAN git: data/pg (data asli lokal), data/demo, laporan-*.xlsx
development.txt           file penanda branch (isi "ini development"); jangan dihapus / diubah tanpa tanya
```

---

## 4. Model domain (wajib dipahami sebelum menyentuh uang)

Mengikuti Odoo: **rencana -> dokumen -> uang**. Tidak ada kolom status/saldo yang diketik manual; semuanya view.

| Tabel | Padanan Odoo | Isi |
|---|---|---|
| `res_partner` (+ `res_partner_bank`) | res.partner | customer, vendor, calo; pajak (PPh/PPN), bill-to, skema bayar default, `sj_tracking` |
| `res_bank_account` | rekening perusahaan | `kind` BANK atau OPERATIONAL (kas operasional untuk transfer malam) |
| `location`, `vehicle`, `pricelist_item`, `route_sla`, `product` | | master; `product.kind`: TRUCKING, CALO, TOL, PARKIR, BONGKAR, LAINNYA, SELLING... |
| `job` (+ `trip_update`) | analytic account | order: nomor `AMC/YYMM/NNNN`, customer, rute POL-POD, trip ONE_WAY / ROUND_TRIP, truk, plat, driver, `do_number` (= **kode tugas**), gate out / in, SJ (resi, diterima, dikirim), `customer_scheme`, `vendor_scheme` |
| `job_line` | order line | rencana uang per job: `side` SALE / PURCHASE, produk, nominal, partner & rekening penerima |
| `account_move` / `account_move_line` | account.move | `move_type` out_invoice (invoice customer, `INV/YYYY/NNNN`) / in_invoice (pengajuan vendor, `REQ/YYYY/NNNN`); `phase` DP / SETTLEMENT / FULL / OTHER; `state` draft -> posted -> cancelled; `approval_state`; `payment_channel` NORMAL / TRANSFER_MALAM. Baris boleh batal sendiri (`cancelled_at`). Baris tanpa `job_line_id` = **selisih tanpa tujuan** |
| `account_payment` / `account_payment_line` | account.payment | uang benar-benar masuk/keluar (`PAY-IN/`, `PAY-OUT/`). Batal bayar = baris **pembalik minus** (`REV/`), data asli tidak dihapus |
| `internal_transfer` | internal transfer | pindah uang antar rekening AMICO (`TRF/`), `move_id` = pengajuan transfer malam yang didanai |
| `sj_delivery` (+ line) | | pengiriman SJ ke customer, satu resi kurir untuk banyak SJ (`SJD/YYMM/NNNN`) |
| `audit_log` | mail.tracking | siapa mengubah apa (`entity`, `action`, `detail` jsonb), termasuk `reroute` |
| `ir_sequence` | ir.sequence | penomoran dokumen (lewat `nextNumber()`, atomik) |
| `app_user`, `app_session`, `app_setting` | | user & role, sesi login, pengaturan perusahaan |
| `jobreg_snapshot` | | angka Excel JOB REG terakhir untuk dibandingkan di halaman Selisih |
| `vehicle_contract`, `vehicle_rent_bill`, `vehicle_rent_payment` | fleet.vehicle.log.contract | kontrak sewa unit bulanan, tagihan sewa `SWA/YYMM/NNNN`, pembayarannya |

View utama (`db/migrations/002..007`): `v_move_status`, `v_job_line_status`, `v_job_balance`, `v_cash_ledger` (jurnal kas),
`v_job_phase_position` (per job x sisi x fase: planned, billed, paid, not_billed, outstanding), `v_kurang_transfer`,
`v_utang_piutang` (format sheet finance), `v_aging`, `v_unassigned` (selisih tanpa tujuan), `v_titipan_operasional`,
`v_bank_balance`, `v_tracker`, `v_job_status` (stage job), `v_vehicle_day` (sewa per hari), `v_vehicle_trip` (job -> unit
sewa, hari trip), `v_vehicle_trip_cost` (sewa teralokasi per trip), `v_vehicle_rent_bill`.

### Istilah bisnis (glosarium)
| Istilah | Arti |
|---|---|
| Selling / Cost | harga jual ke customer / biaya ke vendor truk (dari price book atau manual) |
| Skema 70/30, 50/50, 100% (FULL) | cara bayar per sisi. Customer: 70_30, 50_50, FULL. Vendor: 70_30, FULL. Default dari partner, kalau kosong: dalam kota FULL, antar kota 70/30 |
| DP | uang muka (70% atau 50%). Total DP per job <= DP% x selling/cost **terbaru** (DP tambahan boleh setelah reroute) |
| Pelunasan (SETTLEMENT) | sisa. Customer: selling setelah pajak - DP (jadi tidak selalu tepat 30%) |
| Calo / biaya lain (OTHER) | biaya vendor selain trucking (calo, tol, parkir, bongkar), diajukan terpisah |
| Kode tugas | `job.do_number`. Isian seperti "TIDAK ADA KODE TUGAS" dianggap kosong |
| Gate out / gate in | truk berangkat / sampai. Job tanpa kode tugas + gate out = **rencana** |
| SJ, resi | surat jalan fisik dari driver, dikirim lewat kurir (resi), diterima AMICO, lalu dikirim ke customer |
| Transfer malam | pengajuan dibayar lewat rekening **kas operasional**: kantor kirim dana (titipan) -> operasional salurkan ke driver. Sering terjadi malam, dicatat besok pagi |
| Titipan | dana di kas operasional untuk satu pengajuan yang belum disalurkan |
| Talangan | operasional membayar lebih dulu dari uang lain (titipan minus), kantor mengganti |
| Reroute | rute / truk diganti setelah ada dokumen: wajib alasan, dicatat di audit (`reroute`) |
| Selisih tanpa tujuan | nominal dokumen di atas rencana (dari impor / reroute) tanpa baris order; finance mengarahkan: ke baris order, jadi saldo partner (sudah dibayar), atau dibatalkan (belum dibayar) |
| Kurang transfer | job yang pelunasannya sudah dibayar tapi totalnya masih kurang dari rencana |
| JOB REG | Excel JOB REGISTRATION finance (sumber lama). Selalu **hanya dibaca** |

### Status job bertahap (`v_job_status.stage`)
RENCANA -> JALAN (dalam perjalanan) -> MENUNGGU_SJ -> SIAP_TAGIH -> KIRIM_SJ (SJ belum dikirim ke customer)
-> MENUNGGU_BAYAR -> SELESAI, atau BATAL. Dihitung, tidak disimpan.

### Role (`lib/auth.js` ROLES)
| Role | Boleh |
|---|---|
| ADMIN | semua: user, persetujuan pengajuan vendor, pengaturan perusahaan |
| FINANCE | invoice, pengajuan, pembayaran, transfer, master partner / rekening / price book, edit job |
| OPERATIONAL | buat & edit job, perjalanan (gate, posisi, SJ), lokasi, kendaraan, SLA; keuangan hanya lihat |
| VIEWER | hanya lihat |
Grup di kode: `READ`, `FINANCE`, `OPS`, `JOB_EDIT`, `ADMIN`. Selalu pakai `requireRole(ROLES.X)` di route; UI
menyembunyikan tombol dengan `canFinance()`, `canJob()`, `isAdmin()`, tapi **server yang menentukan**.

---

## 5. Aturan bisnis yang dijaga server (jangan dilonggarkan tanpa persetujuan pemilik)

- Nominal invoice / pengajuan tidak boleh melebihi sisa baris order. Pengajuan berulang boleh; tidak ada angka yang ditimpa.
- DP: total DP per job per sisi <= DP% x selling/cost terbaru. DP/pelunasan hanya untuk skema 70/30 atau 50/50; FULL hanya untuk skema 100%. Skema sisi yang sudah ditagih / diajukan terkunci.
- `require_gate_for_billing` (default nyala): invoice customer dan pelunasan / full vendor wajib kode tugas asli + gate out. DP vendor dan OTHER boleh untuk job rencana.
- Pengajuan vendor dibuat OPERATIONAL / FINANCE, disetujui FINANCE sebelum dibayar (`vendor_approval_required`); menyetujui buatan sendiri butuh `confirm_own`.
- Transfer malam dibayar dari kas OPERATIONAL, maksimal sebesar titipan pengajuan itu.
- Dokumen / baris yang sudah dibayar baru bisa dibatalkan setelah pembayarannya dibalik.
- Selling / cost tidak bisa diturunkan di bawah yang sudah ditagih / diajukan. Top-up wajib alasan. Ganti rute setelah ada dokumen wajib alasan.
- Semua perubahan penting -> `audit()`.
- Customer tanpa SJ fisik lewat kurir (mis. FORTIS dalam kota): `sj_tracking` dimatikan di partner.

---

## 6. Database & migrasi

- Skema hanya berubah lewat **file migrasi baru** `db/migrations/NNN_nama.sql`, dijalankan otomatis saat server start
  (dan oleh `npm test`, `npm run db:migrate`, semua skrip). Satu file = satu transaksi.
- **Jangan pernah mengedit migrasi yang sudah pernah dijalankan** di database mana pun (lokal data/pg, demo, Supabase
  production). Perbaikan = migrasi baru.
- Migrasi production saat ini: `001`..`007` + **`009_sewa_unit.sql`** (unit sewa; sempat terjalankan ke Supabase production
  pada 2026-10-09 lewat insiden tes, jadi isinya **dibekukan**: perubahan apa pun lewat migrasi baru). **Nomor `008` dipesan**
  untuk `008_kas_operasional.sql` (branch `operasional`, git stash, sudah pernah dijalankan di data/pg lokal). Migrasi baru
  lain mulai `010`.
- **Pemilihan database (`config.js`):** di laptop `npm start`, skrip, dan tes **selalu** memakai database lokal (`data/pg`,
  `--data-dir`, atau memori untuk tes) walaupun `.env` berisi `DATABASE_URL` production. `DATABASE_URL` hanya dipakai di
  Railway (`RAILWAY_ENVIRONMENT`), `NODE_ENV=production`, perintah yang diberi `--online`, dan `npm run pindah:postgres`.
  Jangan melonggarkan aturan ini; agent tidak boleh menjalankan perintah `--online` tanpa diminta pemilik.
- View: `create or replace view` hanya boleh **menambah kolom di akhir** dengan tipe sama. Mengubah / menghapus kolom =
  `drop view` (perhatikan view yang bergantung) lalu `create view`.
- Kolom baru di tabel yang sudah berisi: beri `default` atau isi lewat `update` di migrasi yang sama.
- Uang: `numeric(15, 2)`, dibaca sebagai Number. Nominal dari input selalu lewat `money()` ("1.500.000" -> 1500000).
- Tanggal bisnis memakai zona `Asia/Jakarta` (`today()` di util, `at time zone 'Asia/Jakarta'` di SQL).
- **PGlite = satu proses.** `data/pg` tidak bisa dibuka skrip saat `npm start` jalan. Untuk uji, salin dulu ke folder
  scratch. Setelah impor besar jalankan `analyze` (server menjalankannya saat start untuk PGlite).
- `data/pg` berisi **data asli** pemilik (impor JOB REG + Job List v1). Jangan reset / hapus / impor ulang tanpa diminta.
- Impor ulang JOB REG dengan reset (`importJobReg({ reset: true })`) menyimpan lalu memasang lagi data yang diisi di ERP
  (unit, kontrak / tagihan / pembayaran sewa, SLA rute, price book) dalam satu transaksi. Tabel baru yang diisi manual di ERP
  dan terkena `truncate ... cascade` harus ditambahkan ke `keepErpData` / `restoreErpData` di `lib/import-jobreg.js`.

---

## 7. Konvensi kode

Server:
- Handler selalu `route((req) => ...)`; error untuk user lewat `fail("pesan Indonesia", status)`. Pesan harus menjelaskan
  apa yang salah dan apa yang harus dilakukan (mis. "isi kode tugas dan jam gate out dulu").
- Semua yang menulis uang / dokumen: `db.tx(async (t) => ...)`, **kunci baris dulu** (`select ... for update`,
  `lockMove()`), lalu cek aturan, lalu tulis. Urutan kunci konsisten (id kecil dulu) supaya tidak deadlock.
- Nomor dokumen hanya lewat `nextNumber(t, key, prefix)`. Insert / update lewat `insertRow` / `updateRow` / `pick` (kolom
  yang diizinkan saja). SQL selalu berparameter (`$1`), jangan menyambung input user ke string SQL.
- Saldo / status tidak disimpan: tambahkan ke view atau hitung di query.
- Fungsi aturan yang dipakai lebih dari satu route diekspor dari file route-nya (contoh: `eligible`, `loadMove`, `DP_PCT`).
- Komentar singkat berbahasa Indonesia di kepala file / fungsi yang menjelaskan **aturan bisnis**, bukan mengulang kode.

Frontend:
- Halaman baru: `public/pages/nama.js` export `renderNama()`, daftarkan di `NAV` dan `ROUTES` (`public/app.js`), ikon di
  `ICON` (`public/lib.js`) bila perlu.
- Pakai helper `lib.js` (`table`, `tile`, `openModal`, `askReason`, `action`, `toast`, `esc`, `rp`, `tgl`, `jam`,
  `enumOptions`, `options`). **Selalu `esc()`** untuk teks dari data.
- Tabel daftar yang panjang: `xlTable()` (`public/xlfilter.js`) untuk filter / urut per kolom ala Excel dan centang.
- **Kinerja & kelancaran (jangan dilonggarkan):**
  - Jangan menggambar ribuan baris sekaligus. Daftar yang bisa panjang pakai `xlTable()` atau `pagedTable()` (paling banyak 50 baris
    per halaman; filter, total, centang, dan export tetap dari SEMUA baris). `table()` biasa hanya untuk daftar pendek.
  - Halaman langsung menggambar kerangka (judul, filter) lalu memuat data; wadah yang menunggu data diisi `skelTable()` /
    `skelTiles()`, bukan teks "Memuat...". Router sendiri menampilkan `skeleton()` saat pindah halaman.
  - Muat ulang yang dipicu filter / kotak cari dibungkus `latest()` (`const only = latest(); await only(get(url))`) supaya jawaban
    lama yang datang belakangan tidak menimpa yang baru.
  - Permintaan baca (GET) milik halaman lama otomatis dibatalkan saat pindah halaman (`newNavigation()` dipanggil router) dan
    lanjutannya tidak pernah jalan. Karena itu semua baca data harus lewat `api()` / `get()`, jangan `fetch` langsung (kecuali unduh / unggah file).
    POST yang hanya membaca didaftarkan di `READ_POST` (`lib.js`).
  - Permintaan yang tidak saling bergantung dijalankan bersamaan (`Promise.all`), di browser maupun di route server.
  - Baris yang bisa diklik: `tr[data-href]` + `bindRows(wadah)` (satu pendengar per wadah). Jangan memasang `onclick` per baris.
  - Jangan pakai `backdrop-filter` / `filter` CSS di elemen besar (topbar, latar modal): itu sumber modal dan gulir yang berat.
- Label fase pakai `phaseLabel(phase, scheme)` ("DP 70%", "Pelunasan 30%"), bukan kode mentah.
- Warna lewat variabel CSS di `styles.css`; jangan menambah library CSS / JS dari CDN.
- Tampilan harus tetap layak di layar sempit (pane / HP): tabel di `.table-wrap` (scroll horizontal).

---

## 8. Tes

```bash
npm test
```
| File | Isi |
|---|---|
| `test/run-all.js` | alur lengkap lewat HTTP per role di PGlite memori (40 langkah, termasuk job ekspor / impor FF (nomor, data pengiriman, kontainer, syarat ETD, invoice), login & sesi (wajib ganti password, token di-hash, sesi idle, keluar semua perangkat, catatan login), hak akses pengajuan OPERATIONAL / FINANCE + pengajuan uang kembali, kunci API Supabase, cetak invoice format AMICO, kode tugas unik, buat banyak job dari absen + satu rit satu job, uang kembali dari vendor, unit sewa + per periode kontrak + perpanjang + peringatan & tagihan per periode, gate dari daftar job, tanggal job salah ketik, dua orang mengedit job yang sama, cek harga jual, tempel daftar di form pengajuan, dan kompresi jawaban): job, invoice, pengajuan, bayar, transfer malam, 50/50, selisih tanpa tujuan, SJ, reroute, AR/AP, tempel daftar, export |
| `test/import.test.js` | impor dari tiruan database v1 (12) |
| `test/jobreg.test.js` | impor JOB REGISTRATION dari workbook tiruan, termasuk reset yang menjaga sewa / rekening / ATTN dan kode tugas dobel dari Job List v1 (17) |
| `test/joblist-v1.test.js` | impor Job List v1 (5) |
| `test/wa-paste.test.js` | pembaca teks WhatsApp untuk form Job baru, absen banyak rit, + tempel tanggal-jam (7) |

Aturan:
- Setiap aturan bisnis baru / bug yang diperbaiki **wajib** punya langkah tes (`await step("...", async () => {...})`),
  termasuk kasus yang harus **ditolak** (`call(..., 400)` + `assert.match` pesan).
- Tes memakai database memori, tidak menyentuh `data/`. Data contoh tes dibuat di awal `run-all.js` (user `admin`, `fin`,
  `ops`, `viewer`).
- Perubahan yang terlihat di browser: cek juga di UI (server demo port 3201, atau salinan `data/pg` di folder scratch dengan
  port lain). Jangan memakai `data/pg` asli saat server pemilik jalan. Kredensial demo ada di `scripts/demo-seed.js`
  (jangan ditulis di chat / commit lain).
- Tes saat ini berjalan di PGlite (satu koneksi), jadi **kondisi bersamaan (race) belum teruji**; untuk perubahan
  penguncian, uji juga ke PostgreSQL sungguhan.

---

## 9. SDLC (alur kerja dari ide sampai production)

### 9.1 Lingkungan
| Lingkungan | Database | Dipakai untuk |
|---|---|---|
| Tes | PGlite memori | `npm test` |
| Lokal | `data/pg` (PGlite, data asli pemilik sampai dipindah) | pengembangan sehari-hari, `npm start` :3200 |
| Demo | `data/demo` (data contoh) | cek UI, presentasi, `npm run demo` :3201 |
| Production | Supabase PostgreSQL (Session pooler, Singapore) | server di **Railway** (region Singapore, 1 replica), deploy otomatis dari GitHub |

### 9.2 Branch & remote
- `main` = **production**. Setiap push ke `main` di repo yang terhubung Railway langsung ter-deploy.
- `development` = integrasi. Semua pekerjaan masuk sini dulu, lalu digabung ke `main` saat siap rilis.
- Branch fitur dari `development` (contoh: `operasional` untuk Kas Operasional). Nama pendek, bahasa Indonesia boleh.
- Remote: `other-repo` = `afrizalfathan123-netizen/amicoerp_V2` (**terhubung Railway / production**);
  `origin` = `afrizalfathan/erp-amicov2` (repo lama). Pastikan push ke remote yang benar.
- Jaga `development` tidak tertinggal dari `main` (setelah hotfix di `main`, gabungkan balik ke `development`).

### 9.3 Tahapan
1. **Perencanaan (diskusi).** Pahami kebutuhan dari sudut pandang pengguna (operasional / finance / orang baru).
   Tanyakan aturan bisnis yang belum jelas (angka, siapa yang boleh, kapan). Kalau pemilik bilang "diskusi dulu / jangan
   sentuh ERP", **jangan menulis kode**. Usulkan solusi ala Odoo / ERPNext, sebutkan dampak ke data yang sudah ada.
2. **Desain.** Tentukan: tabel / kolom baru (migrasi baru), view, aturan server, endpoint, halaman. Prinsip: dokumen +
   pembayaran, saldo dihitung, tidak ada angka ditimpa, audit untuk setiap perubahan, data lama tetap valid.
3. **Implementasi** di branch fitur / `development`: migrasi -> server (aturan + route) -> UI -> README (bagian aturan /
   fitur) -> AGENTS.md bila ada konvensi baru.
4. **Tes.** `npm test` hijau + langkah tes baru. Untuk fitur UI, cek di browser (demo / salinan data). Untuk migrasi, uji
   ke **salinan** `data/pg` (migrasi + angka laporan tidak berubah), dan `npm run pindah:postgres -- --pratinjau` bila
   menyentuh skema yang akan dipindah.
5. **Review.** Baca ulang diff: aturan uang di transaksi + kunci baris? pesan error jelas? `esc()` di UI? migrasi lama
   tidak tersentuh? rahasia tidak ikut? (Claude Code: bisa `/code-review`.)
6. **Commit & push.** Hanya kalau pemilik meminta (pemilik biasanya commit sendiri). Pesan commit bahasa Indonesia,
   singkat, menjelaskan apa yang berubah untuk pengguna. Jangan commit `.env`, `data/`, file Excel, kredensial.
7. **UAT.** Pemilik / tim mencoba di demo atau lokal dengan data asli. Perbaiki di branch yang sama.
8. **Rilis.** Gabungkan `development` -> `main`, push ke `other-repo main`. Sebelum rilis yang membawa migrasi yang mengubah
   / menghapus data: **backup production dulu** (menu User & Audit > Export semua data, atau pg_dump).
9. **Verifikasi setelah deploy.** Railway > Deploy Logs: ada `Database: PostgreSQL (DATABASE_URL)`, tidak ada
   `Migrasi ... gagal`. Login, cek dashboard, beberapa job, AR/AP, angka sama dengan sebelum rilis.
10. **Pemantauan & rollback.** Bug kecil: hotfix di `main` (tes dulu), gabungkan balik ke `development`. Kode rusak:
    Railway > Deployments > redeploy versi sebelumnya. **Migrasi tidak bisa di-rollback otomatis**: perbaiki dengan
    migrasi baru; kalau data rusak, pulihkan dari backup.

### 9.4 Definition of Done
- [ ] Aturan bisnis dicek di server (bukan hanya di UI), dalam transaksi, dengan kunci baris bila menyangkut uang.
- [ ] Perubahan tercatat di `audit_log`.
- [ ] `npm test` lolos, ada langkah tes baru untuk perilaku baru (termasuk penolakan).
- [ ] UI dicek di browser, tulisan jelas untuk orang baru, layak di layar sempit.
- [ ] Migrasi baru saja (yang lama tidak diubah), aman untuk data yang sudah ada.
- [ ] README / AGENTS.md diperbarui bila ada fitur / aturan / konvensi baru.
- [ ] Tidak ada rahasia, data asli, atau file Excel pemilik di diff.

---

## 10. Deploy & production

- **Railway** menjalankan `npm start` (server Node jalan terus). Variabel: `DATABASE_URL` (Supabase **Session pooler**,
  bukan Direct connection yang IPv6), opsional `SESSION_DAYS`, `TZ=Asia/Jakarta`. `PORT` dari Railway. Domain:
  service > Settings > Networking > Generate Domain.
- **Supabase** hanya dipakai sebagai database. **Data API (REST) Supabase harus dimatikan** karena v2 tidak memakainya
  dan tabel ada di schema `public`.
- **Vercel tidak dipakai**: v2 butuh server yang jalan terus (upload besar, file laporan, transaksi panjang); paket
  gratis Vercel juga tidak untuk pemakaian perusahaan.
- Cookie login `Secure` otomatis di belakang HTTPS (`trust proxy`).
- **Pindah data lokal -> production**: matikan `npm start`, isi `DATABASE_URL` di `.env`, lalu
  `npm run pindah:postgres -- --pratinjau` kemudian `npm run pindah:postgres` (satu transaksi, id tetap, penomoran
  melanjutkan, jumlah baris + total kolom angka dicocokkan; tujuan harus kosong, `--reset` mengosongkan dengan konfirmasi
  "PINDAH"). User ikut pindah.
- Backup: paket gratis Supabase **tanpa backup otomatis**. Sampai ada backup otomatis (rencana: harian ke Cloudflare R2),
  lakukan Export semua data secara berkala.

---

## 11. Keamanan & batas yang tidak boleh dilanggar

- Rahasia (`DATABASE_URL`, password, token) hanya di `.env` lokal (diabaikan git) dan Railway Variables. **Jangan menulis
  rahasia ke file yang di-commit (termasuk `.env.example`), ke log, atau ke chat.** Kalau sempat terlihat, sarankan ganti.
- Jangan memasukkan password asli ke form apa pun. User baru lewat `npm run user:add` (password diketik pemilik) atau menu
  User & Audit.
- File Excel pemilik (JOB REGISTRATION, Job List v1, laporan) **hanya dibaca**, tidak pernah diubah.
- Jangan membuka `data/pg` saat server pemilik jalan; jangan reset / hapus data lokal maupun production tanpa diminta.
- Jangan commit / push / merge / deploy kecuali diminta. Jangan memakai perintah git yang merusak (`reset --hard`,
  `push --force`, `clean -fd`) tanpa persetujuan eksplisit.
- Validasi semua input di server; SQL berparameter; `esc()` di HTML.

---

## 12. Pekerjaan yang masih terbuka (per 2026-10-09)

- **Kas Operasional** (branch `operasional`, git stash `stash@{0}`): konfirmasi pagi transfer malam (dana dari kantor,
  penyaluran massal / gabungan DSB, talangan, alihkan titipan ALH, dana kembali, cocokkan saldo m-banking) + **reroute
  jadi lebih murah** (kelebihan dokumen pindah ke selisih tanpa tujuan). Menunggu keputusan pemilik; operasional memakai
  rekening pribadi, kecenderungan aturan "sisa selalu dikembalikan ke kantor". Migrasi `008_kas_operasional.sql`.
- **Edit job saling menimpa**: perlu optimistic locking (kirim versi `updated_at`, tolak kalau sudah diubah orang lain).
- **Klik ganda / ulang saat bayar sebagian**: perlu kunci idempotensi per aksi uang.
- **Tes serbu** (banyak request bersamaan) ke PostgreSQL sungguhan.
- **Backup harian otomatis** (Cloudflare R2) dan laporan impor tidak lagi disimpan ke disk server.
- Keputusan data yang masih menunggu pemilik: pemetaan vendor "AMICO", 226 beda v1 vs v2 (timpa atau tidak), matikan
  "Lacak SJ" untuk FORTIS.

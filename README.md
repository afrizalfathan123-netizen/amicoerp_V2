# ERP AMICO v2

Model **AMICO Lite** (standar Odoo / ERPNext) + fitur **ERP AMICO**: login & role, operasional job, tracker, keuangan
lanjutan (persetujuan, transfer malam lewat kas operasional, top-up, refund, invoice dengan pajak), dan pindah data
dari ERP AMICO lama. Node.js + PostgreSQL.

## Menjalankan

```bash
npm install
npm start                       # http://localhost:3200, database tertanam di data/pg
npm run user:add -- admin "Nama Admin" ADMIN     # user pertama (password diketik di terminal)
```

Mau mencoba dulu dengan data contoh: `npm run demo:seed` lalu `npm run demo` (http://localhost:3201).
Akun uji demo: `admin`, `finance`, `ops`, `viewer`, dengan password yang tertulis di `scripts/demo-seed.js`.

Lokal tidak perlu install PostgreSQL: di laptop selalu dipakai PostgreSQL tertanam (PGlite) di folder `data/`, walaupun
`.env` berisi `DATABASE_URL`. `DATABASE_URL` hanya dipakai di Railway / `NODE_ENV=production`, perintah dengan `--online`
(mis. `npm run user:add -- admin "Nama" ADMIN --online` untuk user production), dan `npm run pindah:postgres`.
Skema dibuat / diperbarui otomatis saat server jalan (`db/migrations/*.sql`).

## Go live: Supabase (database) + Railway (server)

1. Supabase: project baru (region Singapore). Matikan Data API (Project Settings > API) karena v2 tidak memakainya,
   supaya tabel tidak bisa diakses lewat anon key. Ambil connection string **Session pooler**.
2. Railway: deploy repo ini, region Singapore, 1 replica. Variables: `DATABASE_URL` (connection string di atas),
   opsional `SESSION_DAYS`, `TZ=Asia/Jakarta`. `PORT` diisi Railway. Tanpa `DATABASE_URL` server menolak jalan di Railway.
   Skema dibuat otomatis saat server jalan. SSL ke Supabase otomatis (`DATABASE_SSL=disable` untuk mematikan).
3. Pindah data dari laptop (matikan `npm start` dulu, isi `DATABASE_URL` Supabase di `.env`):
   ```bash
   npm run pindah:postgres -- --pratinjau
   npm run pindah:postgres
   ```
   Semua tabel disalin dalam satu transaksi (id tetap sama, penomoran melanjutkan), lalu jumlah baris dan total setiap
   kolom angka dibandingkan; kalau ada yang beda, dibatalkan seluruhnya. Tujuan harus kosong; `--reset` mengosongkan
   tujuan dulu (konfirmasi "PINDAH"). User ikut pindah dengan password yang sama, semua orang login ulang.

## Pindah data dari ERP AMICO lama

1. Isi `AMICO_DB_URL` di `.env` dengan connection string database Supabase lama (hanya dibaca).
2. `npm run import:amico` (database v2 harus kosong) atau `npm run import:amico -- --reset` (kosongkan data bisnis dulu,
   user & pengaturan tetap).
3. Hasilnya: ringkasan di terminal, selisih angka DIBAYAR dengan data lama, dan laporan Excel di `data/laporan-impor-*.xlsx`.

Aturan pindah data ada di `db/import/amico_import.sql`. Yang penting:
- Pajak customer dari `deduct_tax` (PPh 2% + PPN 1,1%).
- Transfer malam: PAID = dana ke kas operasional; dianggap dibayar ke vendor saat DISBURSED / RECONCILED; dikembalikan
  sebelum disalurkan = transfer balik + baris dibatalkan.
- Status lunas tanpa dokumen di data lama jadi dokumen **SALDO AWAL**.
- Nomor job baru melanjutkan nomor lama per bulan.

## Impor dari Excel JOB REGISTRATION

```bash
npm run import:jobreg -- "C:\path\JOB REGISTRATION.xlsx" --mulai AMC/2607/0001
```
`--reset` mengosongkan data bisnis dulu (user & pengaturan tetap). Data yang diisi di ERP dan tidak ada di Excel (unit,
kontrak & tagihan sewa, SLA rute, price book) disimpan lalu dipasang lagi otomatis; semuanya satu transaksi (gagal = tidak berubah). File Excel hanya dibaca. Laporan
`data/laporan-jobreg-*.xlsx` berisi RINGKASAN, PERLU DICEK (yang salah / janggal di Excel dan apa yang dilakukan
importer), dan KURANG TRANSFER. Aturan ada di kepala `lib/import-jobreg.js`. Yang penting:
- Kolom dicari dari nama header (kolom baru di Excel tidak menggeser hasil).
- Nomor job dengan bulan > 12 (AMC/2698/...) dibetulkan sesuai tanggal job (AMC/2608/...).
- Pajak customer: GSL, TREX, PANCA, FORTIS, CIPS tanpa pajak; lainnya PPh 2% + PPN 1,1%. SELLING AFTER TAX Excel yang
  beda hanya dicatat.
- Sudah dibayar menurut UTANG PIUTANG; job yang tidak ada di sana dianggap dibayar pada tanggal kolom DATE.
- Calo / kelebihan pengajuan vendor masuk dokumen fase "Calo / biaya lain"; kelebihan di atas cost / selling jadi baris SELISIH.

## Status job & surat jalan

- Status job dihitung otomatis (seperti ERPNext): Rencana (belum gate out) -> Dalam perjalanan -> Menunggu SJ -> Siap ditagih ->
  SJ belum dikirim -> Menunggu pembayaran -> Selesai. Job rencana hanya boleh diajukan untuk operasional (DP / calo vendor);
  invoice customer dan pelunasan / full vendor wajib kode tugas + jam gate out (bisa dimatikan di Master Data > Perusahaan).
- Menu Surat Jalan: pemantauan lead time (gate in -> resi driver -> SJ diterima -> dikirim ke customer) dengan target hari,
  input cepat (tempel daftar no job / no SJ / kode tugas), dan Pengiriman SJ ke customer (satu resi untuk banyak SJ, nomor SJD,
  bisa dicetak). Customer tanpa SJ fisik lewat kurir: matikan "Lacak SJ" di partner.
- Ringan untuk data banyak: tabel panjang ditampilkan per halaman (100 baris, bisa diubah 50 / 100 / 250 / 500) tetapi filter,
  total, centang, dan export tetap menghitung semua baris; saat memuat tampil kerangka abu-abu (skeleton) dan garis proses di
  atas layar; jawaban server dikompresi.
- Form Pengajuan / Invoice baru: **Tempel daftar job** (atau tempel beberapa nomor langsung di kotak cari). Job di daftar itu saja
  yang tampil, urut sesuai tempelan dan langsung dicentang; nomor yang sudah diajukan penuh / tidak ketemu disebutkan.
- Daftar job: filter & urut per kolom seperti Excel (klik ▾ di header), dan **Tempel daftar** no job atau kode tugas
  (dari Excel / WhatsApp) untuk menampilkan job itu saja sesuai urutan tempelan, plus daftar yang tidak ketemu.
- Export Job List (Excel + ringkasan) di halaman Job; kalau ada filter kolom / daftar tempel, yang diexport persis yang tampil. Teks WhatsApp pengajuan: tombol "Salin teks WhatsApp" di pengajuan vendor.

## AR Customer & AP Vendor

Per job, dengan bahasa yang mudah untuk orang baru: setiap fase ditulis lengkap (DP 70%, Pelunasan 30%, Full 100%, Calo / biaya lain)
dengan nominal, status (belum ditagih / diajukan, ditagih belum dibayar, belum bisa + alasannya, lunas), nomor dokumen, dan langkah
berikutnya. Tab: Perlu ditagih sekarang, Belum bisa ditagih, Menunggu pembayaran, Lunas. Ada filter kolom ala Excel, Tempel daftar,
salin no job, dan centang job -> langsung buat invoice / pengajuan untuk fase yang bisa. Angkanya sama dengan Rekap Posisi.

## Unit sewa (untung rugi per unit & per trip)

Menu **Unit Sewa** untuk unit yang disewa bulanan. Kontrak sewa per unit (pemilik, mulai / selesai, sewa per bulan, biaya tetap
lain); trip diambil otomatis dari job dengan plat yang sama (spasi / huruf besar diabaikan).
- Biaya per hari = (sewa + biaya tetap lain) / jumlah hari bulan itu.
- Hari trip = tanggal gate out s/d gate in (job tanpa gate = tanggal job). Hari yang dipakai dua job dibagi rata.
- Kontribusi trip = selling - cost job (uang jalan). Untung trip = kontribusi - sewa teralokasi (tampil juga di halaman job).
- Per unit per bulan: hari jalan / menganggur, utilisasi, kontribusi, untung bersih (kontribusi - sewa), biaya menganggur,
  titik impas (trip per bulan), plus kalender hari.
- Periode: per bulan, rentang tanggal bebas, atau keseluruhan (sejak kontrak pertama s/d hari ini); untuk rentang / keseluruhan
  ada tabel tren per bulan (semua unit) dan per unit per bulan.
- Tabel per unit dan tabel trip (per unit atau "Semua trip bulan ini") bisa difilter / diurut per kolom seperti Excel; ringkasan
  dan total mengikuti yang tampil. Export Excel (sheet RINGKASAN UNIT, TRIP, HARIAN) juga persis yang tampil.
- Kontrak bisa diubah (termasuk plat & jenis truk unit) dan dihapus selama belum punya tagihan sewa.
- Tagihan sewa bulanan `SWA/YYMM/NNNN` per kontrak (prorata), dibayar / balik bayar / batal. Pembayaran sewa belum masuk
  Kas & Rekening (menunggu keputusan finance).

## Impor Job List ERP AMICO v1

```bash
npm run import:joblist-v1 -- "C:\path\job-list-semua.xlsx" --pratinjau
```
Atau tombol "Impor Job List v1" di halaman Job (ADMIN, server tidak perlu dimatikan). Melengkapi job yang ada (driver, HP, gate,
SJ, resi, vendor + rekening) dan menambah job yang belum ada (selling / cost 0). Kolom yang beda tidak ditimpa kecuali `--timpa`.
Uang tidak disentuh. Isian buatan v1 (DRIVER DUMMY, HP 08000000.., resi AUTO-SJ..) diabaikan.

## Role

| Role | Boleh |
|---|---|
| ADMIN | semua, termasuk user, persetujuan pengajuan vendor, pengaturan perusahaan |
| FINANCE | invoice, pengajuan, pembayaran, transfer, master partner / rekening / price book, edit job |
| OPERATIONAL | buat & edit job, perjalanan (gate, posisi, SJ), lokasi, kendaraan, SLA; keuangan hanya lihat |
| VIEWER | hanya lihat |

Semua perubahan penting tercatat di audit (menu User & Audit, dan riwayat di halaman job).

## Model data

| Tabel | Padanan Odoo | Isi |
|---|---|---|
| `res_partner` (+ `res_partner_bank`) | res.partner | customer, vendor, calo; pajak & bill-to customer; rekening penerima |
| `res_bank_account` | rekening perusahaan | BANK dan KAS OPERASIONAL (perantara transfer malam) |
| `location`, `vehicle`, `pricelist_item`, `route_sla`, `product` | | master operasional & harga |
| `job` (+ `trip_update`) | analytic account | order, unit, driver, perjalanan, SJ |
| `job_line` | order line | rencana uang job: selling, selling tambahan, cost truk, calo, tol, parkir, bongkar, lainnya |
| `account_move` / `account_move_line` | account.move | invoice customer / pengajuan vendor (batch banyak vendor), draft → posted → batal, persetujuan |
| `account_payment` / `account_payment_line` | account.payment | uang benar-benar masuk / keluar; batal bayar = pembalik minus |
| `internal_transfer` | internal transfer | pindah uang antar rekening AMICO (dana transfer malam ke kas operasional) |

Semua saldo dihitung di view (`db/migrations/002_views.sql`), tidak disimpan: posisi per fase, utang piutang (format
JOB REGISTRATION), kurang transfer, jurnal kas, umur tagihan, titipan kas operasional, mutasi rekening, tracker.

## Aturan yang dijaga server

- Nominal invoice / pengajuan tidak boleh melebihi sisa baris order; pengajuan berulang boleh, tidak ada angka yang ditimpa.
- Skema bayar per sisi: customer 70/30, 50/50, atau 100%; vendor 70/30 atau 100%. Default dari setting partner (Master Data),
  kalau kosong dalam kota 100% / antar kota 70/30. Skema sisi yang sudah ditagih / diajukan terkunci.
- DP sekali per job per sisi (70% atau 50% sesuai skema). DP / pelunasan untuk sisi berskema 70/30 atau 50/50, FULL untuk 100%.
- Selisih tanpa tujuan: nominal dokumen yang melebihi selling / cost (dari impor) dicatat tanpa baris order, jadi selling / cost
  job tetap sesuai sumbernya. Finance mengarahkannya di menu Selisih Tanpa Tujuan: ke baris order job (calo, biaya / selling
  tambahan), jadi saldo partner (kalau sudah dibayar), atau dibatalkan (kalau belum dibayar).
- Calo / biaya lain diajukan dengan fase "Calo / biaya lain"; di laporan finance ikut kolom 30% (atau 100%).
- Selling / cost tidak bisa diturunkan di bawah yang sudah ditagih / diajukan; top-up wajib alasan.
- Pengajuan vendor perlu persetujuan ADMIN sebelum dibayar (bisa dimatikan di pengaturan).
- Transfer malam dibayar dari kas operasional, maksimal sebesar dana yang sudah dikirim ke sana.
- Dokumen / baris yang sudah dibayar baru bisa dibatalkan setelah pembayarannya dibalik.

## Tes

```bash
npm test
```
Alur lengkap lewat HTTP per role (22 langkah) + pindah data dari tiruan database AMICO lama (12 langkah)
+ impor JOB REGISTRATION dari workbook tiruan (14 langkah).

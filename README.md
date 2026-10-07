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

Lokal tidak perlu install PostgreSQL: kalau `DATABASE_URL` kosong, dipakai PostgreSQL tertanam (PGlite) di folder `data/`.
Untuk online (VPS Hostinger / database Supabase baru) isi `DATABASE_URL` di `.env` (lihat `.env.example`).
Skema dibuat / diperbarui otomatis saat server jalan (`db/migrations/*.sql`).

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
`--reset` mengosongkan data bisnis dulu (user & pengaturan tetap). File Excel hanya dibaca. Laporan
`data/laporan-jobreg-*.xlsx` berisi RINGKASAN, PERLU DICEK (yang salah / janggal di Excel dan apa yang dilakukan
importer), dan KURANG TRANSFER. Aturan ada di kepala `lib/import-jobreg.js`. Yang penting:
- Kolom dicari dari nama header (kolom baru di Excel tidak menggeser hasil).
- Nomor job dengan bulan > 12 (AMC/2698/...) dibetulkan sesuai tanggal job (AMC/2608/...).
- Pajak customer: GSL, TREX, PANCA, FORTIS, CIPS tanpa pajak; lainnya PPh 2% + PPN 1,1%. SELLING AFTER TAX Excel yang
  beda hanya dicatat.
- Sudah dibayar menurut UTANG PIUTANG; job yang tidak ada di sana dianggap dibayar pada tanggal kolom DATE.
- Calo / kelebihan pengajuan vendor masuk dokumen fase "Calo / biaya lain"; kelebihan di atas cost / selling jadi baris SELISIH.

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
- DP 70% sekali per job per sisi. DP / pelunasan untuk job skema 70/30, FULL untuk job skema 100%.
- Calo / biaya lain diajukan dengan fase "Calo / biaya lain"; di laporan finance ikut kolom 30% (atau 100%).
- Selling / cost tidak bisa diturunkan di bawah yang sudah ditagih / diajukan; top-up wajib alasan.
- Pengajuan vendor perlu persetujuan ADMIN sebelum dibayar (bisa dimatikan di pengaturan).
- Transfer malam dibayar dari kas operasional, maksimal sebesar dana yang sudah dikirim ke sana.
- Dokumen / baris yang sudah dibayar baru bisa dibatalkan setelah pembayarannya dibalik.

## Tes

```bash
npm test
```
Alur lengkap lewat HTTP per role (18 langkah) + pindah data dari tiruan database AMICO lama (12 langkah)
+ impor JOB REGISTRATION dari workbook tiruan (13 langkah).

// Impor JOB REGISTRATION.xlsx (Excel finance) ke ERP AMICO v2. File Excel hanya DIBACA.
//
//   npm run import:jobreg -- "C:\path\JOB REGISTRATION.xlsx" --mulai AMC/2607/0001
//   ... --reset          -> kosongkan data bisnis v2 dulu (user & pengaturan tetap; sewa, rekening, price book, SLA disimpan
//                           lalu dipasang lagi dan dicocokkan)
//   ... --joblist "C:\path\job-list-semua.xlsx"  -> kode tugas yang dobel di FINANCE diambil dari export Job List ERP v1
//   ... --data-dir=...   -> database tertanam lain (default data/pg, yang dipakai npm start)
//   ... --perbandingan   -> hanya simpan angka Excel untuk halaman Selisih (Excel vs ERP), transaksi tidak diubah.
//                           Bisa juga lewat tombol "Unggah JOB REG" di halaman Selisih tanpa mematikan server.
//
// Laporan (RINGKASAN, PERLU DICEK, KURANG TRANSFER) ditulis ke data/laporan-jobreg-*.xlsx.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { importJobReg, writeJobRegReport, saveJobRegSnapshot } from "../lib/import-jobreg.js";
import { CONFIG, ROOT } from "../config.js";

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith("--") && !["--mulai", "--joblist"].includes(args[i - 1]));
const start = args.includes("--mulai") ? args[args.indexOf("--mulai") + 1] : null;
const joblist = args.includes("--joblist") ? args[args.indexOf("--joblist") + 1] : null;
const reset = args.includes("--reset");
if (!file || !fs.existsSync(file)) {
  console.error('Pakai: npm run import:jobreg -- "<file JOB REGISTRATION.xlsx>" [--mulai AMC/2607/0001] [--reset] [--joblist "<export Job List v1.xlsx>"]');
  process.exit(1);
}
if (joblist && !fs.existsSync(joblist)) {
  console.error(`File Job List v1 tidak ada: ${joblist}`);
  process.exit(1);
}
// tujuan ditampilkan SEBELUM konfirmasi, supaya jelas database mana yang akan diganti
const online = CONFIG.databaseUrl && !CONFIG.dataDirArg;
console.log(`Tujuan: ${online ? `PostgreSQL ONLINE (${new URL(CONFIG.databaseUrl).hostname})` : CONFIG.dataDir}`);
const target = await openDb();
await migrate(target, { log: () => {} });
if (reset) {
  // isi database sekarang: yang disimpan & dipasang lagi, dan yang hilang karena diganti isi Excel
  const [n] = await target.query(
    `select (select count(*) from job)::int as job, (select count(*) from job where source = 'APP')::int as job_app,
            (select count(*) from account_move where created_by is not null)::int as dokumen_app,
            (select count(*) from account_payment where created_by is not null)::int as bayar_app,
            (select count(*) from internal_transfer)::int as transfer, (select count(*) from sj_delivery)::int as kirim_sj,
            (select count(*) from trip_update)::int as posisi,
            (select count(*) from vehicle)::int as unit, (select count(*) from vehicle_contract)::int as kontrak,
            (select count(*) from vehicle_rent_bill)::int as tagihan_sewa, (select count(*) from vehicle_rent_payment)::int as bayar_sewa,
            (select count(*) from res_bank_account)::int as rekening, (select count(*) from pricelist_item)::int as price_book,
            (select count(*) from route_sla)::int as sla`);
  console.log(`Isi sekarang: ${n.job} job.`);
  console.log(`TETAP (disimpan lalu dipasang lagi): ${n.unit} unit, ${n.kontrak} kontrak sewa, ${n.tagihan_sewa} tagihan sewa, ${n.bayar_sewa} pembayaran sewa,`);
  console.log(`  ${n.rekening} rekening AMICO / kas operasional, ${n.price_book} price book, ${n.sla} SLA rute, kontak / ATTN / rekening partner, user, pengaturan.`);
  console.log("  Sesudah impor, jumlah & total sewa dicocokkan; kalau beda, impor dibatalkan otomatis.");
  console.log("DIGANTI isi Excel: job, invoice, pengajuan, pembayaran, partner, lokasi.");
  if (n.job_app || n.dokumen_app || n.bayar_app || n.transfer || n.kirim_sj || n.posisi) {
    console.log(`HILANG (dibuat di ERP, tidak ada di Excel): ${n.job_app} job dibuat di aplikasi, ${n.dokumen_app} invoice / pengajuan dibuat di aplikasi,`);
    console.log(`  ${n.bayar_app} pembayaran dicatat di aplikasi, ${n.transfer} transfer malam, ${n.kirim_sj} pengiriman SJ, ${n.posisi} update posisi.`);
  }
  if (online) console.log("Selama impor berjalan (bisa 15-30 menit) web ERP tidak bisa dipakai. Kalau gagal di tengah, semuanya batal dan data kembali seperti semula.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('Ketik "HAPUS" untuk lanjut: ', r));
  rl.close();
  if (answer.trim() !== "HAPUS") { await target.close(); process.exit(0); }
}
try {
  if (args.includes("--perbandingan")) {
    const info = await saveJobRegSnapshot({ file, target });
    console.log(`Angka Excel disimpan untuk ${info.jobs} job. Buka halaman Selisih untuk melihat Excel vs ERP.`);
    await target.close();
    process.exit(0);
  }
  const t0 = Date.now();
  const result = await importJobReg({ file, target, start, reset, joblist });
  console.log(`Waktu: ${((Date.now() - t0) / 1000).toFixed(1)} detik, catatan perlu dicek: ${result.issues.length}`);
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).replace(/[: ]/g, "-").slice(0, 16);
  const report = await writeJobRegReport(target, result, path.join(ROOT, "data", `laporan-jobreg-${stamp}.xlsx`));
  console.log(`Laporan: ${report}`);
} catch (err) {
  console.error("Impor gagal:", err.message);
  process.exitCode = 1;
} finally {
  await target.close();
}

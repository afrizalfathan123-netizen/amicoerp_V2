// Lengkapi job v2 dari export "Job List" ERP AMICO v1 (driver, HP, gate, SJ, resi, vendor + rekening) dan tambah job yang belum ada.
// Uang tidak disentuh. File Excel hanya dibaca.
//   npm run import:joblist-v1 -- "C:\path\job-list-semua.xlsx"            -> isi kolom v2 yang kosong
//   ... --timpa        -> kolom yang sudah terisi tapi beda ikut ditimpa nilai v1
//   ... --pratinjau    -> hanya laporan, tidak disimpan
//   ... --data-dir=... -> database tertanam lain (default data/pg; server yang memakainya harus mati,
//                         kalau server jalan pakai tombol "Impor Job List v1" di halaman Job)
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { importJobListV1, writeJobListReport } from "../lib/import-joblist-v1.js";
import { ROOT } from "../config.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file || !fs.existsSync(file)) {
  console.error('Pakai: npm run import:joblist-v1 -- "<file job-list.xlsx>" [--timpa] [--pratinjau]');
  process.exit(1);
}
const db = await openDb();
await migrate(db, { log: () => {} });
try {
  const result = await importJobListV1({ file, target: db, timpa: args.includes("--timpa"), dryRun: args.includes("--pratinjau"), log: console.log });
  console.log(result.dryRun ? "PRATINJAU (tidak disimpan):" : "Selesai:", result.stats, `tidak ada di v1: ${result.not_in_v1.length}, perlu dicek: ${result.issues.length}`);
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).replace(/[: ]/g, "-").slice(0, 16);
  console.log("Laporan:", await writeJobListReport(result, path.join(ROOT, "data", `laporan-joblist-v1-${stamp}.xlsx`)));
} catch (err) {
  console.error("Impor gagal:", err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}

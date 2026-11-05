// Kelompokkan invoice customer dan pengajuan vendor (DP, pelunasan, full) mengikuti batch ERP v1. Uang tidak berubah.
// Batch v1 yang belum selesai dan belum ada di JOB REG dibuatkan dokumen tanpa pembayaran.
// Jalankan SETELAH import:jobreg dan import:joblist-v1. Aman dijalankan ulang.
//   npm run import:batch-v1 -- "C:\path\prod-xxxx.sql.gz"     -> database laptop (data/pg)
//   ... --pratinjau      -> hanya menghitung, tidak menyimpan
//   ... --data-dir=...   -> database tertanam lain
//   ... --online         -> DATABASE_URL di .env
// File cadangan didapat dari tombol Backup Database di folder ERP v1. Batch yang dibuat setelah cadangan itu tidak ikut.
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { readV1Dump, groupByV1Batch, writeBatchReport } from "../lib/import-batch-v1.js";
import { CONFIG, ROOT } from "../config.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file || !fs.existsSync(file)) {
  console.error('Pakai: npm run import:batch-v1 -- "<file cadangan v1 .sql.gz>" [--pratinjau] [--online]');
  process.exit(1);
}
const online = CONFIG.databaseUrl && !CONFIG.dataDirArg;
console.log(`Tujuan: ${online ? `PostgreSQL ONLINE (${new URL(CONFIG.databaseUrl).hostname})` : CONFIG.dataDir}`);
const db = await openDb();
await migrate(db, { log: () => {} });
try {
  const tables = await readV1Dump(file);
  const preview = args.includes("--pratinjau");
  const result = await groupByV1Batch({ tables, target: db, log: console.log, dryRun: preview });
  console.log(preview ? "PRATINJAU, tidak ada yang disimpan:" : "Selesai:", result.stats);
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).replace(/[: ]/g, "-").slice(0, 16);
  console.log("Laporan:", await writeBatchReport(result, path.join(ROOT, "data", `laporan-batch-v1-${stamp}.xlsx`)));
} catch (err) {
  console.error("Gagal:", err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}

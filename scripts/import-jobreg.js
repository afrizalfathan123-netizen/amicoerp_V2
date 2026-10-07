// Impor JOB REGISTRATION.xlsx (Excel finance) ke ERP AMICO v2. File Excel hanya DIBACA.
//
//   npm run import:jobreg -- "C:\path\JOB REGISTRATION.xlsx" --mulai AMC/2607/0001
//   ... --reset          -> kosongkan data bisnis v2 dulu (user & pengaturan tetap)
//   ... --data-dir=...   -> database tertanam lain (default data/pg, yang dipakai npm start)
//
// Laporan (RINGKASAN, PERLU DICEK, KURANG TRANSFER) ditulis ke data/laporan-jobreg-*.xlsx.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { importJobReg, writeJobRegReport } from "../lib/import-jobreg.js";
import { CONFIG, ROOT } from "../config.js";

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--mulai");
const start = args.includes("--mulai") ? args[args.indexOf("--mulai") + 1] : null;
const reset = args.includes("--reset");
if (!file || !fs.existsSync(file)) {
  console.error('Pakai: npm run import:jobreg -- "<file JOB REGISTRATION.xlsx>" [--mulai AMC/2607/0001] [--reset]');
  process.exit(1);
}
if (reset) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('Semua job, dokumen, pembayaran, dan master di ERP v2 akan DIHAPUS. Ketik "HAPUS": ', r));
  rl.close();
  if (answer.trim() !== "HAPUS") process.exit(0);
}

const target = await openDb();
await migrate(target, { log: () => {} });
console.log(`Tujuan: ${CONFIG.databaseUrl ? "PostgreSQL (DATABASE_URL)" : CONFIG.dataDir}`);
try {
  const t0 = Date.now();
  const result = await importJobReg({ file, target, start, reset });
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

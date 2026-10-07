// Pindahkan data dari ERP AMICO lama (Supabase) ke ERP AMICO v2.
//
// 1. Isi AMICO_DB_URL di file .env (connection string database Supabase, menu Project Settings > Database > Connection string).
//    Contoh: AMICO_DB_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
//    Database lama hanya DIBACA.
// 2. npm run import:amico                -> impor ke database v2 yang masih kosong
//    npm run import:amico -- --reset     -> kosongkan data bisnis v2 dulu (user & pengaturan tetap), lalu impor
//    (tambahkan --data-dir=... untuk database tertanam lain, misalnya data/demo)
import readline from "node:readline";
import path from "node:path";
import pg from "pg";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { importAmico, writeImportReport } from "../lib/import-amico.js";
import { CONFIG, ROOT } from "../config.js";

const url = process.env.AMICO_DB_URL;
if (!url) {
  console.error("AMICO_DB_URL belum diisi di file .env (lihat petunjuk di atas file ini).");
  process.exit(1);
}
const reset = process.argv.includes("--reset");
if (reset) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('Semua job, dokumen, pembayaran, dan master di ERP v2 akan DIHAPUS. Ketik "HAPUS": ', r));
  rl.close();
  if (answer.trim() !== "HAPUS") process.exit(0);
}

const src = new pg.Pool({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }, max: 2 });
const source = { query: async (sql, params) => (await src.query(sql, params)).rows };
const target = await openDb();
await migrate(target, { log: () => {} });
console.log(`Sumber: ${url.replace(/:[^:@/]+@/, ":****@")}`);
console.log(`Tujuan: ${CONFIG.databaseUrl ? "PostgreSQL (DATABASE_URL)" : CONFIG.dataDir}`);
try {
  const { rekon } = await importAmico({ source, target, reset });
  if (rekon.length) {
    console.log("\nSelisih DIBAYAR dengan data lama (lihat laporan):");
    console.table(rekon);
  } else {
    console.log("\nSemua angka DIBAYAR sama dengan data lama.");
  }
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).replace(/[: ]/g, "-").slice(0, 16);
  const file = await writeImportReport(target, path.join(ROOT, "data", `laporan-impor-${stamp}.xlsx`));
  console.log(`Laporan: ${file}`);
} catch (err) {
  console.error("Impor gagal:", err.message);
  process.exitCode = 1;
} finally {
  await src.end();
  await target.close();
}

// Export seluruh isi database ke Excel (daftar tabel, kolom, isi tiap tabel / view laporan).
//   npm run export:all                  -> data/ERP-AMICO-semua-data-<tanggal>.xlsx (database data/pg)
//   npm run export:all -- --data-dir=.. -> database tertanam lain
// Server yang memakai database tertanam yang sama harus dimatikan dulu; kalau server jalan,
// pakai tombol "Export semua data" di halaman User & Audit.
import path from "node:path";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { buildAllExport } from "../lib/export-all.js";
import { ROOT } from "../config.js";

const db = await openDb();
await migrate(db, { log: () => {} });
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).replace(/[: ]/g, "-").slice(0, 16);
const file = path.join(ROOT, "data", `ERP-AMICO-semua-data-${stamp}.xlsx`);
await (await buildAllExport(db)).xlsx.writeFile(file);
await db.close();
console.log(`Selesai: ${file}`);

// Jalankan file db/migrations/*.sql yang belum pernah dijalankan, berurutan, masing-masing dalam satu transaksi.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";

const DIR = path.join(ROOT, "db", "migrations");

export async function migrate(db, { log = console.log } = {}) {
  await db.exec(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set((await db.query("select name from schema_migrations")).map((r) => r.name));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    try {
      await db.exec(`begin;\n${sql}\n;insert into schema_migrations (name) values ('${file.replace(/'/g, "''")}');\ncommit;`);
    } catch (err) {
      await db.exec("rollback").catch(() => {});
      throw new Error(`Migrasi ${file} gagal: ${err.message}`);
    }
    log(`  migrasi ${file}`);
    applied++;
  }
  return applied;
}

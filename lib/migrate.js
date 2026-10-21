// Jalankan file db/migrations/*.sql yang belum pernah dijalankan, berurutan, masing-masing dalam satu transaksi.
// Sesudahnya API REST Supabase dikunci (lockSupabaseApi) setiap start, supaya tabel baru juga ikut terkunci.
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
  const locked = await lockSupabaseApi(db);
  if (locked) log(`  API REST Supabase dikunci (${locked} tabel diberi RLS)`);
  return applied;
}

// Supabase membuka API REST (PostgREST) untuk semua tabel schema public lewat role anon / authenticated.
// ERP ini tidak memakainya: browser hanya bicara dengan server ERP, server tersambung lewat DATABASE_URL sebagai pemilik tabel.
// Jadi pintu itu ditutup:
//   - semua hak anon / authenticated di tabel, view, sequence, fungsi schema public dicabut (juga untuk objek baru);
//   - RLS dinyalakan (tanpa policy = tidak ada baris yang terlihat lewat API) di tabel milik user ERP. Pemilik tabel
//     tidak terkena RLS, jadi server ERP tetap jalan seperti biasa. Tabel milik role lain tidak disentuh.
// Di database tanpa role anon (laptop / PGlite, PostgreSQL biasa) tidak melakukan apa-apa. Aman diulang.
export async function lockSupabaseApi(db) {
  const [r] = await db.query("select exists (select 1 from pg_roles where rolname = 'anon') as supabase");
  if (!r.supabase) return 0;
  await db.exec(`
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;`);
  const tables = await db.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
       and pg_get_userbyid(c.relowner) = current_user`);
  for (const t of tables) await db.exec(`alter table public."${t.relname.replace(/"/g, '""')}" enable row level security`);
  return tables.length;
}

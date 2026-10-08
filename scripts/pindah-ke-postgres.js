// Pindahkan SEMUA data dari database tertanam (PGlite, data/pg) ke PostgreSQL online (mis. Supabase).
//
//   npm run pindah:postgres -- --pratinjau        -> hanya hitung & cek, tidak menulis apa pun
//   npm run pindah:postgres                       -> salin (database tujuan harus masih kosong)
//   npm run pindah:postgres -- --reset            -> kosongkan dulu SEMUA tabel di tujuan (ketik "PINDAH" untuk konfirmasi)
//   ... --data-dir=...                            -> folder PGlite sumber (default data/pg)
//   ... --target=postgres://...                   -> tujuan (default DATABASE_URL di .env)
//
// Server lokal (npm start) harus dimatikan dulu: PGlite hanya bisa dibuka satu proses.
// Urutan: migrasi skema di tujuan -> salin tabel sesuai urutan foreign key (id tetap sama) -> setel ulang penomoran id
// -> bandingkan jumlah baris dan total setiap kolom angka di sumber vs tujuan. Semua dalam SATU transaksi:
// kalau ada yang gagal atau angkanya beda, tujuan tidak berubah sama sekali.
// Sesi login tidak ikut (semua user login ulang). Kolom / tabel yang hanya ada di sumber dilaporkan.
import readline from "node:readline";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { CONFIG } from "../config.js";

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const preview = args.includes("--pratinjau");
const reset = args.includes("--reset");
const targetDir = opt("target-data-dir");   // untuk uji: tujuan PGlite lain
const targetUrl = opt("target") || process.env.DATABASE_URL;
if (!targetUrl && !targetDir) {
  console.error("Isi DATABASE_URL di .env (connection string Supabase, Session pooler) atau pakai --target=...");
  process.exit(1);
}
const SKIP = new Set(["schema_migrations", "app_session"]);

const source = await openDb({ url: "", dataDir: opt("data-dir") || CONFIG.dataDir });
const target = targetDir ? await openDb({ url: "", dataDir: targetDir }) : await openDb({ url: targetUrl });
const host = targetDir || new URL(targetUrl).hostname;
console.log(`Sumber : ${opt("data-dir") || CONFIG.dataDir}`);
console.log(`Tujuan : ${host}`);

const tables = async (db) => new Map((await db.query(
  `select c.table_name, json_agg(json_build_object('name', c.column_name, 'type', c.data_type) order by c.ordinal_position) as cols
   from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema = 'public' and t.table_type = 'BASE TABLE' group by c.table_name`)).map((r) => [r.table_name, r.cols]));
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const NUM = new Set(["numeric", "integer", "bigint", "smallint", "real", "double precision"]);

try {
  if (!preview) {
    const n = await migrate(target, { log: (m) => console.log(m) });
    console.log(n ? `${n} migrasi dijalankan di tujuan.` : "Skema tujuan sudah terbaru.");
  }
  const src = await tables(source);
  const dst = preview ? src : await tables(target);

  // urutan salin: tabel yang dirujuk lebih dulu (foreign key), rujukan ke diri sendiri diabaikan
  const deps = await (preview ? source : target).query(
    `select tc.relname as child, tp.relname as parent from pg_constraint k
     join pg_class tc on tc.oid = k.conrelid join pg_class tp on tp.oid = k.confrelid
     join pg_namespace n on n.oid = tc.relnamespace
     where k.contype = 'f' and n.nspname = 'public' and tc.relname <> tp.relname`);
  const names = [...src.keys()].filter((t) => dst.has(t) && !SKIP.has(t));
  const order = [];
  const seen = new Set();
  const visit = (t, path = []) => {
    if (seen.has(t)) return;
    if (path.includes(t)) throw new Error(`Rujukan melingkar antar tabel: ${[...path, t].join(" -> ")}`);
    for (const d of deps.filter((x) => x.child === t)) if (names.includes(d.parent)) visit(d.parent, [...path, t]);
    seen.add(t);
    order.push(t);
  };
  names.sort().forEach((t) => visit(t));

  // yang ada di sumber tapi tidak ada di tujuan (mis. tabel dari branch lain)
  const notes = [];
  for (const [t, cols] of src) {
    if (SKIP.has(t)) continue;
    const [{ n }] = await source.query(`select count(*)::int as n from ${ident(t)}`);
    if (!dst.has(t)) { if (n) notes.push(`Tabel ${t} (${n} baris) tidak ada di tujuan, TIDAK disalin`); continue; }
    const have = new Set(dst.get(t).map((c) => c.name));
    for (const c of cols) if (!have.has(c.name)) {
      // angka 0 / false dianggap kosong (nilai bawaan kolom baru)
      const filled = NUM.has(c.type) ? `coalesce(${ident(c.name)}, 0) <> 0` : c.type === "boolean" ? `${ident(c.name)} is true` : `${ident(c.name)} is not null`;
      const [{ m }] = await source.query(`select count(*)::int as m from ${ident(t)} where ${filled}`);
      if (m) notes.push(`Kolom ${t}.${c.name} (${m} baris terisi) tidak ada di tujuan, TIDAK disalin`);
    }
  }

  // ringkasan sumber: jumlah baris + total setiap kolom angka (untuk dicocokkan setelah salin)
  const summary = async (db, t, cols) => {
    const nums = cols.filter((c) => NUM.has(c.type) && c.name !== "id");
    const [r] = await db.query(`select count(*)::int as n${nums.map((c, i) => `, coalesce(sum(${ident(c.name)}), 0)::text as s${i}`).join("")} from ${ident(t)}`);
    return { n: r.n, sums: Object.fromEntries(nums.map((c, i) => [c.name, r[`s${i}`]])) };
  };
  const before = {};
  for (const t of order) {
    const cols = src.get(t).filter((c) => dst.get(t).some((d) => d.name === c.name));
    before[t] = await summary(source, t, cols);
  }
  console.log("\nTabel yang disalin:");
  for (const t of order) console.log(`  ${t.padEnd(24)} ${String(before[t].n).padStart(7)} baris`);
  if (notes.length) { console.log("\nPerhatian:"); notes.forEach((x) => console.log(`  - ${x}`)); }
  if (preview) { console.log("\nPratinjau selesai, tidak ada yang ditulis."); process.exit(0); }

  if (reset) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question(`\nSemua data di ${host} akan DIHAPUS lalu diganti dari data lokal. Ketik "PINDAH": `, r));
    rl.close();
    if (answer.trim() !== "PINDAH") process.exit(0);
  }

  const t0 = Date.now();
  await target.tx(async (t) => {
    if (reset) await t.query(`truncate ${[...dst.keys()].filter((x) => x !== "schema_migrations").map(ident).join(", ")} restart identity cascade`);
    // tujuan harus kosong (pengaturan bawaan dari migrasi boleh, nanti ditimpa)
    for (const tb of order) {
      if (["app_setting", "ir_sequence", "product"].includes(tb)) continue;
      const [{ n }] = await t.query(`select count(*)::int as n from ${ident(tb)}`);
      if (n) throw new Error(`Tabel ${tb} di tujuan sudah berisi ${n} baris. Jalankan dengan --reset untuk mengosongkan dulu (hati-hati: data tujuan hilang).`);
    }
    for (const tb of order) {
      const cols = src.get(tb).filter((c) => dst.get(tb).some((d) => d.name === c.name));
      const dtype = Object.fromEntries(dst.get(tb).map((c) => [c.name, c.type]));
      const rows = await source.query(`select ${cols.map((c) => ident(c.name)).join(", ")} from ${ident(tb)}${cols.some((c) => c.name === "id") ? " order by id" : ""}`);
      // isian bawaan migrasi di tujuan diganti dengan versi sumber
      if (["app_setting", "ir_sequence", "product"].includes(tb)) await t.query(`delete from ${ident(tb)}`);
      const batch = Math.max(1, Math.min(500, Math.floor(30000 / cols.length)));
      for (let i = 0; i < rows.length; i += batch) {
        const part = rows.slice(i, i + batch);
        const params = [];
        const values = part.map((r) => `(${cols.map((c) => {
          let v = r[c.name];
          if (v !== null && v !== undefined && (dtype[c.name] === "jsonb" || dtype[c.name] === "json")) v = JSON.stringify(v);
          params.push(v);
          return `$${params.length}${dtype[c.name] === "jsonb" ? "::jsonb" : dtype[c.name] === "json" ? "::json" : ""}`;
        }).join(", ")})`);
        // id ikut disalin apa adanya (kolom id "generated by default", jadi boleh diisi)
        await t.query(`insert into ${ident(tb)} (${cols.map((c) => ident(c.name)).join(", ")}) values ${values.join(", ")}`, params);
      }
      process.stdout.write(`  disalin ${tb} (${rows.length})\n`);
    }
    // penomoran id berikutnya melanjutkan id terbesar
    for (const tb of order) {
      if (!dst.get(tb).some((c) => c.name === "id")) continue;
      const [{ seq }] = await t.query("select pg_get_serial_sequence($1, 'id') as seq", [tb]);
      if (seq) await t.query(`select setval($1, coalesce((select max(id) from ${ident(tb)}), 0) + 1, false)`, [seq]);
    }
    // cocokkan: jumlah baris dan total kolom angka harus sama persis
    const diffs = [];
    for (const tb of order) {
      const cols = src.get(tb).filter((c) => dst.get(tb).some((d) => d.name === c.name));
      const after = await summary(t, tb, cols);
      if (after.n !== before[tb].n) diffs.push(`${tb}: ${before[tb].n} baris di sumber, ${after.n} di tujuan`);
      for (const [k, v] of Object.entries(before[tb].sums)) if (Number(v) !== Number(after.sums[k])) diffs.push(`${tb}.${k}: ${v} vs ${after.sums[k]}`);
    }
    if (diffs.length) throw new Error(`Hasil salin tidak cocok, dibatalkan:\n  ${diffs.join("\n  ")}`);
  });
  await target.exec("analyze");
  console.log(`\nSelesai dalam ${((Date.now() - t0) / 1000).toFixed(1)} detik. Jumlah baris dan total angka semua tabel cocok.`);
  console.log("Semua user perlu login ulang di server baru (password tetap sama).");
} catch (err) {
  console.error("\nPindah data gagal:", err.message);
  process.exitCode = 1;
} finally {
  await source.close();
  await target.close();
}

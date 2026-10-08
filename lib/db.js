// Lapisan database: PostgreSQL sungguhan (pg) atau PostgreSQL tertanam (PGlite) dengan antarmuka yang sama.
//
//   const db = await openDb();
//   const rows = await db.query("select * from job where id = $1", [id]);
//   await db.tx(async (t) => { await t.query(...); });
//
// Angka (numeric, bigint) dikembalikan sebagai Number, tanggal/waktu sebagai teks apa adanya.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { CONFIG } from "../config.js";

const toNumber = (v) => (v == null ? v : Number(v));
const asText = (v) => v;
// "2026-10-06 08:41:17.759+07" -> "2026-10-06T08:41:17.759+07:00" (aman dibaca new Date() di browser)
const isoTime = (v) => (v == null ? v : String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
// numeric, int8, date, timestamp, timestamptz
const PARSERS = { 1700: toNumber, 20: toNumber, 1082: asText, 1114: isoTime, 1184: isoTime };

for (const [oid, fn] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid), fn);

function wrapPg(pool) {
  const query = async (sql, params = [], client = pool) => (await client.query(sql, params)).rows;
  return {
    kind: "postgres",
    query: (sql, params) => query(sql, params),
    async exec(sql) { await pool.query(sql); },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn({ query: (sql, params) => query(sql, params, client) });
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function wrapPglite(lite) {
  // PGlite hanya satu koneksi: transaksi diantrikan supaya tidak saling tumpuk
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  return {
    kind: "pglite",
    query: (sql, params = []) => serial(async () => (await lite.query(sql, params, { parsers: PARSERS })).rows),
    exec: (sql) => serial(() => lite.exec(sql)),
    tx: (fn) => serial(() => lite.transaction((t) => fn({ query: async (sql, params = []) => (await t.query(sql, params, { parsers: PARSERS })).rows }))),
    close: () => lite.close(),
  };
}

// SSL: wajib ke server online (mis. Supabase), mati untuk localhost. DATABASE_SSL=disable untuk mematikan paksa.
// sslmode di URL dibaca lalu dibuang, karena versi pg baru memperlakukan "require" sebagai verifikasi penuh sertifikat
// (sertifikat Supabase ditandatangani CA mereka sendiri, jadi koneksi bisa gagal). Koneksi tetap terenkripsi.
export function pgOptions(url) {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  const mode = process.env.DATABASE_SSL || u.searchParams.get("sslmode") || (local ? "disable" : "require");
  u.searchParams.delete("sslmode");
  return { connectionString: u.toString(), ssl: mode === "disable" ? false : { rejectUnauthorized: false } };
}

export async function openDb({ url = CONFIG.databaseUrl, dataDir = CONFIG.dataDir, memory = false } = {}) {
  if (url) return wrapPg(new pg.Pool({ ...pgOptions(url), max: 10 }));
  // di server cloud (Railway) disk tidak permanen: tanpa DATABASE_URL data akan hilang tiap deploy, jadi tolak jalan
  if (!memory && CONFIG.onCloud) throw new Error("DATABASE_URL belum diisi. Di server cloud database tertanam (PGlite) tidak boleh dipakai karena datanya hilang setiap deploy.");
  if (!memory) fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const lite = new PGlite(memory ? undefined : dataDir);
  await lite.waitReady;
  return wrapPglite(lite);
}

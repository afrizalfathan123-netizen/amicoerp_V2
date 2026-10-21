// Konfigurasi dari environment. Untuk lokal tidak perlu diisi apa-apa.
//
//   Database:
//     di laptop (default)         -> PostgreSQL tertanam (PGlite) di folder data/pg, WALAUPUN .env berisi DATABASE_URL
//     di Railway / NODE_ENV=production, atau perintah diberi --online
//                                 -> PostgreSQL online dari DATABASE_URL (mis. Supabase)
//     --data-dir=...              -> selalu database tertanam di folder itu (mis. demo)
//   Jadi DATABASE_URL production boleh disimpan di .env laptop (untuk npm run pindah:postgres, atau
//   npm run user:add -- ... --online) tanpa membuat npm start / tes di laptop ikut menulis ke production.
//   PORT           default 3200
//   SESSION_DAYS   lama login berlaku, default 7 hari
//   SESSION_IDLE_HOURS  sesi habis kalau tidak dipakai selama ini, default 8 jam
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

// .env sederhana (KEY=VALUE per baris), opsional
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// argumen baris perintah: --data-dir=... --port=... --online
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

// jalan di Railway: Railway selalu mengisi variabel RAILWAY_* (RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_NAME, ...)
const onCloud = Object.keys(process.env).some((k) => k.startsWith("RAILWAY_"));
const online = onCloud || process.env.NODE_ENV === "production" || process.argv.includes("--online");

export const CONFIG = {
  databaseUrl: online ? process.env.DATABASE_URL || "" : "",
  dataDir: arg("data-dir") || process.env.DATA_DIR || path.join(ROOT, "data", "pg"),
  // --data-dir di baris perintah = sengaja memakai database tertanam itu (mis. demo), DATABASE_URL diabaikan
  dataDirArg: Boolean(arg("data-dir")),
  port: Number(arg("port") || process.env.PORT || 3200),
  sessionDays: Number(process.env.SESSION_DAYS || 7),
  sessionIdleHours: Number(process.env.SESSION_IDLE_HOURS || 8),
  timezone: "Asia/Jakarta",
  onCloud,
  online,
};

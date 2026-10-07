// Konfigurasi dari environment. Untuk lokal tidak perlu diisi apa-apa.
//
//   DATABASE_URL   kosong   -> PostgreSQL tertanam (PGlite) di folder data/pg, tanpa install apa pun
//                  diisi    -> PostgreSQL sungguhan, contoh postgres://user:pass@host:5432/amico
//   PORT           default 3200
//   SESSION_DAYS   lama login berlaku, default 7 hari
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

// argumen baris perintah: --data-dir=... --port=...
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

export const CONFIG = {
  databaseUrl: process.env.DATABASE_URL || "",
  dataDir: arg("data-dir") || process.env.DATA_DIR || path.join(ROOT, "data", "pg"),
  port: Number(arg("port") || process.env.PORT || 3200),
  sessionDays: Number(process.env.SESSION_DAYS || 7),
  timezone: "Asia/Jakarta",
};

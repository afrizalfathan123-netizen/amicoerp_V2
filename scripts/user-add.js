// Buat user dari terminal (dipakai untuk ADMIN pertama), atau GANTI PASSWORD user yang sudah ada (mis. lupa password).
// Password diketik dua kali, tidak tampil di layar. Database laptop: server lokal (npm start) harus dimatikan dulu.
//   npm run user:add -- <username> "<nama tampilan>" <ADMIN|FINANCE|OPERATIONAL|VIEWER>
import readline from "node:readline";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { hashPassword } from "../lib/auth.js";
import { CONFIG } from "../config.js";

const [username, displayName, role = "ADMIN"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!username || !displayName) {
  console.error('Pakai: npm run user:add -- admin "Nama Admin" ADMIN');
  process.exit(1);
}

// Jawaban dibaca per baris lewat antrean, jadi baris yang diketik / ditempel cepat tidak hilang di antara dua pertanyaan.
// Antarmuka baru dibuat saat pertanyaan pertama (setelah database terbuka), supaya input tidak habis terbaca lebih dulu.
let rl = null;
let hidden = null;
const lines = [], waiting = [];
function startInput() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl._writeToOutput = (s) => rl.output.write(hidden && !s.startsWith(hidden) ? s.replace(/[^\r\n]/g, "*") : s);
  rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on("close", () => { while (waiting.length) waiting.shift()(""); });
}
const ask = (question, hide = false) => new Promise((resolve) => {
  if (!rl) startInput();
  hidden = hide ? question : null;
  rl.setPrompt(question);
  rl.prompt();
  const done = (a) => { if (hide && process.stdin.isTTY) process.stdout.write("\n"); hidden = null; resolve(a); };
  lines.length ? done(lines.shift()) : waiting.push(done);
});

const db = await openDb();
await migrate(db, { log: () => {} });
const online = CONFIG.databaseUrl && !CONFIG.dataDirArg;
// tujuan ditampilkan dulu: akun di laptop dan di web online terpisah
console.log(`Database: ${online ? `ONLINE (${new URL(CONFIG.databaseUrl).hostname})` : `laptop (${CONFIG.dataDir})`}`);
const name = username.toLowerCase();
const [existing] = await db.query("select id, role, active from app_user where username = $1", [name]);
if (existing) console.log(`User "${name}" sudah ada (${existing.role}${existing.active ? "" : ", nonaktif"}). Password-nya akan DIGANTI.`);
try {
  const password = await ask("Password (min. 8 karakter): ", true);
  if (password.length < 8) throw new Error("Password minimal 8 karakter.");
  // diketik dua kali: salah ketik di kotak yang tidak terlihat langsung ketahuan, bukan saat login gagal
  if ((await ask("Ketik ulang password: ", true)) !== password) throw new Error("Password kedua tidak sama. Tidak ada yang diubah, ulangi.");
  if (existing) {
    await db.query("update app_user set password_hash = $1, active = true where id = $2", [hashPassword(password), existing.id]);
    await db.query("delete from app_session where user_id = $1", [existing.id]);
    console.log(`Password "${name}" diganti. Silakan login dengan password baru.`);
  } else {
    await db.query("insert into app_user (username, display_name, role, password_hash) values ($1, $2, $3, $4)",
      [name, displayName, role.toUpperCase(), hashPassword(password)]);
    console.log(`User ${name} (${role.toUpperCase()}) dibuat.`);
  }
} catch (err) {
  console.error("Gagal:", err.message);
  process.exitCode = 1;
} finally {
  rl?.close();
  await db.close();
}

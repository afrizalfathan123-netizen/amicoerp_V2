// Buat user dari terminal (dipakai untuk ADMIN pertama). Password diketik sendiri, tidak tampil di layar.
//   npm run user:add -- <username> "<nama tampilan>" <ADMIN|FINANCE|OPERATIONAL|VIEWER>
import readline from "node:readline";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { hashPassword } from "../lib/auth.js";

const [username, displayName, role = "ADMIN"] = process.argv.slice(2);
if (!username || !displayName) {
  console.error('Pakai: npm run user:add -- admin "Nama Admin" ADMIN');
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? question : s.replace(/[^\r\n]/g, "*"));
    rl.question(question, (a) => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
}

const password = await askHidden("Password (min. 8 karakter): ");
if (password.length < 8) {
  console.error("Password minimal 8 karakter.");
  process.exit(1);
}
const db = await openDb();
await migrate(db, { log: () => {} });
try {
  await db.query("insert into app_user (username, display_name, role, password_hash) values ($1, $2, $3, $4)",
    [username.toLowerCase(), displayName, role.toUpperCase(), hashPassword(password)]);
  console.log(`User ${username} (${role.toUpperCase()}) dibuat.`);
} catch (err) {
  console.error("Gagal:", err.message);
} finally {
  await db.close();
}

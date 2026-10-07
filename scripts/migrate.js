// Jalankan migrasi skema: npm run db:migrate
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { CONFIG } from "../config.js";

const db = await openDb();
console.log(`Database: ${CONFIG.databaseUrl ? "PostgreSQL (DATABASE_URL)" : `tertanam di ${CONFIG.dataDir}`}`);
const n = await migrate(db);
console.log(n ? `${n} migrasi dijalankan.` : "Skema sudah terbaru.");
await db.close();

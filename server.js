// ERP AMICO v2: Express + PostgreSQL.
//   npm start                 -> http://localhost:3200 (database tertanam di data/pg kalau DATABASE_URL kosong)
//   npm run user:add -- ...   -> buat user pertama (ADMIN)
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, ROOT } from "./config.js";
import { openDb } from "./lib/db.js";
import { migrate } from "./lib/migrate.js";
import { sessionMiddleware } from "./lib/auth.js";
import authRoutes from "./routes/auth.js";
import masterRoutes from "./routes/master.js";
import jobRoutes from "./routes/jobs.js";
import financeRoutes from "./routes/finance.js";
import reportRoutes from "./routes/reports.js";

export async function createApp(db) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(sessionMiddleware(db));
  app.use("/api", authRoutes(db));
  app.use("/api", masterRoutes(db));
  app.use("/api", jobRoutes(db));
  app.use("/api", financeRoutes(db));
  app.use("/api", reportRoutes(db));
  app.use("/api", (req, res) => res.status(404).json({ error: "Endpoint tidak ada" }));
  app.use(express.static(path.join(ROOT, "public")));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await openDb();
  await migrate(db);
  // Statistik tabel untuk perencana query (PGlite tidak menjalankan autovacuum sendiri)
  if (db.kind === "pglite") await db.exec("analyze");
  const [{ n }] = await db.query("select count(*)::int as n from app_user");
  const app = await createApp(db);
  app.listen(CONFIG.port, () => {
    console.log(`ERP AMICO v2 jalan di http://localhost:${CONFIG.port}`);
    console.log(`Database: ${CONFIG.databaseUrl ? "PostgreSQL (DATABASE_URL)" : `tertanam di ${CONFIG.dataDir}`}`);
    if (!n) console.log('Belum ada user. Buat dulu: npm run user:add -- admin "Nama Admin" ADMIN');
  });
}

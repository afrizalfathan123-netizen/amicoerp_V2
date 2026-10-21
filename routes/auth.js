// Login, logout, user aktif, sesi, dan kelola user (ADMIN).
import express from "express";
import { hashPassword, verifyPassword, createSession, destroySession, requireRole, requireLogin, loginEvent, ROLES } from "../lib/auth.js";
import { route, fail, pick, insertRow, updateRow, audit } from "../lib/util.js";

const MIN_PASSWORD = 8;
const checkPassword = (p) => { if (String(p || "").length < MIN_PASSWORD) fail(`Password minimal ${MIN_PASSWORD} karakter`); };

export default function authRoutes(db) {
  const r = express.Router();

  r.post("/login", route(async (req, res) => {
    const { username, password } = req.body || {};
    const name = String(username || "").trim().toLowerCase();
    const [u] = await db.query("select * from app_user where username = $1", [name]);
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
      await loginEvent(db, req, "LOGIN_GAGAL", { user: u || null, username: name,
        note: !u ? "username tidak ada" : !u.active ? "akun nonaktif" : "password salah" });
      fail("Username atau password salah", 401);
    }
    await createSession(db, req, res, u);
    await loginEvent(db, req, "LOGIN", { user: u });
    return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, must_change_password: u.must_change_password };
  }));

  r.post("/logout", route(async (req, res) => {
    if (req.user) await loginEvent(db, req, "LOGOUT", { user: req.user });
    await destroySession(db, req, res);
    return { ok: true };
  }));

  r.get("/me", route(async (req) => {
    if (!req.user) fail("Belum login", 401);
    return req.user;
  }));

  // Ganti password sendiri. Sesi lain (perangkat lain) dikeluarkan, sesi ini tetap.
  r.post("/me/password", requireLogin, route(async (req) => {
    const { old_password, new_password } = req.body || {};
    const [u] = await db.query("select * from app_user where id = $1", [req.user.id]);
    if (!verifyPassword(old_password, u.password_hash)) fail("Password lama salah");
    checkPassword(new_password);
    if (old_password === new_password) fail("Password baru harus beda dengan password lama");
    await db.tx(async (t) => {
      await t.query("update app_user set password_hash = $1, must_change_password = false, password_changed_at = now() where id = $2",
        [hashPassword(new_password), u.id]);
      await t.query("delete from app_session where user_id = $1 and id <> $2", [u.id, req.sessionId]);
      await loginEvent(t, req, "GANTI_PASSWORD", { user: u });
    });
    return { ok: true };
  }));

  // Sesi login saya (perangkat / browser yang sedang masuk)
  r.get("/me/sessions", requireLogin, route(async (req) => db.query(
    `select id, created_at, last_seen_at, expires_at, ip, user_agent, id = $2 as current
     from app_session where user_id = $1 and expires_at > now() order by last_seen_at desc`, [req.user.id, req.sessionId])));

  r.delete("/me/sessions/:id", requireLogin, route(async (req) => {
    const id = Number(req.params.id);
    if (id === req.sessionId) fail("Ini sesi yang sedang dipakai. Pakai Keluar untuk sesi ini.");
    const rows = await db.query("delete from app_session where id = $1 and user_id = $2 returning id", [id, req.user.id]);
    if (!rows.length) fail("Sesi tidak ditemukan", 404);
    await loginEvent(db, req, "SESI_DIHAPUS", { user: req.user, note: `sesi #${id}` });
    return { ok: true };
  }));

  // Keluar dari semua perangkat lain (sesi ini tetap)
  r.post("/me/sessions/logout-others", requireLogin, route(async (req) => {
    const rows = await db.query("delete from app_session where user_id = $1 and id <> $2 returning id", [req.user.id, req.sessionId]);
    await loginEvent(db, req, "KELUAR_SEMUA", { user: req.user, note: `${rows.length} sesi lain dikeluarkan` });
    return { removed: rows.length };
  }));

  // ---------------------------------------------------------------- kelola user (ADMIN)
  r.get("/users", requireRole(ROLES.ADMIN), route(() =>
    db.query(`select u.id, u.username, u.display_name, u.email, u.role, u.active, u.created_at, u.last_login_at, u.must_change_password,
                     (select count(*) from app_session s where s.user_id = u.id and s.expires_at > now())::int as sesi
              from app_user u order by u.username`)));

  // akun baru: password sementara dari ADMIN, wajib diganti saat login pertama
  r.post("/users", requireRole(ROLES.ADMIN), route((req) => db.tx(async (t) => {
    const b = req.body || {};
    checkPassword(b.password);
    const row = pick(b, ["username", "display_name", "email", "role"]);
    row.username = String(row.username || "").trim().toLowerCase();
    row.password_hash = hashPassword(b.password);
    row.must_change_password = true;
    const id = await insertRow(t, "app_user", row);
    await audit(t, req, "app_user", id, "create", { username: row.username, role: row.role });
    return { id };
  })));

  r.put("/users/:id", requireRole(ROLES.ADMIN), route((req) => db.tx(async (t) => {
    const b = req.body || {};
    const row = pick(b, ["display_name", "email", "role", "active"]);
    if (b.password) {
      checkPassword(b.password);
      row.password_hash = hashPassword(b.password);
      row.must_change_password = true;     // password dari ADMIN = sementara
    }
    if (Number(req.params.id) === req.user.id && (row.role && row.role !== "ADMIN" || row.active === false)) {
      fail("Tidak bisa menurunkan role / menonaktifkan akun sendiri");
    }
    await updateRow(t, "app_user", Number(req.params.id), row);
    if (row.password_hash || row.active === false) await t.query("delete from app_session where user_id = $1", [req.params.id]);
    await audit(t, req, "app_user", Number(req.params.id), "update", { ...row, password_hash: row.password_hash ? "(diganti)" : undefined });
    return { ok: true };
  })));

  // keluarkan user dari semua perangkat (mis. HP hilang). Kalau akun sendiri, sesi yang sedang dipakai tetap.
  r.post("/users/:id/logout-all", requireRole(ROLES.ADMIN), route(async (req) => {
    const id = Number(req.params.id);
    const [u] = await db.query("select id, username from app_user where id = $1", [id]);
    if (!u) fail("User tidak ditemukan", 404);
    const rows = await db.query("delete from app_session where user_id = $1 and id <> $2 returning id", [id, id === req.user.id ? req.sessionId : 0]);
    await loginEvent(db, req, "KELUAR_SEMUA", { user: u, note: `oleh ADMIN ${req.user.username}: ${rows.length} sesi` });
    await audit(db, req, "app_user", id, "logout_all", { sesi: rows.length });
    return { removed: rows.length };
  }));

  // catatan login (berhasil / gagal / logout), terbaru dulu
  r.get("/login-events", requireRole(ROLES.ADMIN), route((req) => db.query(
    `select e.*, u.display_name from login_event e left join app_user u on u.id = e.user_id
     where ($1::int is null or e.user_id = $1) order by e.id desc limit 500`, [req.query.user_id ? Number(req.query.user_id) : null])));

  r.get("/audit", requireRole(ROLES.ADMIN), route((req) => db.query(
    `select a.*, u.username from audit_log a left join app_user u on u.id = a.user_id
     where ($1::text is null or a.entity = $1) and ($2::int is null or a.entity_id = $2)
     order by a.id desc limit 300`, [req.query.entity || null, req.query.entity_id ? Number(req.query.entity_id) : null])));

  return r;
}

// Login, logout, user aktif, dan kelola user (ADMIN).
import express from "express";
import { hashPassword, verifyPassword, createSession, destroySession, requireRole, ROLES } from "../lib/auth.js";
import { route, fail, pick, insertRow, updateRow, audit } from "../lib/util.js";

export default function authRoutes(db) {
  const r = express.Router();

  r.post("/login", route(async (req, res) => {
    const { username, password } = req.body || {};
    const [u] = await db.query("select * from app_user where username = $1 and active", [String(username || "").trim().toLowerCase()]);
    if (!u || !verifyPassword(password, u.password_hash)) fail("Username atau password salah", 401);
    await createSession(db, res, u);
    return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
  }));

  r.post("/logout", route(async (req, res) => {
    await destroySession(db, req, res);
    return { ok: true };
  }));

  r.get("/me", route(async (req) => {
    if (!req.user) fail("Belum login", 401);
    return req.user;
  }));

  r.post("/me/password", requireRole(ROLES.READ), route(async (req) => {
    const { old_password, new_password } = req.body || {};
    const [u] = await db.query("select * from app_user where id = $1", [req.user.id]);
    if (!verifyPassword(old_password, u.password_hash)) fail("Password lama salah");
    if (String(new_password || "").length < 8) fail("Password baru minimal 8 karakter");
    await db.query("update app_user set password_hash = $1 where id = $2", [hashPassword(new_password), u.id]);
    await db.query("delete from app_session where user_id = $1", [u.id]);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- kelola user (ADMIN)
  r.get("/users", requireRole(ROLES.ADMIN), route(() =>
    db.query("select id, username, display_name, email, role, active, created_at, last_login_at from app_user order by username")));

  r.post("/users", requireRole(ROLES.ADMIN), route((req) => db.tx(async (t) => {
    const b = req.body || {};
    if (String(b.password || "").length < 8) fail("Password minimal 8 karakter");
    const row = pick(b, ["username", "display_name", "email", "role"]);
    row.username = String(row.username || "").trim().toLowerCase();
    row.password_hash = hashPassword(b.password);
    const id = await insertRow(t, "app_user", row);
    await audit(t, req, "app_user", id, "create", { username: row.username, role: row.role });
    return { id };
  })));

  r.put("/users/:id", requireRole(ROLES.ADMIN), route((req) => db.tx(async (t) => {
    const b = req.body || {};
    const row = pick(b, ["display_name", "email", "role", "active"]);
    if (b.password) {
      if (String(b.password).length < 8) fail("Password minimal 8 karakter");
      row.password_hash = hashPassword(b.password);
    }
    if (Number(req.params.id) === req.user.id && (row.role && row.role !== "ADMIN" || row.active === false)) {
      fail("Tidak bisa menurunkan role / menonaktifkan akun sendiri");
    }
    await updateRow(t, "app_user", Number(req.params.id), row);
    if (row.password_hash || row.active === false) await t.query("delete from app_session where user_id = $1", [req.params.id]);
    await audit(t, req, "app_user", Number(req.params.id), "update", { ...row, password_hash: row.password_hash ? "(diganti)" : undefined });
    return { ok: true };
  })));

  r.get("/audit", requireRole(ROLES.ADMIN), route((req) => db.query(
    `select a.*, u.username from audit_log a left join app_user u on u.id = a.user_id
     where ($1::text is null or a.entity = $1) and ($2::int is null or a.entity_id = $2)
     order by a.id desc limit 300`, [req.query.entity || null, req.query.entity_id ? Number(req.query.entity_id) : null])));

  return r;
}

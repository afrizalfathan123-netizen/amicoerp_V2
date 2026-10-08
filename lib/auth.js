// Login, sesi (cookie httpOnly), dan pembatasan role.
//
// Role:  ADMIN        semua, termasuk user, persetujuan pengajuan, impor data
//        FINANCE      keuangan (invoice, pengajuan, pembayaran), master partner/rekening/price book, edit job
//        OPERATIONAL  job & operasional (gate, SJ, tracker), master lokasi/kendaraan/SLA; keuangan hanya baca
//        VIEWER       hanya baca
import crypto from "node:crypto";
import { CONFIG } from "../config.js";
import { fail } from "./util.js";

const COOKIE = "amico_sid";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function createSession(db, res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  const days = CONFIG.sessionDays;
  await db.query("insert into app_session (token, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)", [token, user.id, String(days)]);
  await db.query("update app_user set last_login_at = now() where id = $1", [user.id]);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${res.req?.secure ? "; Secure" : ""}`);
}

export async function destroySession(db, req, res) {
  const token = readCookie(req, COOKIE);
  if (token) await db.query("delete from app_session where token = $1", [token]);
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${res.req?.secure ? "; Secure" : ""}`);
}

// Pasang req.user kalau sesi valid
export function sessionMiddleware(db) {
  return async (req, _res, next) => {
    try {
      const token = readCookie(req, COOKIE);
      if (token) {
        const [u] = await db.query(
          `select u.id, u.username, u.display_name, u.role from app_session s join app_user u on u.id = s.user_id
           where s.token = $1 and s.expires_at > now() and u.active`, [token]);
        if (u) req.user = u;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const ROLES = {
  READ: ["ADMIN", "FINANCE", "OPERATIONAL", "VIEWER"],
  FINANCE: ["ADMIN", "FINANCE"],
  OPS: ["ADMIN", "OPERATIONAL"],
  JOB_EDIT: ["ADMIN", "FINANCE", "OPERATIONAL"],
  ADMIN: ["ADMIN"],
};

export function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Silakan login dulu" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: `Tidak punya akses (perlu ${roles.join(" / ")})` });
    next();
  };
}

export function assertRole(req, roles) {
  if (!req.user || !roles.includes(req.user.role)) fail(`Tidak punya akses (perlu ${roles.join(" / ")})`, 403);
}

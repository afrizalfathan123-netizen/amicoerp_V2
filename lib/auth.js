// Login, sesi (cookie httpOnly), dan pembatasan role.
//
// Role:  ADMIN        semua, termasuk user, pengaturan, impor data
//        FINANCE      keuangan: invoice customer, menyetujui & membayar pengajuan vendor, batal bayar, uang kembali,
//                     transfer, master partner / rekening / price book, job
//        OPERATIONAL  job (termasuk cost; selling boleh, utamanya diisi finance), tracker / gate / SJ, master lokasi /
//                     kendaraan / SLA, MEMBUAT pengajuan vendor (DP, pelunasan, calo) dan pengajuan uang kembali;
//                     halaman keuangan hanya baca (mis. untuk mengecek kekurangan bayar lalu mengajukannya)
//        VIEWER       hanya baca
//
// Sesi: token acak di cookie; di database hanya disimpan HASH-nya (sha256). Sesi habis setelah SESSION_DAYS hari,
// atau lebih cepat kalau tidak dipakai SESSION_IDLE_HOURS jam. Akun baru / password direset ADMIN wajib ganti
// password dulu (must_change_password): selama itu hanya /me, /me/password, /me/sessions, /logout yang bisa dipakai.
import crypto from "node:crypto";
import { CONFIG } from "../config.js";
import { fail } from "./util.js";

const COOKIE = "amico_sid";
export const tokenHash = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");

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

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const client = (req) => ({ ip: String(req.ip || "").slice(0, 64) || null, user_agent: String(req.headers["user-agent"] || "").slice(0, 300) || null });

// Catatan login (berhasil / gagal / logout / keluar semua). Tidak pernah menyimpan password.
export async function loginEvent(db, req, event, { user = null, username = null, note = null } = {}) {
  const c = client(req);
  await db.query(
    "insert into login_event (username, user_id, event, note, ip, user_agent) values ($1, $2, $3, $4, $5, $6)",
    [user?.username || (username ? String(username).slice(0, 60) : null), user?.id || null, event, note, c.ip, c.user_agent]);
}

export async function createSession(db, req, res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  const days = CONFIG.sessionDays;
  const c = client(req);
  await db.query(
    "insert into app_session (token, user_id, expires_at, ip, user_agent) values ($1, $2, now() + ($3 || ' days')::interval, $4, $5)",
    [tokenHash(token), user.id, String(days), c.ip, c.user_agent]);
  await db.query("update app_user set last_login_at = now() where id = $1", [user.id]);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${req.secure ? "; Secure" : ""}`);
}

export async function destroySession(db, req, res) {
  const token = readCookie(req);
  if (token) await db.query("delete from app_session where token = $1", [tokenHash(token)]);
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${req.secure ? "; Secure" : ""}`);
}

// Pasang req.user (+ req.sessionId) kalau sesi valid: belum lewat batas hari dan masih dipakai dalam SESSION_IDLE_HOURS jam.
// "Terakhir dipakai" diperbarui paling sering sekali semenit supaya tidak menulis ke database di setiap permintaan.
export function sessionMiddleware(db) {
  return async (req, _res, next) => {
    try {
      const token = readCookie(req);
      if (token) {
        const [u] = await db.query(
          `select u.id, u.username, u.display_name, u.role, u.must_change_password, s.id as session_id,
                  s.last_seen_at < now() - interval '1 minute' as stale
           from app_session s join app_user u on u.id = s.user_id
           where s.token = $1 and s.expires_at > now() and u.active
             and s.last_seen_at > now() - ($2 || ' hours')::interval`, [tokenHash(token), String(CONFIG.sessionIdleHours)]);
        if (u) {
          if (u.stale) await db.query("update app_session set last_seen_at = now() where id = $1", [u.session_id]);
          req.sessionId = u.session_id;
          delete u.stale;
          delete u.session_id;
          req.user = u;
        }
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
  REQUEST: ["ADMIN", "FINANCE", "OPERATIONAL"],     // membuat pengajuan vendor & pengajuan uang kembali
  ADMIN: ["ADMIN"],
};

const MUST_CHANGE = "Ganti password dulu sebelum memakai aplikasi";

// Sudah login (boleh selama wajib ganti password): untuk /me, /me/password, /me/sessions
export function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Silakan login dulu" });
  next();
}

export function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Silakan login dulu" });
    if (req.user.must_change_password) return res.status(403).json({ error: MUST_CHANGE, must_change_password: true });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: `Tidak punya akses (perlu ${roles.join(" / ")})` });
    next();
  };
}

export function assertRole(req, roles) {
  if (!req.user || !roles.includes(req.user.role)) fail(`Tidak punya akses (perlu ${roles.join(" / ")})`, 403);
}

// Helper bersama untuk route.
import { CONFIG } from "../config.js";

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export const fail = (msg, status = 400) => { throw new UserError(msg, status); };

export const money = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  // "1.500.000" atau "1500000" atau "1500000.5"
  const s = String(v).trim();
  const n = /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
export const rupiah = (v) => Number(v || 0).toLocaleString("id-ID");
export const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: CONFIG.timezone });
const blank = (v) => (v === "" || v === undefined ? null : v);

// Bungkus handler express: hasil -> JSON, UserError -> 4xx dengan pesan, lainnya -> 500
export const route = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// insert / update dari objek. Hanya kolom di `allowed` yang dipakai.
export function pick(body, allowed) {
  const out = {};
  for (const k of allowed) if (k in body) out[k] = blank(body[k]);
  return out;
}

export async function insertRow(t, table, row, returning = "id") {
  const cols = Object.keys(row);
  if (!cols.length) fail("Data kosong");
  const sql = `insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning ${returning}`;
  const [r] = await t.query(sql, cols.map((c) => row[c]));
  return returning === "id" ? r.id : r;
}

export async function updateRow(t, table, id, row) {
  const cols = Object.keys(row);
  if (!cols.length) return;
  const sql = `update ${table} set ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} where id = $${cols.length + 1}`;
  await t.query(sql, [...cols.map((c) => row[c]), id]);
}

// Nomor dokumen berurutan per periode (kunci baris di dalam transaksi)
export async function nextNumber(t, key, prefix, pad = 4) {
  const [r] = await t.query(
    `insert into ir_sequence (name, next_number) values ($1, 2)
     on conflict (name) do update set next_number = ir_sequence.next_number + 1
     returning next_number - 1 as n`, [key]);
  return `${prefix}${String(r.n).padStart(pad, "0")}`;
}

export async function audit(t, req, entity, entityId, action, detail = null) {
  await t.query("insert into audit_log (user_id, entity, entity_id, action, detail) values ($1, $2, $3, $4, $5)",
    [req.user?.id ?? null, entity, entityId ?? null, action, detail ? JSON.stringify(detail) : null]);
}

export async function setting(q, key, fallback = null) {
  const [r] = await q.query("select value from app_setting where key = $1", [key]);
  return r ? r.value : fallback;
}

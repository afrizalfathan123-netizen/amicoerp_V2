// Master data: partner (+ rekening), rekening AMICO, lokasi, kendaraan, price book, SLA rute, pengaturan.
import express from "express";
import { requireRole, ROLES } from "../lib/auth.js";
import { route, fail, pick, insertRow, updateRow, audit } from "../lib/util.js";

// tabel -> kolom yang boleh diisi + siapa yang boleh menulis
const MASTER = {
  partners: {
    table: "res_partner", write: ROLES.FINANCE, order: "name",
    fields: ["code", "name", "is_customer", "is_vendor", "phone", "email", "address", "npwp", "bill_to_name", "bill_to_address",
      "bill_to_npwp", "pph_pct", "ppn_pct", "payment_terms_days", "active"],
  },
  "partner-banks": {
    table: "res_partner_bank", write: ROLES.JOB_EDIT, order: "partner_id, id",
    fields: ["partner_id", "bank_name", "account_number", "holder", "is_default", "active"],
  },
  banks: {
    table: "res_bank_account", write: ROLES.FINANCE, order: "kind, id",
    fields: ["name", "bank_name", "account_number", "holder", "kind", "for_tax_invoice", "is_default", "active"],
  },
  locations: { table: "location", write: ROLES.JOB_EDIT, order: "code", fields: ["code", "name", "province", "active"] },
  vehicles: { table: "vehicle", write: ROLES.JOB_EDIT, order: "plate_number", fields: ["plate_number", "truck_type", "owner_partner_id", "pic", "active"] },
  pricelist: {
    table: "pricelist_item", write: ROLES.FINANCE, order: "id",
    fields: ["customer_id", "pol_id", "pod_id", "truck_type", "trip_type", "selling", "cost", "effective_from", "effective_to", "active"],
  },
  "route-sla": { table: "route_sla", write: ROLES.JOB_EDIT, order: "id", fields: ["pol_id", "pod_id", "trip_type", "sla_hours"] },
  products: { table: "product", write: [], order: "id", fields: [] },
};

const SETTING_KEYS = ["company_name", "company_address", "company_npwp", "vendor_approval_required"];

export default function masterRoutes(db) {
  const r = express.Router();

  for (const [name, cfg] of Object.entries(MASTER)) {
    r.get(`/${name}`, requireRole(ROLES.READ), route(() => db.query(`select * from ${cfg.table} order by ${cfg.order}`)));
    if (!cfg.write.length) continue;
    r.post(`/${name}`, requireRole(cfg.write), route((req) => db.tx(async (t) => {
      const row = pick(req.body || {}, cfg.fields);
      if (name === "partners") row.code = String(row.code || "").trim().toUpperCase() || null;
      if (name === "locations") row.code = String(row.code || "").trim().toUpperCase() || null;
      if (name === "vehicles") row.plate_number = String(row.plate_number || "").trim().toUpperCase() || null;
      const id = await insertRow(t, cfg.table, row);
      await audit(t, req, cfg.table, id, "create", row);
      return { id };
    })));
    r.put(`/${name}/:id`, requireRole(cfg.write), route((req) => db.tx(async (t) => {
      const row = pick(req.body || {}, cfg.fields);
      await updateRow(t, cfg.table, Number(req.params.id), row);
      await audit(t, req, cfg.table, Number(req.params.id), "update", row);
      return { ok: true };
    })));
  }

  // Cari harga di price book: harga khusus customer dulu, lalu harga umum; yang berlaku pada tanggal job.
  r.get("/price-lookup", requireRole(ROLES.READ), route((req) => findPrice(db, req.query)));

  r.get("/settings", requireRole(ROLES.READ), route(async () => {
    const rows = await db.query("select key, value from app_setting");
    return Object.fromEntries(rows.map((x) => [x.key, x.value]));
  }));
  r.put("/settings", requireRole(ROLES.ADMIN), route((req) => db.tx(async (t) => {
    for (const k of SETTING_KEYS) {
      if (!(k in (req.body || {}))) continue;
      await t.query("insert into app_setting (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value",
        [k, JSON.stringify(req.body[k])]);
    }
    await audit(t, req, "app_setting", null, "update", req.body);
    return { ok: true };
  })));

  return r;
}

export async function findPrice(q, { customer_id, pol_id, pod_id, truck_type, trip_type, date }) {
  if (!pol_id || !pod_id || !truck_type) return null;
  const rows = await q.query(
    `select * from pricelist_item
     where active and pol_id = $1 and pod_id = $2 and upper(truck_type) = upper($3) and trip_type = $4
       and (customer_id = $5 or customer_id is null)
       and (effective_from is null or effective_from <= coalesce($6::date, current_date))
       and (effective_to is null or effective_to >= coalesce($6::date, current_date))
     order by customer_id is null, effective_from desc nulls last`,
    [Number(pol_id), Number(pod_id), truck_type, trip_type || "ONE_WAY", customer_id ? Number(customer_id) : null, date || null]);
  if (!rows.length) return null;
  // selling dan cost bisa berasal dari baris berbeda (harga jual khusus customer, cost umum)
  const selling = rows.find((x) => x.selling != null);
  const cost = rows.find((x) => x.cost != null);
  return {
    selling: selling ? selling.selling : null,
    cost: cost ? cost.cost : null,
    selling_source: selling ? (selling.customer_id ? "khusus customer" : "umum") : null,
    cost_source: cost ? (cost.customer_id ? "khusus customer" : "umum") : null,
  };
}

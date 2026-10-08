// Job: buat / ubah (termasuk ganti rute), baris order (selling, cost, calo, tol, ...), top-up, perjalanan (gate, posisi, SJ).
import express from "express";
import { requireRole, ROLES } from "../lib/auth.js";
import { route, fail, money, rupiah, pick, insertRow, updateRow, nextNumber, audit } from "../lib/util.js";
import { findPrice } from "./master.js";

const KINDS = ["TRUCKING", "CALO", "TOL", "PARKIR", "BONGKAR", "LAINNYA"];
const HEADER_FIELDS = ["job_date", "customer_id", "vendor_id", "pol_id", "pod_id", "trip_type", "service_type", "delivery_scope",
  "rit_number", "truck_type", "vehicle_id", "plate_number", "driver1_name", "driver1_phone", "driver2_name", "driver2_phone",
  "do_number", "customer_scheme", "vendor_scheme", "selling_after_tax", "note"];
const TRIP_FIELDS = ["gate_out_at", "gate_in_at", "sj_number", "sj_resi_received_at", "sj_received_at", "sj_resi_number",
  "sj_delivered_at", "sj_delivered_resi_number"];

const productId = async (t, kind) => (await t.query("select id from product where kind = $1", [kind]))[0].id;

// Rekening baru langsung dari form job (pemilik rekening boleh beda dengan vendor, mis. PT ABC -> rekening Fulan)
async function newVendorBank(t, b, vendorId) {
  if (!String(b.new_account_number || "").trim()) return;
  if (!vendorId) fail("Pilih vendor dulu sebelum menambah rekening");
  if (!String(b.new_bank_name || "").trim() || !String(b.new_holder || "").trim()) fail("Rekening baru: isi bank, nomor, dan atas nama");
  const [r] = await t.query(
    `insert into res_partner_bank (partner_id, bank_name, account_number, holder) values ($1, $2, $3, $4)
     on conflict (partner_id, bank_name, account_number) do update set holder = excluded.holder, active = true returning id`,
    [Number(vendorId), String(b.new_bank_name).trim().toUpperCase(), String(b.new_account_number).replace(/\s+/g, ""), String(b.new_holder).trim()]);
  b.vendor_bank_id = r.id;
}

// Skema bayar default: dari setting partner, kalau kosong dalam kota 100% / antar kota 70/30. Vendor tidak ada 50/50.
async function defaultSchemes(t, row) {
  const pick1 = async (id) => (id ? (await t.query("select payment_scheme from res_partner where id = $1", [Number(id)]))[0]?.payment_scheme : null);
  const scope = row.delivery_scope === "INNERCITY" ? "FULL" : "70_30";
  if (!row.customer_scheme) row.customer_scheme = (await pick1(row.customer_id)) || scope;
  if (!row.vendor_scheme) {
    const v = await pick1(row.vendor_id);
    row.vendor_scheme = v === "FULL" || v === "70_30" ? v : scope;
  }
  if (!["70_30", "50_50", "FULL"].includes(row.customer_scheme)) fail("Skema customer tidak dikenal");
  if (!["70_30", "FULL"].includes(row.vendor_scheme)) fail("Skema vendor hanya 70/30 atau 100%");
}

// Selling & cost dari mode selling + price book
async function resolveAmounts(t, b) {
  const mode = b.selling_mode || "PRICE_BOOK";
  const price = await findPrice(t, { ...b, date: b.job_date });
  let selling;
  if (mode === "ZERO") selling = 0;
  else if (mode === "CUSTOM") selling = money(b.selling);
  else {
    if (price?.selling == null) fail("Price book untuk rute + truk + trip ini belum ada. Pilih Custom atau isi price book dulu.");
    selling = price.selling;
  }
  const cost = b.cost === "" || b.cost == null ? (price?.cost ?? 0) : money(b.cost);
  return { mode, selling, cost };
}

export async function jobLineStatus(t, jobId) {
  return t.query(
    `select s.*, p.name as product, pt.name as partner, pb.bank_name, pb.account_number, pb.holder
     from v_job_line_status s join product p on p.kind = s.kind
     left join res_partner pt on pt.id = s.partner_id left join res_partner_bank pb on pb.id = s.partner_bank_id
     where s.job_id = $1 order by s.side desc, (s.kind <> 'TRUCKING'), s.job_line_id`, [jobId]);
}

export default function jobRoutes(db) {
  const r = express.Router();

  r.get("/jobs", requireRole(ROLES.READ), route(async (req) => {
    const where = [];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const p = `$${params.length}`;
      where.push(`(j.job_number ilike ${p} or j.plate_number ilike ${p} or j.do_number ilike ${p} or c.name ilike ${p} or j.driver1_name ilike ${p})`);
    }
    if (req.query.stage) add("st.stage = ?", req.query.stage);
    if (req.query.state === "kurang_transfer") where.push("kt.job_id is not null");
    else if (req.query.state) add("j.state = ?", req.query.state);
    if (req.query.from) add("j.job_date >= ?", req.query.from);
    if (req.query.to) add("j.job_date <= ?", req.query.to);
    if (req.query.customer_id) add("j.customer_id = ?", Number(req.query.customer_id));
    if (req.query.scope) add("j.delivery_scope = ?", req.query.scope);
    const limit = Math.min(Number(req.query.limit || 300), 2000);
    const offset = Number(req.query.offset || 0);
    return db.query(
      `select j.*, c.name as customer, v.name as vendor, lp.code as pol, ld.code as pod,
              b.selling, b.cost, b.invoiced, b.received, b.requested, b.paid,
              kt.vendor as kurang_transfer_vendor, kt.customer as kurang_bayar_customer,
              st.stage, st.trip_status, st.sj_status, st.customer_status, st.vendor_status, st.sj_late, st.lead_time_sj
       from job j
       join v_job_status st on st.job_id = j.id
       join res_partner c on c.id = j.customer_id
       left join res_partner v on v.id = j.vendor_id
       join location lp on lp.id = j.pol_id
       join location ld on ld.id = j.pod_id
       join v_job_balance b on b.job_id = j.id
       left join (
         select job_id, sum(kurang) filter (where side = 'PURCHASE') as vendor, sum(kurang) filter (where side = 'SALE') as customer
         from v_kurang_transfer group by job_id
       ) kt on kt.job_id = j.id
       ${where.length ? "where " + where.join(" and ") : ""}
       order by j.job_date desc, j.id desc limit ${limit} offset ${offset}`, params);
  }));

  r.get("/jobs/:id", requireRole(ROLES.READ), route(async (req) => {
    const id = Number(req.params.id);
    const [job] = await db.query(
      `select j.*, c.name as customer, c.pph_pct, c.ppn_pct, v.name as vendor, lp.code as pol, ld.code as pod,
              lp.name as pol_name, ld.name as pod_name
       from job j join res_partner c on c.id = j.customer_id left join res_partner v on v.id = j.vendor_id
       join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id where j.id = $1`, [id]);
    if (!job) fail("Job tidak ditemukan", 404);
    const [balance] = await db.query("select * from v_job_balance where job_id = $1", [id]);
    const moves = await db.query(
      `select m.id, m.number, m.move_type, m.phase, m.state, m.approval_state, m.payment_channel, m.move_date,
              coalesce(pt.name, ml.payee_holder) as partner, ml.amount, ml.cancelled_at, ml.job_line_id is null as tanpa_tujuan
       from account_move_line ml join account_move m on m.id = ml.move_id
       left join res_partner pt on pt.id = coalesce(m.partner_id, ml.payee_partner_id)
       where ml.job_id = $1 order by m.move_date, m.id`, [id]);
    return {
      job, balance,
      lines: await jobLineStatus(db, id),
      moves,
      ledger: await db.query("select * from v_cash_ledger where job_id = $1 order by tanggal, id", [id]),
      position: await db.query("select * from v_job_phase_position where job_id = $1 order by side desc, phase", [id]),
      kurang_transfer: await db.query("select * from v_kurang_transfer where job_id = $1 order by side desc", [id]),
      status: (await db.query("select * from v_job_status where job_id = $1", [id]))[0],
      reroutes: await db.query(
        `select a.at, a.detail, u.display_name as by_name from audit_log a left join app_user u on u.id = a.user_id
         where a.entity = 'job' and a.entity_id = $1 and a.action = 'reroute' order by a.id`, [id]),
      sj_deliveries: await db.query(
        `select d.* from sj_delivery d join sj_delivery_line l on l.delivery_id = d.id where l.job_id = $1 order by d.id`, [id]),
      unassigned: await db.query("select * from v_unassigned where job_id = $1 order by move_date, move_line_id", [id]),
      trip_updates: await db.query(
        `select tu.*, u.display_name as by_name from trip_update tu left join app_user u on u.id = tu.created_by
         where tu.job_id = $1 order by tu.at desc`, [id]),
      audit: await db.query(
        `select a.at, a.action, a.detail, u.display_name as by_name from audit_log a left join app_user u on u.id = a.user_id
         where a.entity in ('job', 'job_line') and (a.entity_id = $1 or (a.detail->>'job_id')::int = $1)
         order by a.id desc limit 50`, [id]),
    };
  }));

  r.post("/jobs", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const b = req.body || {};
    for (const f of ["job_date", "customer_id", "pol_id", "pod_id", "truck_type"]) if (!b[f]) fail(`${f} wajib diisi`);
    const { mode, selling, cost } = await resolveAmounts(t, b);
    const yymm = String(b.job_date).slice(2, 4) + String(b.job_date).slice(5, 7);
    const row = pick(b, HEADER_FIELDS);
    row.job_number = b.job_number ? String(b.job_number).trim() : await nextNumber(t, `JOB/${yymm}`, `AMC/${yymm}/`);
    row.selling_mode = mode;
    await defaultSchemes(t, row);
    await newVendorBank(t, b, b.vendor_id);
    if (row.plate_number) row.plate_number = String(row.plate_number).trim().toUpperCase();
    row.created_by = req.user.id;
    const id = await insertRow(t, "job", row);
    await insertRow(t, "job_line", { job_id: id, side: "SALE", product_id: await productId(t, "TRUCKING"),
      partner_id: Number(b.customer_id), description: "Jasa trucking", amount: selling });
    await insertRow(t, "job_line", { job_id: id, side: "PURCHASE", product_id: await productId(t, "TRUCKING"),
      partner_id: b.vendor_id ? Number(b.vendor_id) : null, partner_bank_id: b.vendor_bank_id ? Number(b.vendor_bank_id) : null,
      description: "Sewa truk", amount: cost });
    await audit(t, req, "job", id, "create", { job_number: row.job_number, selling, cost });
    return { id, job_number: row.job_number };
  })));

  // Ubah job, termasuk ganti rute / truk (harga dihitung ulang). Nominal tidak boleh turun di bawah yang sudah ditagih/diajukan.
  r.put("/jobs/:id", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const [job] = await t.query("select * from job where id = $1 for update", [id]);
    if (!job) fail("Job tidak ditemukan", 404);
    if (job.state === "cancelled") fail("Job sudah dibatalkan");
    const merged = { ...job, ...b, selling_mode: b.selling_mode || job.selling_mode };
    await newVendorBank(t, b, merged.vendor_id);
    const row = pick(b, HEADER_FIELDS);
    if (row.plate_number) row.plate_number = String(row.plate_number).trim().toUpperCase();

    const main = await t.query(
      "select s.* from v_job_line_status s where s.job_id = $1 and s.kind = 'TRUCKING' order by s.job_line_id", [id]);
    const sale = main.find((x) => x.side === "SALE");
    const purchase = main.find((x) => x.side === "PURCHASE");
    if (sale?.billed > 0 && row.customer_scheme && row.customer_scheme !== job.customer_scheme) fail("Skema customer tidak bisa diganti karena sudah ditagih");
    if (purchase?.billed > 0 && row.vendor_scheme && row.vendor_scheme !== job.vendor_scheme) fail("Skema vendor tidak bisa diganti karena sudah diajukan");
    if (row.customer_scheme && !["70_30", "50_50", "FULL"].includes(row.customer_scheme)) fail("Skema customer tidak dikenal");
    if (row.vendor_scheme && !["70_30", "FULL"].includes(row.vendor_scheme)) fail("Skema vendor hanya 70/30 atau 100%");
    if (sale?.billed > 0 && row.customer_id && Number(row.customer_id) !== job.customer_id) fail("Customer tidak bisa diganti karena sudah ditagih");

    // Hitung ulang harga hanya kalau rute / truk / customer / mode selling / nominal memang berubah,
    // supaya perubahan price book tidak diam-diam mengubah job lama.
    const changed = (k) => k in b && String(b[k] ?? "").toUpperCase() !== String(job[k] ?? "").toUpperCase();
    // Ganti rute / truk setelah ada pengajuan / invoice = reroute: wajib alasan, dicatat sebelum -> sesudah
    const routeChanged = ["pol_id", "pod_id", "trip_type", "truck_type"].some(changed);
    const [docs] = await t.query(
      `select count(*)::int as n from account_move_line ml join account_move m on m.id = ml.move_id
       where ml.job_id = $1 and m.state = 'posted' and ml.cancelled_at is null`, [id]);
    if (routeChanged && docs.n > 0 && !String(b.reason || "").trim()) {
      fail("Job ini sudah punya pengajuan / invoice. Isi alasan ganti rute (mis. reroute permintaan gudang).");
    }
    const routeName = async (pol, pod, trip) => {
      const [x] = await t.query("select (select code from location where id = $1) || ' - ' || (select code from location where id = $2) as r", [pol, pod]);
      return `${x.r}${trip === "ROUND_TRIP" ? " PP" : ""}`;
    };
    const before = routeChanged ? { rute: await routeName(job.pol_id, job.pod_id, job.trip_type), truk: job.truck_type, selling: sale?.amount ?? 0, cost: purchase?.amount ?? 0 } : null;
    const mode = b.selling_mode || job.selling_mode;
    const pricingChanged = ["pol_id", "pod_id", "truck_type", "trip_type", "customer_id", "selling_mode"].some(changed)
      || (mode === "CUSTOM" && "selling" in b && b.selling !== "" && money(b.selling) !== sale?.amount)
      || ("cost" in b && b.cost !== "" && b.cost != null && money(b.cost) !== purchase?.amount);
    if (pricingChanged) {
      // ganti rute tanpa isi cost = cost dari price book rute baru; selain itu cost lama / yang diisi
      const keepCost = "cost" in b ? b.cost : routeChanged ? "" : purchase?.amount;
      const { mode, selling, cost } = await resolveAmounts(t, {
        ...merged, cost: keepCost, selling: "selling" in b ? b.selling : sale?.amount });
      row.selling_mode = mode;
      if (sale) {
        if (selling < sale.billed) fail(`Selling ${rupiah(selling)} lebih kecil dari yang sudah ditagih (${rupiah(sale.billed)})`);
        await t.query("update job_line set amount = $1, partner_id = $2 where id = $3", [selling, Number(merged.customer_id), sale.job_line_id]);
      }
      if (purchase) {
        if (cost < purchase.billed) fail(`Cost ${rupiah(cost)} lebih kecil dari yang sudah diajukan (${rupiah(purchase.billed)})`);
        await t.query("update job_line set amount = $1 where id = $2", [cost, purchase.job_line_id]);
      }
    }
    if (purchase && ("vendor_id" in b || "vendor_bank_id" in b)) {
      await t.query("update job_line set partner_id = $1, partner_bank_id = $2 where id = $3",
        [merged.vendor_id ? Number(merged.vendor_id) : null, b.vendor_bank_id ? Number(b.vendor_bank_id) : null, purchase.job_line_id]);
    }
    row.updated_at = new Date().toISOString();
    await updateRow(t, "job", id, row);
    if (routeChanged) {
      const [now] = await t.query(
        `select (select amount from job_line where id = $1) as selling, (select amount from job_line where id = $2) as cost`,
        [sale?.job_line_id ?? 0, purchase?.job_line_id ?? 0]);
      await audit(t, req, "job", id, "reroute", {
        dari: before.rute, ke: await routeName(merged.pol_id, merged.pod_id, merged.trip_type), truk_dari: before.truk, truk_ke: merged.truck_type,
        selling_dari: before.selling, selling_ke: now.selling ?? 0, cost_dari: before.cost, cost_ke: now.cost ?? 0,
        alasan: String(b.reason || "").trim() || null, sudah_ada_dokumen: docs.n > 0,
      });
    } else {
      await audit(t, req, "job", id, pricingChanged ? "update_pricing" : "update", b);
    }
    return { ok: true };
  })));

  r.post("/jobs/:id/state", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const { state, reason } = req.body || {};
    if (!["confirmed", "done", "cancelled"].includes(state)) fail("State tidak dikenal");
    if (state === "cancelled") {
      const [m] = await t.query(
        `select count(*)::int n from account_move_line ml join account_move m on m.id = ml.move_id
         where ml.job_id = $1 and m.state <> 'cancelled' and ml.cancelled_at is null`, [id]);
      if (m.n > 0) fail("Batalkan dulu invoice/pengajuan job ini");
    }
    await t.query("update job set state = $1, updated_at = now() where id = $2", [state, id]);
    await audit(t, req, "job", id, `state_${state}`, { reason });
    return { ok: true };
  })));

  // ---------------------------------------------------------------- baris order
  r.post("/jobs/:id/lines", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const { side = "PURCHASE", kind, partner_id, partner_bank_id, amount, description } = req.body || {};
    if (!KINDS.includes(kind)) fail("Jenis biaya tidak dikenal");
    if (!["SALE", "PURCHASE"].includes(side)) fail("Sisi tidak dikenal");
    if (!(money(amount) > 0)) fail("Nominal harus lebih dari 0");
    const [job] = await t.query("select state, customer_id from job where id = $1", [id]);
    if (!job || job.state === "cancelled") fail("Job tidak aktif");
    const lineId = await insertRow(t, "job_line", {
      job_id: id, side, product_id: await productId(t, kind),
      partner_id: side === "SALE" ? job.customer_id : (partner_id ? Number(partner_id) : null),
      partner_bank_id: partner_bank_id ? Number(partner_bank_id) : null,
      description: description || null, amount: money(amount),
    });
    await audit(t, req, "job_line", lineId, "create", { job_id: id, side, kind, amount: money(amount), description });
    return { id: lineId };
  })));

  r.put("/job-lines/:id", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const [s] = await t.query("select * from v_job_line_status where job_line_id = $1", [id]);
    if (!s) fail("Baris tidak ditemukan", 404);
    const b = req.body || {};
    const amount = "amount" in b ? money(b.amount) : s.amount;
    if (amount < s.billed) fail(`Nominal tidak boleh di bawah yang sudah ditagih/diajukan (${rupiah(s.billed)})`);
    await t.query(
      `update job_line set amount = $1, description = coalesce($2, description),
         partner_id = case when $3::boolean then $4 else partner_id end,
         partner_bank_id = case when $3::boolean then $5 else partner_bank_id end
       where id = $6`,
      [amount, b.description || null, "partner_id" in b, b.partner_id ? Number(b.partner_id) : null,
       b.partner_bank_id ? Number(b.partner_bank_id) : null, id]);
    await audit(t, req, "job_line", id, "update", { job_id: s.job_id, from: s.amount, to: amount, reason: b.reason || null });
    return { ok: true };
  })));

  r.delete("/job-lines/:id", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const [used] = await t.query("select count(*)::int n from account_move_line where job_line_id = $1", [id]);
    if (used.n > 0) fail("Baris ini sudah dipakai di invoice/pengajuan");
    const [l] = await t.query("select jl.job_id, p.kind from job_line jl join product p on p.id = jl.product_id where jl.id = $1", [id]);
    if (!l) fail("Baris tidak ditemukan", 404);
    const [count] = await t.query(
      "select count(*)::int n from job_line jl join product p on p.id = jl.product_id where jl.job_id = $1 and p.kind = 'TRUCKING' and jl.side = (select side from job_line where id = $2)", [l.job_id, id]);
    if (l.kind === "TRUCKING" && count.n <= 1) fail("Baris trucking utama tidak bisa dihapus, ubah lewat edit job");
    await t.query("delete from job_line where id = $1", [id]);
    await audit(t, req, "job_line", id, "delete", { job_id: l.job_id });
    return { ok: true };
  })));

  // Top-up: cost truk naik (mis. biaya tambahan disepakati dengan vendor). Wajib alasan, tercatat di audit.
  r.post("/jobs/:id/topup", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const { amount, reason } = req.body || {};
    if (!(money(amount) > 0)) fail("Nominal top-up harus lebih dari 0");
    if (!String(reason || "").trim()) fail("Alasan top-up wajib diisi");
    const [line] = await t.query(
      `select jl.id, jl.amount from job_line jl join product p on p.id = jl.product_id
       where jl.job_id = $1 and jl.side = 'PURCHASE' and p.kind = 'TRUCKING' order by jl.id limit 1 for update`, [id]);
    if (!line) fail("Job tidak punya baris cost trucking");
    await t.query("update job_line set amount = amount + $1 where id = $2", [money(amount), line.id]);
    await audit(t, req, "job", id, "topup", { job_id: id, from: line.amount, to: line.amount + money(amount), reason });
    return { ok: true };
  })));

  // ---------------------------------------------------------------- perjalanan
  r.put("/jobs/:id/trip", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const row = pick(req.body || {}, TRIP_FIELDS);
    if (row.gate_out_at && row.gate_in_at && new Date(row.gate_in_at) < new Date(row.gate_out_at)) fail("Gate in tidak boleh sebelum gate out");
    row.updated_at = new Date().toISOString();
    await updateRow(t, "job", id, row);
    if (row.gate_in_at) await t.query("update job set state = 'done' where id = $1 and state = 'confirmed'", [id]);
    await audit(t, req, "job", id, "trip", row);
    return { ok: true };
  })));

  r.post("/jobs/:id/trip-updates", requireRole(ROLES.JOB_EDIT), route((req) => db.tx(async (t) => {
    const { location, note, at } = req.body || {};
    if (!String(location || "").trim()) fail("Posisi wajib diisi");
    const id = await insertRow(t, "trip_update", {
      job_id: Number(req.params.id), location: String(location).trim(), note: note || null,
      at: at || new Date().toISOString(), created_by: req.user.id });
    return { id };
  })));

  return r;
}

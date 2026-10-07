// Keuangan: invoice customer & pengajuan vendor (account_move), pembayaran (account_payment),
// persetujuan, batal (dokumen / per baris), transfer malam lewat kas operasional (internal_transfer).
//
// Aturan (dicek di dalam transaksi):
//   - Nominal tidak boleh melebihi sisa baris order; pengajuan berulang boleh tapi tidak lewat rencana.
//   - DP 70% sekali per job per sisi. DP / pelunasan hanya job skema 70/30; FULL hanya job skema 100%.
//   - Fase OTHER hanya untuk biaya vendor selain trucking (calo, tol, parkir, bongkar, lainnya).
//   - Pengajuan vendor harus disetujui ADMIN sebelum dibayar (kalau setting vendor_approval_required).
//   - Dokumen / baris yang sudah ada pembayaran tidak bisa dibatalkan sebelum pembayarannya dibalik.
//   - Transfer malam: dibayar ke vendor dari kas OPERATIONAL, maksimal sebesar dana yang sudah dikirim ke sana.
import express from "express";
import { requireRole, assertRole, ROLES } from "../lib/auth.js";
import { route, fail, money, rupiah, today, insertRow, nextNumber, audit, setting } from "../lib/util.js";

const PHASES = ["DP_70", "SETTLEMENT_30", "FULL", "OTHER"];

// ---------------------------------------------------------------- calon baris dokumen
// Customer: per job (nominal dibagi ke semua baris selling job itu). Vendor: per baris order.
export async function eligible(t, { move_type, phase, partner_id, job_ids, exclude_move_id = 0, search }) {
  if (!PHASES.includes(phase)) fail("Fase tidak dikenal");
  const sale = move_type === "out_invoice";
  if (sale && phase === "OTHER") fail("Invoice customer tidak memakai fase OTHER");
  const scheme = phase === "FULL" ? "FULL" : phase === "OTHER" ? null : "70_30";
  const params = [exclude_move_id || 0];
  const where = ["j.state <> 'cancelled'", `jl.side = '${sale ? "SALE" : "PURCHASE"}'`];
  if (!sale) where.push(phase === "OTHER" ? "p.kind <> 'TRUCKING'" : "p.kind = 'TRUCKING'");
  if (scheme) where.push(`j.payment_scheme = '${scheme}'`);
  if (partner_id) { params.push(Number(partner_id)); where.push(sale ? `j.customer_id = $${params.length}` : `jl.partner_id = $${params.length}`); }
  if (job_ids?.length) { params.push(job_ids.map(Number)); where.push(`j.id = any($${params.length}::int[])`); }
  if (search) { params.push(`%${search}%`); where.push(`(j.job_number ilike $${params.length} or j.plate_number ilike $${params.length})`); }

  const rows = await t.query(
    `select jl.id as job_line_id, jl.job_id, jl.amount as line_amount, p.kind, jl.description,
            jl.partner_id, pt.name as partner, jl.partner_bank_id, pb.bank_name, pb.account_number, pb.holder,
            j.job_number, j.job_date, j.plate_number, j.do_number, j.payment_scheme, j.customer_id, j.selling_after_tax,
            c.pph_pct, c.ppn_pct,
            concat(lp.code, ' - ', ld.code, case when j.trip_type = 'ROUND_TRIP' then ' PP' else '' end) as route,
            coalesce((select sum(ml.amount) from account_move_line ml join account_move m on m.id = ml.move_id
                      where ml.job_line_id = jl.id and ml.cancelled_at is null and m.state = 'posted' and m.id <> $1), 0) as billed,
            coalesce((select sum(ml.amount) from account_move_line ml join account_move m on m.id = ml.move_id
                      where ml.job_line_id = jl.id and ml.cancelled_at is null and m.state = 'posted' and m.phase = 'DP_70' and m.id <> $1), 0) as dp_billed,
            coalesce((select sum(ml.amount) from account_move_line ml join account_move m on m.id = ml.move_id
                      where ml.job_line_id = jl.id and ml.cancelled_at is null and m.state = 'draft'), 0) as in_draft
     from job_line jl
     join product p on p.id = jl.product_id
     join job j on j.id = jl.job_id
     join res_partner c on c.id = j.customer_id
     left join res_partner pt on pt.id = jl.partner_id
     left join res_partner_bank pb on pb.id = jl.partner_bank_id
     join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id
     where ${where.join(" and ")}
     order by j.job_date, j.id, (p.kind <> 'TRUCKING'), jl.id`, params);

  if (!sale) {
    return rows.map((r) => {
      const remaining = money(r.line_amount - r.billed);
      let suggested = remaining;
      if (phase === "DP_70") suggested = r.dp_billed > 0 ? 0 : Math.min(remaining, Math.round(r.line_amount * 0.7));
      return { ...r, remaining, suggested: money(Math.max(suggested, 0)) };
    });
  }
  // customer: gabung per job
  const byJob = new Map();
  for (const r of rows) {
    const g = byJob.get(r.job_id) || { ...r, job_line_id: null, line_amount: 0, billed: 0, dp_billed: 0, in_draft: 0, kind: "SELLING" };
    g.line_amount += r.line_amount; g.billed += r.billed; g.dp_billed += r.dp_billed; g.in_draft += r.in_draft;
    byJob.set(r.job_id, g);
  }
  return [...byJob.values()].map((g) => {
    const net = g.selling_after_tax ?? Math.round(g.line_amount * (1 - g.pph_pct / 100 + g.ppn_pct / 100));
    const remaining = money(g.line_amount - g.billed);
    let suggested;
    if (phase === "DP_70") suggested = g.dp_billed > 0 ? 0 : Math.round(g.line_amount * 0.7);
    else suggested = net - g.billed;       // pelunasan / FULL: sisa setelah pajak
    return { ...g, selling_net: net, remaining, suggested: money(Math.max(Math.min(suggested, remaining), 0)) };
  });
}

// ---------------------------------------------------------------- validasi dokumen
export async function checkMove(t, moveId) {
  const [m] = await t.query("select * from account_move where id = $1", [moveId]);
  const lines = await t.query(
    `select ml.*, j.job_number, j.state as job_state, j.customer_id, j.payment_scheme, jl.side, p.kind, jl.amount as line_amount
     from account_move_line ml join job j on j.id = ml.job_id join job_line jl on jl.id = ml.job_line_id
     join product p on p.id = jl.product_id
     where ml.move_id = $1 and ml.cancelled_at is null`, [moveId]);
  if (!lines.length) fail("Dokumen kosong, pilih minimal 1 job");
  const side = m.move_type === "out_invoice" ? "SALE" : "PURCHASE";
  for (const l of lines) {
    const tag = l.job_number;
    if (l.job_state === "cancelled") fail(`${tag}: job sudah dibatalkan`);
    if (l.side !== side) fail(`${tag}: baris order tidak cocok dengan jenis dokumen`);
    if (m.move_type === "out_invoice" && l.customer_id !== m.partner_id) fail(`${tag}: customer job beda dengan customer invoice`);
    if (["DP_70", "SETTLEMENT_30"].includes(m.phase) && l.payment_scheme !== "70_30") fail(`${tag}: job skema 100%, tidak bisa DP / pelunasan`);
    if (m.phase === "FULL" && l.payment_scheme !== "FULL") fail(`${tag}: job skema 70/30, tidak bisa FULL`);
    if (m.phase === "OTHER" && (side !== "PURCHASE" || l.kind === "TRUCKING")) fail(`${tag}: fase calo/biaya lain hanya untuk biaya vendor selain trucking`);
    if (m.phase !== "OTHER" && side === "PURCHASE" && l.kind !== "TRUCKING") fail(`${tag}: calo/biaya lain diajukan dengan fase "Calo / biaya lain"`);
  }
  if (m.phase === "DP_70") {
    const dup = await t.query(
      `select distinct j.job_number from account_move_line ml join account_move m2 on m2.id = ml.move_id
       join job_line jl on jl.id = ml.job_line_id join job j on j.id = ml.job_id
       where ml.job_id = any($1::int[]) and ml.cancelled_at is null and m2.state = 'posted' and m2.phase = 'DP_70'
         and m2.id <> $2 and jl.side = $3`, [lines.map((l) => l.job_id), moveId, side]);
    if (dup.length) fail(`${dup[0].job_number}: DP 70% sudah pernah ${side === "SALE" ? "ditagih" : "diajukan"}`);
  }
  const over = await t.query(
    `select j.job_number, jl.amount, sum(ml.amount) as this_move,
            coalesce((select sum(ml2.amount) from account_move_line ml2 join account_move m2 on m2.id = ml2.move_id
                      where ml2.job_line_id = jl.id and ml2.cancelled_at is null and m2.state = 'posted' and m2.id <> $1), 0) as billed_other
     from account_move_line ml join job_line jl on jl.id = ml.job_line_id join job j on j.id = jl.job_id
     where ml.move_id = $1 and ml.cancelled_at is null
     group by jl.id, j.job_number, jl.amount`, [moveId]);
  for (const o of over) {
    if (o.this_move > o.amount - o.billed_other + 0.004) fail(`${o.job_number}: ${rupiah(o.this_move)} melebihi sisa ${rupiah(o.amount - o.billed_other)}`);
  }
}

// Isi baris dokumen. lines: [{job_id, job_line_id?, amount, payee_partner_id?, payee_bank_name?, ...}]
async function writeLines(t, moveId, move, lines) {
  if (!Array.isArray(lines) || !lines.length) fail("Pilih minimal 1 job");
  await t.query("delete from account_move_line where move_id = $1", [moveId]);
  const side = move.move_type === "out_invoice" ? "SALE" : "PURCHASE";
  let no = 0;
  for (const l of lines) {
    let left = money(l.amount);
    if (!(left > 0)) fail("Nominal harus lebih dari 0");
    const cands = await t.query(
      `select jl.id, jl.amount, jl.partner_id, jl.description, p.kind, pt.name as partner_name,
              pb.bank_name, pb.account_number, pb.holder,
              jl.amount - coalesce((select sum(ml.amount) from account_move_line ml join account_move m on m.id = ml.move_id
                where ml.job_line_id = jl.id and ml.cancelled_at is null and m.state = 'posted' and m.id <> $3), 0) as remaining
       from job_line jl join product p on p.id = jl.product_id
       left join res_partner pt on pt.id = jl.partner_id left join res_partner_bank pb on pb.id = jl.partner_bank_id
       where jl.job_id = $1 and jl.side = $2 ${l.job_line_id ? "and jl.id = $4" : side === "PURCHASE" ? "and p.kind = 'TRUCKING'" : ""}
       order by (p.kind <> 'TRUCKING'), jl.id`,
      l.job_line_id ? [Number(l.job_id), side, moveId, Number(l.job_line_id)] : [Number(l.job_id), side, moveId]);
    if (!cands.length) fail(`Job ${l.job_id}: tidak ada baris order yang cocok`);
    for (const c of cands) {
      if (left <= 0) break;
      const take = l.job_line_id ? left : Math.min(left, Math.max(c.remaining, 0));
      if (take <= 0) continue;
      no += 1;
      await insertRow(t, "account_move_line", {
        move_id: moveId, line_no: no, job_line_id: c.id, job_id: Number(l.job_id), amount: take,
        description: l.description || c.description || null,
        payee_partner_id: side === "PURCHASE" ? (l.payee_partner_id ? Number(l.payee_partner_id) : c.partner_id) : null,
        payee_bank_name: side === "PURCHASE" ? (l.payee_bank_name ?? c.bank_name ?? null) : null,
        payee_account_number: side === "PURCHASE" ? (l.payee_account_number ?? c.account_number ?? null) : null,
        payee_holder: side === "PURCHASE" ? (l.payee_holder ?? c.holder ?? c.partner_name ?? null) : null,
      });
      left = money(left - take);
    }
    if (left > 0.004) {
      const [j] = await t.query("select job_number from job where id = $1", [Number(l.job_id)]);
      fail(`${j?.job_number || l.job_id}: nominal melebihi sisa yang bisa ${side === "SALE" ? "ditagih" : "diajukan"}`);
    }
  }
}

// Info pajak invoice (untuk cetak): dasar = selling kotor job, PPN / PPh dari customer
async function invoiceTax(t, moveId) {
  const [m] = await t.query("select * from account_move where id = $1", [moveId]);
  if (m.move_type !== "out_invoice" || m.phase === "DP_70") {
    await t.query("update account_move set tax_basis = 0, ppn_amount = 0, pph23_amount = 0 where id = $1", [moveId]);
    return;
  }
  await t.query(
    `update account_move m set tax_basis = x.basis, ppn_amount = round(x.basis * c.ppn_pct / 100), pph23_amount = round(x.basis * c.pph_pct / 100)
     from (select sum(jl.amount) as basis from job_line jl
           where jl.side = 'SALE' and jl.job_id in (select distinct job_id from account_move_line where move_id = $1 and cancelled_at is null)) x,
          res_partner c
     where m.id = $1 and c.id = m.partner_id`, [moveId]);
}

export async function loadMove(q, id) {
  const [move] = await q.query(
    `select m.*, pt.name as partner, pt.address as partner_address, pt.npwp as partner_npwp,
            pt.pph_pct, pt.ppn_pct, s.amount_total, s.amount_paid, s.amount_residual,
            ba.name as bank_account, ba.bank_name as company_bank, ba.account_number as company_account_number, ba.holder as company_holder,
            cu.display_name as created_by_name, au.display_name as approved_by_name,
            coalesce(tt.titipan, 0) as titipan, coalesce(tt.dana_masuk, 0) as dana_operasional
     from account_move m left join res_partner pt on pt.id = m.partner_id join v_move_status s on s.move_id = m.id
     left join res_bank_account ba on ba.id = m.bank_account_id
     left join app_user cu on cu.id = m.created_by left join app_user au on au.id = m.approved_by
     left join v_titipan_operasional tt on tt.move_id = m.id
     where m.id = $1`, [id]);
  if (!move) fail("Dokumen tidak ditemukan", 404);
  move.lines = await q.query(
    `select ml.*, j.job_number, j.plate_number, j.do_number, j.job_date, j.truck_type, p.kind, payee.name as payee_name,
            concat(lp.code, ' - ', ld.code, case when j.trip_type = 'ROUND_TRIP' then ' PP' else '' end) as route,
            coalesce((select sum(pl.amount) from account_payment_line pl where pl.move_line_id = ml.id), 0) as paid,
            (select sum(jl2.amount) from job_line jl2 where jl2.job_id = j.id and jl2.side = 'SALE') as job_selling
     from account_move_line ml join job j on j.id = ml.job_id join job_line jl on jl.id = ml.job_line_id
     join product p on p.id = jl.product_id left join res_partner payee on payee.id = ml.payee_partner_id
     join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id
     where ml.move_id = $1 order by ml.line_no, ml.id`, [id]);
  move.payments = await q.query(
    `select p.*, ba.name as bank_account, u.display_name as created_by_name from account_payment p
     left join res_bank_account ba on ba.id = p.bank_account_id left join app_user u on u.id = p.created_by
     where p.move_id = $1 order by p.id`, [id]);
  move.transfers = await q.query(
    `select t.*, fa.name as from_name, ta.name as to_name, fa.kind as from_kind, ta.kind as to_kind from internal_transfer t
     join res_bank_account fa on fa.id = t.from_account_id join res_bank_account ta on ta.id = t.to_account_id
     where t.move_id = $1 order by t.id`, [id]);
  return move;
}

async function postMove(t, req, id) {
  const [m] = await t.query("select * from account_move where id = $1 for update", [id]);
  if (m.state !== "draft") fail("Dokumen sudah diposting / dibatalkan");
  await t.query("select id from job_line where id in (select job_line_id from account_move_line where move_id = $1) for update", [id]);
  await checkMove(t, id);
  const year = String(m.move_date).slice(0, 4);
  const number = m.move_type === "out_invoice"
    ? await nextNumber(t, `INV/${year}`, `INV/${year}/`)
    : await nextNumber(t, `REQ/${year}`, `REQ/${year}/`);
  const needApproval = m.move_type === "in_invoice" && (await setting(t, "vendor_approval_required", true)) !== false;
  await t.query(
    "update account_move set state = 'posted', number = $1, posted_at = now(), approval_state = $2 where id = $3",
    [number, needApproval ? "PENDING" : "NOT_REQUIRED", id]);
  await audit(t, req, "account_move", id, "post", { number });
  return number;
}

async function lockMove(t, id) {
  const [m] = await t.query("select * from account_move where id = $1 for update", [id]);
  if (!m) fail("Dokumen tidak ditemukan", 404);
  return m;
}

export default function financeRoutes(db) {
  const r = express.Router();

  r.get("/moves/eligible", requireRole(ROLES.READ), route((req) => eligible(db, {
    ...req.query, job_ids: req.query.job_ids ? String(req.query.job_ids).split(",") : null })));

  r.get("/moves", requireRole(ROLES.READ), route(async (req) => {
    const params = [];
    const where = ["true"];
    const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    if (req.query.move_type) add("m.move_type = ?", req.query.move_type);
    if (req.query.state) add("m.state = ?", req.query.state);
    if (req.query.approval) add("m.approval_state = ?", req.query.approval);
    if (req.query.channel) add("m.payment_channel = ?", req.query.channel);
    if (req.query.from) add("m.move_date >= ?", req.query.from);
    if (req.query.to) add("m.move_date <= ?", req.query.to);
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      where.push(`(m.number ilike $${params.length} or m.legacy_number ilike $${params.length} or pt.name ilike $${params.length}
                   or exists (select 1 from account_move_line ml join job j on j.id = ml.job_id where ml.move_id = m.id and j.job_number ilike $${params.length}))`);
    }
    return db.query(
      `select m.*, pt.name as partner, s.amount_total, s.amount_paid, s.amount_residual,
              (select count(distinct ml.job_id)::int from account_move_line ml where ml.move_id = m.id and ml.cancelled_at is null) as total_jobs,
              (select string_agg(distinct coalesce(pp.name, ml.payee_holder), ', ') from account_move_line ml
                 left join res_partner pp on pp.id = ml.payee_partner_id where ml.move_id = m.id and ml.cancelled_at is null) as payees,
              coalesce(tt.titipan, 0) as titipan
       from account_move m left join res_partner pt on pt.id = m.partner_id join v_move_status s on s.move_id = m.id
       left join v_titipan_operasional tt on tt.move_id = m.id
       where ${where.join(" and ")} order by m.id desc limit 500`, params);
  }));

  r.get("/moves/:id", requireRole(ROLES.READ), route((req) => loadMove(db, Number(req.params.id))));

  r.post("/moves", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const b = req.body || {};
    if (!["out_invoice", "in_invoice"].includes(b.move_type)) fail("Jenis dokumen tidak dikenal");
    if (!PHASES.includes(b.phase)) fail("Fase tidak dikenal");
    if (b.move_type === "out_invoice" && b.phase === "OTHER") fail("Invoice customer tidak memakai fase OTHER");
    let partnerId = b.partner_id ? Number(b.partner_id) : null;
    if (b.move_type === "out_invoice" && !partnerId && b.lines?.length) {
      partnerId = (await t.query("select customer_id from job where id = $1", [Number(b.lines[0].job_id)]))[0]?.customer_id;
    }
    if (b.move_type === "out_invoice" && !partnerId) fail("Customer wajib diisi");
    const [cust] = partnerId ? await t.query("select * from res_partner where id = $1", [partnerId]) : [null];
    const id = await insertRow(t, "account_move", {
      move_type: b.move_type, phase: b.phase, partner_id: partnerId, move_date: b.move_date || today(),
      due_date: b.due_date || null, bank_account_id: b.bank_account_id ? Number(b.bank_account_id) : null,
      payment_channel: b.move_type === "in_invoice" && b.payment_channel === "TRANSFER_MALAM" ? "TRANSFER_MALAM" : "NORMAL",
      note: b.note || null, created_by: req.user.id,
      bill_to_name: b.move_type === "out_invoice" ? (cust?.bill_to_name || cust?.name) : null,
      bill_to_address: b.move_type === "out_invoice" ? (cust?.bill_to_address || cust?.address || null) : null,
      bill_to_npwp: b.move_type === "out_invoice" ? (cust?.bill_to_npwp || cust?.npwp || null) : null,
    });
    const [move] = await t.query("select * from account_move where id = $1", [id]);
    await writeLines(t, id, move, b.lines);
    await checkMove(t, id);
    await invoiceTax(t, id);
    await audit(t, req, "account_move", id, "create", { move_type: b.move_type, phase: b.phase, lines: b.lines?.length });
    if (b.post) await postMove(t, req, id);
    return loadMove(t, id);
  })));

  r.put("/moves/:id", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const m = await lockMove(t, id);
    if (m.state !== "draft") fail("Hanya draft yang bisa diubah");
    const b = req.body || {};
    await t.query("update account_move set move_date = $1, due_date = $2, bank_account_id = $3, note = $4, payment_channel = $5 where id = $6",
      [b.move_date || m.move_date, b.due_date || null, b.bank_account_id ? Number(b.bank_account_id) : m.bank_account_id, b.note ?? m.note,
       m.move_type === "in_invoice" && b.payment_channel ? b.payment_channel : m.payment_channel, id]);
    if (b.lines) await writeLines(t, id, m, b.lines);
    await checkMove(t, id);
    await invoiceTax(t, id);
    return loadMove(t, id);
  })));

  r.put("/moves/:id/bill-to", requireRole(ROLES.FINANCE), route(async (req) => {
    const b = req.body || {};
    await db.query("update account_move set bill_to_name = $1, bill_to_address = $2, bill_to_npwp = $3, bank_account_id = coalesce($4, bank_account_id) where id = $5",
      [b.bill_to_name || null, b.bill_to_address || null, b.bill_to_npwp || null, b.bank_account_id ? Number(b.bank_account_id) : null, Number(req.params.id)]);
    return loadMove(db, Number(req.params.id));
  }));

  r.post("/moves/:id/post", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    await postMove(t, req, Number(req.params.id));
    return loadMove(t, Number(req.params.id));
  })));

  // Persetujuan pengajuan vendor (ADMIN). Ditolak = dokumen batal, job bisa diajukan lagi.
  r.post("/moves/:id/approve", requireRole(ROLES.ADMIN), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const m = await lockMove(t, id);
    if (m.state !== "posted" || m.approval_state !== "PENDING") fail("Dokumen tidak sedang menunggu persetujuan");
    const approve = req.body?.approve !== false;
    if (approve) {
      await t.query("update account_move set approval_state = 'APPROVED', approved_by = $1, approved_at = now() where id = $2", [req.user.id, id]);
    } else {
      if (!String(req.body?.reason || "").trim()) fail("Alasan penolakan wajib diisi");
      await t.query(
        "update account_move set approval_state = 'REJECTED', rejection_reason = $1, state = 'cancelled', cancelled_at = now(), approved_by = $2, approved_at = now() where id = $3",
        [req.body.reason, req.user.id, id]);
    }
    await audit(t, req, "account_move", id, approve ? "approve" : "reject", { reason: req.body?.reason });
    return loadMove(t, id);
  })));

  r.post("/moves/:id/cancel", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const m = await lockMove(t, id);
    if (m.state === "cancelled") fail("Dokumen sudah dibatalkan");
    const [s] = await t.query("select amount_paid from v_move_status where move_id = $1", [id]);
    if (s.amount_paid !== 0) fail("Sudah ada pembayaran. Balik dulu pembayarannya.");
    const [tt] = await t.query("select titipan from v_titipan_operasional where move_id = $1", [id]);
    if (tt && tt.titipan > 0) fail(`Masih ada dana ${rupiah(tt.titipan)} di kas operasional. Kembalikan dulu dananya.`);
    if (m.state === "draft") {
      await t.query("delete from account_move where id = $1", [id]);
      await audit(t, req, "account_move", id, "delete_draft");
      return { deleted: true };
    }
    if (!String(req.body?.reason || "").trim()) fail("Alasan pembatalan wajib diisi");
    await t.query("update account_move set state = 'cancelled', cancelled_at = now(), cancel_reason = $1 where id = $2", [req.body.reason, id]);
    await audit(t, req, "account_move", id, "cancel", { reason: req.body.reason });
    return loadMove(t, id);
  })));

  // Batalkan satu baris (mis. satu job di batch pengajuan) tanpa membatalkan seluruh dokumen.
  r.post("/move-lines/:id/cancel", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const [l] = await t.query("select * from account_move_line where id = $1 and cancelled_at is null for update", [id]);
    if (!l) fail("Baris tidak ditemukan / sudah dibatalkan");
    const [p] = await t.query("select coalesce(sum(amount), 0) as paid from account_payment_line where move_line_id = $1", [id]);
    if (p.paid !== 0) fail("Baris ini masih ada pembayaran. Balik dulu pembayarannya.");
    if (!String(req.body?.reason || "").trim()) fail("Alasan pembatalan wajib diisi");
    await t.query("update account_move_line set cancelled_at = now(), cancel_reason = $1 where id = $2", [req.body.reason, id]);
    const [left] = await t.query("select count(*)::int n from account_move_line where move_id = $1 and cancelled_at is null", [l.move_id]);
    if (left.n === 0) await t.query("update account_move set state = 'cancelled', cancelled_at = now(), cancel_reason = 'Semua baris dibatalkan' where id = $1", [l.move_id]);
    await audit(t, req, "account_move", l.move_id, "cancel_line", { line_id: id, job_id: l.job_id, reason: req.body.reason });
    return loadMove(t, l.move_id);
  })));

  // ---------------------------------------------------------------- pembayaran
  r.post("/moves/:id/pay", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const m = await lockMove(t, id);
    const move = await loadMove(t, id);
    if (m.state !== "posted") fail("Hanya dokumen posted yang bisa dibayar");
    if (!["NOT_REQUIRED", "APPROVED"].includes(m.approval_state)) fail("Pengajuan belum disetujui");
    const b = req.body || {};
    const amount = b.amount == null || b.amount === "" ? move.amount_residual : money(b.amount);
    if (!(amount > 0)) fail("Nominal harus lebih dari 0");
    if (amount > move.amount_residual + 0.004) fail(`Melebihi sisa ${rupiah(move.amount_residual)}`);
    const bankId = b.bank_account_id ? Number(b.bank_account_id) : m.bank_account_id;
    if (!bankId) fail("Pilih rekening AMICO yang dipakai");
    const [bank] = await t.query("select * from res_bank_account where id = $1", [bankId]);
    if (m.payment_channel === "TRANSFER_MALAM") {
      if (bank.kind !== "OPERATIONAL") fail("Pengajuan transfer malam dibayar dari kas operasional");
      if (amount > move.titipan + 0.004) fail(`Dana di kas operasional untuk pengajuan ini tinggal ${rupiah(move.titipan)}. Kirim dana dulu.`);
    }
    const inbound = m.move_type === "out_invoice";
    const date = b.pay_date || today();
    const year = String(date).slice(0, 4);
    const paymentId = await insertRow(t, "account_payment", {
      number: await nextNumber(t, `${inbound ? "PIN" : "POUT"}/${year}`, `${inbound ? "PAY-IN" : "PAY-OUT"}/${year}/`),
      payment_type: inbound ? "inbound" : "outbound", move_id: id, pay_date: date, amount, bank_account_id: bankId,
      proof_url: b.proof_url || null, note: b.note || null, created_by: req.user.id,
    });
    // bayar baris tertentu saja (mis. satu vendor di batch) atau berurutan
    const only = Array.isArray(b.line_ids) && b.line_ids.length ? new Set(b.line_ids.map(Number)) : null;
    let left = amount;
    for (const l of move.lines) {
      if (l.cancelled_at || (only && !only.has(l.id))) continue;
      const open = money(l.amount - l.paid);
      if (left <= 0 || open <= 0) continue;
      const part = Math.min(open, left);
      await insertRow(t, "account_payment_line", {
        payment_id: paymentId, move_line_id: l.id, job_id: l.job_id, amount: part,
        actual_payee_name: b.actual_payee_name || null, actual_bank_name: b.actual_bank_name || null,
        actual_account_number: b.actual_account_number || null, actual_holder: b.actual_holder || null,
      });
      left = money(left - part);
    }
    if (left > 0.004) fail("Nominal melebihi sisa baris yang dipilih");
    await audit(t, req, "account_payment", paymentId, "pay", { move_id: id, amount, bank_account_id: bankId });
    return loadMove(t, id);
  })));

  r.post("/payments/:id/reverse", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const [p] = await t.query("select * from account_payment where id = $1 for update", [id]);
    if (!p) fail("Pembayaran tidak ditemukan", 404);
    if (p.state === "reversed" || p.reversed_payment_id) fail("Pembayaran ini sudah dibalik / adalah pembalik");
    if (!String(req.body?.reason || "").trim()) fail("Alasan wajib diisi");
    const date = req.body.pay_date || today();
    const revId = await insertRow(t, "account_payment", {
      number: await nextNumber(t, `REV/${String(date).slice(0, 4)}`, `REV/${String(date).slice(0, 4)}/`),
      payment_type: p.payment_type, move_id: p.move_id, pay_date: date, amount: -p.amount, bank_account_id: p.bank_account_id,
      reversed_payment_id: p.id, note: req.body.reason, created_by: req.user.id,
    });
    await t.query(
      `insert into account_payment_line (payment_id, move_line_id, job_id, amount, actual_payee_name, actual_bank_name, actual_account_number, actual_holder)
       select $1, move_line_id, job_id, -amount, actual_payee_name, actual_bank_name, actual_account_number, actual_holder
       from account_payment_line where payment_id = $2`, [revId, p.id]);
    await t.query("update account_payment set state = 'reversed' where id = $1", [p.id]);
    await audit(t, req, "account_payment", p.id, "reverse", { reason: req.body.reason });
    return loadMove(t, p.move_id);
  })));

  // ---------------------------------------------------------------- transfer malam (kas operasional)
  // Kirim dana pengajuan ke kas operasional
  r.post("/moves/:id/fund", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const m = await lockMove(t, id);
    const move = await loadMove(t, id);
    if (m.move_type !== "in_invoice" || m.payment_channel !== "TRANSFER_MALAM") fail("Hanya untuk pengajuan transfer malam");
    if (m.state !== "posted" || !["NOT_REQUIRED", "APPROVED"].includes(m.approval_state)) fail("Pengajuan harus posted dan disetujui");
    const b = req.body || {};
    const need = money(move.amount_residual - move.titipan);
    const amount = b.amount == null || b.amount === "" ? need : money(b.amount);
    if (!(amount > 0)) fail("Tidak ada dana yang perlu dikirim");
    if (amount > need + 0.004) fail(`Melebihi kebutuhan ${rupiah(need)}`);
    const [from] = await t.query("select * from res_bank_account where id = $1", [Number(b.from_account_id)]);
    const [to] = await t.query("select * from res_bank_account where id = $1", [Number(b.to_account_id)]);
    if (!from || from.kind !== "BANK") fail("Pilih rekening bank asal");
    if (!to || to.kind !== "OPERATIONAL") fail("Pilih kas operasional tujuan");
    const date = b.transfer_date || today();
    const tid = await insertRow(t, "internal_transfer", {
      number: await nextNumber(t, `TRF/${String(date).slice(0, 4)}`, `TRF/${String(date).slice(0, 4)}/`),
      transfer_date: date, from_account_id: from.id, to_account_id: to.id, amount, move_id: id, note: b.note || null, created_by: req.user.id,
    });
    await audit(t, req, "internal_transfer", tid, "fund", { move_id: id, amount });
    return loadMove(t, id);
  })));

  // Dana kembali dari kas operasional (belum / tidak jadi disalurkan)
  r.post("/moves/:id/return-fund", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    await lockMove(t, id);
    const move = await loadMove(t, id);
    const b = req.body || {};
    const amount = b.amount == null || b.amount === "" ? move.titipan : money(b.amount);
    if (!(amount > 0)) fail("Tidak ada dana di kas operasional");
    if (amount > move.titipan + 0.004) fail(`Melebihi dana di kas operasional (${rupiah(move.titipan)})`);
    const last = move.transfers.filter((x) => x.to_kind === "OPERATIONAL").at(-1);
    if (!last) fail("Belum ada dana yang dikirim");
    const date = b.transfer_date || today();
    const tid = await insertRow(t, "internal_transfer", {
      number: await nextNumber(t, `TRF/${String(date).slice(0, 4)}`, `TRF/${String(date).slice(0, 4)}/`),
      transfer_date: date, from_account_id: last.to_account_id, to_account_id: b.to_account_id ? Number(b.to_account_id) : last.from_account_id,
      amount, move_id: id, note: b.note || "Dana kembali dari operasional", created_by: req.user.id,
    });
    await audit(t, req, "internal_transfer", tid, "return_fund", { move_id: id, amount, reason: b.note });
    return loadMove(t, id);
  })));

  // Transfer internal bebas (antar rekening AMICO)
  r.get("/transfers", requireRole(ROLES.READ), route(() => db.query(
    `select t.*, fa.name as from_name, ta.name as to_name, m.number as move_number from internal_transfer t
     join res_bank_account fa on fa.id = t.from_account_id join res_bank_account ta on ta.id = t.to_account_id
     left join account_move m on m.id = t.move_id order by t.id desc limit 500`)));

  r.post("/transfers", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const b = req.body || {};
    const date = b.transfer_date || today();
    if (!(money(b.amount) > 0)) fail("Nominal harus lebih dari 0");
    const tid = await insertRow(t, "internal_transfer", {
      number: await nextNumber(t, `TRF/${String(date).slice(0, 4)}`, `TRF/${String(date).slice(0, 4)}/`),
      transfer_date: date, from_account_id: Number(b.from_account_id), to_account_id: Number(b.to_account_id),
      amount: money(b.amount), note: b.note || null, created_by: req.user.id,
    });
    await audit(t, req, "internal_transfer", tid, "create", b);
    return { id: tid };
  })));

  return r;
}

export { assertRole };

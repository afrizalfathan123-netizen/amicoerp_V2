// Surat jalan (SJ): input massal (resi dari driver, SJ diterima), pemantauan lead time & keterlambatan,
// pengiriman SJ ke customer (satu kiriman / satu resi kurir untuk banyak SJ, nomor SJD/YYMM/NNNN),
// dan export Job List + ringkasan.
//
// Alur: gate in -> driver kirim SJ lewat kurir (resi) -> SJ diterima di AMICO -> siap ditagih (finance)
//       -> SJ dikirim ke customer (dokumen Pengiriman SJ) -> diterima customer.
import express from "express";
import ExcelJS from "exceljs";
import { requireRole, ROLES } from "../lib/auth.js";
import fs from "node:fs";
import path from "node:path";
import { route, fail, today, insertRow, nextNumber, audit } from "../lib/util.js";
import { importJobListV1, writeJobListReport } from "../lib/import-joblist-v1.js";
import { ROOT } from "../config.js";

export const STAGE_LABEL = {
  RENCANA: "Rencana (belum berangkat)", JALAN: "Dalam perjalanan", MENUNGGU_SJ: "Menunggu SJ", SIAP_TAGIH: "Siap ditagih",
  KIRIM_SJ: "SJ belum dikirim ke customer", MENUNGGU_BAYAR: "Menunggu pembayaran", SELESAI: "Selesai", BATAL: "Batal",
};
const SJ_LABEL = { BELUM_ADA_RESI: "Belum ada resi", DI_KURIR: "Di kurir", DITERIMA: "Diterima AMICO", DIKIRIM: "Dikirim ke customer" };
const LATE_LABEL = { RESI_TERLAMBAT: "Driver belum kirim SJ", KURIR_NYANGKUT: "Resi nyangkut di kurir", TERLAMBAT_KIRIM: "Belum dikirim ke customer" };

// "2026-10-07", "07/10/2026", "7-10-26" -> yyyy-mm-dd
export function parseDate(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

// Baris tempelan: "AMC/2610/0253", "AMC/2610/0253<TAB>JNE123", "SJ123  07/10/2026", dst. Kunci = no job / no SJ / kode tugas.
const findJobs = (t, key) => t.query(
  `select j.id, j.job_number, j.sj_number, j.do_number, j.gate_in_at, j.sj_resi_number, j.sj_resi_received_at, j.sj_received_at, j.sj_delivered_at,
          c.name as customer
   from job j join res_partner c on c.id = j.customer_id
   where j.state <> 'cancelled' and (upper(j.job_number) = upper($1) or upper(j.sj_number) = upper($1) or upper(j.do_number) = upper($1))`, [key]);

async function matchLines(t, mode, text, defaultDate) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const parts = raw.split(/[\s;|]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) continue;
    // kunci = kata pertama yang cocok dengan no job / no SJ / kode tugas (label seperti "SJ diterima :" dilewati)
    let key = null;
    let jobs = [];
    for (const p of parts.filter((x) => !parseDate(x) && x.length >= 3)) {
      jobs = await findJobs(t, p);
      if (jobs.length) { key = p; break; }
    }
    if (!key) key = parts.find((x) => !parseDate(x)) || parts[0];
    const rest = parts.filter((x) => x !== key);
    const date = rest.map(parseDate).find(Boolean) || defaultDate;
    const resi = mode === "resi" ? rest.find((x) => !parseDate(x) && /\d/.test(x)) || null : null;   // no resi selalu ada angkanya
    if (!jobs.length) jobs = await findJobs(t, key);
    let status = "OK";
    let note = "";
    if (!jobs.length) { status = "TIDAK_KETEMU"; note = "Tidak ada job dengan nomor job / SJ / kode tugas ini"; }
    else if (jobs.length > 1) { status = "GANDA"; note = `Cocok ke ${jobs.length} job: ${jobs.map((j) => j.job_number).join(", ")}`; }
    else if (!date) { status = "TANGGAL"; note = "Tanggal tidak terbaca"; }
    else if (mode === "resi" && !resi) { status = "RESI"; note = "Nomor resi kosong"; }
    else if (mode === "received" && jobs[0].sj_received_at) { status = "SUDAH"; note = `Sudah diterima ${jobs[0].sj_received_at}, akan ditimpa`; }
    else if (mode === "received" && !jobs[0].gate_in_at) { status = "OK"; note = "Job belum gate in"; }
    out.push({ line: raw.trim(), key, date, resi, status, note, job: jobs.length === 1 ? jobs[0] : null });
  }
  return out;
}

export default function sjRoutes(db) {
  const r = express.Router();
  const read = requireRole(ROLES.READ);
  const edit = requireRole(ROLES.JOB_EDIT);

  // Pemantauan: job yang sudah gate in, dengan status & lead time SJ
  r.get("/sj/tracking", read, route((req) => {
    const params = [];
    const where = ["j.state <> 'cancelled'", "j.gate_in_at is not null", "st.sj_status is not null"];
    const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    if (req.query.status) add("st.sj_status = ?", req.query.status);
    if (req.query.late === "1") where.push("st.sj_late is not null");
    if (req.query.customer_id) add("j.customer_id = ?", Number(req.query.customer_id));
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      where.push(`(j.job_number ilike $${params.length} or j.sj_number ilike $${params.length} or j.plate_number ilike $${params.length} or j.sj_resi_number ilike $${params.length})`);
    }
    return db.query(
      `select j.id as job_id, j.job_number, j.job_date, c.name as customer, lp.code as pol, ld.code as pod, j.plate_number, j.driver1_name, j.driver1_phone,
              j.gate_in_at, j.sj_number, j.sj_resi_number, j.sj_resi_received_at, j.sj_received_at, j.sj_delivered_at, j.sj_delivered_resi_number,
              st.sj_status, st.sj_late, st.hari_ke_resi, st.lead_time_sj, st.hari_di_kurir, st.hari_tunggu_kirim, st.stage, st.customer_status
       from job j join v_job_status st on st.job_id = j.id join res_partner c on c.id = j.customer_id
       join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id
       where ${where.join(" and ")}
       order by (st.sj_late is null), j.gate_in_at limit 2000`, params);
  }));

  r.get("/sj/summary", read, route(async () => {
    const [s] = await db.query(
      `select count(*) filter (where sj_status = 'BELUM_ADA_RESI')::int as belum_ada_resi,
              count(*) filter (where sj_status = 'DI_KURIR')::int as di_kurir,
              count(*) filter (where sj_status = 'DITERIMA')::int as diterima_belum_kirim,
              count(*) filter (where sj_late = 'RESI_TERLAMBAT')::int as resi_terlambat,
              count(*) filter (where sj_late = 'KURIR_NYANGKUT')::int as kurir_nyangkut,
              count(*) filter (where sj_late = 'TERLAMBAT_KIRIM')::int as terlambat_kirim,
              round(avg(lead_time_sj) filter (where lead_time_sj is not null), 1) as rata_lead_time
       from v_job_status st join job j on j.id = st.job_id where j.state <> 'cancelled'`);
    const stages = await db.query("select stage, count(*)::int as n from v_job_status group by 1");
    return { ...s, stages: Object.fromEntries(stages.map((x) => [x.stage, x.n])) };
  }));

  // Input massal. mode: resi (driver kirim SJ) | received (SJ diterima di AMICO). dry_run = pratinjau saja.
  // Cari job untuk input SJ: sebagian kode tugas (mis. 5 digit terakhir), no job, no SJ, atau plat.
  // Hasil menampilkan plat, rute, tanggal untuk dicek sebelum ditambahkan.
  r.get("/sj/search", read, route((req) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 3) return [];
    return db.query(
      `select j.id as job_id, j.job_number, j.job_date, j.do_number, j.sj_number, j.plate_number, j.gate_out_at, j.gate_in_at,
              j.sj_resi_number, j.sj_resi_received_at, j.sj_received_at, j.sj_delivered_at, c.name as customer,
              lp.code as pol, ld.code as pod, j.trip_type, st.sj_status,
              (upper(j.do_number) like upper($2)) as exact_end
       from job j join res_partner c on c.id = j.customer_id join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id
       join v_job_status st on st.job_id = j.id
       where j.state <> 'cancelled'
         and (j.do_number ilike $1 or j.job_number ilike $1 or j.sj_number ilike $1 or replace(j.plate_number, ' ', '') ilike replace($1, ' ', ''))
       order by (upper(j.do_number) like upper($2)) desc, (j.sj_received_at is null) desc, j.job_date desc
       limit 15`, [`%${q}%`, `%${q}`]);
  }));

  r.post("/sj/bulk", edit, route((req) => db.tx(async (t) => {
    const b = req.body || {};
    if (!["resi", "received"].includes(b.mode)) fail("Mode tidak dikenal");
    const date = b.date ? parseDate(b.date) : today();
    // bentuk kolom dari layar: items = [{ job_id, date, resi }]
    const rows = Array.isArray(b.items)
      ? await Promise.all(b.items.map(async (it) => {
          const [job] = await t.query("select id, job_number from job where id = $1 and state <> 'cancelled'", [Number(it.job_id)]);
          const d = parseDate(it.date) || date;
          const resi = it.resi ? String(it.resi).trim() : null;
          const status = !job ? "TIDAK_KETEMU" : !d ? "TANGGAL" : b.mode === "resi" && !resi ? "RESI" : "OK";
          return { key: job?.job_number, date: d, resi, status, job };
        }))
      : await matchLines(t, b.mode, b.text, date);
    if (b.dry_run) return { rows };
    let saved = 0;
    for (const x of rows) {
      if (!x.job || !["OK", "SUDAH"].includes(x.status)) continue;
      if (b.mode === "resi") {
        await t.query("update job set sj_resi_number = $1, sj_resi_received_at = $2, updated_at = now() where id = $3", [x.resi, x.date, x.job.id]);
      } else {
        await t.query("update job set sj_received_at = $1, updated_at = now() where id = $2", [x.date, x.job.id]);
      }
      await audit(t, req, "job", x.job.id, b.mode === "resi" ? "sj_resi" : "sj_received", { date: x.date, resi: x.resi });
      saved++;
    }
    return { rows, saved };
  })));

  // Job yang SJ-nya sudah diterima tapi belum dikirim ke customer (bahan pengiriman SJ)
  r.get("/sj/ready", read, route((req) => db.query(
    `select j.id as job_id, j.job_number, j.job_date, j.sj_number, j.sj_received_at, j.plate_number, lp.code as pol, ld.code as pod,
            st.customer_status
     from job j join v_job_status st on st.job_id = j.id join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id
     where j.state <> 'cancelled' and j.customer_id = $1 and j.sj_received_at is not null
       and not exists (select 1 from sj_delivery_line l join sj_delivery d on d.id = l.delivery_id where l.job_id = j.id and d.state <> 'cancelled')
     order by j.sj_received_at, j.job_number`, [Number(req.query.customer_id)])));

  r.get("/sj/deliveries", read, route(() => db.query(
    `select d.*, c.name as customer, (select count(*)::int from sj_delivery_line l where l.delivery_id = d.id) as jobs,
            (current_date - d.delivery_date) as umur_hari
     from sj_delivery d join res_partner c on c.id = d.customer_id order by d.id desc limit 500`)));

  r.get("/sj/deliveries/:id", read, route(async (req) => {
    const [d] = await db.query(
      "select d.*, c.name as customer, c.address as customer_address from sj_delivery d join res_partner c on c.id = d.customer_id where d.id = $1",
      [Number(req.params.id)]);
    if (!d) fail("Pengiriman SJ tidak ditemukan", 404);
    d.lines = await db.query(
      `select j.id as job_id, j.job_number, j.job_date, j.sj_number, j.plate_number, j.do_number, lp.code as pol, ld.code as pod
       from sj_delivery_line l join job j on j.id = l.job_id join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id
       where l.delivery_id = $1 order by j.job_number`, [d.id]);
    return d;
  }));

  r.post("/sj/deliveries", edit, route((req) => db.tx(async (t) => {
    const b = req.body || {};
    const ids = (b.job_ids || []).map(Number).filter(Boolean);
    if (!b.customer_id) fail("Pilih customer");
    if (!ids.length) fail("Pilih minimal 1 job");
    const date = b.delivery_date || today();
    const jobs = await t.query(
      `select j.id, j.job_number, j.customer_id, j.sj_received_at,
              exists (select 1 from sj_delivery_line l join sj_delivery d on d.id = l.delivery_id where l.job_id = j.id and d.state <> 'cancelled') as sent
       from job j where j.id = any($1::int[]) for update`, [ids]);
    for (const j of jobs) {
      if (j.customer_id !== Number(b.customer_id)) fail(`${j.job_number}: customer berbeda`);
      if (!j.sj_received_at) fail(`${j.job_number}: SJ belum diterima`);
      if (j.sent) fail(`${j.job_number}: SJ sudah ada di pengiriman lain`);
    }
    const yymm = String(date).slice(2, 4) + String(date).slice(5, 7);
    const number = await nextNumber(t, `SJD/${yymm}`, `SJD/${yymm}/`);
    const id = await insertRow(t, "sj_delivery", {
      number, customer_id: Number(b.customer_id), delivery_date: date, courier: b.courier || null, resi_number: b.resi_number || null,
      note: b.note || null, created_by: req.user.id,
    });
    for (const j of jobs) {
      await insertRow(t, "sj_delivery_line", { delivery_id: id, job_id: j.id });
      await t.query("update job set sj_delivered_at = $1, sj_delivered_resi_number = $2, updated_at = now() where id = $3",
        [date, b.resi_number || number, j.id]);
    }
    await audit(t, req, "sj_delivery", id, "create", { number, jobs: jobs.length, resi: b.resi_number });
    return { id, number };
  })));

  r.post("/sj/deliveries/:id/received", edit, route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const date = req.body?.date || today();
    const [d] = await t.query("update sj_delivery set state = 'received', received_at = $1 where id = $2 and state <> 'cancelled' returning id", [date, id]);
    if (!d) fail("Pengiriman tidak ditemukan / sudah dibatalkan");
    await audit(t, req, "sj_delivery", id, "received", { date });
    return { ok: true };
  })));

  r.post("/sj/deliveries/:id/cancel", edit, route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    if (!String(req.body?.reason || "").trim()) fail("Alasan wajib diisi");
    const [d] = await t.query("update sj_delivery set state = 'cancelled', cancel_reason = $1 where id = $2 and state <> 'cancelled' returning *", [req.body.reason, id]);
    if (!d) fail("Pengiriman tidak ditemukan / sudah dibatalkan");
    await t.query(
      `update job j set sj_delivered_at = null, sj_delivered_resi_number = null, updated_at = now()
       from sj_delivery_line l where l.delivery_id = $1 and l.job_id = j.id`, [id]);
    await audit(t, req, "sj_delivery", id, "cancel", { reason: req.body.reason });
    return { ok: true };
  })));

  // Export Job List (semua job aktif atau sesuai filter) + sheet RINGKASAN
  // GET: filter tanggal / status. POST { ids }: persis job yang tampil di layar (setelah filter kolom / tempel daftar).
  const exportJobList = async (req, res, q, ids) => {
    try {
      const params = [];
      const where = ["true"];
      const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
      if (ids) add("j.id = any(?::int[])", ids.map(Number).filter(Boolean));
      if (q.stage) add("st.stage = ?", q.stage);
      if (q.from) add("j.job_date >= ?", q.from);
      if (q.to) add("j.job_date <= ?", q.to);
      if (q.customer_id) add("j.customer_id = ?", Number(q.customer_id));
      if (!ids && q.include_cancelled !== "1") where.push("j.state <> 'cancelled'");
      const rows = await db.query(
        `select j.job_date, j.gate_out_at, j.gate_in_at, j.job_number, j.sj_number, c.name as customer, lp.code as pol, ld.code as pod,
                j.truck_type, j.plate_number, j.sj_resi_received_at, j.sj_resi_number, j.sj_received_at, st.lead_time_sj,
                j.sj_delivered_at, j.sj_delivered_resi_number, st.stage, st.sj_status, st.sj_late, j.service_type, j.trip_type, j.delivery_scope,
                v.name as vendor, j.driver1_name, j.driver1_phone, j.driver2_name, j.driver2_phone, j.do_number,
                pb.holder as penerima, pb.bank_name as bank, pb.account_number as no_rekening,
                j.customer_scheme, j.vendor_scheme, b.selling, b.cost, b.selling - b.cost as margin, b.invoiced, b.received, b.requested, b.paid
         from job j join v_job_status st on st.job_id = j.id join v_job_balance b on b.job_id = j.id
         join res_partner c on c.id = j.customer_id left join res_partner v on v.id = j.vendor_id
         join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id
         left join lateral (select partner_bank_id from job_line jl join product p on p.id = jl.product_id
                            where jl.job_id = j.id and jl.side = 'PURCHASE' and p.kind = 'TRUCKING' order by jl.id limit 1) tl on true
         left join res_partner_bank pb on pb.id = tl.partner_bank_id
         where ${where.join(" and ")} order by j.job_date desc, j.job_number desc`, params);
      const wb = new ExcelJS.Workbook();
      const cols = [
        ["TANGGAL", "job_date", 12], ["GATE OUT", "gate_out_at", 17], ["GATE IN", "gate_in_at", 17], ["JOB NUMBER", "job_number", 16],
        ["SJ NUMBER", "sj_number", 18], ["CUSTOMER", "customer", 14], ["POL", "pol", 8], ["POD", "pod", 14], ["TRUCK TYPE", "truck_type", 10],
        ["PLATE NUMBER", "plate_number", 13], ["TGL RESI SJ (DRIVER)", "sj_resi_received_at", 12], ["RESI NUMBER SJ", "resi", 18],
        ["SJ RECEIVED", "sj_received_at", 12], ["LEAD TIME SJ (HARI)", "lead_time_sj", 10], ["SJ DELIVERED", "sj_delivered_at", 12],
        ["RESI SJ DELIVERED", "sj_delivered_resi_number", 18], ["STATUS JOB", "stage_label", 24], ["STATUS SJ", "sj_label", 18],
        ["SJ TERLAMBAT", "late_label", 22], ["SERVICE TYPE", "service_type", 10], ["JENIS TRIP", "trip_type", 10], ["LINGKUP", "delivery_scope", 10],
        ["UNIT DARI (VENDOR)", "vendor", 22], ["DRIVER 1", "driver1_name", 14], ["HP DRIVER 1", "driver1_phone", 14],
        ["DRIVER 2", "driver2_name", 14], ["HP DRIVER 2", "driver2_phone", 14], ["KODE TUGAS", "do_number", 16],
        ["PENERIMA TRANSFER", "penerima", 22], ["BANK", "bank", 8], ["NO REKENING", "no_rekening", 16],
        ["SKEMA CUSTOMER", "customer_scheme", 10], ["SKEMA VENDOR", "vendor_scheme", 10],
        ["SELLING", "selling", 14], ["COST", "cost", 14], ["MARGIN", "margin", 14], ["DITAGIH", "invoiced", 14], ["DITERIMA", "received", 14],
        ["DIAJUKAN", "requested", 14], ["DIBAYAR", "paid", 14],
      ];
      const ws = wb.addWorksheet("JOB LIST");
      ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
      const t = (v) => (v ? new Date(v).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 16) : null);
      for (const x of rows) {
        ws.addRow({ ...x, gate_out_at: t(x.gate_out_at), gate_in_at: t(x.gate_in_at), resi: x.sj_resi_number,
          stage_label: STAGE_LABEL[x.stage], sj_label: SJ_LABEL[x.sj_status] || "", late_label: LATE_LABEL[x.sj_late] || "" });
      }
      for (const k of ["selling", "cost", "margin", "invoiced", "received", "requested", "paid"]) ws.getColumn(k).numFmt = "#,##0;-#,##0";
      ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2A1A0E" } };
      ws.views = [{ state: "frozen", ySplit: 1, xSplit: 4 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

      const s = wb.addWorksheet("RINGKASAN");
      s.columns = [{ header: "ERP AMICO v2 - JOB LIST", key: "k", width: 40 }, { header: "", key: "v", width: 22 }];
      const count = (f) => rows.filter(f).length;
      const sum = (k) => rows.reduce((a, x) => a + Number(x[k] || 0), 0);
      [["Dibuat", new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })], ["Total job", rows.length],
        ...Object.entries(STAGE_LABEL).map(([k, l]) => [`  ${l}`, count((x) => x.stage === k)]),
        ["Gate out belum gate in", count((x) => x.gate_out_at && !x.gate_in_at)],
        ["Gate in, SJ belum diterima", count((x) => x.gate_in_at && !x.sj_received_at)],
        ...Object.entries(LATE_LABEL).map(([k, l]) => [`  SJ terlambat: ${l}`, count((x) => x.sj_late === k)]),
        ["SJ diterima, belum dikirim ke customer", count((x) => x.sj_received_at && !x.sj_delivered_at)],
        ["Total selling", sum("selling")], ["Total cost", sum("cost")], ["Margin rencana", sum("selling") - sum("cost")],
      ].forEach(([k, v]) => s.addRow({ k, v }));
      s.getColumn("v").numFmt = "#,##0;-#,##0";
      s.getRow(1).font = { bold: true, size: 13 };

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="job-list-${today()}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      res.status(500).send(err.message);
    }
  };
  r.get("/export/job-list.xlsx", read, (req, res) => exportJobList(req, res, req.query, null));
  r.post("/export/job-list.xlsx", read, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: "Tidak ada job yang dipilih" });
    return exportJobList(req, res, {}, ids);
  });

  // Unggah export Job List ERP AMICO v1: lengkapi job yang ada + tambah job baru (ADMIN). pratinjau=1 tidak menyimpan.
  r.post("/import/joblist-v1", requireRole(ROLES.ADMIN), express.raw({ type: () => true, limit: "60mb" }), route(async (req) => {
    if (!req.body?.length) fail("File kosong");
    const result = await importJobListV1({ file: req.body, target: db, timpa: req.query.timpa === "1", dryRun: req.query.pratinjau === "1" })
      .catch((err) => fail(`File tidak bisa diimpor: ${err.message}`));
    result.file = String(req.query.name || "job-list.xlsx");
    const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).replace(/[: ]/g, "-").slice(0, 16);
    const report = path.basename(await writeJobListReport(result, path.join(ROOT, "data", `laporan-joblist-v1-${stamp}.xlsx`)));
    if (!result.dryRun) await audit(db, req, "import", null, "joblist_v1", { file: result.file, ...result.stats });
    return { stats: result.stats, dryRun: result.dryRun, rows: result.rows, not_in_v1: result.not_in_v1.length, issues: result.issues.length,
      conflicts: result.conflicts.slice(0, 50), report };
  }));

  // Unduh laporan impor (hanya file laporan-*.xlsx di folder data)
  r.get("/import/reports/:file", requireRole(ROLES.ADMIN), (req, res) => {
    const name = String(req.params.file);
    if (!/^laporan-[\w-]+\.xlsx$/.test(name)) return res.status(400).send("Nama file tidak valid");
    const file = path.join(ROOT, "data", name);
    if (!fs.existsSync(file)) return res.status(404).send("Laporan tidak ada");
    res.download(file);
  });

  return r;
}

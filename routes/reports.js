// Laporan: dashboard, rekap posisi per fase, aging, kurang transfer, jurnal kas, utang piutang,
// titipan operasional, saldo rekening, tracker, dan export Excel.
import express from "express";
import ExcelJS from "exceljs";
import { requireRole, ROLES } from "../lib/auth.js";
import { route, today } from "../lib/util.js";
import { buildAllExport } from "../lib/export-all.js";

const PHASE_ORDER = "case phase when 'DP' then 1 when 'SETTLEMENT' then 2 when 'FULL' then 3 else 4 end";
const PHASE_NAMES = { DP: "DP", SETTLEMENT: "Pelunasan", FULL: "Full 100%", OTHER: "Calo / lain" };
const SCHEME_NAMES = { "70_30": "70/30", "50_50": "50/50", FULL: "100%" };

function filterSql(query, { date = "job_date", allowed = [] } = {}) {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (query.from) add(`${date} >= ?`, query.from);
  if (query.to) add(`${date} <= ?`, query.to);
  if (allowed.includes("customer_id") && query.customer_id) add("customer_id = ?", Number(query.customer_id));
  if (allowed.includes("scheme") && query.scheme) add("scheme = ?", query.scheme);
  if (allowed.includes("side") && query.side) add("side = ?", query.side);
  if (allowed.includes("phase") && query.phase) add("phase = ?", query.phase);
  if (allowed.includes("status")) {
    const s = { not_billed: "not_billed > 0", outstanding: "outstanding > 0", paid: "paid > 0", unpaid: "unpaid > 0" }[query.status];
    if (s) where.push(s);
  }
  if (query.search && allowed.includes("search")) {
    params.push(`%${query.search}%`);
    where.push(`(job_number ilike $${params.length} or coalesce(pihak, '') ilike $${params.length} or coalesce(move_number, '') ilike $${params.length})`);
  }
  return { sql: where.length ? `where ${where.join(" and ")}` : "", params };
}

const COLUMNS = {
  utang_piutang: [
    ["JOB NUMBER", "job_number"], ["DO NUMBER", "do_number"], ["CUSTOMER", "customer"], ["KETERANGAN", "keterangan"],
    ["SKEMA CUSTOMER", "customer_scheme_label"], ["SKEMA VENDOR", "vendor_scheme_label"],
    ["UTANG 100%", "utang_100"], ["UTANG 100% TERBAYAR", "utang_100_terbayar"], ["UTANG 70%", "utang_70"], ["UTANG 70% TERBAYAR", "utang_70_terbayar"],
    ["UTANG 30% BELUM BAYAR", "utang_30_belum_bayar"], ["UTANG 30% TERBAYAR", "utang_30_terbayar"],
    ["PIUTANG 100% BELUM TERBAYAR", "piutang_100_belum_terbayar"], ["PIUTANG 100% TERBAYAR", "piutang_100_terbayar"],
    ["PIUTANG DP (70/50%) BELUM TERTAGIH", "piutang_70_belum_tertagih"], ["PIUTANG DP (70/50%) TERTAGIH", "piutang_70_tertagih"], ["PIUTANG DP (70/50%) TERBAYAR", "piutang_70_terbayar"],
    ["PIUTANG PELUNASAN (30/50%) BELUM TERTAGIH", "piutang_30_belum_tertagih"], ["PIUTANG PELUNASAN (30/50%) TERTAGIH", "piutang_30_tertagih"], ["PIUTANG PELUNASAN (30/50%) TERBAYAR", "piutang_30_terbayar"],
    ["CALO / LAIN TERBAYAR", "calo_lain_terbayar"], ["CALO / LAIN BELUM BAYAR", "calo_lain_belum_bayar"],
    ["KURANG TRANSFER KE VENDOR", "kurang_transfer_vendor"], ["KURANG BAYAR DARI CUSTOMER", "kurang_bayar_customer"],
  ],
  ledger: [
    ["TANGGAL", "tanggal"], ["JOB NUMBER", "job_number"], ["ARAH", "arah"], ["JENIS", "jenis"], ["PORSI", "porsi"], ["PIHAK", "pihak"],
    ["NOMINAL", "nominal"], ["REKENING", "rekening"], ["NO PEMBAYARAN", "payment_number"], ["DOKUMEN", "move_number"], ["MEMBALIK", "membalik"],
  ],
  posisi: [
    ["JOB NUMBER", "job_number"], ["TANGGAL", "job_date"], ["CUSTOMER", "customer"], ["SKEMA", "scheme_label"], ["SISI", "side_label"],
    ["FASE", "phase_label"], ["RENCANA", "planned"], ["BELUM DIAJUKAN / DITAGIH", "not_billed"], ["DIAJUKAN / DITAGIH BELUM DIBAYAR", "outstanding"],
    ["SUDAH DIBAYAR", "paid"], ["TOTAL BELUM DIBAYAR", "unpaid"],
  ],
  kurang: [
    ["JOB NUMBER", "job_number"], ["TANGGAL", "job_date"], ["CUSTOMER", "customer"], ["ARAH", "arah"], ["SEHARUSNYA", "seharusnya"],
    ["DP SEHARUSNYA (70%)", "dp_seharusnya"], ["DP DIBAYAR", "dp_dibayar"], ["PELUNASAN SEHARUSNYA", "pelunasan_seharusnya"],
    ["PELUNASAN DIBAYAR", "pelunasan_dibayar"], ["DP KURANG", "dp_kurang"], ["PELUNASAN KURANG", "pelunasan_kurang"], ["TOTAL KURANG", "kurang"], ["KE KAS AMICO (+ SURPLUS / - MINUS)", "selisih_kas"],
  ],
  tracker: [
    ["JOB NUMBER", "job_number"], ["TANGGAL", "job_date"], ["CUSTOMER", "customer"], ["POL", "pol"], ["POD", "pod"], ["TRUK", "truck_type"],
    ["PLAT", "plate_number"], ["DRIVER", "driver1_name"], ["STATUS", "trip_status"], ["GATE OUT", "gate_out_at"], ["GATE IN", "gate_in_at"],
    ["DURASI (JAM)", "durasi_jam"], ["SLA (JAM)", "sla_hours"], ["LEWAT SLA", "lewat_sla_label"], ["POSISI TERAKHIR", "posisi_terakhir"],
  ],
};

async function sendSheet(res, filename, sheetName, columns, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map(([header, key]) => ({ header, key, width: Math.max(12, Math.min(header.length + 2, 30)) }));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c) => { if (rows.some((r) => typeof r[c.key] === "number")) c.numFmt = "#,##0;-#,##0"; });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

export default function reportRoutes(db) {
  const r = express.Router();
  const read = requireRole(ROLES.READ);

  r.get("/dashboard", read, route(async () => {
    const [t] = await db.query(
      `select count(*)::int as jobs,
              coalesce(sum(selling), 0) as selling, coalesce(sum(cost), 0) as cost,
              coalesce(sum(invoiced - received), 0) as piutang, coalesce(sum(requested - paid), 0) as utang,
              (select coalesce(sum(case when payment_type = 'inbound' then amount else -amount end), 0) from account_payment) as kas
       from v_job_balance b join job j on j.id = b.job_id where j.state <> 'cancelled'`);
    const [pos] = await db.query(
      `select coalesce(sum(not_billed) filter (where side = 'SALE'), 0) as perlu_ditagih,
              coalesce(sum(not_billed) filter (where side = 'PURCHASE'), 0) as belum_diajukan
       from v_job_phase_position`);
    const [pend] = await db.query(
      "select count(*)::int as n, coalesce(sum(s.amount_total), 0) as total from account_move m join v_move_status s on s.move_id = m.id where m.state = 'posted' and m.approval_state = 'PENDING'");
    const [titip] = await db.query("select coalesce(sum(titipan), 0) as titipan from v_titipan_operasional");
    const [trip] = await db.query(
      `select count(*) filter (where trip_status = 'DALAM PERJALANAN')::int as jalan,
              count(*) filter (where trip_status = 'DALAM PERJALANAN' and lewat_sla)::int as lewat_sla
       from v_tracker`);
    const [kurang] = await db.query("select count(distinct job_id)::int as jobs, coalesce(sum(kurang), 0) as total from v_kurang_transfer");
    const [tanpa] = await db.query(
      `select count(*) filter (where status = 'OPEN')::int as n, coalesce(sum(amount) filter (where status = 'OPEN'), 0) as total,
              coalesce(sum(paid) filter (where status = 'PARTNER_BALANCE' and move_type = 'in_invoice'), 0) as saldo_vendor,
              coalesce(sum(paid) filter (where status = 'PARTNER_BALANCE' and move_type = 'out_invoice'), 0) as saldo_customer
       from v_unassigned`);
    const monthly = await db.query(
      `select to_char(tanggal, 'YYYY-MM') as bulan,
              sum(case when arah = 'MASUK' then nominal else 0 end) as masuk,
              sum(case when arah = 'KELUAR' then nominal else 0 end) as keluar
       from v_cash_ledger group by 1 order by 1 desc limit 12`);
    return { totals: { ...t, ...pos, menunggu_persetujuan: pend.n, menunggu_persetujuan_total: pend.total, titipan: titip.titipan,
      trip_jalan: trip.jalan, trip_lewat_sla: trip.lewat_sla, kurang_transfer_jobs: kurang.jobs, kurang_transfer_total: kurang.total,
      tanpa_tujuan: tanpa.n, tanpa_tujuan_total: tanpa.total, saldo_vendor: tanpa.saldo_vendor, saldo_customer: tanpa.saldo_customer }, monthly };
  }));

  r.get("/rekap", read, route(async (req) => {
    const f = filterSql(req.query, { allowed: ["customer_id", "scheme", "side", "phase", "status"] });
    return db.query(
      `select side, phase, count(*)::int as jobs, sum(planned) as planned, sum(not_billed) as not_billed,
              sum(outstanding) as outstanding, sum(paid) as paid, sum(unpaid) as unpaid,
              count(*) filter (where not_billed > 0)::int as jobs_not_billed, count(*) filter (where outstanding > 0)::int as jobs_outstanding
       from v_job_phase_position ${f.sql} group by side, phase order by side desc, ${PHASE_ORDER}`, f.params);
  }));

  r.get("/rekap/jobs", read, route((req) => {
    const f = filterSql(req.query, { allowed: ["customer_id", "scheme", "side", "phase", "status"] });
    return db.query(`select * from v_job_phase_position ${f.sql} order by job_date, job_id limit 2000`, f.params);
  }));

  r.get("/aging", read, route((req) => db.query(
    `select coalesce(partner, '-') as partner, count(*)::int as docs,
            sum(case when age_days <= 30 then residual else 0 end) as d0_30,
            sum(case when age_days between 31 and 60 then residual else 0 end) as d31_60,
            sum(case when age_days between 61 and 90 then residual else 0 end) as d61_90,
            sum(case when age_days > 90 then residual else 0 end) as d90,
            sum(residual) as total
     from v_aging where move_type = $1 group by 1 order by total desc`,
    [req.query.move_type === "in_invoice" ? "in_invoice" : "out_invoice"])));

  r.get("/kurang-transfer", read, route(() => db.query("select * from v_kurang_transfer order by side desc, job_date, job_id")));

  r.get("/ledger", read, route((req) => {
    const f = filterSql(req.query, { date: "tanggal", allowed: ["search"] });
    return db.query(`select * from v_cash_ledger ${f.sql} order by tanggal desc, id desc limit 3000`, f.params);
  }));

  r.get("/utang-piutang", read, route((req) => {
    const s = req.query.search ? `%${req.query.search}%` : null;
    return db.query(
      `select * from v_utang_piutang ${s ? "where job_number ilike $1 or customer ilike $1 or keterangan ilike $1" : ""} order by job_number desc limit 3000`,
      s ? [s] : []);
  }));

  r.get("/titipan", read, route(() => db.query("select * from v_titipan_operasional where titipan <> 0 order by tanggal_dana")));
  r.get("/bank-balance", read, route(() => db.query("select * from v_bank_balance order by kind, bank_account_id")));

  r.get("/tracker", read, route((req) => {
    const params = [];
    const where = [];
    if (req.query.status) { params.push(req.query.status); where.push(`trip_status = $${params.length}`); }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      where.push(`(job_number ilike $${params.length} or plate_number ilike $${params.length} or driver1_name ilike $${params.length} or customer ilike $${params.length})`);
    }
    if (req.query.from) { params.push(req.query.from); where.push(`job_date >= $${params.length}`); }
    if (req.query.to) { params.push(req.query.to); where.push(`job_date <= $${params.length}`); }
    return db.query(`select * from v_tracker ${where.length ? "where " + where.join(" and ") : ""}
      order by case trip_status when 'DALAM PERJALANAN' then 1 when 'BELUM BERANGKAT' then 2 else 3 end, gate_out_at desc nulls last, job_date desc
      limit 1000`, params);
  }));

  // ---------------------------------------------------------------- export Excel
  const exportRoute = (path, file, sheet, cols, sqlFn) => r.get(`/export/${path}`, read, async (req, res) => {
    try {
      const rows = await sqlFn(req);
      await sendSheet(res, `${file}-${today()}.xlsx`, sheet, cols, rows);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });
  // Seluruh isi database (ADMIN): daftar tabel, kolom, dan isi tiap tabel / view laporan
  r.get("/export/semua.xlsx", requireRole(ROLES.ADMIN), async (req, res) => {
    try {
      const wb = await buildAllExport(db);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="ERP-AMICO-semua-data-${today()}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      res.status(500).send(err.message);
    }
  });
  exportRoute("utang-piutang.xlsx", "UTANG-PIUTANG", "UTANG PIUTANG", COLUMNS.utang_piutang,
    async () => (await db.query("select * from v_utang_piutang order by job_number"))
      .map((x) => ({ ...x, customer_scheme_label: SCHEME_NAMES[x.customer_scheme], vendor_scheme_label: SCHEME_NAMES[x.vendor_scheme] })));
  exportRoute("jurnal-kas.xlsx", "JURNAL-KAS", "JURNAL KAS", COLUMNS.ledger, (req) => {
    const f = filterSql(req.query, { date: "tanggal", allowed: ["search"] });
    return db.query(`select * from v_cash_ledger ${f.sql} order by tanggal, id`, f.params);
  });
  exportRoute("posisi.xlsx", "POSISI-PER-FASE", "POSISI PER FASE", COLUMNS.posisi, async (req) => {
    const f = filterSql(req.query, { allowed: ["customer_id", "scheme", "side", "phase", "status"] });
    return (await db.query(`select * from v_job_phase_position ${f.sql} order by job_date, job_id, side desc, ${PHASE_ORDER}`, f.params))
      .map((x) => ({ ...x, side_label: x.side === "SALE" ? "Customer (piutang)" : "Vendor (utang)", phase_label: PHASE_NAMES[x.phase], scheme_label: SCHEME_NAMES[x.scheme] }));
  });
  exportRoute("kurang-transfer.xlsx", "KURANG-TRANSFER", "KURANG TRANSFER", COLUMNS.kurang, async () =>
    (await db.query("select * from v_kurang_transfer order by side desc, job_date, job_id"))
      .map((x) => ({ ...x, arah: x.side === "PURCHASE" ? "AMICO kurang transfer ke vendor" : "Customer kurang bayar ke AMICO" })));
  exportRoute("tracker.xlsx", "TRACKER", "TRACKER", COLUMNS.tracker, async () =>
    (await db.query("select * from v_tracker order by job_date desc, job_id desc"))
      .map((x) => ({ ...x, lewat_sla_label: x.lewat_sla == null ? "" : x.lewat_sla ? "YA" : "TIDAK" })));

  return r;
}

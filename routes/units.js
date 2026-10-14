// Unit sewa: kontrak sewa bulanan per unit (plat), untung rugi per unit per bulan dan per trip, tagihan sewa bulanan.
//
// Aturan hitung ada di migrasi 009 (v_vehicle_day, v_vehicle_trip, v_vehicle_trip_cost). Ringkasnya:
//   biaya per hari = (sewa + biaya tetap lain) / jumlah hari bulan itu
//   kontribusi trip = selling - cost job (uang jalan); untung trip = kontribusi - sewa teralokasi (hari gate out s/d gate in)
//   untung unit sebulan = kontribusi trip yang berangkat bulan itu - sewa hari-hari bulan itu (s/d hari ini)
//   biaya menganggur = sewa di hari tanpa trip
// Kontrak satu unit tidak boleh tumpang tindih tanggalnya. Tagihan sewa: satu per kontrak per bulan (prorata hari).
import express from "express";
import ExcelJS from "exceljs";
import { requireRole, ROLES } from "../lib/auth.js";
import { route, fail, money, rupiah, today, insertRow, nextNumber, audit } from "../lib/util.js";

const monthRange = (m) => {
  const v = /^\d{4}-\d{2}$/.test(String(m || "")) ? m : today().slice(0, 7);
  const [y, mo] = v.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { month: v, from: `${v}-01`, to: `${v}-${String(last).padStart(2, "0")}`, days: last };
};
const normPlate = (p) => String(p || "").replace(/\s+/g, " ").trim().toUpperCase();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const lastDay = (ym) => { const [y, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };

// periode laporan: ?month=YYYY-MM (default bulan ini) | ?from=YYYY-MM-DD&to=YYYY-MM-DD | ?all=1 (sejak kontrak pertama s/d hari ini)
export async function periodOf(q, src = {}) {
  if (src.all === "1" || src.all === true || src.all === 1) {
    const [r] = await q.query("select min(date_start) as d from vehicle_contract");
    const from = r?.d && r.d <= today() ? r.d : `${today().slice(0, 7)}-01`;
    return { kind: "all", from, to: today(), label: "Keseluruhan" };
  }
  if (DATE.test(src.from || "") && DATE.test(src.to || "")) {
    if (src.from > src.to) fail("Tanggal awal setelah tanggal akhir");
    return { kind: "range", from: src.from, to: src.to, label: `${src.from} s/d ${src.to}` };
  }
  const m = monthRange(src.month);
  return { kind: "month", ...m, label: m.month };
}
// bulan-bulan di dalam periode (bulan awal / akhir dipotong sesuai periode)
const monthsOf = (pr) => {
  const out = [];
  for (let ym = pr.from.slice(0, 7); ym <= pr.to.slice(0, 7);) {
    out.push({ month: ym, from: ym === pr.from.slice(0, 7) ? pr.from : `${ym}-01`, to: ym === pr.to.slice(0, 7) ? pr.to : lastDay(ym) });
    const [y, m] = ym.split("-").map(Number);
    ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return out;
};

// trip unit sewa yang menyentuh periode itu (satu unit, atau semua unit kalau vehicleId kosong). rg = { from, to } atau "YYYY-MM"
export async function unitTrips(q, period, vehicleId = null) {
  const rg = typeof period === "object" && period ? period : monthRange(period);
  const rows = await q.query(
    `select t.job_id, t.vehicle_id, v.plate_number, j.job_number, j.job_date, j.gate_out_at, j.gate_in_at, j.trip_type, j.driver1_name,
            j.do_number, j.delivery_scope, cu.name as customer, lp.code as pol, ld.code as pod, t.day_from, t.day_to, t.masih_jalan,
            t.tanpa_gate, b.selling, b.cost, b.selling - b.cost as kontribusi, coalesce(tc.days, 0) as days,
            coalesce(tc.rent_cost, 0) as rent_cost, b.selling - b.cost - coalesce(tc.rent_cost, 0) as untung
     from v_vehicle_trip t join vehicle v on v.id = t.vehicle_id join job j on j.id = t.job_id join v_job_balance b on b.job_id = t.job_id
     join res_partner cu on cu.id = j.customer_id join location lp on lp.id = j.pol_id join location ld on ld.id = j.pod_id
     left join v_vehicle_trip_cost tc on tc.job_id = t.job_id
     where ($1::int is null or t.vehicle_id = $1) and t.day_from <= $3 and t.day_to >= $2
     order by t.day_from, v.plate_number, j.id`, [vehicleId ? Number(vehicleId) : null, rg.from, rg.to]);
  for (const x of rows) {
    x.rent_cost = Math.round(x.rent_cost);
    x.untung = Math.round(x.untung);
    x.status = x.masih_jalan ? "Masih jalan" : x.tanpa_gate ? "Tanpa gate (tgl job)" : "Selesai";
    x.rute = `${x.pol} - ${x.pod}${x.trip_type === "ROUND_TRIP" ? " PP" : ""}`;
  }
  return rows;
}

// ---------------------------------------------------------------- export Excel
const XL_SUMMARY = [
  ["PLAT", "plate_number", 14], ["TRUK", "truck_type", 10], ["PEMILIK", "pemilik", 22], ["SEWA / BULAN", "sewa_bulanan"],
  ["BIAYA / HARI", "biaya_per_hari"], ["HARI KONTRAK", "hari_kontrak"], ["HARI JALAN", "hari_jalan"], ["HARI MENGANGGUR", "hari_menganggur"],
  ["UTILISASI %", "utilisasi"], ["TRIP", "trips"], ["SELLING", "selling"], ["UANG JALAN", "uang_jalan"], ["KONTRIBUSI", "kontribusi"],
  ["SEWA BULAN INI", "sewa_bulan"], ["SEWA S/D HARI INI", "sewa_sd_hari_ini"], ["UNTUNG BERSIH", "untung"], ["BIAYA MENGANGGUR", "biaya_menganggur"],
  ["TITIK IMPAS (TRIP)", "titik_impas"],
];
const XL_TRIPS = [
  ["PLAT", "plate_number", 14], ["JOB NUMBER", "job_number", 16], ["KODE TUGAS", "do_number", 18], ["TGL JOB", "job_date", 12],
  ["CUSTOMER", "customer", 18], ["RUTE", "rute", 22], ["DRIVER", "driver1_name", 16], ["GATE OUT", "gate_out_at", 18], ["GATE IN", "gate_in_at", 18],
  ["STATUS", "status", 18], ["HARI DARI", "day_from", 12], ["HARI SAMPAI", "day_to", 12], ["HARI", "days"], ["SELLING", "selling"],
  ["UANG JALAN", "cost"], ["KONTRIBUSI", "kontribusi"], ["SEWA TERALOKASI", "rent_cost"], ["UNTUNG TRIP", "untung"],
];
const XL_DAYS = [["PLAT", "plate_number", 14], ["TANGGAL", "day", 12], ["BIAYA SEWA HARI INI", "day_cost"], ["STATUS", "status", 14], ["JOB", "jobs", 40]];

function addSheet(wb, name, cols, rows, totalKeys = []) {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width: width || Math.max(12, Math.min(header.length + 2, 22)) }));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2A1A0E" } };
  for (const r of rows) ws.addRow(r);
  if (rows.length && totalKeys.length) {
    const total = { [cols[0][1]]: "TOTAL" };
    for (const k of totalKeys) total[k] = rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    const tr = ws.addRow(total);
    tr.font = { bold: true };
  }
  ws.columns.forEach((c) => { if (rows.some((r) => typeof r[c.key] === "number")) c.numFmt = "#,##0;-#,##0"; });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

// untung rugi semua unit sewa dalam satu periode. period = { from, to } atau "YYYY-MM"
export async function unitSummary(q, period) {
  const r = typeof period === "object" && period ? period : monthRange(period);
  const rows = await q.query(
    `with days as (
       select vd.vehicle_id, vd.day, vd.day_cost,
              exists (select 1 from v_vehicle_trip t where t.vehicle_id = vd.vehicle_id and vd.day between t.day_from and t.day_to) as dipakai
       from v_vehicle_day vd where vd.day between $1 and $2
     ),
     trips as (
       select t.vehicle_id, count(*)::int as trips, sum(b.selling) as selling, sum(b.cost) as cost,
              sum(tc.rent_cost) as rent_alloc, count(*) filter (where t.masih_jalan)::int as masih_jalan,
              count(*) filter (where t.tanpa_gate)::int as tanpa_gate
       from v_vehicle_trip t join v_job_balance b on b.job_id = t.job_id
       left join v_vehicle_trip_cost tc on tc.job_id = t.job_id
       where t.day_from between $1 and $2 group by t.vehicle_id
     )
     select v.id as vehicle_id, v.plate_number, v.truck_type,
            (select string_agg(distinct p.name, ', ') from vehicle_contract c left join res_partner p on p.id = c.partner_id
              where c.vehicle_id = v.id and c.date_start <= $2 and coalesce(c.date_end, $2) >= $1) as pemilik,
            (select max(c.monthly_rent + c.other_monthly_cost) from vehicle_contract c
              where c.vehicle_id = v.id and c.date_start <= $2 and coalesce(c.date_end, $2) >= $1) as sewa_bulanan,
            count(d.day)::int as hari_kontrak,
            count(d.day) filter (where d.day <= $3)::int as hari_berjalan,
            count(d.day) filter (where d.day <= $3 and d.dipakai)::int as hari_jalan,
            count(d.day) filter (where d.day <= $3 and not d.dipakai)::int as hari_menganggur,
            coalesce(sum(d.day_cost), 0) as sewa_bulan,
            coalesce(sum(d.day_cost) filter (where d.day <= $3), 0) as sewa_sd_hari_ini,
            coalesce(sum(d.day_cost) filter (where d.day <= $3 and not d.dipakai), 0) as biaya_menganggur,
            coalesce(t.trips, 0) as trips, coalesce(t.selling, 0) as selling, coalesce(t.cost, 0) as uang_jalan,
            coalesce(t.selling, 0) - coalesce(t.cost, 0) as kontribusi, coalesce(t.masih_jalan, 0) as masih_jalan,
            coalesce(t.tanpa_gate, 0) as tanpa_gate
     from vehicle v
     join days d on d.vehicle_id = v.id
     left join trips t on t.vehicle_id = v.id
     group by v.id, t.trips, t.selling, t.cost, t.masih_jalan, t.tanpa_gate
     order by v.plate_number`, [r.from, r.to, today()]);
  for (const x of rows) {
    // sewa per hari bisa berkoma (15.000.000 / 31); ditampilkan dalam rupiah bulat
    for (const k of ["sewa_bulan", "sewa_sd_hari_ini", "biaya_menganggur"]) x[k] = Math.round(x[k]);
    x.biaya_per_hari = x.hari_kontrak ? Math.round(x.sewa_bulan / x.hari_kontrak) : 0;
    x.untung = money(x.kontribusi - x.sewa_sd_hari_ini);
    x.utilisasi = x.hari_berjalan ? Math.round((x.hari_jalan / x.hari_berjalan) * 100) : 0;
    const avg = x.trips ? x.kontribusi / x.trips : 0;
    x.titik_impas = avg > 0 ? Math.round((x.sewa_bulan / avg) * 10) / 10 : null;   // trip dalam periode agar sewa tertutup
  }
  return { ...r, today: today(), units: rows };
}

// ---------------------------------------------------------------- periode kontrak (siklus sewa)
// Satu siklus = satu bulan sewa mengikuti tanggal mulai kontrak (mulai 21 Sep -> 21 Sep-20 Okt, 21 Okt-20 Nov, ...).
// Sisa ekor <= 2 hari di akhir kontrak digabung ke siklus terakhir (mis. kontrak 6 Okt - 6 Nov = satu siklus).
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => isoDay(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
function addMonthsClamp(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return isoDay(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last))));
}
export function contractCycles(start, end, now) {
  const stop = end || now;                     // kontrak tanpa tanggal selesai: sampai siklus yang memuat hari ini
  const out = [];
  for (let k = 0; k < 600; k++) {
    const from = addMonthsClamp(start, k);
    if (from > stop) break;
    const full = addDays(addMonthsClamp(start, k + 1), -1);
    let to = end && full > end ? end : full;
    if (end && to < end && dayDiff(to, end) <= 2) to = end;   // ekor pendek ikut siklus ini
    // potong = siklus berhenti sebelum genap sebulan karena kontrak selesai (sewanya sebanding hari)
    out.push({ ke: k + 1, from, to, hari: dayDiff(from, to) + 1, hari_penuh: dayDiff(from, full) + 1, potong: to < full });
    if (to === end) break;
  }
  return out;
}

export async function contractPeriods(q) {
  const now = today();
  const contracts = await q.query(
    `select c.*, v.plate_number, v.truck_type, p.name as pemilik from vehicle_contract c join vehicle v on v.id = c.vehicle_id
     left join res_partner p on p.id = c.partner_id where c.date_start <= $1::date + 45 order by v.plate_number, c.date_start`, [now]);
  const rows = [];
  // ringkasan unit untuk satu rentang tanggal dipakai bersama oleh kontrak lain yang siklusnya sama
  const cache = new Map();
  const summaryOf = (from, to) => {
    if (!cache.has(`${from}|${to}`)) cache.set(`${from}|${to}`, unitSummary(q, { from, to }));
    return cache.get(`${from}|${to}`);
  };
  // periode dinomori per UNIT, bukan per kontrak: kontrak bulanan yang bersambung (16 Sep - 15 Okt, lalu 16 Okt - 15 Nov)
  // tetap jadi periode 1, 2, ... dan dibandingkan dengan periode sebelumnya unit yang sama
  const perUnit = new Map();   // vehicle_id -> { ke, prev }
  for (const c of contracts) {
    const sewa = Number(c.monthly_rent) + Number(c.other_monthly_cost || 0);
    const unit = perUnit.get(c.vehicle_id) || { ke: 0, prev: null };
    perUnit.set(c.vehicle_id, unit);
    const startStr = String(c.date_start).slice(0, 10);
    if (startStr > now) {
      // kontrak yang belum mulai (mis. perpanjangan mulai besok): periode pertamanya tampil sebagai "belum mulai", angka masih 0
      const [cy] = contractCycles(startStr, c.date_end ? String(c.date_end).slice(0, 10) : null, startStr);
      unit.ke += 1;
      rows.push({
        contract_id: c.id, vehicle_id: c.vehicle_id, plate_number: c.plate_number, truck_type: c.truck_type, pemilik: c.pemilik,
        ke: unit.ke, ke_kontrak: 1, from: cy.from, to: cy.to, hari: cy.hari, hari_berjalan: 0, status: "BELUM_MULAI", mulai_dalam: dayDiff(now, cy.from),
        sewa_periode: cy.potong ? Math.round((sewa * cy.hari) / cy.hari_penuh) : Math.round(sewa), sewa_sd_hari_ini: 0, biaya_per_hari: 0,
        trips: 0, masih_jalan: 0, selling: 0, uang_jalan: 0, kontribusi: 0, hari_jalan: 0, hari_menganggur: 0, utilisasi: 0,
        untung: 0, biaya_menganggur: 0, untung_sebelumnya: null, selisih_sebelumnya: null,
      });
      continue;
    }
    for (const cy of contractCycles(String(c.date_start).slice(0, 10), c.date_end ? String(c.date_end).slice(0, 10) : null, now)) {
      unit.ke += 1;
      const prev = unit.prev;
      if (cy.from > now) {
        // periode kontrak yang diperpanjang / sudah tercatat tapi belum mulai: tampil "belum mulai", angka masih 0
        rows.push({
          contract_id: c.id, vehicle_id: c.vehicle_id, plate_number: c.plate_number, truck_type: c.truck_type, pemilik: c.pemilik,
          ke: unit.ke, ke_kontrak: cy.ke, from: cy.from, to: cy.to, hari: cy.hari, hari_berjalan: 0, status: "BELUM_MULAI", mulai_dalam: dayDiff(now, cy.from),
          sewa_periode: cy.potong ? Math.round((sewa * cy.hari) / cy.hari_penuh) : Math.round(sewa), sewa_sd_hari_ini: 0, biaya_per_hari: 0,
          trips: 0, masih_jalan: 0, selling: 0, uang_jalan: 0, kontribusi: 0, hari_jalan: 0, hari_menganggur: 0, utilisasi: 0,
          untung: 0, biaya_menganggur: 0, untung_sebelumnya: null, selisih_sebelumnya: null,
        });
        continue;
      }
      const u = (await summaryOf(cy.from, cy.to)).units.find((x) => x.vehicle_id === c.vehicle_id) || {};
      const status = cy.to < now ? "SELESAI" : "BERJALAN";
      // sewa satu siklus = sewa bulanan penuh (termasuk ekor 1-2 hari yang digabung); siklus terpotong = sebanding jumlah harinya
      const sewaPeriode = cy.potong ? Math.round((sewa * cy.hari) / cy.hari_penuh) : Math.round(sewa);
      const berjalan = status === "BERJALAN" ? Math.min(cy.hari, dayDiff(cy.from, now) + 1) : cy.hari;
      const sewaSdHariIni = Math.round((sewaPeriode * berjalan) / cy.hari);
      const perHari = sewaPeriode / cy.hari;
      const row = {
        contract_id: c.id, vehicle_id: c.vehicle_id, plate_number: c.plate_number, truck_type: c.truck_type, pemilik: c.pemilik,
        ke: unit.ke, ke_kontrak: cy.ke, from: cy.from, to: cy.to, hari: cy.hari, hari_berjalan: berjalan, status,
        sewa_periode: sewaPeriode, sewa_sd_hari_ini: sewaSdHariIni, biaya_per_hari: Math.round(perHari),
        trips: u.trips || 0, masih_jalan: u.masih_jalan || 0, selling: u.selling || 0, uang_jalan: u.uang_jalan || 0, kontribusi: u.kontribusi || 0,
        hari_jalan: u.hari_jalan || 0, hari_menganggur: u.hari_menganggur || 0, utilisasi: u.utilisasi || 0,
      };
      row.untung = money(row.kontribusi - sewaSdHariIni);
      row.biaya_menganggur = Math.round(row.hari_menganggur * perHari);
      // dibanding siklus sebelumnya dari kontrak yang sama (siklus berjalan dibanding secara sampai hari ini)
      row.untung_sebelumnya = prev ? prev.untung : null;
      row.selisih_sebelumnya = prev ? money(row.untung - prev.untung) : null;
      rows.push(row);
      unit.prev = row;
    }
  }
  return { today: now, periods: rows };
}

// Yang perlu perhatian: kontrak habis <= 7 hari lagi (belum diperpanjang), kontrak sudah habis tapi unit masih dipakai trip
// (sewanya tidak terhitung), dan tagihan sewa yang jatuh tempo <= 3 hari lagi / sudah lewat dan belum lunas.
export const HARI_PERINGATAN_KONTRAK = 7;
export async function unitAlerts(q) {
  const now = today();
  // "sudah diperpanjang" = ada kontrak unit yang sama yang mulai paling lambat sehari setelah kontrak ini habis.
  // Kontrak berikutnya yang mulai jauh sesudahnya tetap diperingatkan (ada jeda tanpa kontrak).
  const next = `(select min(n.date_start) from vehicle_contract n where n.vehicle_id = c.vehicle_id and n.date_start > c.date_end)`;
  const ending = await q.query(
    `select * from (
       select c.id as contract_id, v.plate_number, c.date_end, (c.date_end - $1::date) as sisa_hari, p.name as pemilik, ${next} as kontrak_berikutnya
       from vehicle_contract c join vehicle v on v.id = c.vehicle_id left join res_partner p on p.id = c.partner_id
       where c.date_end between $1::date and $1::date + $2::int) x
     where kontrak_berikutnya is null or kontrak_berikutnya > date_end + 1
     order by date_end, plate_number`, [now, HARI_PERINGATAN_KONTRAK]);
  const ended = await q.query(
    `select * from (
       select c.id as contract_id, v.plate_number, c.date_end, ($1::date - c.date_end) as lewat_hari, ${next} as kontrak_berikutnya,
              (select count(*)::int from v_vehicle_trip t where t.vehicle_id = c.vehicle_id and t.day_from > c.date_end
                 and t.day_from < coalesce(${next}, '9999-12-31'::date)) as trip_setelah
       from vehicle_contract c join vehicle v on v.id = c.vehicle_id
       where c.date_end < $1::date and c.date_end >= $1::date - 31) x
     where kontrak_berikutnya is null or kontrak_berikutnya > date_end + 1
     order by date_end desc, plate_number`, [now]);
  const bills = await q.query(
    `select b.id, b.number, v.plate_number, b.due_date, b.residual, (b.due_date - $1::date) as sisa_hari
     from v_vehicle_rent_bill b join vehicle_contract c on c.id = b.contract_id join vehicle v on v.id = c.vehicle_id
     where b.state = 'posted' and b.residual > 0.004 and b.due_date is not null and b.due_date <= $1::date + 3
     order by b.due_date, v.plate_number`, [now]);
  return { today: now, hari_peringatan: HARI_PERINGATAN_KONTRAK, ending, ended: ended.filter((x) => x.trip_setelah > 0 || x.lewat_hari <= 7), bills };
}

// ringkasan periode + rincian per bulan (kalau periode lebih dari satu bulan)
async function summaryWithMonths(q, pr) {
  const s = await unitSummary(q, pr);
  const months = monthsOf(pr);
  s.period = pr;
  s.per_bulan = [];
  if (months.length > 1 || pr.kind !== "month") {
    const perMonth = await Promise.all(months.map((m) => unitSummary(q, m)));   // bersamaan, urutan bulan tetap
    months.forEach((m, i) => { for (const u of perMonth[i].units) s.per_bulan.push({ bulan: m.month, ...u }); });
  }
  return s;
}

export default function unitRoutes(db) {
  const r = express.Router();
  const read = requireRole(ROLES.READ);

  r.get("/units/summary", read, route(async (req) => summaryWithMonths(db, await periodOf(db, req.query))));
  // untung rugi per siklus kontrak sewa (bandingkan periode 1, 2, ... tiap unit)
  r.get("/units/periods", read, route(() => contractPeriods(db)));
  // peringatan di atas halaman Unit Sewa
  r.get("/units/alerts", read, route(() => unitAlerts(db)));
  // semua trip unit sewa dalam periode (untuk analisa lintas unit)
  r.get("/units/trips", read, route(async (req) => {
    const pr = await periodOf(db, req.query);
    return { ...pr, period: pr, trips: await unitTrips(db, pr, req.query.vehicle_id || null) };
  }));

  // Excel: RINGKASAN UNIT, TRIP, HARIAN. POST { month, vehicle_ids?, job_ids? } = persis yang tampil setelah filter di layar.
  const exportUnits = async (req, res, b) => {
    try {
      const rg = await periodOf(db, b);
      const keepV = Array.isArray(b.vehicle_ids) && b.vehicle_ids.length ? new Set(b.vehicle_ids.map(Number)) : null;
      const keepJ = Array.isArray(b.job_ids) && b.job_ids.length ? new Set(b.job_ids.map(Number)) : null;
      const sum = await summaryWithMonths(db, rg);
      let units = sum.units;
      if (b.vehicle_id) units = units.filter((u) => u.vehicle_id === Number(b.vehicle_id));
      if (keepV) units = units.filter((u) => keepV.has(u.vehicle_id));
      let trips = await unitTrips(db, rg, b.vehicle_id || null);
      if (keepJ) trips = trips.filter((t) => keepJ.has(t.job_id));
      else if (keepV) trips = trips.filter((t) => keepV.has(t.vehicle_id));
      const vids = [...new Set((b.vehicle_id ? [Number(b.vehicle_id)] : units.map((u) => u.vehicle_id)))];
      const days = vids.length ? await db.query(
        `select v.plate_number, to_char(g.d, 'YYYY-MM-DD') as day, round(vd.day_cost) as day_cost,
                (select string_agg(j.job_number, ', ' order by j.job_number) from v_vehicle_trip t join job j on j.id = t.job_id
                  where t.vehicle_id = v.id and g.d::date between t.day_from and t.day_to) as jobs
         from vehicle v cross join generate_series($2::date, $3::date, interval '1 day') g(d)
         left join v_vehicle_day vd on vd.vehicle_id = v.id and vd.day = g.d::date
         where v.id = any($1::int[]) order by v.plate_number, g.d`, [vids, rg.from, rg.to]) : [];
      for (const d of days) d.status = d.day_cost == null ? "Di luar kontrak" : d.day > today() ? "Belum terjadi" : d.jobs ? "Dipakai" : "Menganggur";
      const wb = new ExcelJS.Workbook();
      addSheet(wb, "RINGKASAN UNIT", XL_SUMMARY, units,
        ["hari_kontrak", "hari_jalan", "hari_menganggur", "trips", "selling", "uang_jalan", "kontribusi", "sewa_bulan", "sewa_sd_hari_ini", "untung", "biaya_menganggur"]);
      addSheet(wb, "TRIP", XL_TRIPS, trips, ["days", "selling", "cost", "kontribusi", "rent_cost", "untung"]);
      addSheet(wb, "HARIAN", XL_DAYS, days, ["day_cost"]);
      if (sum.per_bulan.length) {
        let pb = sum.per_bulan;
        if (b.vehicle_id) pb = pb.filter((u) => u.vehicle_id === Number(b.vehicle_id));
        if (keepV) pb = pb.filter((u) => keepV.has(u.vehicle_id));
        addSheet(wb, "PER BULAN", [["BULAN", "bulan", 10], ...XL_SUMMARY], pb,
          ["hari_jalan", "hari_menganggur", "trips", "selling", "uang_jalan", "kontribusi", "sewa_sd_hari_ini", "untung", "biaya_menganggur"]);
      }
      const plate = b.vehicle_id && units[0] ? `-${units[0].plate_number.replace(/\s/g, "")}` : "";
      const tag = rg.kind === "all" ? "keseluruhan" : rg.kind === "range" ? `${rg.from}_sd_${rg.to}` : rg.month;
      const name = `unit-sewa-${tag}${plate}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
  r.get("/units/export.xlsx", read, (req, res) => exportUnits(req, res, req.query));
  r.post("/units/export.xlsx", read, (req, res) => exportUnits(req, res, req.body || {}));

  // rincian satu unit: trip bulan itu + kalender hari (dipakai / menganggur)
  r.get("/units/:vehicleId/detail", read, route(async (req) => {
    const id = Number(req.params.vehicleId);
    const rg = await periodOf(db, req.query);
    const [vehicle] = await db.query("select * from vehicle where id = $1", [id]);
    if (!vehicle) fail("Unit tidak ditemukan", 404);
    const trips = await unitTrips(db, rg, id);
    const days = await db.query(
      `select to_char(g.d, 'YYYY-MM-DD') as day, vd.day_cost,
              (select string_agg(j.job_number, ', ' order by j.job_number) from v_vehicle_trip t join job j on j.id = t.job_id
                where t.vehicle_id = $1 and g.d::date between t.day_from and t.day_to) as jobs
       from generate_series($2::date, $3::date, interval '1 day') g(d)
       left join v_vehicle_day vd on vd.vehicle_id = $1 and vd.day = g.d::date
       order by g.d`, [id, rg.from, rg.to]);
    const contracts = await db.query(
      `select c.*, p.name as partner from vehicle_contract c left join res_partner p on p.id = c.partner_id
       where c.vehicle_id = $1 order by c.date_start`, [id]);
    for (const x of days) if (x.day_cost != null) x.day_cost = Math.round(x.day_cost);
    return { ...rg, period: rg, today: today(), vehicle, trips, days: days.slice(-400), contracts };
  }));

  // ---------------------------------------------------------------- kontrak sewa
  r.get("/units/contracts", read, route(() => db.query(
    `select c.*, v.plate_number, v.truck_type, p.name as partner,
            (c.date_end is null or c.date_end >= (now() at time zone 'Asia/Jakarta')::date) as berjalan,
            c.date_start > (now() at time zone 'Asia/Jakarta')::date as belum_mulai
     from vehicle_contract c join vehicle v on v.id = c.vehicle_id left join res_partner p on p.id = c.partner_id
     order by berjalan desc, v.plate_number, c.date_start desc`)));

  // ganti plat / jenis truk dari form kontrak. Plat baru yang sudah ada di master -> kontrak pindah ke unit itu;
  // unit lama yang jadi tidak terpakai (tanpa kontrak lain & tanpa job) dihapus. Plat baru yang belum ada -> unit ini diganti platnya
  // (kalau unit ini juga dipakai kontrak lain / job, dibuat unit baru supaya data lain tidak ikut berubah).
  const changeUnit = async (t, contractId, curId, b) => {
    const [cur] = await t.query("select * from vehicle where id = $1 for update", [curId]);
    if (!cur) fail("Unit tidak ditemukan", 404);
    const plate = normPlate(b.plate_number);
    const truck = String(b.truck_type || "").trim().toUpperCase();
    const key = (x) => String(x || "").replace(/\s/g, "").toUpperCase();
    const usedElsewhere = async (vid) => (await t.query(
      "select (select count(*) from vehicle_contract where vehicle_id = $1 and id <> $2)::int + (select count(*) from job where vehicle_id = $1)::int as n",
      [vid, contractId]))[0].n > 0;
    if (!plate || key(plate) === key(cur.plate_number)) {
      if (truck && truck !== cur.truck_type) await t.query("update vehicle set truck_type = $1 where id = $2", [truck, cur.id]);
      return { vid: cur.id, orphan: null };
    }
    const [ex] = await t.query("select id from vehicle where upper(regexp_replace(plate_number, '\\s', '', 'g')) = $1 and id <> $2", [key(plate), cur.id]);
    if (ex) {
      if (truck) await t.query("update vehicle set truck_type = $1 where id = $2", [truck, ex.id]);
      return { vid: ex.id, orphan: (await usedElsewhere(cur.id)) ? null : cur.id };
    }
    if (!(await usedElsewhere(cur.id))) {
      await t.query("update vehicle set plate_number = $1, truck_type = $2 where id = $3", [plate, truck || cur.truck_type, cur.id]);
      return { vid: cur.id, orphan: null };
    }
    const vid = await insertRow(t, "vehicle", { plate_number: plate, truck_type: truck || cur.truck_type, owner_partner_id: cur.owner_partner_id, pic: cur.pic });
    return { vid, orphan: null };
  };

  const saveContract = async (t, req, id) => {
    const b = req.body || {};
    let vehicleId = Number(b.vehicle_id) || null;
    // unit baru langsung dari form: plat + jenis truk
    if (!vehicleId) {
      const plate = normPlate(b.plate_number);
      if (!plate) fail("Pilih unit atau isi plat");
      const [ex] = await t.query("select id from vehicle where upper(regexp_replace(plate_number, '\\s', '', 'g')) = $1", [plate.replace(/\s/g, "")]);
      vehicleId = ex?.id || await insertRow(t, "vehicle", { plate_number: plate, truck_type: String(b.truck_type || "").trim().toUpperCase() || "CDDL",
        owner_partner_id: b.partner_id ? Number(b.partner_id) : null });
    }
    let unitChange = null;
    if (id && vehicleId && (b.plate_number || b.truck_type)) {
      const [cv] = await t.query("select plate_number, truck_type from vehicle where id = $1", [vehicleId]);
      unitChange = await changeUnit(t, id, vehicleId, b);
      if (unitChange.vid !== vehicleId || normPlate(b.plate_number) !== normPlate(cv.plate_number) || (b.truck_type && b.truck_type.toUpperCase() !== cv.truck_type))
        unitChange.dari = cv;
      vehicleId = unitChange.vid;
    }
    if (!b.date_start) fail("Isi tanggal mulai sewa");
    if (b.date_end && b.date_end < b.date_start) fail("Tanggal selesai sebelum tanggal mulai");
    const rent = money(b.monthly_rent);
    if (!(rent > 0)) fail("Isi biaya sewa per bulan");
    const [overlap] = await t.query(
      `select id, date_start, date_end from vehicle_contract where vehicle_id = $1 and id <> $2
       and date_start <= coalesce($4::date, 'infinity'::date) and coalesce(date_end, 'infinity'::date) >= $3::date`,
      [vehicleId, id || 0, b.date_start, b.date_end || null]);
    if (overlap) fail(`Unit ini sudah punya kontrak ${overlap.date_start} s/d ${overlap.date_end || "sekarang"} yang tumpang tindih. Isi tanggal selesai kontrak lama dulu.`);
    const row = {
      vehicle_id: vehicleId, partner_id: b.partner_id ? Number(b.partner_id) : null, date_start: b.date_start, date_end: b.date_end || null,
      monthly_rent: rent, other_monthly_cost: money(b.other_monthly_cost), note: b.note || null,
    };
    if (id) {
      const [old] = await t.query("select * from vehicle_contract where id = $1 for update", [id]);
      if (!old) fail("Kontrak tidak ditemukan", 404);
      const [billed] = await t.query("select count(*)::int as n from vehicle_rent_bill where contract_id = $1 and state = 'posted'", [id]);
      if (billed.n && (Number(old.monthly_rent) !== rent || old.date_start !== b.date_start))
        fail("Kontrak ini sudah ditagih. Untuk harga sewa baru, isi tanggal selesai kontrak ini lalu buat kontrak baru mulai tanggal harga baru.");
      await t.query(`update vehicle_contract set ${Object.keys(row).map((k, i) => `${k} = $${i + 1}`).join(", ")} where id = $${Object.keys(row).length + 1}`,
        [...Object.values(row), id]);
      if (unitChange?.orphan) await t.query("delete from vehicle where id = $1", [unitChange.orphan]);
      await audit(t, req, "vehicle_contract", id, "update", { dari: { sewa: old.monthly_rent, mulai: old.date_start, selesai: old.date_end,
        ...(unitChange?.dari ? { plat: unitChange.dari.plate_number, truk: unitChange.dari.truck_type } : {}) },
        ke: { ...row, ...(unitChange?.dari ? { plat: normPlate(b.plate_number) || unitChange.dari.plate_number, truk: b.truck_type || unitChange.dari.truck_type } : {}) } });
      return id;
    }
    const newId = await insertRow(t, "vehicle_contract", { ...row, created_by: req.user.id });
    await audit(t, req, "vehicle_contract", newId, "create", row);
    return newId;
  };
  r.post("/units/contracts", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => ({ id: await saveContract(t, req, null) }))));
  r.put("/units/contracts/:id", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => ({ id: await saveContract(t, req, Number(req.params.id)) }))));

  // hapus kontrak: hanya kalau belum punya tagihan sewa (tagihan = dokumen keuangan). Unit tetap ada di master Kendaraan.
  // Perpanjang: tanggal selesai mundur N bulan di kontrak yang sama (tanggal yang sama bulan berikutnya: habis 16 Okt -> 16 Nov),
  // jadi periode tetap 16 - 15 dan tidak perlu kontrak baru tiap bulan. Harga baru tetap lewat kontrak baru.
  r.post("/units/contracts/:id/extend", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const months = Math.max(1, Math.min(24, Number(req.body?.months) || 1));
    const [c] = await t.query(
      "select c.*, v.plate_number from vehicle_contract c join vehicle v on v.id = c.vehicle_id where c.id = $1 for update of c", [id]);
    if (!c) fail("Kontrak tidak ditemukan", 404);
    if (!c.date_end) fail(`Kontrak ${c.plate_number} tidak punya tanggal selesai (berjalan terus), tidak perlu diperpanjang`);
    const end = addMonthsClamp(String(c.date_end).slice(0, 10), months);
    const [next] = await t.query(
      "select date_start from vehicle_contract where vehicle_id = $1 and id <> $2 and date_start > $3 and date_start <= $4 order by date_start limit 1",
      [c.vehicle_id, id, c.date_end, end]);
    if (next) fail(`Sudah ada kontrak ${c.plate_number} berikutnya mulai ${String(next.date_start).slice(0, 10)}. Perpanjang sampai sebelum tanggal itu, atau ubah kontrak tersebut.`);
    await t.query("update vehicle_contract set date_end = $1 where id = $2", [end, id]);
    await audit(t, req, "vehicle_contract", id, "extend", { dari: c.date_end, ke: end, bulan: months });
    return { id, date_end: end };
  })));

  r.delete("/units/contracts/:id", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const [c] = await t.query(
      "select c.*, v.plate_number from vehicle_contract c join vehicle v on v.id = c.vehicle_id where c.id = $1 for update of c", [id]);
    if (!c) fail("Kontrak tidak ditemukan", 404);
    if (!String(req.body?.reason || "").trim()) fail("Alasan wajib diisi");
    const [b] = await t.query("select count(*)::int as n from vehicle_rent_bill where contract_id = $1", [id]);
    if (b.n) fail(`Kontrak ${c.plate_number} sudah punya ${b.n} tagihan sewa, jadi tidak bisa dihapus. Kalau sewanya sudah berhenti, isi tanggal selesai sewa.`);
    await t.query("delete from vehicle_contract where id = $1", [id]);
    await audit(t, req, "vehicle_contract", id, "delete",
      { plat: c.plate_number, sewa: c.monthly_rent, mulai: c.date_start, selesai: c.date_end, alasan: req.body.reason });
    return { ok: true };
  })));

  // ---------------------------------------------------------------- tagihan sewa bulanan
  r.get("/units/rent-bills", read, route(async (req) => {
    const pr = await periodOf(db, req.query);
    const rg = { from: `${pr.from.slice(0, 7)}-01`, to: pr.to };
    return db.query(
      `select b.*, v.plate_number, v.truck_type, p.name as partner, c.monthly_rent,
              greatest(b.period, c.date_start) as dari, greatest(b.period, c.date_start) + b.days - 1 as sampai,
              (select json_agg(json_build_object('id', x.id, 'pay_date', x.pay_date, 'amount', x.amount, 'note', x.note,
                 'reversed', x.reversed_payment_id is not null or exists (select 1 from vehicle_rent_payment y where y.reversed_payment_id = x.id),
                 'bank', ba.name) order by x.id)
               from vehicle_rent_payment x left join res_bank_account ba on ba.id = x.bank_account_id where x.bill_id = b.id) as payments
       from v_vehicle_rent_bill b join vehicle_contract c on c.id = b.contract_id join vehicle v on v.id = c.vehicle_id
       left join res_partner p on p.id = c.partner_id
       where ($1::text = 'all' or b.period between $2::date and $3::date) order by b.period desc, v.plate_number`,
      [pr.kind === "all" ? "all" : "", rg.from, rg.to]);
  }));

  // buat tagihan sewa untuk semua kontrak yang berjalan di bulan itu (prorata hari), yang sudah ada dilewati
  // Tagihan sewa = satu per kontrak per PERIODE KONTRAK (siklus sewa mengikuti tanggal mulai kontrak, sama dengan tab
  // "Per periode kontrak"). Jatuh tempo bawaan = tanggal mulai periode unit itu, jadi tiap unit beda (bisa diubah per tagihan).
  // Dibuat untuk semua periode yang sudah mulai (s/d hari ini) dan belum punya tagihan; ?month=YYYY-MM = hanya periode yang mulai di bulan itu.
  r.post("/units/rent-bills/generate", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const now = today();
    const month = req.body?.month ? monthRange(req.body.month) : null;
    const contracts = await t.query("select * from vehicle_contract where date_start <= $1 order by id for update", [now]);
    const made = [], skipped = [];
    for (const c of contracts) {
      const start = String(c.date_start).slice(0, 10), end = c.date_end ? String(c.date_end).slice(0, 10) : null;
      for (const cy of contractCycles(start, end, now)) {
        if (cy.from > now || (month && (cy.from < month.from || cy.from > month.to))) continue;
        const [has] = await t.query("select 1 from vehicle_rent_bill where contract_id = $1 and period = $2 and state = 'posted'", [c.id, cy.from]);
        if (has) continue;
        // jangan tertagih dua kali: tanggal periode ini sudah tercakup tagihan lain (mis. tagihan model lama per bulan kalender)
        const [overlap] = await t.query(
          `select b.number from vehicle_rent_bill b
           where b.contract_id = $1 and b.state = 'posted'
             and greatest(b.period, $4::date) <= $3::date and greatest(b.period, $4::date) + b.days - 1 >= $2::date
           order by b.id limit 1`, [c.id, cy.from, cy.to, start]);
        if (overlap) { skipped.push({ contract_id: c.id, dari: cy.from, sampai: cy.to, karena: overlap.number }); continue; }
        // ke pemilik hanya sewa (biaya tetap lain tidak ditagihkan); periode terpotong selesai kontrak = sebanding hari
        const amount = Math.round(cy.potong ? (Number(c.monthly_rent) * cy.hari) / cy.hari_penuh : Number(c.monthly_rent));
        if (!(amount > 0)) continue;
        const yymm = cy.from.slice(2, 4) + cy.from.slice(5, 7);
        const id = await insertRow(t, "vehicle_rent_bill", {
          number: await nextNumber(t, `SWA/${yymm}`, `SWA/${yymm}/`),
          contract_id: c.id, period: cy.from, days: cy.hari, amount, due_date: cy.from, note: req.body?.note || null, created_by: req.user.id,
        });
        await audit(t, req, "vehicle_rent_bill", id, "create", { contract_id: c.id, period: cy.from, sampai: cy.to, days: cy.hari, amount, jatuh_tempo: cy.from });
        made.push({ id, amount });
      }
    }
    if (skipped.length) {
      const plates = new Map((await t.query("select c.id, v.plate_number from vehicle_contract c join vehicle v on v.id = c.vehicle_id")).map((x) => [x.id, x.plate_number]));
      for (const x of skipped) x.plate_number = plates.get(x.contract_id);
    }
    return { count: made.length, total: money(made.reduce((a, x) => a + x.amount, 0)), skipped };
  })));

  // ubah jatuh tempo / catatan satu tagihan (mis. pemilik minta dibayar tanggal lain)
  r.put("/units/rent-bills/:id", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const [b] = await t.query("select * from vehicle_rent_bill where id = $1 for update", [id]);
    if (!b) fail("Tagihan tidak ditemukan", 404);
    if (b.state !== "posted") fail("Tagihan sudah dibatalkan");
    const due = req.body?.due_date;
    if (!DATE.test(due || "")) fail("Isi tanggal jatuh tempo");
    await t.query("update vehicle_rent_bill set due_date = $1, note = coalesce($2, note) where id = $3", [due, req.body?.note ?? null, id]);
    await audit(t, req, "vehicle_rent_bill", id, "due_date", { dari: b.due_date, ke: due });
    return { ok: true };
  })));

  r.post("/units/rent-bills/:id/pay", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    await t.query("select id from vehicle_rent_bill where id = $1 for update", [id]);
    const [b] = await t.query("select * from v_vehicle_rent_bill where id = $1", [id]);
    if (!b) fail("Tagihan tidak ditemukan", 404);
    if (b.state !== "posted") fail("Tagihan sudah dibatalkan");
    const body = req.body || {};
    const amount = body.amount == null || body.amount === "" ? Number(b.residual) : money(body.amount);
    if (!(amount > 0)) fail("Nominal harus lebih dari 0");
    if (amount > Number(b.residual) + 0.004) fail(`Melebihi sisa tagihan ${rupiah(b.residual)}`);
    const [bank] = await t.query("select * from res_bank_account where id = $1", [Number(body.bank_account_id) || 0]);
    if (!bank) fail("Pilih rekening AMICO yang dipakai membayar");
    const pid = await insertRow(t, "vehicle_rent_payment", {
      bill_id: id, pay_date: body.pay_date || today(), amount, bank_account_id: bank.id, note: body.note || null, created_by: req.user.id,
    });
    await audit(t, req, "vehicle_rent_bill", id, "pay", { payment_id: pid, amount, bank: bank.name });
    return { id: pid };
  })));

  r.post("/units/rent-payments/:id/reverse", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    const [p] = await t.query("select * from vehicle_rent_payment where id = $1 for update", [id]);
    if (!p) fail("Pembayaran tidak ditemukan", 404);
    if (p.reversed_payment_id || Number(p.amount) < 0) fail("Ini sudah baris pembalik");
    const [done] = await t.query("select id from vehicle_rent_payment where reversed_payment_id = $1", [id]);
    if (done) fail("Pembayaran ini sudah dibalik");
    if (!String(req.body?.reason || "").trim()) fail("Alasan wajib diisi");
    const rid = await insertRow(t, "vehicle_rent_payment", {
      bill_id: p.bill_id, pay_date: req.body.pay_date || today(), amount: -Number(p.amount), bank_account_id: p.bank_account_id,
      reversed_payment_id: id, note: req.body.reason, created_by: req.user.id,
    });
    await audit(t, req, "vehicle_rent_bill", p.bill_id, "reverse_pay", { payment_id: id, reason: req.body.reason });
    return { id: rid };
  })));

  r.post("/units/rent-bills/:id/cancel", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const id = Number(req.params.id);
    await t.query("select id from vehicle_rent_bill where id = $1 for update", [id]);
    const [b] = await t.query("select * from v_vehicle_rent_bill where id = $1", [id]);
    if (!b) fail("Tagihan tidak ditemukan", 404);
    if (b.state !== "posted") fail("Tagihan sudah dibatalkan");
    if (Math.abs(Number(b.paid)) > 0.004) fail("Tagihan ini sudah ada pembayaran. Balik dulu pembayarannya.");
    if (!String(req.body?.reason || "").trim()) fail("Alasan wajib diisi");
    await t.query("update vehicle_rent_bill set state = 'cancelled', cancel_reason = $1 where id = $2", [req.body.reason, id]);
    await audit(t, req, "vehicle_rent_bill", id, "cancel", { reason: req.body.reason });
    return { ok: true };
  })));

  return r;
}

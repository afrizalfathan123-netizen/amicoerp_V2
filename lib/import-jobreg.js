// Impor JOB REGISTRATION.xlsx (Excel finance) ke ERP AMICO v2. Port dari importer AMICO Lite.
// File Excel hanya DIBACA. Dipakai oleh scripts/import-jobreg.js dan test/jobreg.test.js.
//
// Sumber: sheet FINANCE (job + uang), JOB LIST (gate out/in, SJ, catatan finance),
// UTANG PIUTANG (sudah dibayar atau belum, skema 100%). Kolom dicari dari nama header, bukan nomor kolom.
//
// Aturan:
// - Setiap baris FINANCE -> 1 job (nomor job sama dengan Excel). Nomor dengan bulan > 12 (mis. AMC/2698/0001)
//   dibetulkan memakai bulan tanggal job (AMC/2608/0001) dan dicatat di laporan.
// - VENDOR BILL 70% / 30%       -> pengajuan vendor (in_invoice, sudah disetujui) per fase.
//   Bagian calo / selisih masuk dokumen terpisah fase "Calo / biaya lain" (aturan v2).
// - REGISTER PAYMENT 70% / 30%  -> invoice customer (out_invoice) per fase.
// - Sudah dibayar berapa: dari UTANG PIUTANG kalau job itu ada di sana; kalau tidak, dianggap
//   dibayar pada tanggal di kolom DATE (tanggal kosong -> tanggal job, dicatat di laporan).
// - Selling setelah pajak dihitung dari pajak customer (GSL, TREX, PANCA, FORTIS, CIPS tanpa pajak; lainnya
//   PPh 2% + PPN 1,1%). Kolom SELLING AFTER TAX di Excel yang beda hanya dicatat, tidak diikuti.
//   Kurang transfer (70/30) muncul sendiri di laporan Kurang Transfer.
// - Baris format lama (kolom nominal berisi teks) -> job saja, isi aslinya di catatan job.
// - Nominal yang melebihi cost / selling -> baris calo (kalau ada), sisanya "selisih tanpa tujuan" (baris dokumen tanpa
//   baris order). Uangnya tetap tercatat, selling / cost job tetap sesuai Excel; finance mengarahkannya nanti.
// - Semua yang tidak mulus masuk laporan "PERLU DICEK".
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { insertRow } from "./util.js";
import { BUSINESS_TABLES } from "./import-amico.js";

// ------------------------------------------------------------ baca nilai sel
export function raw(cell) {
  let v = cell?.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("formula" in v || "sharedFormula" in v || "result" in v) v = v.result ?? null;
    else if ("richText" in v) v = v.richText.map((t) => t.text).join("");
    else if ("text" in v) v = v.text;
    else if ("error" in v) v = null;
  }
  if (v && typeof v === "object" && !(v instanceof Date) && "error" in v) v = null;
  if (typeof v === "string") v = v.trim();
  return v === "" ? null : v ?? null;
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const money = (v) => Math.round(Number(v || 0) * 100) / 100;

const BULAN = { jan: 1, januari: 1, feb: 2, februari: 2, mar: 3, maret: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6,
  jul: 7, juli: 7, agu: 8, agt: 8, agustus: 8, aug: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10,
  nov: 11, november: 11, des: 12, desember: 12, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => (y > 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

// Tanggal dari: Date, serial Excel, "8 Desember 2025", "5 JANUARI2026", "16/2/2026"
export function toDate(v) {
  if (v instanceof Date) {
    if (v.getUTCFullYear() < 1990) return null; // sel jam saja
    return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (isNum(v) && v > 40000 && v < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (typeof v === "string") {
    let m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (m) return ymd(+m[3], +m[2], +m[1]);
    m = v.toLowerCase().match(/^(\d{1,2})\s*([a-z]+)\.?\s*(\d{4})/);
    if (m && BULAN[m[2]]) return ymd(+m[3], BULAN[m[2]], +m[1]);
  }
  return null;
}

// Gate out/in: "07/11/2025 07.30" atau Date (kadang hari & bulan tertukar oleh Excel). Jam = WIB.
export function toDateTime(v, jobDate) {
  let y, mo, d, h = 0, mi = 0;
  if (v instanceof Date) {
    if (v.getUTCFullYear() < 1990) return null;
    [y, mo, d, h, mi] = [v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), v.getUTCHours(), v.getUTCMinutes()];
    const near = (yy, mm, dd) => jobDate && Math.abs(new Date(`${ymd(yy, mm, dd)}T00:00:00Z`) - new Date(`${jobDate}T00:00:00Z`)) <= 20 * 86400000;
    if (!near(y, mo, d) && d <= 12 && ymd(y, d, mo) && near(y, d, mo)) [mo, d] = [d, mo];
  } else if (typeof v === "string") {
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2})[.:](\d{2}))?/);
    if (!m) return null;
    [d, mo, y, h, mi] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0)];
  } else return null;
  const day = ymd(y, mo, d);
  return day ? `${day} ${pad(h)}:${pad(mi)}:00+07` : null;
}

// AMC/2607/0001 -> angka urut untuk dibandingkan
export const jobKey = (no) => {
  const m = String(no).match(/^AMC\/(\d{4})\/?(\d+)$/i);
  return m ? Number(m[1]) * 100000 + Number(m[2]) : null;
};

// ------------------------------------------------------------ baca workbook
const norm = (s) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();
const letter = (c) => (c <= 26 ? String.fromCharCode(64 + c) : String.fromCharCode(64 + Math.floor((c - 1) / 26)) + String.fromCharCode(65 + ((c - 1) % 26)));

// want: { key: "NAMA HEADER" | ["NAMA", nomorKe] }. Header dicocokkan persis (huruf besar, spasi dirapikan).
// Nama yang muncul lebih dari sekali (DATE 70%) dipilih dengan nomorKe (1 = pertama).
function readSheet(wb, name, headerRow, want, optional = []) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`Sheet "${name}" tidak ada di file Excel`);
  const header = ws.getRow(headerRow);
  const found = {};
  const seen = {};
  for (let c = 1; c <= Math.max(header.cellCount, 60); c++) {
    const h = norm(raw(header.getCell(c)));
    if (!h) continue;
    seen[h] = (seen[h] || 0) + 1;
    for (const [key, spec] of Object.entries(want)) {
      const [text, nth] = Array.isArray(spec) ? spec : [spec, 1];
      if (found[key] == null && h === text && seen[h] === nth) found[key] = c;
    }
  }
  const missing = Object.keys(want).filter((k) => found[k] == null && !optional.includes(k));
  if (missing.length)
    throw new Error(`Sheet ${name} baris ${headerRow}: kolom ${missing.map((k) => `"${[].concat(want[k])[0]}"`).join(", ")} tidak ketemu. Format Excel berubah?`);
  const rows = [];
  ws.eachRow((row, n) => {
    if (n > headerRow) rows.push({ n, get: (key) => (found[key] == null ? null : raw(row.getCell(found[key]))) });
  });
  const col = Object.fromEntries(Object.entries(found).map(([k, c]) => [k, letter(c)]));
  return { rows, col };
}

const FINANCE = {
  date: "DATE", job: "JOB NUMBER", do: "DO NUMBER", cust: "CUSTOMER", pol: "POL", pod: "POD", truck: "TRUCK TYPE", plate: "PLATE NUMBER",
  cost: "COST", calo: "CALO", selling: "SELLING", sat: "SELLING AFTER TAX",
  vb70: "VENDOR BILL 70%", d70v: ["DATE 70%", 1], vb30: "VENDOR BILL 30%", d30v: ["DATE 30%", 1],
  rp70: "REGISTER PAYMENT 70%", d70c: ["DATE 70%", 2], rp30: "REGISTER PAYMENT 30%", d30c: ["DATE 30%", 2],
};
const JOB_LIST = {
  job: "JOB NUMBER", gateOut: "GATE OUT", gateIn: "GATE IN", ketDp: "KET FINANCE DP", ketStl: "KET FINANCE PELUNASAN",
  invStl: "NOMOR INV PELUNASAN", sj: "SJ NUMBER", unit: ["POD", 2], resiRecv: "RESI SJ RECEIVED", sjRecv: "SJ RECEIVED",
  resiNo: "RESI NUMBER SJ", sjDeliv: "SJ DELIVERED", resiDeliv: "RESI SJ DELIVERED",
};
const JOB_LIST_OPTIONAL = ["ketDp", "ketStl", "invStl", "sj", "unit", "resiRecv", "sjRecv", "resiNo", "sjDeliv", "resiDeliv"];
const UTANG_PIUTANG = {
  job: "JOB NUMBER", u100: "UTANG 100%", u100t: "UTANG 100% TERBAYAR", u70: "UTANG 70%", u70t: "UTANG 70% TERBAYAR",
  u30: "UTANG 30% BELUM BAYAR", u30t: "UTANG 30% TERBAYAR",
  tempo: "TEMPO/HARI", p100b: "PIUTANG 100% BELUM TERBAYAR", p100g: "PIUTANG 100% TERTAGIH", p100t: "PIUTANG 100% TERBAYAR",
  p70b: "PIUTANG 70% BELUM TERTAGIH", p70g: "PIUTANG 70% TERTAGIH", p70t: "PIUTANG 70% TERBAYAR",
  p30b: "PIUTANG 30% BELUM TERTAGIH", p30g: "PIUTANG 30% TERTAGIH", p30t: "PIUTANG 30% TERBAYAR",
};
const UP_OPTIONAL = ["u100", "u70", "u30", "tempo", "p100b", "p100g", "p70b", "p70g", "p30b", "p30g"];

// file: path atau Buffer (unggahan)
export async function readJobReg(file) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(file)) await wb.xlsx.load(file);
  else await wb.xlsx.readFile(file);
  const fin = readSheet(wb, "FINANCE", 12, FINANCE);
  const jl = readSheet(wb, "JOB LIST", 12, JOB_LIST, JOB_LIST_OPTIONAL);
  const up = readSheet(wb, "UTANG PIUTANG", 7, UTANG_PIUTANG, UP_OPTIONAL);
  const key = (v) => String(v).trim();
  return {
    finance: fin.rows.filter((r) => r.get("job") != null),
    financeCol: fin.col,
    jobList: new Map(jl.rows.filter((r) => r.get("job") != null).map((r) => [key(r.get("job")), r])),
    utangPiutang: new Map(up.rows.filter((r) => r.get("job") != null).map((r) => [key(r.get("job")), r])),
    upCol: up.col,
  };
}

// Nomor job dari baris FINANCE. Nomor berformat tanggal dibaca balik; bulan > 12 (AMC/2698/...) dibetulkan
// memakai bulan tanggal job (AMC/2608/...).
function jobNumberOf(r) {
  const jobRaw = r.get("job");
  const original = jobRaw instanceof Date ? String(Math.round((jobRaw - Date.UTC(1899, 11, 30)) / 86400000)) : String(jobRaw).trim();
  const jobDate = toDate(r.get("date"));
  const bad = original.match(/^AMC\/(\d{2})(\d{2})\/(\d+)$/i);
  if (bad && Number(bad[2]) > 12 && jobDate && jobDate.slice(2, 4) === bad[1]) {
    return { original, J: `AMC/${bad[1]}${jobDate.slice(5, 7)}/${bad[3]}`, jobDate, renamed: true };
  }
  return { original, J: original, jobDate, renamed: false };
}

// ------------------------------------------------------------ salinan angka Excel (perbandingan di halaman Selisih)
const SNAP_FIN = ["cost", "calo", "selling", "sat", "vb70", "vb30", "rp70", "rp30"];
const SNAP_UP = ["u100", "u100t", "u70", "u70t", "u30", "u30t", "p100b", "p100g", "p100t", "p70b", "p70g", "p70t", "p30b", "p30g", "p30t"];

function buildSnapshot(finance, utangPiutang) {
  const out = new Map();
  for (const r of finance) {
    const { original, J } = jobNumberOf(r);
    if (out.has(J)) continue;
    const up = utangPiutang.get(original) || utangPiutang.get(J);
    const data = { in_up: !!up };
    for (const k of SNAP_FIN) data[k] = isNum(r.get(k)) ? money(r.get(k)) : 0;
    for (const k of SNAP_UP) data[k] = up && isNum(up.get(k)) ? money(up.get(k)) : 0;
    out.set(J, data);
  }
  return [...out].map(([job_number, data]) => ({ job_number, data }));
}

async function writeSnapshot(t, rows, name) {
  await t.query("delete from jobreg_snapshot");
  const [{ n }] = await t.query(
    `with x as (select * from jsonb_to_recordset($1::jsonb) as x(job_number text, data jsonb)),
     ins as (insert into jobreg_snapshot (job_id, data) select j.id, x.data from x join job j on j.job_number = x.job_number returning 1)
     select count(*)::int as n from ins`, [JSON.stringify(rows)]);
  const info = { file: name, at: new Date().toISOString(), jobs: n };
  await t.query(`insert into app_setting (key, value) values ('jobreg_snapshot', $1)
                 on conflict (key) do update set value = excluded.value`, [JSON.stringify(info)]);
  return info;
}

// Simpan angka JOB REG untuk job yang sudah ada di ERP, tanpa mengubah transaksi apa pun.
export async function saveJobRegSnapshot({ file, name, target }) {
  const { finance, utangPiutang } = await readJobReg(file);
  return target.tx((t) => writeSnapshot(t, buildSnapshot(finance, utangPiutang), name || path.basename(String(file))));
}

// Excel vs ERP per kolom UTANG PIUTANG, dengan penyebab beda per job
const COMPARE = [
  ["UTANG 100%", ["u100"], ["utang_100"], "PURCHASE"],
  ["UTANG 100% TERBAYAR", ["u100t"], ["utang_100_terbayar"], "PURCHASE"],
  ["UTANG 70% (DP BELUM BAYAR)", ["u70"], ["utang_70"], "PURCHASE"],
  ["UTANG 70% TERBAYAR", ["u70t"], ["utang_70_terbayar"], "PURCHASE"],
  ["UTANG 30% BELUM BAYAR", ["u30"], ["utang_30_belum_bayar"], "PURCHASE"],
  ["UTANG 30% TERBAYAR", ["u30t"], ["utang_30_terbayar"], "PURCHASE"],
  ["CALO / LAIN BELUM BAYAR", [], ["calo_lain_belum_bayar"], "PURCHASE"],
  ["PIUTANG 100% BELUM TERBAYAR + TERTAGIH", ["p100b", "p100g"], ["piutang_100_belum_terbayar"], "SALE"],
  ["PIUTANG 100% TERBAYAR", ["p100t"], ["piutang_100_terbayar"], "SALE"],
  ["PIUTANG 70% BELUM TERTAGIH", ["p70b"], ["piutang_70_belum_tertagih"], "SALE"],
  ["PIUTANG 70% TERTAGIH", ["p70g"], ["piutang_70_tertagih"], "SALE"],
  ["PIUTANG 70% TERBAYAR", ["p70t"], ["piutang_70_terbayar"], "SALE"],
  ["PIUTANG 30% BELUM TERTAGIH", ["p30b"], ["piutang_30_belum_tertagih"], "SALE"],
  ["PIUTANG 30% TERTAGIH", ["p30g"], ["piutang_30_tertagih"], "SALE"],
  ["PIUTANG 30% TERBAYAR", ["p30t"], ["piutang_30_terbayar"], "SALE"],
];

export async function compareJobReg(db) {
  const [info] = await db.query("select value from app_setting where key = 'jobreg_snapshot'");
  const rows = await db.query(
    `select s.job_id, s.data, u.*, b.cost, b.paid, b.selling, b.received
     from jobreg_snapshot s join v_utang_piutang u on u.job_id = s.job_id join v_job_balance b on b.job_id = s.job_id`);
  const kt = new Set((await db.query("select job_id, side from v_kurang_transfer")).map((r) => `${r.job_id}:${r.side}`));
  const un = new Set((await db.query("select distinct job_id, move_type from v_unassigned"))
    .map((u) => `${u.job_id}:${u.move_type === "out_invoice" ? "SALE" : "PURCHASE"}`));
  const why = (r, side, label, x, e) => {
    if (label.startsWith("CALO")) return "Calo: Excel tidak punya kolom calo / pembayaran calo";
    if (kt.has(`${r.job_id}:${side}`)) return side === "PURCHASE" ? "Kurang transfer: Excel menganggap lunas" : "Customer kurang bayar: Excel menganggap lunas";
    if (un.has(`${r.job_id}:${side}`)) return side === "PURCHASE" ? "Vendor dibayar di atas cost: kelebihan ada di Tanpa Tujuan" : "Ditagih di atas selling: kelebihan ada di Tanpa Tujuan";
    if (side === "PURCHASE" && label.startsWith("UTANG 100%") && e > x && r.paid < r.cost) return "Kurang bayar skema 100%: Excel menganggap lunas";
    if (side === "SALE" && Math.abs(r.data.sat - r.selling_net) > 1) return "Selling after tax di Excel beda dengan pajak customer";
    return "Catatan FINANCE dan UTANG PIUTANG di Excel tidak sama";
  };
  const columns = COMPARE.map(([label, xk, ek, side]) => {
    let excel = 0;
    let erp = 0;
    const jobs = [];
    for (const r of rows) {
      const x = xk.reduce((s, k) => s + Number(r.data[k] || 0), 0);
      const e = ek.reduce((s, k) => s + Number(r[k] || 0), 0);
      excel += x;
      erp += e;
      if (Math.abs(x - e) > 1) jobs.push({ job_id: r.job_id, job_number: r.job_number, customer: r.customer, excel: x, erp: e, beda: money(e - x), sebab: why(r, side, label, x, e) });
    }
    return { label, side, excel: money(excel), erp: money(erp), beda: money(erp - excel), jobs };
  });
  // angka Excel per job untuk baris kurang transfer / tanpa tujuan
  const perJob = Object.fromEntries(rows.map((r) => [r.job_id, {
    sisa_vendor: r.data.u100 + r.data.u70 + r.data.u30, dibayar_vendor: r.data.u100t + r.data.u70t + r.data.u30t,
    sisa_customer: r.data.p100b + r.data.p100g + r.data.p70b + r.data.p70g + r.data.p30b + r.data.p30g,
    dibayar_customer: r.data.p100t + r.data.p70t + r.data.p30t, in_up: r.data.in_up,
  }]));
  return { info: info?.value || null, columns, perJob };
}

// ------------------------------------------------------------ impor
const NO_TAX = new Set(["GSL", "TREX", "PANCA", "FORTIS", "CIPS"]);
const VENDOR_NAME = "VENDOR (tidak tercatat di JOB REG)";
const CALO_NAME = "CALO (JOB REG)";

// target: db v2 (lib/db.js). start: "AMC/2607/0001" -> job sebelum nomor ini dilewati.
export async function importJobReg({ file, target, start = null, reset = false, log = console.log }) {
  const startKey = start ? jobKey(start) : null;
  if (start && startKey == null) throw new Error(`Nomor mulai harus seperti AMC/2607/0001, bukan "${start}"`);
  const startDate = start ? `20${start.slice(4, 6)}-${start.slice(6, 8)}-01` : null;

  log(`Membaca ${file}`);
  const { finance, financeCol: COL, jobList, utangPiutang, upCol } = await readJobReg(file);
  log(`FINANCE ${finance.length} baris, JOB LIST ${jobList.size}, UTANG PIUTANG ${utangPiutang.size}`);

  if (reset) {
    await target.exec(`truncate ${BUSINESS_TABLES.join(", ")} restart identity cascade`);
    log("Data bisnis di database tujuan dikosongkan (user & pengaturan tetap).");
  }
  const [{ n }] = await target.query("select count(*)::int as n from job");
  if (n > 0) throw new Error(`Database tujuan sudah berisi ${n} job. Jalankan dengan --reset untuk mengosongkan dulu.`);

  const issues = [];
  const issue = (job, sheet, kolom, masalah, nilai, tindakan) =>
    issues.push({ job, sheet, kolom: kolom ?? "", masalah, nilai: nilai instanceof Date ? nilai.toISOString().slice(0, 10) : nilai ?? "", tindakan });
  const stats = { skippedBeforeStart: 0, jobs: 0, renamed: 0, jobsOldFormat: 0, moves: 0, payments: 0, unpaidMoves: 0, unassignedLines: 0, schemeFromCustomer: 0 };

  await target.tx(async (t) => {
    const ins = (table, row) => insertRow(t, table, row);
    const product = Object.fromEntries((await t.query("select kind, id from product")).map((p) => [p.kind, p.id]));

    let [bank] = await t.query("select id from res_bank_account where kind = 'BANK' and active order by is_default desc, id limit 1");
    if (!bank) {
      bank = { id: await ins("res_bank_account", { name: "Rekening AMICO (impor JOB REG)", bank_name: "-", account_number: "-", holder: "PT AMICO", kind: "BANK", is_default: true }) };
      issue("-", "-", "-", "Rekening AMICO belum ada", null, 'Dibuat "Rekening AMICO (impor JOB REG)"; ganti nama / nomornya di Master > Rekening');
    }

    const partners = new Map();
    const partnerTax = new Map();
    async function partner(name, role) {
      const clean = norm(name) || "TANPA NAMA";
      const k = `${role}:${clean}`;
      if (!partners.has(k)) {
        const code = `${role === "customer" ? "C" : "V"}-${clean.replace(/[^A-Z0-9]+/g, "-")}`.slice(0, 30);
        const tax = role === "customer" && !NO_TAX.has(clean) ? { pph_pct: 2, ppn_pct: 1.1 } : { pph_pct: 0, ppn_pct: 0 };
        const id = await ins("res_partner", { code, name: clean, is_customer: role === "customer", is_vendor: role !== "customer", ...tax });
        partners.set(k, id);
        partnerTax.set(id, tax);
      }
      return partners.get(k);
    }
    const VENDOR = await partner(VENDOR_NAME, "vendor");
    const CALO = await partner(CALO_NAME, "vendor");

    const locations = new Map();
    async function location(name) {
      const code = norm(name ?? "-").slice(0, 40) || "-";
      if (!locations.has(code)) locations.set(code, await ins("location", { code, name: code }));
      return locations.get(code);
    }

    const seen = new Set();
    const schemeCount = new Map();   // customer -> { "70_30": n, FULL: n } dari job yang skemanya terbaca
    const undecided = [];            // job tanpa UTANG PIUTANG dan tanpa nominal bayar
    for (const r of finance) {
      const { original, J, renamed } = jobNumberOf(r);
      let { jobDate } = jobNumberOf(r);
      const renamedNote = renamed ? `Nomor di Excel: ${original}` : null;

      if (startKey != null) {
        const k = jobKey(J);
        if (k != null ? k < startKey : (jobDate || "") < startDate) { stats.skippedBeforeStart++; continue; }
      }
      if (seen.has(J)) { issue(J, "FINANCE", COL.job, "Nomor job dobel", `baris ${r.n}`, "Baris kedua dilewati"); continue; }
      seen.add(J);
      if (renamedNote) {
        stats.renamed++;
        issue(J, "FINANCE", COL.job, "Bulan di nomor job salah ketik", original, `Diimpor sebagai ${J} (tanggal job ${jobDate})`);
      } else if (!/^AMC\/\d{4}\/\d+$/.test(J)) issue(J, "FINANCE", COL.job, "Nomor job tidak standar", J, "Tetap diimpor dengan nomor ini");

      const notes = renamedNote ? [renamedNote] : [];
      if (!jobDate) {
        const m = J.match(/^AMC\/(\d{2})(\d{2})\//);
        jobDate = m && Number(m[2]) <= 12 ? `20${m[1]}-${m[2]}-01` : startDate || "2000-01-01";
        issue(J, "FINANCE", COL.date, "Tanggal job kosong / tidak terbaca", r.get("date"), `Dipakai ${jobDate}`);
      }
      let pod = String(r.get("pod") ?? "-").trim();
      let trip = "ONE_WAY";
      if (/\sPP$/i.test(pod)) { trip = "ROUND_TRIP"; pod = pod.replace(/\s+PP$/i, ""); }
      let truck = String(r.get("truck") ?? "-").trim().slice(0, 20) || "-";
      // FORTIS: kolom TRUCK TYPE berisi "RIT n" (nomor rit dalam kota), bukan jenis truk
      const ritInTruck = truck.match(/^RIT\s*(\d+)$/i);
      if (ritInTruck) truck = "-";
      if (r.get("cust") == null) issue(J, "FINANCE", COL.cust, "Customer kosong", null, 'Diisi "TANPA NAMA"');
      const customerId = await partner(r.get("cust"), "customer");

      // --- nominal
      const nums = {};
      for (const k of ["cost", "calo", "selling", "vb70", "vb30", "rp70", "rp30"]) nums[k] = isNum(r.get(k)) ? money(r.get(k)) : 0;
      if (nums.cost === 0 && nums.selling === 0) issue(J, "FINANCE", `${COL.cost}/${COL.selling}`, "Cost dan selling kosong", null, "Job diimpor dengan nominal 0");
      const tax = partnerTax.get(customerId);
      const expectedSat = Math.round(nums.selling * (1 - tax.pph_pct / 100 + tax.ppn_pct / 100));
      const sat = r.get("sat");
      if (nums.selling > 0 && isNum(sat) && Math.abs(sat - expectedSat) > 1)
        issue(J, "FINANCE", COL.sat, tax.pph_pct ? "SELLING AFTER TAX di Excel tanpa pajak, padahal customer kena pajak"
          : "SELLING AFTER TAX di Excel dipotong pajak, padahal customer tidak kena pajak",
          sat, `Dipakai ${expectedSat.toLocaleString("id-ID")} (selling ${nums.selling.toLocaleString("id-ID")}${tax.pph_pct ? " - 2% + 1,1%" : ", tanpa pajak"})`);

      const textInMoney = ["vb70", "vb30", "rp70", "rp30"].filter((k) => r.get(k) != null && !isNum(r.get(k)));
      const oldFormat = textInMoney.length > 0;

      // --- skema bayar
      const up = utangPiutang.get(original) || utangPiutang.get(J);
      const upn = (k) => (up && isNum(up.get(k)) ? money(up.get(k)) : 0);
      let scheme = "70_30";
      if (up && (upn("u100") || upn("u100t") || upn("p100b") || upn("p100g") || upn("p100t"))) scheme = "FULL";
      else if (!up && nums.cost > 0 && nums.vb70 >= nums.cost && !nums.vb30) scheme = "FULL";
      const tempo = up && isNum(up.get("tempo")) ? Math.round(up.get("tempo")) : null;

      // --- JOB LIST
      const jl = jobList.get(original) || jobList.get(J);
      const trip_ = {};
      if (jl) {
        trip_.gate_out_at = toDateTime(jl.get("gateOut"), jobDate);
        trip_.gate_in_at = toDateTime(jl.get("gateIn"), jobDate);
        if (jl.get("gateOut") != null && !trip_.gate_out_at) issue(J, "JOB LIST", "B", "Gate out tidak terbaca", jl.get("gateOut"), "Dikosongkan");
        if (jl.get("gateIn") != null && !trip_.gate_in_at) issue(J, "JOB LIST", "C", "Gate in tidak terbaca", jl.get("gateIn"), "Dikosongkan");
        const text = (k) => { const v = jl.get(k); return v == null || v === "-" || typeof v === "boolean" ? null : String(v instanceof Date ? toDate(v) : v).slice(0, 80); };
        trip_.sj_number = text("sj");
        trip_.sj_resi_number = text("resiNo");
        trip_.sj_delivered_resi_number = text("resiDeliv");
        trip_.sj_resi_received_at = toDate(jl.get("resiRecv"));
        trip_.sj_received_at = toDate(jl.get("sjRecv"));
        trip_.sj_delivered_at = toDate(jl.get("sjDeliv"));
        const rit = String(jl.get("unit") ?? "").match(/^RIT\s*(\d+)/i) || ritInTruck;
        if (rit) { trip_.rit_number = Number(rit[1]); trip_.delivery_scope = "INNERCITY"; }
        for (const [label, k] of [["Ket finance DP", "ketDp"], ["Ket finance pelunasan", "ketStl"], ["No inv pelunasan", "invStl"]]) {
          const v = text(k);
          if (v) notes.push(`${label}: ${v}`);
        }
      } else issue(J, "JOB LIST", "D", "Job tidak ada di JOB LIST", null, "Gate out/in dan SJ kosong");
      if (ritInTruck && !trip_.rit_number) { trip_.rit_number = Number(ritInTruck[1]); trip_.delivery_scope = "INNERCITY"; }

      if (oldFormat) {
        stats.jobsOldFormat++;
        const keep = ["vb70", "d70v", "vb30", "d30v", "rp70", "d70c", "rp30", "d30c"]
          .map((k) => [k, r.get(k)]).filter(([, v]) => v != null)
          .map(([k, v]) => `${COL[k]}=${v instanceof Date ? toDate(v) : v}`);
        notes.push(`Isi keuangan asli (format lama, belum diimpor): ${keep.join("; ")}`);
        issue(J, "FINANCE", textInMoney.map((k) => COL[k]).join(","), "Format lama: kolom nominal berisi teks",
          textInMoney.map((k) => r.get(k)).join(" | "), "Job diimpor tanpa transaksi, isi asli disimpan di catatan job");
      }

      const jobId = await ins("job", {
        job_number: J, job_date: jobDate, customer_id: customerId, vendor_id: VENDOR,
        pol_id: await location(r.get("pol")), pod_id: await location(pod), trip_type: trip, truck_type: truck,
        plate_number: r.get("plate") != null ? String(r.get("plate")).replace(/\s+/g, " ").toUpperCase().slice(0, 20) : null,
        do_number: r.get("do") != null ? String(r.get("do")).slice(0, 60) : null,
        customer_scheme: scheme, vendor_scheme: scheme, selling_mode: nums.selling > 0 ? "CUSTOM" : "ZERO",
        state: trip_.gate_in_at ? "done" : "confirmed", ...trip_,
        note: notes.join("\n") || null, source: "JOB_REG",
      });
      stats.jobs++;
      const upHasValue = ["u100", "u100t", "u70t", "u30t", "p100b", "p100g", "p100t", "p70t", "p30t"].some((k) => upn(k));
      if (upHasValue || ["vb70", "vb30", "rp70", "rp30"].some((k) => nums[k] > 0)) {
        const c = schemeCount.get(customerId) || { "70_30": 0, FULL: 0 };
        c[scheme]++;
        schemeCount.set(customerId, c);
      } else undecided.push({ jobId, J, customerId, scheme });

      // --- baris order
      const lines = [];
      const addLine = async (side, kind, partnerId, description, amount) => {
        const id = await ins("job_line", { job_id: jobId, side, product_id: product[kind], partner_id: partnerId, description, amount });
        const line = { id, side, kind, partnerId, description, amount, used: 0 };
        lines.push(line);
        return line;
      };
      await addLine("SALE", "TRUCKING", customerId, "Jasa trucking", nums.selling);
      await addLine("PURCHASE", "TRUCKING", VENDOR, "Sewa truk", nums.cost);
      if (nums.calo > 0) await addLine("PURCHASE", "CALO", CALO, "Calo (JOB REG)", nums.calo);
      if (oldFormat) continue;

      // Pecah nominal ke baris order: trucking dulu, lalu calo, sisanya selisih tanpa tujuan
      async function allocate(side, amount, label) {
        const parts = [];
        let left = amount;
        for (const kind of side === "SALE" ? ["TRUCKING"] : ["TRUCKING", "CALO"]) {
          for (const l of lines.filter((x) => x.side === side && x.kind === kind)) {
            const take = Math.min(left, money(l.amount - l.used));
            if (take > 0) { parts.push({ line: l, amount: take }); l.used = money(l.used + take); left = money(left - take); }
          }
        }
        if (left > 0) {
          const loose = { id: null, kind: "UNASSIGNED", partnerId: side === "SALE" ? null : VENDOR, description: `Selisih tanpa tujuan (kolom ${label})` };
          parts.push({ line: loose, amount: left });
          stats.unassignedLines++;
          issue(J, "FINANCE", label, `${side === "SALE" ? "Tagihan" : "Pengajuan"} melebihi ${side === "SALE" ? "selling" : "cost + calo"}`,
            left, 'Kelebihan dicatat sebagai "selisih tanpa tujuan", diarahkan finance di menu Selisih Tanpa Tujuan');
        }
        return parts;
      }

      async function writeMove({ number, type, phase, date, parts, paid, note, dueDays }) {
        const side = type === "out_invoice" ? "SALE" : "PURCHASE";
        const total = money(parts.reduce((s, p) => s + p.amount, 0));
        let taxInfo = {};
        if (side === "SALE" && phase !== "DP") {
          const basis = money(lines.filter((l) => l.side === "SALE").reduce((s, l) => s + l.amount, 0));
          taxInfo = { tax_basis: basis, ppn_amount: Math.round(basis * tax.ppn_pct / 100), pph23_amount: Math.round(basis * tax.pph_pct / 100) };
        }
        const moveId = await ins("account_move", {
          number, move_type: type, phase, partner_id: side === "SALE" ? customerId : (parts.every((p) => p.line.kind === "CALO") ? CALO : null),
          move_date: date, due_date: dueDays != null ? addDays(date, dueDays) : null,
          bank_account_id: side === "SALE" ? bank.id : null, state: "posted",
          approval_state: side === "SALE" ? "NOT_REQUIRED" : "APPROVED", ...taxInfo,
          note, legacy_source: "JOB_REG", legacy_number: original, posted_at: `${date} 00:00:00+07`,
          approved_at: side === "SALE" ? null : `${date} 00:00:00+07`,
        });
        stats.moves++;
        const moveLines = [];
        let no = 0;
        for (const p of parts) {
          moveLines.push({
            id: await ins("account_move_line", {
              move_id: moveId, line_no: ++no, job_line_id: p.line.id, job_id: jobId, amount: p.amount, description: p.line.description,
              payee_partner_id: side === "PURCHASE" ? p.line.partnerId : null,
            }),
            amount: p.amount,
          });
        }
        if (paid > 0) {
          const payId = await ins("account_payment", {
            number: number.replace(/^JR\//, "JR/P"), payment_type: side === "SALE" ? "inbound" : "outbound",
            move_id: moveId, pay_date: date, amount: paid, bank_account_id: bank.id, note: "Impor JOB REG", legacy_source: "JOB_REG",
          });
          stats.payments++;
          let left = paid;
          for (const ml of moveLines) {
            const take = Math.min(left, ml.amount);
            if (take > 0) await ins("account_payment_line", { payment_id: payId, move_line_id: ml.id, job_id: jobId, amount: take });
            left = money(left - take);
          }
        }
        if (paid < total) stats.unpaidMoves++;
      }

      const full = scheme === "FULL";
      const buckets = [
        { key: "vb70", dateKey: "d70v", type: "in_invoice", code: "V70", phase: full ? "FULL" : "DP", upPaid: full ? "u100t" : "u70t", group: "V" },
        { key: "vb30", dateKey: "d30v", type: "in_invoice", code: "V30", phase: full ? "FULL" : "SETTLEMENT", upPaid: full ? "u100t" : "u30t", group: "V" },
        { key: "rp70", dateKey: "d70c", type: "out_invoice", code: "C70", phase: full ? "FULL" : "DP", upPaid: full ? "p100t" : "p70t", group: "C" },
        { key: "rp30", dateKey: "d30c", type: "out_invoice", code: "C30", phase: full ? "FULL" : "SETTLEMENT", upPaid: full ? "p100t" : "p30t", group: "C" },
      ];
      // Untuk job FULL, 70% dan 30% berbagi satu kolom "100% terbayar" di UTANG PIUTANG
      const upPool = {};
      for (const b of buckets) {
        const amount = nums[b.key];
        const dateRaw = r.get(b.dateKey);
        if (!(amount > 0)) {
          if (dateRaw instanceof Date && dateRaw.getUTCFullYear() > 1990 && r.get(b.key) == null)
            issue(J, "FINANCE", COL[b.dateKey], "Ada tanggal tapi nominal kosong", toDate(dateRaw), "Dilewati");
          continue;
        }
        let date = toDate(dateRaw);
        if (!date) {
          date = jobDate;
          issue(J, "FINANCE", COL[b.dateKey], "Nominal ada, tanggal kosong / tidak terbaca", dateRaw, `Dipakai tanggal job ${jobDate}`);
        }
        let paid = amount;
        if (up) {
          if (!(b.upPaid in upPool)) upPool[b.upPaid] = upn(b.upPaid);
          paid = Math.min(amount, upPool[b.upPaid]);
          upPool[b.upPaid] = money(upPool[b.upPaid] - paid);
        }
        const side = b.type === "out_invoice" ? "SALE" : "PURCHASE";
        const parts = await allocate(side, amount, COL[b.key]);
        const note = `Impor JOB REG kolom ${COL[b.key]} (baris ${r.n})`;
        const number = `JR/${b.code}/${J}`;
        if (side === "SALE") {
          await writeMove({ number, type: b.type, phase: b.phase, date, parts, paid, note, dueDays: tempo });
        } else {
          // v2: calo / selisih vendor diajukan dengan fase "Calo / biaya lain" (OTHER)
          const main = parts.filter((p) => p.line.kind !== "CALO");
          const other = parts.filter((p) => p.line.kind === "CALO");
          const mainTotal = money(main.reduce((s, p) => s + p.amount, 0));
          if (main.length) await writeMove({ number, type: b.type, phase: b.phase, date, parts: main, paid: Math.min(paid, mainTotal), note });
          if (other.length) await writeMove({ number: `JR/${b.code}L/${J}`, type: b.type, phase: "OTHER", date, parts: other, paid: money(Math.max(paid - mainTotal, 0)), note });
        }
      }
      if (up) {
        for (const [k, left] of Object.entries(upPool)) {
          if (left > 1) issue(J, "UTANG PIUTANG", upCol[k], "Terbayar di UTANG PIUTANG lebih besar dari nominal di FINANCE", left, "Kelebihan tidak dicatat sebagai pembayaran");
        }
      }
    }

    // Job yang skemanya tidak terbaca (belum ada pembayaran) ikut skema terbanyak customer-nya
    for (const u of undecided) {
      const c = schemeCount.get(u.customerId);
      const scheme = c && c.FULL > c["70_30"] ? "FULL" : "70_30";
      if (scheme === u.scheme) continue;
      await t.query("update job set customer_scheme = $1, vendor_scheme = $1 where id = $2", [scheme, u.jobId]);
      stats.schemeFromCustomer++;
      issue(u.J, "FINANCE", "-", "Skema bayar belum terbaca (belum ada di UTANG PIUTANG / belum ada nominal)", null,
        `Dipakai skema terbanyak customer ini: ${scheme === "FULL" ? "100%" : "70/30"}`);
    }

    // Nomor job baru di aplikasi melanjutkan nomor terakhir per bulan
    await t.query(
      `insert into ir_sequence (name, next_number)
       select 'JOB/' || substr(job_number, 5, 4), max(substr(job_number, 10)::int) + 1 from job
       where job_number ~ '^AMC/[0-9]{4}/[0-9]+$' group by 1
       on conflict (name) do update set next_number = greatest(ir_sequence.next_number, excluded.next_number)`);
    await t.query("insert into audit_log (entity, action, detail) values ('import', 'jobreg', $1)",
      [JSON.stringify({ file: path.basename(file), start, ...stats, issues: issues.length })]);
    await writeSnapshot(t, buildSnapshot(finance, utangPiutang), path.basename(file));
  });

  await target.exec("analyze"); // statistik baru supaya laporan tetap cepat
  log("Impor selesai:", stats);
  return { stats, issues, file, start };
}

const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ------------------------------------------------------------ laporan
export async function writeJobRegReport(target, { stats, issues, file: source, start }, file) {
  const out = new ExcelJS.Workbook();
  const head = (ws) => {
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };
  const kurang = await target.query("select * from v_kurang_transfer order by side desc, job_number");
  const sum = out.addWorksheet("RINGKASAN");
  sum.columns = [{ header: "Hal", key: "k", width: 56 }, { header: "Jumlah", key: "v", width: 16 }];
  head(sum);
  [
    ["File sumber", path.basename(source)], ["Mulai dari job", start || "(semua)"],
    ["Job sebelum nomor mulai (tidak diimpor)", stats.skippedBeforeStart],
    ["Job diimpor", stats.jobs], ["  di antaranya nomor job dibetulkan (bulan salah ketik)", stats.renamed],
    ["  di antaranya format lama (tanpa transaksi)", stats.jobsOldFormat],
    ["Dokumen invoice / pengajuan dibuat", stats.moves], ["Pembayaran dibuat", stats.payments],
    ["Dokumen belum lunas (menurut UTANG PIUTANG)", stats.unpaidMoves], ['Baris "selisih tanpa tujuan" dibuat', stats.unassignedLines],
    ["Skema bayar diambil dari skema terbanyak customer", stats.schemeFromCustomer],
    ["Job kurang transfer / kurang bayar (skema 70/30)", kurang.length],
    ["Catatan perlu dicek", issues.length],
  ].forEach(([k, v]) => sum.addRow({ k, v }));
  sum.addRow({});
  const byType = {};
  for (const i of issues) byType[i.masalah] = (byType[i.masalah] || 0) + 1;
  sum.addRow({ k: "Jenis masalah", v: "Jumlah" }).font = { bold: true };
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => sum.addRow({ k, v }));

  const ws = out.addWorksheet("PERLU DICEK");
  ws.columns = [
    { header: "JOB NUMBER", key: "job", width: 16 }, { header: "SHEET", key: "sheet", width: 15 }, { header: "KOLOM", key: "kolom", width: 10 },
    { header: "MASALAH", key: "masalah", width: 52 }, { header: "NILAI DI EXCEL", key: "nilai", width: 34 }, { header: "YANG DILAKUKAN IMPORTER", key: "tindakan", width: 56 },
  ];
  head(ws);
  issues.forEach((i) => ws.addRow(i));
  ws.autoFilter = { from: "A1", to: "F1" };

  const kt = out.addWorksheet("KURANG TRANSFER");
  const cols = ["job_number", "job_date", "customer", "side", "seharusnya", "dp_seharusnya", "dp_dibayar", "pelunasan_seharusnya", "pelunasan_dibayar", "dp_kurang", "pelunasan_kurang", "kurang"];
  kt.columns = cols.map((c) => ({ header: c === "side" ? "SISI" : c.toUpperCase().replace(/_/g, " "), key: c, width: c === "customer" ? 22 : 16 }));
  head(kt);
  kurang.forEach((r) => kt.addRow({ ...r, side: r.side === "SALE" ? "CUSTOMER KURANG BAYAR" : "AMICO KURANG TRANSFER KE VENDOR" }));

  fs.mkdirSync(path.dirname(file), { recursive: true });
  await out.xlsx.writeFile(file);
  return file;
}

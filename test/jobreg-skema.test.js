// Impor JOB REG: skema bayar dibaca per sisi, nomor FF berspasi, dan baris catatan jadi job kosong.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { importJobReg, compareJobReg } from "../lib/import-jobreg.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobreg-skema-"));
const file = path.join(dir, "JOB REGISTRATION.xlsx");
const D = (s) => new Date(`${s}T00:00:00Z`);
const wb = new ExcelJS.Workbook();
const sheet = (name, headerRow, headers, rows) => {
  const ws = wb.addWorksheet(name);
  ws.getRow(headerRow).values = headers;
  rows.forEach((r, i) => { ws.getRow(headerRow + 1 + i).values = r; });
};
sheet("FINANCE", 12,
  ["DATE", "JOB NUMBER", "DO NUMBER", "CUSTOMER", "POL", "POD", "TRUCK TYPE", "PLATE NUMBER", "COST", "CALO", "SELLING", "SELLING AFTER TAX",
   "PROFIT", "PERSENTASE", "VENDOR BILL 70%", "DATE 70%", "VENDOR BILL 30%", "DATE 30%", "REGISTER PAYMENT 70%", "DATE 70%", "REGISTER PAYMENT 30%", "DATE 30%"],
  [
    // customer 100%, vendor 70/30 sudah lunas dua-duanya
    [D("2026-10-01"), "AMC/2610/0001", "K1", "GSL", "JKT", "SBY", "CDDL", "B 1", 12000000, null, 15000000, 15000000,
     null, null, 8400000, D("2026-10-02"), 3600000, D("2026-10-05"), 15000000, D("2026-10-03")],
    // customer 70/30, vendor 100% lunas
    [D("2026-10-01"), "AMC/2610/0002", "K2", "GSL", "JKT", "SBY", "CDDL", "B 2", 5000000, null, 8000000, 8000000,
     null, null, 5000000, D("2026-10-02"), null, null, 5600000, D("2026-10-03"), 2400000, D("2026-10-06")],
    // customer 100%, vendor 70/30 baru DP (sisa pelunasan masih utang)
    [D("2026-10-01"), "AMC/2610/0003", "K3", "GSL", "JKT", "SBY", "CDDL", "B 3", 10000000, null, 12000000, 12000000,
     null, null, 7000000, D("2026-10-02"), null, null, 12000000, D("2026-10-03")],
    // hanya kolom customer yang terisi: vendor mengikuti customer
    [D("2026-10-01"), "AMC/2610/0004", "K4", "GSL", "JKT", "SBY", "CDDL", "B 4", 1000000, null, 2000000, 2000000],
    // nomor FF dengan spasi
    [D("2026-10-28"), "AMC/2610/0974 FF", null, "GSL", "BUSAN", "JAKARTA", "FOB"],
    // baris catatan, bukan trip
    [D("2026-08-05"), "AMC/2608/0056", "DATA BASE EXTRACTOR", "GSL", "-", "-", "DATA BASE EXTRACTOR"],
    // tanpa rute & nominal tapi isiannya biasa: tidak diubah
    [D("2026-08-06"), "AMC/2608/0057", "KODE-ASLI", "GSL", "-", "-", "CDDL"],
  ]);
sheet("JOB LIST", 12,
  ["DATE", "GATE OUT", "GATE IN", "JOB NUMBER", "KET FINANCE DP", "KET FINANCE PELUNASAN", "NOMOR INV PELUNASAN", "SJ NUMBER", "CUSTOMER", "POL", "POD", "POD",
   "PLATE NUMBER", "RESI SJ RECEIVED", "SJ RECEIVED", "RESI NUMBER SJ", "LEAD TIME SJ", "SJ DELIVERED", "RESI SJ DELIVERED"],
  [[D("2026-08-05"), null, null, "AMC/2608/0056", "DONE", null, null, "DATA BASE EXTRACTOR"]]);
const blank = Array(24).fill(null);
const up = (vals) => { const r = [...blank]; for (const [c, v] of Object.entries(vals)) r[Number(c) - 1] = v; return r; };
sheet("UTANG PIUTANG", 7,
  ["JOB NUMBER", "DO NUMBER", "CUSTOMER", "KETERANGAN", "UTANG 100%", "UTANG 100% TERBAYAR", "UTANG 70%", "UTANG 70% TERBAYAR", "UTANG 30% BELUM BAYAR",
   "UTANG 30% TERBAYAR", "TANGGAL PELUNASAN UTANG", "TEMPO/HARI", "TANGGAL JATUH TEMPO", "SISA HARI", "STATUS PIUTANG", "Piutang 100% Belum Terbayar",
   "Piutang 100% Tertagih", "Piutang 100% Terbayar", "PIUTANG 70% BELUM TERTAGIH", "PIUTANG 70% TERTAGIH", "PIUTANG 70% TERBAYAR",
   "PIUTANG 30% BELUM TERTAGIH", "PIUTANG 30% TERTAGIH", "PIUTANG 30% TERBAYAR"],
  [
    up({ 1: "AMC/2610/0001", 8: 8400000, 10: 3600000, 18: 15000000 }),
    up({ 1: "AMC/2610/0002", 6: 5000000, 21: 5600000, 24: 2400000 }),
    up({ 1: "AMC/2610/0003", 8: 7000000, 9: 3000000, 18: 12000000 }),
    up({ 1: "AMC/2610/0004", 16: 2000000 }),
  ]);
await wb.xlsx.writeFile(file);

const db = await openDb({ memory: true });
await migrate(db, { log: () => {} });
await importJobReg({ file, target: db, log: () => {} });
const job = async (no) => (await db.query(
  `select j.customer_scheme as cs, j.vendor_scheme as vs, bal.requested, bal.paid, bal.received, to_jsonb(u) as up
   from job j join v_job_balance bal on bal.job_id = j.id join v_utang_piutang u on u.job_id = j.id where j.job_number = $1`, [no]))[0];
const phases = async (no, type) => (await db.query(
  `select distinct m.phase, s.amount_paid from account_move m join v_move_status s on s.move_id = m.id
   join account_move_line ml on ml.move_id = m.id join job j on j.id = ml.job_id
   where j.job_number = $1 and m.move_type = $2 order by m.phase`, [no, type])).map((x) => [x.phase, Number(x.amount_paid)]);

let j = await job("AMC/2610/0001");
assert.deepEqual([j.cs, j.vs, j.paid, j.received], ["FULL", "70_30", 12000000, 15000000]);
assert.deepEqual([j.up.utang_100, j.up.utang_70_terbayar, j.up.utang_30_terbayar, j.up.utang_30_belum_bayar], [0, 8400000, 3600000, 0]);
assert.deepEqual(await phases("AMC/2610/0001", "in_invoice"), [["DP", 8400000], ["SETTLEMENT", 3600000]]);
assert.deepEqual(await phases("AMC/2610/0001", "out_invoice"), [["FULL", 15000000]]);
j = await job("AMC/2610/0002");
assert.deepEqual([j.cs, j.vs, j.paid, j.received], ["70_30", "FULL", 5000000, 8000000]);
assert.deepEqual(await phases("AMC/2610/0002", "in_invoice"), [["FULL", 5000000]]);
j = await job("AMC/2610/0003");
assert.deepEqual([j.cs, j.vs, j.paid, j.up.utang_70_terbayar, j.up.utang_30_belum_bayar], ["FULL", "70_30", 7000000, 7000000, 3000000]);
j = await job("AMC/2610/0004");
assert.deepEqual([j.cs, j.vs], ["FULL", "FULL"]);
const x = await compareJobReg(db);
const check = ["AMC/2610/0001", "AMC/2610/0002", "AMC/2610/0003"];
assert.deepEqual(x.columns.flatMap((c) => c.jobs.map((b) => [c.label, b.job_number])).filter(([, no]) => check.includes(no)), []);

const [ff] = await db.query("select job_number, service_type from job where job_number like 'AMC/2610/0974%'");
assert.deepEqual([ff.job_number, ff.service_type], ["AMC/2610/0974FF", "FORWARDING"]);
const [m] = await db.query("select do_number, truck_type, sj_number, note from job where job_number = 'AMC/2608/0056'");
assert.deepEqual([m.do_number, m.truck_type, m.sj_number], [null, "-", null]);
assert.ok(m.note.includes("Keterangan: DATA BASE EXTRACTOR"));
const [n] = await db.query("select do_number, truck_type, note from job where job_number = 'AMC/2608/0057'");
assert.deepEqual([n.do_number, n.truck_type, n.note], ["KODE-ASLI", "CDDL", null]);

await db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("Impor JOB REG, skema per sisi: lulus");

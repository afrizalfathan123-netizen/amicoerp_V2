// Tes impor export Job List ERP AMICO v1: melengkapi job yang ada, beda dicatat, vendor + rekening, job baru.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { importJobListV1, writeJobListReport } from "../lib/import-joblist-v1.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joblist-v1-"));
const file = path.join(dir, "job-list.xlsx");
const D = (s) => new Date(`${s}Z`);   // jam dinding WIB seperti yang ditulis Excel v1

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("JOB LIST");
ws.addRow(["DATE", "GATE OUT", "GATE IN", "JOB NUMBER", "SJ NUMBER", "CUSTOMER", "POL", "POD", "TRUCK TYPE", "PLATE NUMBER",
  "RESI SJ RECEIVED", "SJ RECEIVED", "RESI NUMBER SJ", "LEAD TIME SJ", "SJ DELIVERED", "RESI SJ DELIVERED", "STATUS", "SERVICE TYPE",
  "JENIS TRIP", "UNIT DARI SIAPA", "DRIVER 1", "HP DRIVER 1", "DRIVER 2", "HP DRIVER 2", "PENERIMA TRANSFER", "BANK", "NO REKENING", "ATAS NAMA REKENING"]);
// job yang sudah ada: driver & SJ diisi, plat beda (dicatat), unit dari PT GNX dengan rekening Fulan
ws.addRow([D("2026-10-01T00:00:12"), D("2026-10-01T08:00:12"), D("2026-10-02T09:59:59"), "AMC/2610/0001", "SJ-1", "LINTAS", "JKT", "SBY", "CDDL", "B 2 BB",
  null, D("2026-10-04T00:00:12"), 15940009250526, 2, null, null, "COMPLETED", "Trucking", "One Way", "PT GNX", "Budi", "0812", "Andi", "0813",
  "Fulan", "bca", "123 456", "Fulan"]);
// job baru dari v1, tanpa unit; gate in salah ketik tahun 2926
ws.addRow([D("2026-10-05T00:00:12"), D("2026-10-05T07:00:00"), D("2926-10-06T07:00:00"), "AMC/2610/0300", null, "FORTIS", "JAT", "DC GUNUNG SAHARI", "CDEL", "B 9 CC",
  null, null, "AUTO-SJR-0300", null, null, null, "ACTIVE", "Trucking", "Round Trip", null, "DRIVER DUMMY 0300", "08000000300", null, null, "Selviana", "Mandiri", "999", "Selviana"]);
await wb.xlsx.writeFile(file);

const db = await openDb({ memory: true });
await migrate(db, { log: () => {} });
const one = async (sql, p) => (await db.query(sql, p))[0];
// data v2: job hasil impor JOB REG dengan vendor penampung + pengajuan lama
const [cust] = await db.query("insert into res_partner (code, name, is_customer, pph_pct, ppn_pct) values ('C-LINTAS', 'LINTAS', true, 2, 1.1) returning id");
const [ph] = await db.query("insert into res_partner (code, name, is_vendor) values ('V-PH', 'VENDOR (tidak tercatat di JOB REG)', true) returning id");
const [l1] = await db.query("insert into location (code, name) values ('JKT', 'JKT') returning id");
const [l2] = await db.query("insert into location (code, name) values ('SBY', 'SBY') returning id");
const [job] = await db.query(
  `insert into job (job_number, job_date, customer_id, vendor_id, pol_id, pod_id, truck_type, plate_number, sj_resi_number, source, customer_scheme, vendor_scheme)
   values ('AMC/2610/0001', '2026-10-01', $1, $2, $3, $4, 'CDDL', 'B 1 AA', '015940009250526', 'JOB_REG', '70_30', '70_30') returning id`, [cust.id, ph.id, l1.id, l2.id]);
const prod = (await one("select id from product where kind = 'TRUCKING'")).id;
const [jl] = await db.query("insert into job_line (job_id, side, product_id, partner_id, amount) values ($1, 'PURCHASE', $2, $3, 2000000) returning id", [job.id, prod, ph.id]);
await db.query("insert into job_line (job_id, side, product_id, partner_id, amount) values ($1, 'SALE', $2, $3, 2500000)", [job.id, prod, cust.id]);
const [mv] = await db.query("insert into account_move (number, move_type, phase, move_date, state, approval_state) values ('JR/V70/1', 'in_invoice', 'DP', '2026-10-01', 'posted', 'APPROVED') returning id");
await db.query("insert into account_move_line (move_id, job_line_id, job_id, amount, payee_partner_id) values ($1, $2, $3, 1400000, $4)", [mv.id, jl.id, job.id, ph.id]);

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log("  ok -", name); };

await step("pratinjau tidak menyimpan apa pun", async () => {
  const r = await importJobListV1({ file, target: db, dryRun: true });
  assert.equal(r.stats.new_jobs, 1);
  assert.equal((await one("select count(*)::int n from job")).n, 1);
  assert.equal((await one("select driver1_name from job where id = $1", [job.id])).driver1_name, null);
});

const res = await importJobListV1({ file, target: db });
await step("job yang ada dilengkapi, nilai yang beda tidak ditimpa", async () => {
  const j = await one("select * from job where id = $1", [job.id]);
  assert.deepEqual([j.driver1_name, j.driver2_phone, j.sj_number, j.sj_received_at, j.plate_number, j.state], ["Budi", "0813", "SJ-1", "2026-10-04", "B 1 AA", "done"]);
  assert.equal(j.gate_out_at.slice(0, 16), "2026-10-01T08:00");
  assert.equal(j.gate_in_at.slice(0, 16), "2026-10-02T10:00");            // dibulatkan ke menit
  assert.deepEqual(res.conflicts.map((c) => [c.kolom, c.v2, c.v1]), [["Plat", "B 1 AA", "B 2 BB"]]);   // resi beda nol depan saja = sama
});

await step("vendor dari UNIT DARI SIAPA + rekening atas nama orang lain, pengajuan lama ikut", async () => {
  const j = await one("select v.name, pb.bank_name, pb.account_number, pb.holder from job j join res_partner v on v.id = j.vendor_id join job_line jl on jl.job_id = j.id and jl.side = 'PURCHASE' join res_partner_bank pb on pb.id = jl.partner_bank_id where j.id = $1", [job.id]);
  assert.deepEqual(j, { name: "PT GNX", bank_name: "BCA", account_number: "123456", holder: "Fulan" });
  const ml = await one("select p.name, ml.payee_holder, ml.amount from account_move_line ml join res_partner p on p.id = ml.payee_partner_id where ml.move_id = $1", [mv.id]);
  assert.deepEqual(ml, { name: "PT GNX", payee_holder: "Fulan", amount: 1400000 });   // nominal tidak berubah
});

await step("job baru: harga 0, skema & customer dibuat, vendor = penerima transfer, tahun salah ketik dicatat", async () => {
  const j = await one("select j.*, c.name as customer, c.pph_pct, v.name as vendor from job j join res_partner c on c.id = j.customer_id left join res_partner v on v.id = j.vendor_id where job_number = 'AMC/2610/0300'");
  assert.deepEqual([j.customer, j.pph_pct, j.vendor, j.trip_type, j.gate_in_at, j.state, j.selling_mode, j.source], ["FORTIS", 0, "SELVIANA", "ROUND_TRIP", null, "confirmed", "ZERO", "AMICO"]);
  assert.ok(res.issues.some((i) => i.job === "AMC/2610/0300" && i.kolom === "Gate in"));
  // isian buatan v1 diabaikan
  assert.deepEqual([j.driver1_name, j.driver1_phone, j.sj_resi_number, res.stats.fake_skipped], [null, null, null, 3]);
  assert.equal((await one("select next_number from ir_sequence where name = 'JOB/2610'")).next_number, 301);
});

await step("impor ulang: tidak ada yang berubah lagi, laporan ditulis", async () => {
  const again = await importJobListV1({ file, target: db });
  assert.deepEqual([again.stats.jobs_updated, again.stats.new_jobs, again.stats.vendor_set], [0, 0, 0]);
  const out = await writeJobListReport(res, path.join(dir, "laporan.xlsx"));
  const rep = new ExcelJS.Workbook();
  await rep.xlsx.readFile(out);
  assert.deepEqual(rep.worksheets.map((w) => w.name), ["RINGKASAN", "DIISI", "BEDA", "JOB BARU", "PERLU DICEK", "TIDAK ADA DI V1"]);
});

await db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Impor Job List v1: ${passed} langkah lulus`);

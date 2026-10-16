// Tes impor JOB REGISTRATION.xlsx: workbook kecil dibuat di folder sementara, diimpor ke database di memori.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { importJobReg, writeJobRegReport, compareJobReg, saveJobRegSnapshot } from "../lib/import-jobreg.js";
import { checkMove } from "../routes/finance.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobreg-"));
const file = path.join(dir, "JOB REGISTRATION.xlsx");
const D = (s) => new Date(`${s}T00:00:00Z`);

// ---------------------------------------------------------------- workbook tiruan
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
    // sebelum nomor mulai -> dilewati
    [D("2026-06-20"), "AMC/2606/0100", "DO0", "LINTAS", "JKT", "SBY", "CDDL", "B 1 A", 1000000, null, 1500000, 1486500],
    // 70/30 kena pajak, lunas semua, pelunasan vendor termasuk calo 50.000
    [D("2026-07-02"), "AMC/2607/0001", "DO1", "GARBANTARA", "JST", "SOC PP", "CDDL", "b 9345  scu", 2200000, 50000, 2500000, 2477500,
     null, null, 1540000, D("2026-07-03"), 710000, D("2026-07-10"), 1750000, D("2026-07-05"), 727500, D("2026-07-15")],
    // bulan salah ketik 2698 -> 2608; vendor kurang transfer 50.000; SAT Excel dipotong pajak padahal GSL tanpa pajak
    [D("2026-08-14"), "AMC/2698/0172", "DO2", "GSL", "SRG", "BTN", "CDDL", "AB 8640 BK", 2000000, null, 3000000, 2973000,
     null, null, 1400000, D("2026-08-15"), 550000, D("2026-08-20"), 2100000, D("2026-08-16"), 900000, D("2026-08-21")],
    // skema 100% (dari UTANG PIUTANG), customer belum bayar, tanggal vendor kosong
    [D("2026-09-17"), "AMC/2609/0424", "DO3", "FORTIS", "JAT", "DC JAGAKARSA", "CDDE", "B 9444 JZN", 400000, null, 500000, 500000,
     null, null, 400000, null, null, null, 500000, D("2026-09-20")],
    // vendor dibayar 50.000 lebih dari cost (CALO kosong) -> selisih tanpa tujuan, cost job tetap 2.100.000
    [D("2026-09-02"), "AMC/2609/0010", "DO4", "GARBANTARA", "SOC", "CKP", "CDDL", "B 1 X", 2100000, null, 2500000, 2477500,
     null, null, 1470000, D("2026-09-03"), 680000, D("2026-09-08"), 1750000, D("2026-09-04"), 727500, D("2026-09-10")],
    // job baru, belum ada nominal & belum di UTANG PIUTANG -> skema terbanyak customer (FORTIS = 100%)
    [D("2026-10-05"), "AMC/2610/0182", null, "FORTIS", "JAT", "DC TANAH ABANG", "RIT 1", "B 9907 FXX"],
  ]);
sheet("JOB LIST", 12,
  ["DATE", "GATE OUT", "GATE IN", "JOB NUMBER", "KET FINANCE DP", "KET FINANCE PELUNASAN", "NOMOR INV PELUNASAN", "SJ NUMBER", "CUSTOMER", "POL", "POD", "POD",
   "PLATE NUMBER", "RESI SJ RECEIVED", "SJ RECEIVED", "RESI NUMBER SJ", "LEAD TIME SJ", "SJ DELIVERED", "RESI SJ DELIVERED"],
  [
    [D("2026-07-02"), "02/07/2026 07.30", new Date("2026-03-07T21:15:00Z"), "AMC/2607/0001", "DONE", "15 JULI 2026", "INV-1", "SJ-1", null, null, null, "CDDL",
     null, null, D("2026-07-12"), "RESI-9"],
    [D("2026-08-14"), "15/08/2026 07:51", "15/08/2026 21:03", "AMC/2698/0172"],
    [D("2026-09-17"), "17/09/2026 22:56", null, "AMC/2609/0424", null, null, null, null, null, null, null, "RIT 6"],
  ]);
const up = Array(24).fill(null);
const upRow = (vals) => { const r = [...up]; for (const [c, v] of Object.entries(vals)) r[Number(c) - 1] = v; return r; };
sheet("UTANG PIUTANG", 7,
  ["JOB NUMBER", "DO NUMBER", "CUSTOMER", "KETERANGAN", "UTANG 100%", "UTANG 100% TERBAYAR", "UTANG 70%", "UTANG 70% TERBAYAR", "UTANG 30% BELUM BAYAR",
   "UTANG 30% TERBAYAR", "TANGGAL PELUNASAN UTANG", "TEMPO/HARI", "TANGGAL JATUH TEMPO", "SISA HARI", "STATUS PIUTANG", "Piutang 100% Belum Terbayar",
   "Piutang 100% Tertagih", "Piutang 100% Terbayar", "PIUTANG 70% BELUM TERTAGIH", "PIUTANG 70% TERTAGIH", "PIUTANG 70% TERBAYAR",
   "PIUTANG 30% BELUM TERTAGIH", "PIUTANG 30% TERTAGIH", "PIUTANG 30% TERBAYAR"],
  [
    upRow({ 1: "AMC/2607/0001", 8: 1540000, 10: 710000, 12: 8, 21: 1750000, 24: 727500 }),
    upRow({ 1: "AMC/2698/0172", 8: 1400000, 10: 550000, 21: 2100000, 24: 900000 }),
    upRow({ 1: "AMC/2609/0424", 5: 0, 6: 400000, 12: 14, 17: 500000 }),
    upRow({ 1: "AMC/2609/0010", 8: 1470000, 10: 680000, 21: 1750000, 24: 727500 }),
    upRow({ 1: "AMC/2610/0182", 12: 14 }),   // baris kosong untuk job baru
  ]);
await wb.xlsx.writeFile(file);

// ---------------------------------------------------------------- impor
const db = await openDb({ memory: true });
await migrate(db, { log: () => {} });
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log("  ok -", name); };
const one = async (sql, params) => (await db.query(sql, params))[0];

const result = await importJobReg({ file, target: db, start: "AMC/2607/0001", log: () => {} });
const has = (masalah, job) => result.issues.some((i) => i.masalah.startsWith(masalah) && (!job || i.job === job));

await step("job sebelum nomor mulai dilewati, sisanya diimpor", async () => {
  assert.equal(result.stats.skippedBeforeStart, 1);
  assert.equal(result.stats.jobs, 5);
  assert.equal((await one("select count(*)::int n from job where job_number = 'AMC/2606/0100'")).n, 0);
});

await step("nomor AMC/2698 dibetulkan jadi AMC/2608 dan dicatat", async () => {
  const j = await one("select * from job where job_number = 'AMC/2608/0172'");
  assert.ok(j && j.note.includes("AMC/2698/0172"));
  assert.ok(has("Bulan di nomor job salah ketik", "AMC/2608/0172"));
  assert.equal(result.stats.renamed, 1);
});

await step("job & perjalanan: rute PP, plat dirapikan, gate (hari/bulan tertukar), SJ, rit", async () => {
  const j = await one("select j.*, l.code as pod from job j join location l on l.id = j.pod_id where job_number = 'AMC/2607/0001'");
  assert.equal(j.trip_type, "ROUND_TRIP");
  assert.equal(j.pod, "SOC");
  assert.equal(j.plate_number, "B 9345 SCU");
  assert.equal(j.state, "done");
  assert.equal(j.gate_out_at.slice(0, 16), "2026-07-02T07:30");
  assert.equal(j.gate_in_at.slice(0, 16), "2026-07-03T21:15");
  assert.equal(j.sj_number, "SJ-1");
  assert.equal(j.sj_received_at, "2026-07-12");
  assert.equal(j.sj_resi_number, "RESI-9");
  const f = await one("select * from job where job_number = 'AMC/2609/0424'");
  assert.equal(f.rit_number, 6);
  assert.equal(f.delivery_scope, "INNERCITY");
  assert.equal(f.customer_scheme, "FULL");
  assert.equal(f.vendor_scheme, "FULL");
});

await step("pajak customer: GSL & FORTIS tanpa pajak, lainnya PPh 2% + PPN 1,1%", async () => {
  const rows = await db.query("select name, pph_pct, ppn_pct from res_partner where is_customer order by name");
  assert.deepEqual(rows.map((r) => [r.name, r.pph_pct, r.ppn_pct]), [["FORTIS", 0, 0], ["GARBANTARA", 2, 1.1], ["GSL", 0, 0]]);
  assert.ok(has("SELLING AFTER TAX di Excel dipotong pajak", "AMC/2608/0172"));
});

await step("pelunasan vendor berisi calo -> dokumen terpisah fase Calo / biaya lain", async () => {
  const moves = await db.query(
    `select m.number, m.phase, m.approval_state, s.amount_total, s.amount_paid from account_move m join v_move_status s on s.move_id = m.id
     where m.number like 'JR/V%/AMC/2607/0001' order by m.number`);
  assert.deepEqual(moves.map((m) => [m.number, m.phase, m.amount_total, m.amount_paid]), [
    ["JR/V30/AMC/2607/0001", "SETTLEMENT", 660000, 660000],
    ["JR/V30L/AMC/2607/0001", "OTHER", 50000, 50000],
    ["JR/V70/AMC/2607/0001", "DP", 1540000, 1540000],
  ]);
  assert.ok(moves.every((m) => m.approval_state === "APPROVED"));
});

await step("invoice customer: jatuh tempo dari TEMPO, info pajak di pelunasan", async () => {
  const m = await one("select * from account_move where number = 'JR/C30/AMC/2607/0001'");
  assert.equal(m.due_date, "2026-07-23");
  assert.equal(m.tax_basis, 2500000);
  assert.equal(m.ppn_amount, 27500);
  assert.equal(m.pph23_amount, 50000);
  const b = await one("select * from v_job_balance where job_number = 'AMC/2607/0001'");
  assert.equal(b.received, 2477500);
  assert.equal(b.paid, 2250000);
});

await step("skema 100%: dibayar dari UTANG PIUTANG, tanggal kosong pakai tanggal job", async () => {
  const v = await one("select m.move_date, m.phase, s.amount_paid from account_move m join v_move_status s on s.move_id = m.id where number = 'JR/V70/AMC/2609/0424'");
  assert.equal(v.phase, "FULL");
  assert.equal(v.move_date, "2026-09-17");
  assert.equal(v.amount_paid, 400000);
  assert.ok(has("Nominal ada, tanggal kosong", "AMC/2609/0424"));
  const c = await one("select s.amount_paid, s.amount_residual from account_move m join v_move_status s on s.move_id = m.id where number = 'JR/C70/AMC/2609/0424'");
  assert.equal(c.amount_paid, 0);
  assert.equal(c.amount_residual, 500000);
});

await step("skema job yang belum terbaca ikut skema terbanyak customer", async () => {
  assert.equal((await one("select customer_scheme from job where job_number = 'AMC/2610/0182'")).customer_scheme, "FULL");
  assert.equal(result.stats.schemeFromCustomer, 1);
});

await step("lebih bayar vendor -> selisih tanpa tujuan, cost job tetap sesuai Excel", async () => {
  const b = await one("select * from v_job_balance where job_number = 'AMC/2609/0010'");
  assert.deepEqual([b.cost, b.requested, b.paid], [2100000, 2100000, 2100000]);
  const u = await db.query("select number, amount, paid, status, selisih_kas from v_unassigned where job_number = 'AMC/2609/0010'");
  assert.deepEqual(u, [{ number: "JR/V30/AMC/2609/0010", amount: 50000, paid: 50000, status: "OPEN", selisih_kas: -50000 }]);
  assert.equal(result.stats.unassignedLines, 1);
  assert.equal((await one("select count(*)::int n from job_line jl join product p on p.id = jl.product_id where p.kind = 'SELISIH'")).n, 0);
  assert.ok(has("Pengajuan melebihi cost + calo", "AMC/2609/0010"));
});

await step("angka Excel disimpan; Excel vs ERP per kolom + penyebab beda", async () => {
  let c = await compareJobReg(db);
  assert.equal(c.info.jobs, 5);
  const col = (label) => c.columns.find((x) => x.label === label);
  const u30 = col("UTANG 30% BELUM BAYAR");
  assert.deepEqual([u30.excel, u30.erp], [0, 50000]);
  assert.deepEqual(u30.jobs.map((j) => [j.job_number, j.sebab.split(":")[0]]), [["AMC/2608/0172", "Kurang transfer"]]);
  const u30t = col("UTANG 30% TERBAYAR");
  assert.deepEqual(u30t.jobs.map((j) => [j.job_number, j.excel, j.erp, j.sebab.split(":")[0]]), [["AMC/2609/0010", 680000, 630000, "Vendor dibayar di atas cost"]]);
  assert.equal(col("PIUTANG 70% TERBAYAR").beda, 0);
  assert.equal(c.perJob[(await one("select id from job where job_number = 'AMC/2608/0172'")).id].sisa_vendor, 0);
  // unggah ulang file (buffer) = ganti salinan, transaksi tidak berubah
  const before = await one("select count(*)::int n from account_payment");
  const info = await saveJobRegSnapshot({ file: fs.readFileSync(file), name: "ulang.xlsx", target: db });
  assert.deepEqual([info.jobs, info.file, (await one("select count(*)::int n from account_payment")).n], [5, "ulang.xlsx", before.n]);
});

await step("kurang transfer vendor 70/30 terdeteksi", async () => {
  const k = await db.query("select job_number, side, kurang, selisih_kas from v_kurang_transfer");
  assert.deepEqual(k, [{ job_number: "AMC/2608/0172", side: "PURCHASE", kurang: 50000, selisih_kas: 50000 }]);   // belum ditransfer = surplus
});

await step("semua dokumen lolos aturan dokumen v2", async () => {
  // data lama: sebagian job tidak punya kode tugas / gate out; aturan itu hanya untuk dokumen baru
  await db.query("update app_setting set value = 'false' where key = 'require_gate_for_billing'");
  for (const m of await db.query("select id from account_move")) await checkMove(db, m.id);
});

await step("nomor job baru melanjutkan nomor impor", async () => {
  const s = await one("select next_number from ir_sequence where name = 'JOB/2609'");
  assert.equal(s.next_number, 425);
});

await step("impor kedua ditolak kalau database sudah berisi job", async () => {
  await assert.rejects(importJobReg({ file, target: db, log: () => {} }), /sudah berisi 5 job/);
});

await step("impor ulang dengan reset: unit, kontrak & tagihan sewa, SLA, price book, kas operasional, ATTN partner tetap ada", async () => {
  const [{ jobs }] = await db.query("select count(*)::int as jobs from job");
  const loc = async (code) => (await db.query("insert into location (code, name) values ($1, $1) on conflict (code) do update set code = excluded.code returning id", [code]))[0].id;
  const [v] = await db.query("insert into vehicle (plate_number, truck_type) values ('B 7777 SW', 'CDDL') returning id");
  const [vend] = await db.query("insert into res_partner (code, name, is_vendor) values ('V-PEMILIK', 'PEMILIK UNIT', true) returning id");
  const [c] = await db.query(`insert into vehicle_contract (vehicle_id, partner_id, date_start, monthly_rent) values ($1, $2, '2026-09-01', 15000000) returning id`, [v.id, vend.id]);
  const [b] = await db.query(`insert into vehicle_rent_bill (number, contract_id, period, days, amount) values ('SWA/2609/0003', $1, '2026-09-01', 30, 15000000) returning id`, [c.id]);
  const [bank] = await db.query("select id, name from res_bank_account order by id limit 1");
  await db.query("insert into vehicle_rent_payment (bill_id, pay_date, amount, bank_account_id) values ($1, '2026-10-01', 5000000, $2)", [b.id, bank.id]);
  await db.query("insert into route_sla (pol_id, pod_id, trip_type, sla_hours) values ($1, $2, 'ONE_WAY', 19)", [await loc("SLA-A"), await loc("SLA-B")]);
  await db.query("insert into pricelist_item (pol_id, pod_id, truck_type, trip_type, selling, cost) values ($1, $2, 'CDDL', 'ONE_WAY', 900000, 700000)", [await loc("SLA-A"), await loc("SLA-B")]);
  await db.query("insert into res_bank_account (name, bank_name, account_number, holder, kind) values ('Kas Ops', 'BCA', '77', 'Ops', 'OPERATIONAL')");
  await db.query("update res_partner set attn = 'Pak Budi', phone = '021-1' where name = 'GARBANTARA'");
  await db.query("insert into res_partner_bank (partner_id, bank_name, account_number, holder) values ($1, 'BRI', '555', 'Pemilik')", [vend.id]);
  const banks = (await db.query("select count(*)::int as n from res_bank_account"))[0].n;
  const again = await importJobReg({ file, target: db, start: "AMC/2607/0001", reset: true, log: () => {} });
  assert.deepEqual(again.stats.erpKept, { unit: 1, kontrak: 1, tagihan_sewa: 1, bayar_sewa: 1, sla: 1, price_book: 1,
    rekening_amico: banks, isian_partner: 1, rekening_partner: 1 });
  // rekening AMICO & kas operasional persis, tidak ada "Rekening AMICO (impor JOB REG)" baru
  assert.equal((await db.query("select count(*)::int as n from res_bank_account"))[0].n, banks);
  assert.equal((await db.query("select count(*)::int as n from res_bank_account where name = 'Kas Ops' and kind = 'OPERATIONAL'"))[0].n, 1);
  assert.deepEqual(Object.values((await db.query("select attn, phone from res_partner where name = 'GARBANTARA'"))[0]), ["Pak Budi", "021-1"]);
  assert.equal((await db.query("select count(*)::int as n from res_partner_bank b join res_partner p on p.id = b.partner_id where p.name = 'PEMILIK UNIT' and b.account_number = '555'"))[0].n, 1);
  assert.equal((await db.query("select count(*)::int as n from job"))[0].n, jobs);
  const [k] = await db.query(`select v.plate_number, p.name, c.monthly_rent from vehicle_contract c join vehicle v on v.id = c.vehicle_id
    left join res_partner p on p.id = c.partner_id`);
  assert.deepEqual([k.plate_number, k.name, k.monthly_rent], ["B 7777 SW", "PEMILIK UNIT", 15000000]);
  const [bb] = await db.query("select number, paid, residual from v_vehicle_rent_bill");
  assert.deepEqual([bb.number, bb.paid, bb.residual], ["SWA/2609/0003", 5000000, 10000000]);
  assert.equal((await db.query("select next_number from ir_sequence where name = 'SWA/2609'"))[0].next_number, 4);
  assert.equal((await db.query("select count(*)::int as n from route_sla"))[0].n, 1);
  assert.equal((await db.query("select count(*)::int as n from pricelist_item"))[0].n, 1);
});

await step("laporan Excel ditulis", async () => {
  const out = await writeJobRegReport(db, result, path.join(dir, "laporan.xlsx"));
  const rep = new ExcelJS.Workbook();
  await rep.xlsx.readFile(out);
  assert.deepEqual(rep.worksheets.map((w) => w.name), ["RINGKASAN", "PERLU DICEK", "KURANG TRANSFER"]);
  assert.equal(rep.getWorksheet("KURANG TRANSFER").rowCount, 2);
});

await step("kode tugas dobel di FINANCE diambil dari Job List v1, berantai sampai tidak bentrok", async () => {
  // FINANCE: 0002 memakai kode 0001 (dobel); menurut v1 0002 = K2, padahal K2 milik 0003 di FINANCE -> 0003 ikut ke K3 (v1).
  // 0005 & 0006 dobel K5 dan v1 juga K5 untuk keduanya -> tetap dobel, dicatat.
  const w = new ExcelJS.Workbook();
  const add = (name, headerRow, headers, rows) => { const ws = w.addWorksheet(name); ws.getRow(headerRow).values = headers; rows.forEach((r, i) => { ws.getRow(headerRow + 1 + i).values = r; }); };
  const row = (n, d) => [D("2026-10-01"), `AMC/2610/000${n}`, d, "FORTIS", "JAT", "DC KAMAL", "CDDL", `B ${n} X`, 100, null, 200, 200];
  add("FINANCE", 12, ["DATE", "JOB NUMBER", "DO NUMBER", "CUSTOMER", "POL", "POD", "TRUCK TYPE", "PLATE NUMBER", "COST", "CALO", "SELLING", "SELLING AFTER TAX",
    "PROFIT", "PERSENTASE", "VENDOR BILL 70%", "DATE 70%", "VENDOR BILL 30%", "DATE 30%", "REGISTER PAYMENT 70%", "DATE 70%", "REGISTER PAYMENT 30%", "DATE 30%"],
    [row(1, "K1"), row(2, "K1"), row(3, "K2"), row(4, "K9"), row(5, "K5"), row(6, "k 5")]);
  add("JOB LIST", 12, ["DATE", "GATE OUT", "GATE IN", "JOB NUMBER"], []);
  add("UTANG PIUTANG", 7, ["JOB NUMBER", "UTANG 100% TERBAYAR", "UTANG 70% TERBAYAR", "UTANG 30% TERBAYAR", "PIUTANG 100% TERBAYAR", "PIUTANG 70% TERBAYAR", "PIUTANG 30% TERBAYAR"], []);
  const f2 = path.join(dir, "JOB REG 2.xlsx");
  await w.xlsx.writeFile(f2);
  const v1 = new ExcelJS.Workbook();
  const ws = v1.addWorksheet("JOB LIST");
  ws.addRow(["DATE", "JOB NUMBER", "SJ NUMBER"]);
  for (const [n, sj] of [[1, "K1"], [2, "K2"], [3, "K3"], [4, "K9"], [5, "K5"], [6, "K5"]]) ws.addRow([D("2026-10-01"), `AMC/2610/000${n}`, sj]);
  const f3 = path.join(dir, "job-list-v1.xlsx");
  await v1.xlsx.writeFile(f3);
  const db2 = await openDb({ memory: true });
  await migrate(db2, { log: () => {} });
  const r = await importJobReg({ file: f2, target: db2, joblist: f3, log: () => {} });
  const codes = Object.fromEntries((await db2.query("select job_number, do_number from job order by 1")).map((j) => [j.job_number.slice(-1), j.do_number]));
  assert.deepEqual(codes, { 1: "K1", 2: "K2", 3: "K3", 4: "K9", 5: "K5", 6: "k 5" });
  assert.deepEqual([r.stats.doFixed, r.stats.doStillDup], [2, 2]);
  assert.ok(r.issues.some((i) => i.job === "AMC/2610/0003" && /Diganti dari Job List v1 \(SJ NUMBER\): K3/.test(i.tindakan)));
  assert.equal(r.issues.filter((i) => /tetap dobel/.test(i.masalah)).length, 2);
  await db2.close();
});

await db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Impor JOB REG: ${passed} langkah lulus`);

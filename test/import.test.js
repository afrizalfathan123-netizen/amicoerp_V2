// Tes impor dari ERP AMICO lama. "Supabase" lama ditiru dengan PostgreSQL tertanam (PGlite) berisi tabel lama.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { importAmico, writeImportReport } from "../lib/import-amico.js";
import { ROOT } from "../config.js";

// sumber: tabel lama = bentuk tabel penampung tanpa prefix skema
const source = await openDb({ memory: true });
await source.exec(fs.readFileSync(path.join(ROOT, "db", "import", "staging.sql"), "utf8")
  .replace(/drop schema if exists amico_legacy cascade;\s*create schema amico_legacy;/, "")
  .replaceAll("amico_legacy.", "public."));
const target = await openDb({ memory: true });
await migrate(target, { log: () => {} });

const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const S = (sql, params) => source.query(sql, params);
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log("  ok -", name); };

// ---------------------------------------------------------------- data lama
await S(`insert into customers (id, customer_code, name, deduct_tax, is_active, invoice_bill_name) values
  ($1, 'LINTAS', 'LINTAS', true, true, 'PT LINTAS LOGISTIK'), ($2, 'FORTIS', 'FORTIS', false, true, null)`, [uid(1), uid(2)]);
await S(`insert into locations (id, location_code, name, is_active) values ($1, 'jrt', 'Jakarta', true), ($2, 'MES', 'Medan', true),
  ($3, 'CKR', 'Cikarang', true), ($4, 'CKG', 'Cakung', true)`, [uid(11), uid(12), uid(13), uid(14)]);
await S(`insert into vehicles (id, truck_type, plate_number, unit_owner, is_active) values ($1, 'CDDL', 'b 9123  abc', 'CV Sinar Jaya', true)`, [uid(21)]);
await S(`insert into transfer_payees (id, payee_name, account_name, bank_name, bank_account) values ($1, 'CV Sinar Jaya', 'CV SINAR JAYA', 'BCA', '1234567890')`, [uid(31)]);
await S(`insert into company_accounts (id, label, bank_name, account_number, account_name, is_active) values ($1, 'BCA AMICO', 'BCA', '0001', 'PT AMICO', true)`, [uid(41)]);
await S(`insert into selling_rates (id, customer_id, origin_location_id, destination_location_id, truck_type, trip_type, selling_price, is_active)
  values ($1, null, $2, $3, 'CDDL', 'ROUND_TRIP', 19500000, true)`, [uid(51), uid(11), uid(12)]);
await S(`insert into cost_rates (id, vehicle_id, origin_location_id, destination_location_id, truck_type, trip_type, cost_price, is_active)
  values ($1, null, $2, $3, 'CDDL', 'ROUND_TRIP', 18000000, true), ($4, $5, $2, $3, 'CDDL', 'ROUND_TRIP', 17000000, true)`, [uid(52), uid(11), uid(12), uid(53), uid(21)]);
const job = (n, no, cust, sell, cost, extra = {}) => S(
  `insert into jobs (id, job_number, operational_date, customer_id, pol_location_id, pod_location_id, vehicle_id, trip_type, selling_amount, cost_amount,
     selling_items, cost_items, delivery_scope, payment_receiver_name, payment_bank_name, payment_bank_account, gate_out_at, gate_in_at, deleted_at, task_code)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
  [uid(n), no, extra.date || "2026-05-01", cust, extra.pol || uid(11), extra.pod || uid(12), extra.vehicle ?? uid(21), extra.trip || "ROUND_TRIP", sell, cost,
   JSON.stringify(extra.sellingItems || []), JSON.stringify(extra.costItems || []), extra.scope || "INTERCITY",
   "CV Sinar Jaya", "BCA", "1234567890", extra.gateOut || null, extra.gateIn || null, extra.deleted || null, extra.task || null]);
await job(101, "AMC/2605/0001", uid(1), 19500000, 18000000, { gateOut: "2026-05-01T01:00:00Z", gateIn: "2026-05-05T12:00:00Z", task: "DKGX1" });
await job(102, "AMC/2609/0100", uid(2), 550000, 450000, { scope: "INNERCITY", pol: uid(13), pod: uid(14), trip: "ONE_WAY", vehicle: null });
await job(103, "AMC/2605/0002", uid(1), 19500000, 18000000);
await job(104, "AMC/2609/0200", uid(1), 19500000, 18000000, { date: "2026-09-20" });
await job(105, "AMC/2609/0201", uid(1), 19500000, 18000000, { date: "2026-09-21" });
await job(106, "AMC/2605/0003", uid(1), 3500000, 3000000, { costItems: [{ type: "TRUCKING", amount: "3000000" }, { type: "CALO", note: "Calo", amount: 100000 }] });
await job(107, "AMC/2605/0004", uid(1), 1000000, 900000, { deleted: "2026-05-05T00:00:00Z" });

const batch = (n, no, type, status, created, paid, extra = {}) => S(
  `insert into payment_request_batches (id, batch_number, request_type, status, created_at, paid_at, cancelled_at, refunded_at, payment_channel,
     reconciliation_status, disbursed_at, operational_payee_name, operational_bank_name, operational_bank_account)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
  [uid(n), no, type, status, created, paid, extra.cancelled || null, extra.refunded || null, extra.channel || "NORMAL", extra.recon || "PENDING",
   extra.disbursed || null, extra.channel === "TRANSFER_MALAM" ? "Pak Ops" : null, extra.channel === "TRANSFER_MALAM" ? "BCA" : null,
   extra.channel === "TRANSFER_MALAM" ? "9999" : null]);
const item = (n, b, j, no, type, amount, extra = {}) => S(
  `insert into payment_request_items (id, batch_id, job_id, request_type, item_no, job_number, cost_type, vendor_name, bank_name, bank_account,
     account_name, request_amount, refunded_at, cancelled_at)
   values ($1, $2, $3, $4, $5, (select job_number from jobs where id = $3), $6, $7, 'BCA', '1234567890', 'CV SINAR JAYA', $8, $9, $10)`,
  [uid(n), uid(b), uid(j), type, no, extra.cost_type || "TRUCKING", extra.vendor || "CV Sinar Jaya", amount, extra.refunded || null, extra.cancelled || null]);
const status = (j, bucket, action, amount, at) => S(
  "insert into finance_workflow_status (id, job_id, workflow_bucket, workflow_action, amount, processed_at) values (gen_random_uuid(), $1, $2, $3, $4, $5)",
  [uid(j), bucket, action, amount, at]);
const invoice = async (n, no, type, cust, date, sell, j, extra = {}) => {
  await S(`insert into customer_invoice_batches (id, invoice_number, invoice_type, customer_id, invoice_date, subtotal, ppn_amount, pph23_amount, company_account_id, created_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [uid(n), no, type, cust, date, sell, extra.ppn || 0, extra.pph || 0, uid(41), `${date}T03:00:00Z`]);
  await S(`insert into customer_invoice_items (id, batch_id, job_id, item_no, job_number, selling_amount) values (gen_random_uuid(), $1, $2, 1, (select job_number from jobs where id = $2), $3)`,
    [uid(n), uid(j), sell]);
};

// J1: DP + pelunasan + calo di batch pelunasan, invoice DP + pelunasan berpajak
await batch(201, "B-DP-1", "DP_70", "PAID", "2026-05-01T03:00:00Z", "2026-05-01T08:00:00Z"); await item(301, 201, 101, 1, "DP_70", 12600000);
await batch(202, "B-PL-1", "SETTLEMENT_30", "PAID", "2026-05-13T03:00:00Z", "2026-05-13T08:00:00Z");
await item(302, 202, 101, 1, "SETTLEMENT_30", 5400000); await item(303, 202, 101, 2, "SETTLEMENT_30", 50000, { cost_type: "CALO", vendor: "Agus calo" });
await invoice(401, "INV-1", "DP_70", uid(1), "2026-05-02", 19500000, 101);
await invoice(402, "INV-2", "SETTLEMENT_30", uid(1), "2026-05-14", 19500000, 101, { ppn: 214500, pph: 390000 });
for (const [b, a, v, at] of [["CUSTOMER_INVOICE", "DP_PAID", 13650000, "2026-05-02"], ["CUSTOMER_INVOICE", "SETTLEMENT_PAID", 5674500, "2026-05-15"],
  ["VENDOR_BILL", "DP_PAID", 12600000, "2026-05-01"], ["VENDOR_BILL", "SETTLEMENT_PAID", 5450000, "2026-05-13"]]) await status(101, b, a, v, at);
// J2: dalam kota FULL
await batch(203, "B-FULL-1", "FULL", "PAID", "2026-09-07T03:00:00Z", "2026-09-07T05:00:00Z"); await item(304, 203, 102, 1, "FULL", 450000);
await invoice(403, "INV-3", "FULL", uid(2), "2026-09-09", 550000, 102);
await status(102, "CUSTOMER_INVOICE", "SETTLEMENT_PAID", 550000, "2026-09-28"); await status(102, "VENDOR_BILL", "SETTLEMENT_PAID", 450000, "2026-09-07");
// J3: transfer malam sudah disalurkan lalu item di-refund
await batch(204, "B-DP-2", "DP_70", "PAID", "2026-05-02T13:00:00Z", "2026-05-02T14:00:00Z", { channel: "TRANSFER_MALAM", recon: "RECONCILED", disbursed: "2026-05-02T16:00:00Z" });
await item(305, 204, 103, 1, "DP_70", 12600000, { refunded: "2026-05-03T02:00:00Z" });
await batch(205, "B-DP-3", "DP_70", "CANCELLED", "2026-05-03T03:00:00Z", null, { cancelled: "2026-05-03T04:00:00Z" }); await item(306, 205, 103, 1, "DP_70", 12600000);
// J4: transfer malam masih di kas operasional (PAID_TO_OPERATIONAL)
await batch(206, "B-DP-4", "DP_70", "PAID", "2026-09-20T13:00:00Z", "2026-09-20T14:00:00Z", { channel: "TRANSFER_MALAM", recon: "PAID_TO_OPERATIONAL" });
await item(307, 206, 104, 1, "DP_70", 12600000);
// J5: transfer malam dikembalikan sebelum disalurkan, lalu diajukan ulang (normal)
await batch(207, "B-DP-5", "DP_70", "PAID", "2026-09-21T13:00:00Z", "2026-09-21T14:00:00Z", { channel: "TRANSFER_MALAM", recon: "PAID_TO_OPERATIONAL", refunded: "2026-09-22T02:00:00Z" });
await item(308, 207, 105, 1, "DP_70", 12600000);
await batch(208, "B-DP-6", "DP_70", "PAID", "2026-09-22T03:00:00Z", "2026-09-22T05:00:00Z"); await item(309, 208, 105, 1, "DP_70", 12600000);
await status(105, "VENDOR_BILL", "DP_PAID", 12600000, "2026-09-22");
// J6: status lunas tanpa dokumen (saldo awal), cost_items dengan calo
await status(106, "VENDOR_BILL", "DP_PAID", 2100000, "2026-05-04"); await status(106, "CUSTOMER_INVOICE", "DP_REQUESTED", 2450000, "2026-05-04");

try {
  let res;
  await step("impor berjalan, job yang diarsipkan dilewati", async () => {
    res = await importAmico({ source, target, log: () => {} });
    assert.equal(res.result.job, 6);
    assert.equal(res.result.saldo_awal, 2);
  });

  const up = async (no) => (await target.query("select * from v_utang_piutang where job_number = $1", [no]))[0];

  await step("master: customer + pajak, vendor + rekening, kendaraan, price book (cost per kendaraan tidak ikut), rekening AMICO + kas operasional", async () => {
    const lintas = (await target.query("select * from res_partner where code = 'LINTAS'"))[0];
    assert.deepEqual([lintas.pph_pct, lintas.ppn_pct, lintas.bill_to_name], [2, 1.1, "PT LINTAS LOGISTIK"]);
    const sinar = (await target.query("select p.id, b.account_number from res_partner p join res_partner_bank b on b.partner_id = p.id where p.name = 'CV SINAR JAYA'"));
    assert.deepEqual(sinar.map((x) => x.account_number), ["1234567890"]);
    assert.equal((await target.query("select plate_number from vehicle"))[0].plate_number, "B 9123 ABC");
    const price = await target.query("select selling, cost from pricelist_item order by id");
    assert.deepEqual(price.map((p) => [p.selling, p.cost]), [[19500000, null], [null, 18000000]]);
    const banks = await target.query("select kind, account_number from res_bank_account order by id");
    assert.deepEqual(banks.map((b) => [b.kind, b.account_number]), [["BANK", "0001"], ["OPERATIONAL", "9999"]]);
  });

  await step("J1: DP + pelunasan + calo + invoice berpajak", async () => {
    const a = await up("AMC/2605/0001");
    assert.deepEqual(["utang_70_terbayar", "utang_30_terbayar", "calo_lain_terbayar", "piutang_70_terbayar", "piutang_30_terbayar", "piutang_30_belum_tertagih"].map((k) => a[k]),
      [12600000, 5450000, 50000, 13650000, 5674500, 0]);
    const j = (await target.query("select * from job where job_number = 'AMC/2605/0001'"))[0];
    assert.deepEqual([j.state, j.plate_number, j.do_number, j.source], ["done", "B 9123 ABC", "DKGX1", "AMICO"]);
  });

  await step("J2: job FULL", async () => {
    const b = await up("AMC/2609/0100");
    assert.deepEqual([b.customer_scheme, b.utang_100_terbayar, b.piutang_100_terbayar], ["FULL", 450000, 550000]);
  });

  await step("J3: transfer malam disalurkan lalu refund -> pembalik + dana kembali, job bebas diajukan lagi", async () => {
    const c = await up("AMC/2605/0002");
    assert.deepEqual([c.utang_70, c.utang_70_terbayar], [12600000, 0]);
    const kas = (await target.query("select * from v_bank_balance where kind = 'OPERATIONAL'"))[0];
    assert.ok(kas.transfer_masuk >= 12600000);
  });

  await step("J4: transfer malam belum disalurkan = titipan di kas operasional", async () => {
    const t = await target.query("select m.number, t.titipan from v_titipan_operasional t join account_move m on m.id = t.move_id where t.titipan <> 0");
    assert.deepEqual(t.map((x) => [x.number, x.titipan]), [["B-DP-4", 12600000]]);
    const d = await up("AMC/2609/0200");
    assert.deepEqual([d.utang_70, d.utang_70_terbayar], [12600000, 0]);
  });

  await step("J5: dikembalikan sebelum disalurkan lalu diajukan ulang: DP dihitung sekali", async () => {
    const e = await up("AMC/2609/0201");
    assert.deepEqual([e.utang_70, e.utang_70_terbayar], [0, 12600000]);
    assert.equal((await target.query(
      "select 1 from job_line jl join product p on p.id = jl.product_id join job j on j.id = jl.job_id where j.job_number = 'AMC/2609/0201' and p.kind = 'SELISIH'")).length, 0);
  });

  await step("J6: saldo awal + calo dari cost_items", async () => {
    const f = await up("AMC/2605/0003");
    assert.deepEqual([f.utang_70_terbayar, f.piutang_70_tertagih, f.calo_lain_belum_bayar], [2100000, 2450000, 100000]);
  });

  await step("rekonsiliasi: semua DIBAYAR sama dengan data lama", async () => {
    assert.deepEqual(res.rekon, []);
  });

  await step("nomor job baru melanjutkan nomor lama", async () => {
    const [s] = await target.query("select next_number from ir_sequence where name = 'JOB/2609'");
    assert.equal(s.next_number, 201 + 1);
  });

  await step("impor ulang ditolak kalau sudah ada job; --reset mengosongkan lalu impor lagi", async () => {
    await assert.rejects(importAmico({ source, target, log: () => {} }), /sudah berisi/);
    const again = await importAmico({ source, target, reset: true, log: () => {} });
    assert.equal(again.result.job, 6);
    assert.deepEqual(again.rekon, []);
  });

  await step("laporan impor Excel", async () => {
    const file = path.join(ROOT, "data", "test-laporan-impor.xlsx");
    await writeImportReport(target, file);
    assert.ok(fs.statSync(file).size > 3000);
    fs.rmSync(file);
  });

  console.log(`\nSemua ${passed} langkah lolos.`);
} finally {
  await source.close();
  await target.close();
}

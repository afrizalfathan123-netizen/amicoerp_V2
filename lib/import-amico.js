// Impor dari database ERP AMICO lama (Supabase / PostgreSQL) ke ERP AMICO v2.
// Sumber hanya DIBACA. Dipakai oleh scripts/import-amico.js dan test/import.test.js.
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { ROOT } from "../config.js";

const TABLES = ["customers", "locations", "vehicles", "transfer_payees", "company_accounts", "selling_rates", "cost_rates", "jobs",
  "payment_request_batches", "payment_request_items", "customer_invoice_batches", "customer_invoice_items", "finance_workflow_status"];

export const BUSINESS_TABLES = ["trip_update", "account_payment_line", "account_payment", "internal_transfer", "account_move_line", "account_move",
  "job_line", "job", "pricelist_item", "route_sla", "vehicle", "res_partner_bank", "res_partner", "location", "res_bank_account", "ir_sequence"];

const read = (f) => fs.readFileSync(path.join(ROOT, "db", "import", f), "utf8");

// source: { query(sql, params) } ke database lama. target: db ERP v2 (lib/db.js).
export async function importAmico({ source, target, reset = false, log = console.log }) {
  if (reset) {
    await target.exec(`truncate ${BUSINESS_TABLES.join(", ")} restart identity cascade`);
    log("Data bisnis di database tujuan dikosongkan (user & pengaturan tetap).");
  }
  const [{ n }] = await target.query("select count(*)::int as n from job");
  if (n > 0) throw new Error(`Database tujuan sudah berisi ${n} job. Jalankan dengan --reset untuk mengosongkan dulu.`);

  await target.exec(read("staging.sql"));
  const counts = {};
  for (const table of TABLES) {
    const wanted = (await target.query(
      "select column_name, data_type from information_schema.columns where table_schema = 'amico_legacy' and table_name = $1 order by ordinal_position", [table]));
    const have = new Set((await source.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).map((r) => r.column_name));
    if (!have.size) { log(`  ${table}: tidak ada di database lama, dilewati`); counts[table] = 0; continue; }
    const cols = wanted.filter((c) => have.has(c.column_name));
    const missing = wanted.filter((c) => !have.has(c.column_name)).map((c) => c.column_name);
    if (missing.length) log(`  ${table}: kolom belum ada di database lama (dibiarkan kosong): ${missing.join(", ")}`);
    let total = 0;
    for (let offset = 0; ; offset += 2000) {
      const rows = await source.query(`select ${cols.map((c) => c.column_name).join(", ")} from public.${table} order by 1 limit 2000 offset ${offset}`);
      if (!rows.length) break;
      const params = [];
      const values = rows.map((r) => `(${cols.map((c) => {
        const v = r[c.column_name];
        params.push(c.data_type === "jsonb" ? (v == null ? null : JSON.stringify(v)) : v);
        return `$${params.length}`;
      }).join(", ")})`);
      await target.query(`insert into amico_legacy.${table} (${cols.map((c) => c.column_name).join(", ")}) values ${values.join(", ")}`, params);
      total += rows.length;
      if (rows.length < 2000) break;
    }
    counts[table] = total;
    log(`  ${table.padEnd(26)} ${String(total).padStart(7)} baris`);
  }

  await target.exec(read("amico_import.sql"));
  const t0 = Date.now();
  const [{ r: result }] = await target.tx(async (t) => t.query("select amico_legacy.run_import() as r"));
  await target.exec("analyze");
  log(`Impor selesai (${((Date.now() - t0) / 1000).toFixed(1)} detik):`, result);

  const rekon = await target.query(
    `select bucket, fase, count(*)::int as job, sum(selisih_dibayar) as selisih
     from amico_legacy.v_rekon where abs(selisih_dibayar) > 1 group by 1, 2 order by 1, 2`);
  return { counts, result, rekon };
}

export async function writeImportReport(target, file) {
  const sheets = [
    ["SELISIH DIBAYAR", "Angka DIBAYAR sistem baru beda dengan finance_workflow_status lama",
      "select * from amico_legacy.v_rekon where abs(selisih_dibayar) > 1 order by abs(selisih_dibayar) desc"],
    ["SALDO AWAL", "Status lama tanpa dokumen, dibuatkan dokumen saldo awal",
      `select m.number, m.move_type, m.phase, m.move_date, s.amount_total, s.amount_paid
       from account_move m join v_move_status s on s.move_id = m.id where m.legacy_source = 'finance_workflow_status' order by m.number`],
    ["SELISIH NOMINAL", "Pengajuan / tagihan lama yang melebihi cost / selling job (dicatat sebagai baris SELISIH)",
      `select j.job_number, jl.side, jl.description, jl.amount from job_line jl join job j on j.id = jl.job_id
       join product p on p.id = jl.product_id where p.kind = 'SELISIH' order by j.job_number`],
    ["TITIPAN OPERASIONAL", "Transfer malam: dana di kas operasional yang belum disalurkan ke vendor",
      "select number, move_date, dana_masuk, disalurkan, titipan from v_titipan_operasional where titipan <> 0 order by move_date"],
    ["JOB DILEWATI", "Job lama yang tidak diimpor (customer / lokasi tidak ditemukan)",
      `select lj.job_number, lj.operational_date, lj.customer_id, lj.pol_location_id, lj.pod_location_id from amico_legacy.jobs lj
       where lj.deleted_at is null and not exists (select 1 from job j where j.legacy_id = lj.id) order by lj.job_number`],
    ["KURANG TRANSFER", "Job 70/30 yang pelunasannya sudah dibayar tapi totalnya kurang", "select * from v_kurang_transfer order by side desc, job_number"],
  ];
  const wb = new ExcelJS.Workbook();
  const sum = wb.addWorksheet("RINGKASAN");
  sum.columns = [{ header: "Hal", key: "k", width: 80 }, { header: "Jumlah", key: "v", width: 14 }];
  for (const [name, note, sql] of sheets) {
    const rows = await target.query(sql);
    sum.addRow({ k: `${name}: ${note}`, v: rows.length });
    const ws = wb.addWorksheet(name);
    ws.addRow([note]).font = { italic: true };
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const head = ws.addRow(cols);
    head.font = { bold: true };
    for (const r of rows) ws.addRow(cols.map((c) => r[c]));
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = Math.min(Math.max(c.length + 2, 12), 34); });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return file;
}

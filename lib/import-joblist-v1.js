// Impor export "Job List" ERP AMICO v1 (sheet JOB LIST) ke v2: melengkapi data operasional job yang sudah ada
// (dicocokkan lewat JOB NUMBER) dan menambah job yang belum ada. Uang (invoice, pengajuan, pembayaran) tidak disentuh.
//
// - Kolom v2 yang kosong diisi dari v1. Kolom yang sudah terisi dan beda dicatat di laporan (BEDA), tidak ditimpa,
//   kecuali timpa = true.
// - UNIT DARI SIAPA = vendor (partner). Kosong -> vendor = PENERIMA TRANSFER. Rekening (BANK, NO REKENING, ATAS NAMA)
//   disimpan sebagai rekening vendor itu (atas nama boleh orang lain, mis. PT ABC -> rekening Fulan).
//   Job yang vendornya masih penampung impor JOB REG / kosong diganti ke vendor ini, termasuk penerima di pengajuan lamanya.
// - Job baru dibuat dengan selling / cost 0 (export Job List tidak berisi harga) dan dicatat di laporan.
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { raw } from "./import-jobreg.js";

const NO_TAX = new Set(["GSL", "TREX", "PANCA", "FORTIS", "CIPS"]);
const PLACEHOLDER = "VENDOR (TIDAK TERCATAT DI JOB REG)";
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toUpperCase();
const pad = (n) => String(n).padStart(2, "0");

// Date dari Excel (jam dinding WIB) -> "YYYY-MM-DD HH:MM:00+07", dibulatkan ke menit. Tahun > 2100 = salah ketik.
function ts(v) {
  if (!(v instanceof Date)) return { value: null };
  const d = new Date(Math.round(v.getTime() / 60000) * 60000);
  if (d.getUTCFullYear() > 2100 || d.getUTCFullYear() < 2000) return { value: null, bad: d.toISOString().slice(0, 16).replace("T", " ") };
  return { value: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+07` };
}
const day = (v) => { const t = ts(v); return { value: t.value ? t.value.slice(0, 10) : null, bad: t.bad }; };
const text = (v) => { const s = v == null ? "" : String(v instanceof Date ? "" : v).trim(); return { value: s && s !== "-" ? s : null }; };
// Isian buatan v1 saat pindah dari spreadsheet (bukan data asli): DRIVER DUMMY, HP 08000000xxx, resi AUTO-SJR- / AUTO-SJD-
const real = (reader, isFake) => (v) => { const x = reader(v); return x.value != null && isFake(String(x.value)) ? { value: null, fake: true } : x; };
const fakeDriver = (s) => /DUMMY/i.test(s);
const fakePhone = (s) => /^0?8000000\d*$/.test(s.replace(/\D/g, ""));
const fakeResi = (s) => /^AUTO-SJ[A-Z]?-/i.test(s);

const FIELDS = [
  // [header v1, kolom v2, pembaca, label]
  ["GATE OUT", "gate_out_at", ts, "Gate out"],
  ["GATE IN", "gate_in_at", ts, "Gate in"],
  ["SJ NUMBER", "sj_number", text, "No SJ"],
  ["PLATE NUMBER", "plate_number", (v) => ({ value: text(v).value ? norm(v) : null }), "Plat"],
  ["TRUCK TYPE", "truck_type", text, "Jenis truk"],
  ["RESI SJ RECEIVED", "sj_resi_received_at", day, "Tgl resi SJ"],
  ["RESI NUMBER SJ", "sj_resi_number", real(text, fakeResi), "No resi SJ"],
  ["SJ RECEIVED", "sj_received_at", day, "SJ diterima"],
  ["SJ DELIVERED", "sj_delivered_at", day, "SJ dikirim"],
  ["RESI SJ DELIVERED", "sj_delivered_resi_number", real(text, fakeResi), "Resi SJ dikirim"],
  ["DRIVER 1", "driver1_name", real(text, fakeDriver), "Driver 1"],
  ["HP DRIVER 1", "driver1_phone", real(text, fakePhone), "HP driver 1"],
  ["DRIVER 2", "driver2_name", real(text, fakeDriver), "Driver 2"],
  ["HP DRIVER 2", "driver2_phone", real(text, fakePhone), "HP driver 2"],
];

// Nilai v2 yang sebenarnya kosong: placeholder dari JOB REG ("TIDAK ADA KODE TUGAS", "-"), jenis truk berisi "RIT n"
const emptyish = (col, v) => v == null || v === "" || ["-", "TIDAK ADA KODE TUGAS", "STB"].includes(norm(v))
  || (col === "truck_type" && /^RIT\s*\d+$/i.test(String(v).trim()));

const same = (col, a, b) => {
  if (a == null || b == null) return a == b;
  if (col.includes("resi_number")) return norm(a).replace(/^0+/, "") === norm(b).replace(/^0+/, "");   // nol depan hilang di Excel v1
  if (col.endsWith("_at") && col.startsWith("gate")) return new Date(a).getTime() === new Date(String(b).replace(" ", "T").replace("+07", "+07:00")).getTime();
  return norm(String(a).slice(0, col.endsWith("_at") ? 10 : undefined)) === norm(b);
};

export async function readJobListV1(file) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(file)) await wb.xlsx.load(file);
  else await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet("JOB LIST");
  if (!ws) throw new Error('Sheet "JOB LIST" tidak ada. Pakai file export Job List dari ERP AMICO v1.');
  const header = {};
  ws.getRow(1).eachCell((c, n) => { header[norm(raw(c))] = n; });
  for (const h of ["JOB NUMBER", "CUSTOMER", "POL", "POD"]) if (!header[h]) throw new Error(`Kolom "${h}" tidak ada di sheet JOB LIST`);
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = (h) => (header[h] ? raw(row.getCell(header[h])) : null);
    if (get("JOB NUMBER")) rows.push({ n, get });
  });
  return rows;
}

export async function importJobListV1({ file, target, timpa = false, dryRun = false, log = () => {} }) {
  const rows = await readJobListV1(file);
  log(`JOB LIST v1: ${rows.length} baris`);
  const result = {
    file: path.basename(Buffer.isBuffer(file) ? "unggahan.xlsx" : String(file)), rows: rows.length, timpa,
    stats: { fake_skipped: 0, jobs_updated: 0, fields_filled: 0, fields_overwritten: 0, conflicts: 0, new_jobs: 0, vendors_created: 0, banks: 0, vendor_set: 0, payee_lines: 0 },
    filled: [], conflicts: [], created: [], issues: [], not_in_v1: [],
  };
  const DRY = new Error("dry-run");
  try {
    await target.tx(async (t) => {
      const one = async (sql, p) => (await t.query(sql, p))[0];
      const product = Object.fromEntries((await t.query("select kind, id from product")).map((p) => [p.kind, p.id]));
      const partners = new Map((await t.query("select id, name, code, is_customer, is_vendor, payment_scheme from res_partner")).map((p) => [norm(p.name), p]));
      const codes = new Set([...partners.values()].map((p) => p.code));
      const placeholder = partners.get(PLACEHOLDER)?.id ?? null;
      async function partner(name, role) {
        const key = norm(name);
        let p = partners.get(key);
        if (p) {
          if (role === "vendor" && !p.is_vendor) { await t.query("update res_partner set is_vendor = true where id = $1", [p.id]); p.is_vendor = true; }
          if (role === "customer" && !p.is_customer) { await t.query("update res_partner set is_customer = true where id = $1", [p.id]); p.is_customer = true; }
          return p;
        }
        let code = `${role === "customer" ? "C" : "V"}-${key.replace(/[^A-Z0-9]+/g, "-")}`.slice(0, 28);
        for (let i = 2; codes.has(code); i++) code = `${code.slice(0, 26)}-${i}`;
        codes.add(code);
        const tax = role === "customer" && !NO_TAX.has(key) ? [2, 1.1] : [0, 0];
        const [r] = await t.query(
          `insert into res_partner (code, name, is_customer, is_vendor, pph_pct, ppn_pct) values ($1, $2, $3, $4, $5, $6) returning id`,
          [code, key, role === "customer", role === "vendor", ...tax]);
        p = { id: r.id, name: key, code, is_customer: role === "customer", is_vendor: role === "vendor" };
        partners.set(key, p);
        if (role === "vendor") result.stats.vendors_created++;
        return p;
      }
      const locations = new Map((await t.query("select id, code from location")).map((l) => [norm(l.code), l.id]));
      async function location(code) {
        const key = norm(code).slice(0, 40) || "-";
        if (!locations.has(key)) locations.set(key, (await one("insert into location (code, name) values ($1, $1) returning id", [key])).id);
        return locations.get(key);
      }
      async function bank(vendorId, bankName, number, holder) {
        const no = String(number || "").replace(/\s+/g, "");
        if (!no) return null;
        const r = await one(
          `insert into res_partner_bank (partner_id, bank_name, account_number, holder) values ($1, $2, $3, $4)
           on conflict (partner_id, bank_name, account_number) do update set holder = excluded.holder returning id, (xmax = 0) as inserted`,
          [vendorId, norm(bankName) || "-", no, String(holder || "").trim() || "-"]);
        if (r.inserted) result.stats.banks++;
        return r.id;
      }
      // skema & lingkup default per customer = yang paling banyak di job customer itu
      const habit = new Map((await t.query(
        `select customer_id, mode() within group (order by customer_scheme) as cs, mode() within group (order by vendor_scheme) as vs,
                mode() within group (order by delivery_scope) as scope
         from job group by customer_id`)).map((x) => [x.customer_id, x]));

      const existing = new Map((await t.query("select * from job")).map((j) => [norm(j.job_number), j]));
      const seen = new Set();
      for (const r of rows) {
        const J = String(r.get("JOB NUMBER")).trim();
        const key = norm(J);
        if (seen.has(key)) { result.issues.push({ job: J, kolom: "JOB NUMBER", masalah: "Nomor job dobel di file", nilai: `baris ${r.n}` }); continue; }
        seen.add(key);
        const v1 = {};
        for (const [h, col, reader, label] of FIELDS) {
          const x = reader(r.get(h));
          if (x.fake) result.stats.fake_skipped++;
          if (x.bad) result.issues.push({ job: J, kolom: label, masalah: "Tanggal tidak masuk akal (salah ketik tahun?)", nilai: x.bad });
          v1[col] = x.value;
        }
        const trip = norm(r.get("JENIS TRIP")).includes("ROUND") ? "ROUND_TRIP" : "ONE_WAY";
        const unitFrom = text(r.get("UNIT DARI SIAPA")).value;
        const payee = text(r.get("PENERIMA TRANSFER")).value;
        const vendorName = unitFrom || payee;
        const bankInfo = [text(r.get("BANK")).value, text(r.get("NO REKENING")).value, text(r.get("ATAS NAMA REKENING")).value || payee];

        let job = existing.get(key);
        if (!job) {
          // ---------------------------------------------------------- job baru
          const cust = await partner(r.get("CUSTOMER"), "customer");
          const h = habit.get(cust.id);
          const jobDate = day(r.get("DATE")).value || (v1.gate_out_at || "").slice(0, 10) || null;
          if (!jobDate) { result.issues.push({ job: J, kolom: "DATE", masalah: "Tanggal job kosong", nilai: "" }); continue; }
          const vendor = vendorName ? await partner(vendorName, "vendor") : null;
          const scope = h?.scope || "INTERCITY";
          const cs = cust.payment_scheme || h?.cs || (scope === "INNERCITY" ? "FULL" : "70_30");
          const vs = h?.vs || (cs === "FULL" ? "FULL" : "70_30");
          const [jr] = await t.query(
            `insert into job (job_number, job_date, customer_id, vendor_id, pol_id, pod_id, trip_type, truck_type, plate_number,
                              driver1_name, driver1_phone, driver2_name, driver2_phone, delivery_scope, customer_scheme, vendor_scheme,
                              selling_mode, state, gate_out_at, gate_in_at, sj_number, sj_resi_received_at, sj_resi_number, sj_received_at,
                              sj_delivered_at, sj_delivered_resi_number, note, source)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ZERO',$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'AMICO') returning *`,
            [J, jobDate, cust.id, vendor?.id ?? null, await location(r.get("POL")), await location(r.get("POD")), trip, v1.truck_type || "-",
             v1.plate_number, v1.driver1_name, v1.driver1_phone, v1.driver2_name, v1.driver2_phone, scope, cs, vs,
             v1.gate_in_at ? "done" : "confirmed", v1.gate_out_at, v1.gate_in_at, v1.sj_number, v1.sj_resi_received_at, v1.sj_resi_number,
             v1.sj_received_at, v1.sj_delivered_at, v1.sj_delivered_resi_number,
             "Dari export Job List ERP AMICO v1. Selling / cost belum ada: isi lewat Edit job."]);
          const bankId = vendor ? await bank(vendor.id, ...bankInfo) : null;
          await t.query("insert into job_line (job_id, side, product_id, partner_id, description, amount) values ($1, 'SALE', $2, $3, 'Jasa trucking', 0)",
            [jr.id, product.TRUCKING, cust.id]);
          await t.query("insert into job_line (job_id, side, product_id, partner_id, partner_bank_id, description, amount) values ($1, 'PURCHASE', $2, $3, $4, 'Sewa truk', 0)",
            [jr.id, product.TRUCKING, vendor?.id ?? null, bankId]);
          existing.set(key, jr);
          result.stats.new_jobs++;
          result.created.push({ job: J, customer: cust.name, tanggal: jobDate, vendor: vendor?.name || "", catatan: "Selling / cost 0, kode tugas kosong" });
          continue;
        }

        // ------------------------------------------------------------ job yang sudah ada
        const set = {};
        for (const [, col, , label] of FIELDS) {
          const nv = v1[col];
          if (nv == null) continue;
          const old = job[col];
          if (emptyish(col, old)) { set[col] = nv; result.filled.push({ job: J, kolom: label, nilai: nv.replace?.("+07", "") ?? nv }); continue; }
          if (same(col, old, nv)) continue;
          if (timpa) { set[col] = nv; result.stats.fields_overwritten++; }
          else result.stats.conflicts++;
          result.conflicts.push({ job: J, kolom: label, v2: col.endsWith("_at") && col.startsWith("gate") ? new Date(old).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 16) : old,
            v1: nv.replace?.("+07", "") ?? nv, tindakan: timpa ? "Ditimpa nilai v1" : "Dibiarkan (nilai v2)" });
        }
        if (set.gate_in_at && job.state === "confirmed") set.state = "done";
        if (Object.keys(set).length) {
          const cols = Object.keys(set);
          await t.query(`update job set ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}, updated_at = now() where id = $${cols.length + 1}`,
            [...cols.map((c) => set[c]), job.id]);
          result.stats.jobs_updated++;
          result.stats.fields_filled += cols.length - (set.state ? 1 : 0);
        }
        // vendor & rekening
        if (vendorName) {
          const vendor = await partner(vendorName, "vendor");
          const bankId = await bank(vendor.id, ...bankInfo);
          if (job.vendor_id == null || job.vendor_id === placeholder) {
            await t.query("update job set vendor_id = $1 where id = $2", [vendor.id, job.id]);
            await t.query(
              `update job_line jl set partner_id = $1, partner_bank_id = coalesce($2, jl.partner_bank_id)
               from product p where p.id = jl.product_id and jl.job_id = $3 and jl.side = 'PURCHASE' and p.kind = 'TRUCKING'
                 and (jl.partner_id is null or jl.partner_id = $4)`, [vendor.id, bankId, job.id, placeholder]);
            const upd = await t.query(
              `update account_move_line ml set payee_partner_id = $1,
                      payee_bank_name = coalesce($2, ml.payee_bank_name), payee_account_number = coalesce($3, ml.payee_account_number),
                      payee_holder = coalesce($4, ml.payee_holder)
               from account_move m where m.id = ml.move_id and m.move_type = 'in_invoice' and ml.job_id = $5
                 and (ml.payee_partner_id is null or ml.payee_partner_id = $6)
                 and (ml.job_line_id is null or ml.job_line_id in (select jl.id from job_line jl join product p on p.id = jl.product_id
                                                                   where jl.job_id = $5 and p.kind = 'TRUCKING'))
               returning ml.id`,
              [vendor.id, bankId ? norm(bankInfo[0]) : null, bankId ? String(bankInfo[1]).replace(/\s+/g, "") : null, bankId ? bankInfo[2] : null, job.id, placeholder]);
            result.stats.vendor_set++;
            result.stats.payee_lines += upd.length;
          } else if (job.vendor_id !== vendor.id) {
            const cur = [...partners.values()].find((p) => p.id === job.vendor_id);
            result.conflicts.push({ job: J, kolom: "Vendor", v2: cur?.name || job.vendor_id, v1: vendor.name, tindakan: "Dibiarkan (nilai v2)" });
            result.stats.conflicts++;
          }
        }
      }
      for (const [k, j] of existing) if (!seen.has(k) && j.state !== "cancelled") result.not_in_v1.push({ job: j.job_number, tanggal: j.job_date, sumber: j.source });

      await t.query(
        `insert into ir_sequence (name, next_number)
         select 'JOB/' || substr(job_number, 5, 4), max(substr(job_number, 10)::int) + 1 from job
         where job_number ~ '^AMC/[0-9]{4}/[0-9]+$' group by 1
         on conflict (name) do update set next_number = greatest(ir_sequence.next_number, excluded.next_number)`);
      await t.query("insert into audit_log (entity, action, detail) values ('import', 'joblist_v1', $1)",
        [JSON.stringify({ file: result.file, timpa, dry_run: dryRun, ...result.stats })]);
      if (dryRun) throw DRY;
    });
  } catch (err) {
    if (err !== DRY) throw err;
  }
  if (!dryRun) await target.exec("analyze");
  result.dryRun = dryRun;
  return result;
}

export async function writeJobListReport(result, file) {
  const wb = new ExcelJS.Workbook();
  const sheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2A1A0E" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (rows.length) ws.autoFilter = { from: "A1", to: { row: 1, column: cols.length } };
  };
  const s = result.stats;
  sheet("RINGKASAN", [["Hal", "k", 52], ["Jumlah", "v", 16]], [
    { k: "File", v: result.file }, { k: result.dryRun ? "PRATINJAU (belum disimpan)" : "Sudah disimpan", v: "" },
    { k: "Baris di JOB LIST v1", v: result.rows }, { k: "Job yang dilengkapi", v: s.jobs_updated }, { k: "Kolom yang diisi", v: s.fields_filled },
    { k: "Kolom ditimpa (mode timpa)", v: s.fields_overwritten },
    { k: "Isian buatan v1 diabaikan (DRIVER DUMMY, HP 08000000.., resi AUTO-SJ..)", v: s.fake_skipped }, { k: "Beda v1 vs v2 (lihat sheet BEDA)", v: s.conflicts },
    { k: "Job baru (selling / cost 0)", v: s.new_jobs }, { k: "Vendor baru", v: s.vendors_created }, { k: "Rekening baru", v: s.banks },
    { k: "Job yang vendornya diisi", v: s.vendor_set }, { k: "Baris pengajuan lama yang penerimanya diisi", v: s.payee_lines },
    { k: "Job v2 yang tidak ada di file v1", v: result.not_in_v1.length }, { k: "Catatan perlu dicek", v: result.issues.length },
  ]);
  sheet("DIISI", [["JOB NUMBER", "job", 16], ["KOLOM", "kolom", 18], ["NILAI DARI V1", "nilai", 28]], result.filled);
  sheet("BEDA", [["JOB NUMBER", "job", 16], ["KOLOM", "kolom", 16], ["NILAI V2", "v2", 26], ["NILAI V1", "v1", 26], ["TINDAKAN", "tindakan", 22]], result.conflicts);
  sheet("JOB BARU", [["JOB NUMBER", "job", 16], ["TANGGAL", "tanggal", 12], ["CUSTOMER", "customer", 16], ["VENDOR", "vendor", 26], ["CATATAN", "catatan", 36]], result.created);
  sheet("PERLU DICEK", [["JOB NUMBER", "job", 16], ["KOLOM", "kolom", 14], ["MASALAH", "masalah", 44], ["NILAI", "nilai", 22]], result.issues);
  sheet("TIDAK ADA DI V1", [["JOB NUMBER", "job", 16], ["TANGGAL", "tanggal", 12], ["SUMBER", "sumber", 10]], result.not_in_v1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return file;
}

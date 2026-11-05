// Kelompokkan dokumen hasil impor JOB REG mengikuti batch ERP v1: invoice customer dan pengajuan DP vendor.
// Sumber: file cadangan database v1 (.sql / .sql.gz dari tombol Backup Database). File hanya dibaca, v1 tidak dihubungi.
//
// Uang tetap dari JOB REG. Yang berubah hanya pengelompokan: nomor dokumen menjadi nomor batch v1, beberapa dokumen satu job
// menjadi satu dokumen banyak job, dan pembayaran di batch yang sama (tanggal & rekening sama) menjadi satu pembayaran.
// - Sebelum dan sesudah, angka tiap job, jurnal kas, dan mutasi rekening dicocokkan. Beda sedikit saja = seluruhnya dibatalkan.
// - Hanya dokumen JR/... yang disentuh; dokumen buatan aplikasi tidak. Aman dijalankan ulang.
// - Job yang tidak ada di batch v1 tetap satu dokumen per job, seperti hasil impor JOB REG.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import readline from "node:readline";
import ExcelJS from "exceljs";

const WANT = {
  payment_request_batches: ["id", "batch_number", "request_type", "status", "created_at", "cancelled_at"],
  payment_request_items: ["batch_id", "request_type", "item_no", "job_number", "cost_type", "request_amount", "cancelled_at", "refunded_at"],
  customer_invoice_batches: ["id", "invoice_number", "invoice_date", "invoice_type", "cancelled_at", "bill_to_name", "bill_to_address", "bill_to_npwp"],
  customer_invoice_items: ["batch_id", "item_no", "job_number", "cancelled_at"],
};
const unescapeCopy = (v) => (v === "\\N" ? null : v.replace(/\\(.)/g, (_, c) => ({ t: "\t", n: "\n", r: "\r", "\\": "\\" }[c] ?? c)));

// Hanya kolom di WANT yang disimpan; rekening dan data pribadi lain tidak ikut terbaca ke memori.
export async function readV1Dump(file) {
  const tables = Object.fromEntries(Object.keys(WANT).map((t) => [t, []]));
  const raw = fs.createReadStream(file);
  const input = /\.gz$/i.test(file) ? raw.pipe(zlib.createGunzip()) : raw;
  let cur = null, cols = null;
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (cur) {
      if (line === "\\.") { cur = null; continue; }
      const v = line.split("\t");
      const row = {};
      for (const c of WANT[cur]) { const i = cols.indexOf(c); row[c] = i < 0 ? null : unescapeCopy(v[i]); }
      tables[cur].push(row);
      continue;
    }
    const m = line.match(/^COPY (?:public\.)?"?(\w+)"? \(([^)]*)\) FROM stdin;$/);
    if (m && WANT[m[1]]) { cur = m[1]; cols = m[2].split(",").map((s) => s.trim().replace(/"/g, "")); }
  }
  if (!tables.customer_invoice_batches.length && !tables.payment_request_batches.length) {
    throw new Error("File ini tidak berisi tabel batch ERP v1. Pakai file dari tombol Backup Database.");
  }
  return tables;
}

// Batch v1 yang masih hidup: { key, number, type, phase, date, billTo, items: [job_number, ...], amounts }
export function liveBatches(t) {
  const out = [];
  const add = (b, type, phase, number, date, items, billTo = null) => {
    if (b.cancelled_at || !items.length) return;
    items.sort((a, c) => Number(a.item_no) - Number(c.item_no));
    out.push({ number, type, phase, date: String(date || "").slice(0, 10) || null, billTo, items });
  };
  const byBatch = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.batch_id)) m.set(r.batch_id, []); m.get(r.batch_id).push(r); } return m; };
  const pi = byBatch(t.payment_request_items.filter((i) => !i.cancelled_at && !i.refunded_at && (i.cost_type ?? "TRUCKING") === "TRUCKING"));
  for (const b of t.payment_request_batches) {
    // hanya pengajuan DP; yang ditolak / dibatalkan / uangnya kembali tidak dianggap batch hidup
    if (b.request_type !== "DP_70" || ["CANCELLED", "REJECTED", "DRAFT", "REFUNDED"].includes(b.status)) continue;
    add(b, "in_invoice", "DP", b.batch_number, b.created_at, pi.get(b.id) || []);
  }
  const ci = byBatch(t.customer_invoice_items.filter((i) => !i.cancelled_at));
  const PHASE = { DP_70: "DP", SETTLEMENT_30: "SETTLEMENT", FULL: "FULL" };
  for (const b of t.customer_invoice_batches) {
    if (!PHASE[b.invoice_type]) continue;
    add(b, "out_invoice", PHASE[b.invoice_type], b.invoice_number, b.invoice_date, ci.get(b.id) || [],
      { name: b.bill_to_name, address: b.bill_to_address, npwp: b.bill_to_npwp });
  }
  return out;
}

// Sidik uang: tiap job per fase, jurnal kas, dan mutasi rekening. Harus sama persis sebelum & sesudah.
async function moneyPrint(t) {
  const q = async (sql) => JSON.stringify(await t.query(sql));
  return {
    per_job: await q(`select ml.job_id, m.move_type, m.phase, m.state, sum(ml.amount)::text as amount,
        sum(coalesce((select sum(pl.amount) from account_payment_line pl where pl.move_line_id = ml.id), 0))::text as paid
      from account_move_line ml join account_move m on m.id = ml.move_id where ml.cancelled_at is null group by 1, 2, 3, 4 order by 1, 2, 3, 4`),
    utang_piutang: await q("select * from v_utang_piutang order by job_id"),
    jurnal: await q("select job_id, tanggal, arah, jenis, sum(nominal)::text as nominal from v_cash_ledger group by 1, 2, 3, 4 order by 1, 2, 3, 4"),
    rekening: await q("select bank_account_id, mutasi_bersih::text from v_bank_balance order by 1"),
  };
}

// dryRun: dijalankan penuh lalu dibatalkan, jadi hitungannya sama dengan yang sungguhan
export async function groupByV1Batch({ tables, target, log = () => {}, dryRun = false }) {
  const STOP = new Error("pratinjau");
  const batches = liveBatches(tables);
  const stats = { batch_v1: batches.length, batch_cocok: 0, dokumen_digabung: 0, dokumen_jadi: 0, nomor_diganti: 0, pembayaran_digabung: 0, job_tidak_ketemu: 0, customer_beda: 0, nomor_sudah_dipakai: 0 };
  const issues = [];
  const note = (job, batch, masalah) => issues.push({ job, batch, masalah });
  await target.tx(async (t) => {
    const before = await moneyPrint(t);
    const docs = await t.query(
      `select m.id, m.number, m.move_type, m.phase, m.partner_id, m.tax_basis, m.ppn_amount, m.pph23_amount, m.due_date::text as due_date, j.job_number, ml.job_id
       from account_move m join account_move_line ml on ml.move_id = m.id join job j on j.id = ml.job_id
       where m.number like 'JR/%' and m.state = 'posted' group by m.id, j.job_number, ml.job_id order by m.id`);
    const pool = new Map();
    for (const d of docs) {
      const k = `${d.move_type}|${d.phase}|${d.job_number}`;
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(d);
    }
    // batch yang sudah terbentuk pada pemakaian sebelumnya dilewati, supaya dijalankan ulang tidak mencatat masalah palsu
    const done = new Set((await t.query("select legacy_number from account_move where legacy_source = 'V1_BATCH'")).map((x) => x.legacy_number));
    for (const b of batches) {
      if (done.has(b.number)) continue;
      const picked = [];
      for (const it of b.items) {
        const found = pool.get(`${b.type}|${b.phase}|${it.job_number}`);
        if (found?.length) picked.push(...found.splice(0));
        // job di luar rentang impor memang tidak ada di ERP, tidak perlu dicatat
        else if (it.job_number && (await t.query("select 1 from job where job_number = $1", [it.job_number])).length) {
          stats.job_tidak_ketemu++;
          note(it.job_number, b.number, "Ada di batch v1, tapi JOB REG tidak punya dokumen fase ini (atau sudah masuk batch lain)");
        }
      }
      if (!picked.length) continue;
      // satu dokumen invoice untuk satu customer: nama customer yang beda di Excel dibiarkan terpisah
      let group = picked;
      if (b.type === "out_invoice") {
        const count = new Map();
        for (const d of picked) count.set(d.partner_id, (count.get(d.partner_id) || 0) + 1);
        const main = [...count.entries()].sort((x, y) => y[1] - x[1])[0][0];
        group = picked.filter((d) => d.partner_id === main);
        for (const d of picked.filter((x) => x.partner_id !== main)) {
          stats.customer_beda++;
          note(d.job_number, b.number, "Nama customer di JOB REG beda dengan job lain di batch ini, dokumennya dibiarkan terpisah");
        }
      }
      if ((await t.query("select 1 from account_move where number = $1", [b.number])).length) {
        stats.nomor_sudah_dipakai++;
        note(group[0].job_number, b.number, "Nomor batch sudah dipakai dokumen lain, dokumen tidak diubah");
        continue;
      }
      const ids = group.map((d) => d.id);
      // Cetak invoice menghitung "DP sebelumnya" dari dokumen DP ber-id lebih kecil. Jadi dokumen DP memakai id terkecil dan
      // pelunasan / full memakai id terbesar, supaya DP tiap job di batch tetap terbaca.
      const keep = b.phase === "DP" ? Math.min(...ids) : Math.max(...ids);
      const rest = ids.filter((x) => x !== keep);
      // pajak dihitung per job sekali (job FULL bisa punya dua dokumen dengan dasar yang sama)
      const perJob = new Map();
      for (const d of group) perJob.set(d.job_id, d);
      const sum = (k) => [...perJob.values()].reduce((a, d) => a + Number(d[k] || 0), 0);
      const dues = group.map((d) => d.due_date).filter(Boolean).sort();
      await t.query(
        `update account_move set number = $1, move_date = coalesce($2::date, move_date), due_date = $3::date, tax_basis = $4, ppn_amount = $5, pph23_amount = $6,
           bill_to_name = coalesce($7, bill_to_name), bill_to_address = coalesce($8, bill_to_address), bill_to_npwp = coalesce($9, bill_to_npwp),
           legacy_source = 'V1_BATCH', legacy_number = $1, note = $10 where id = $11`,
        [b.number, b.date, dues[0] || null, sum("tax_basis"), sum("ppn_amount"), sum("pph23_amount"), b.billTo?.name || null, b.billTo?.address || null, b.billTo?.npwp || null,
         `Batch ERP v1 ${b.number}, ${perJob.size} job. Nominal dari JOB REG.`, keep]);
      if (rest.length) {
        // urutan baris mengikuti urutan job di batch v1
        const order = new Map(b.items.map((it, i) => [it.job_number, i]));
        const lines = await t.query("select ml.id, j.job_number from account_move_line ml join job j on j.id = ml.job_id where ml.move_id = any($1::int[]) order by ml.id", [ids]);
        lines.sort((x, y) => (order.get(x.job_number) ?? 1e9) - (order.get(y.job_number) ?? 1e9));
        for (const [i, l] of lines.entries()) await t.query("update account_move_line set move_id = $1, line_no = $2 where id = $3", [keep, i + 1, l.id]);
        await t.query("update account_payment set move_id = $1 where move_id = any($2::int[])", [keep, rest]);
        await t.query("delete from account_move where id = any($1::int[])", [rest]);
        stats.dokumen_digabung += rest.length;
      }
      // pembayaran di hari & rekening yang sama = satu kali transfer
      const pays = await t.query("select id, pay_date::text as pay_date, bank_account_id, payment_type, amount from account_payment where move_id = $1 and state <> 'reversed' and reversed_payment_id is null order by pay_date, id", [keep]);
      const byKey = new Map();
      for (const p of pays) { const k = `${p.pay_date}|${p.bank_account_id}|${p.payment_type}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }
      let no = 0;
      for (const list of byKey.values()) {
        const [first, ...others] = list;
        no++;
        if (others.length) {
          const otherIds = others.map((p) => p.id);
          await t.query("update account_payment_line set payment_id = $1 where payment_id = any($2::int[])", [first.id, otherIds]);
          await t.query("delete from account_payment where id = any($1::int[])", [otherIds]);
          await t.query("update account_payment set amount = $1 where id = $2", [list.reduce((a, p) => a + Number(p.amount), 0), first.id]);
          stats.pembayaran_digabung += others.length;
        }
        await t.query("update account_payment set number = $1, legacy_source = 'V1_BATCH' where id = $2", [`PAY/${b.number}${byKey.size > 1 ? `/${no}` : ""}`, first.id]);
      }
      stats.batch_cocok++;
      stats.dokumen_jadi++;
      if (!rest.length) stats.nomor_diganti++;
    }
    const after = await moneyPrint(t);
    for (const k of Object.keys(before)) {
      if (before[k] !== after[k]) throw new Error(`Angka ${k} berubah setelah digabung. Semua dibatalkan, tidak ada yang berubah.`);
    }
    await t.query("insert into audit_log (entity, action, detail) values ('import', 'batch_v1', $1)", [JSON.stringify(stats)]);
    log("Uang tiap job, jurnal kas, dan mutasi rekening dicek: sama persis dengan sebelum digabung.");
    if (dryRun) throw STOP;
  }).catch((err) => { if (err !== STOP) throw err; });
  return { stats, issues };
}

export async function writeBatchReport({ stats, issues }, file) {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("RINGKASAN");
  a.columns = [{ header: "ISI", key: "k", width: 34 }, { header: "JUMLAH", key: "v", width: 12 }];
  for (const [k, v] of Object.entries(stats)) a.addRow({ k, v });
  const b = wb.addWorksheet("PERLU DICEK");
  b.columns = [{ header: "JOB", key: "job", width: 18 }, { header: "BATCH V1", key: "batch", width: 24 }, { header: "MASALAH", key: "masalah", width: 80 }];
  for (const i of issues) b.addRow(i);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return file;
}

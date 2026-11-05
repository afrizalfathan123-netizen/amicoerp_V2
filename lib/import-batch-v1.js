// Kelompokkan dokumen hasil impor JOB REG mengikuti batch ERP v1: invoice customer dan pengajuan vendor (DP, pelunasan, full).
// Sumber: file cadangan database v1 (.sql / .sql.gz dari tombol Backup Database). File hanya dibaca, v1 tidak dihubungi.
//
// Uang tetap dari JOB REG. Yang berubah pengelompokannya: nomor dokumen menjadi nomor batch v1, beberapa dokumen satu job
// menjadi satu dokumen banyak job, dan pembayaran di batch yang sama (tanggal & rekening sama) menjadi satu pembayaran.
// Batch v1 yang belum selesai dan belum tercatat di JOB REG dibuatkan dokumen TANPA pembayaran: sisa utang / piutang tiap job tetap sama.
// - Sebelum dan sesudah, angka tiap job, jurnal kas, dan mutasi rekening dicocokkan. Beda sedikit saja = seluruhnya dibatalkan.
// - Hanya dokumen JR/... yang digabung; dokumen buatan aplikasi tidak disentuh, dan fase yang sudah punya dokumen tidak dibuat lagi. Aman dijalankan ulang.
// - Job yang tidak ada di batch v1 tetap satu dokumen per job, seperti hasil impor JOB REG.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import readline from "node:readline";
import ExcelJS from "exceljs";

const WANT = {
  payment_request_batches: ["id", "batch_number", "request_type", "status", "payment_channel", "created_at", "cancelled_at"],
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

// Batch v1 yang masih hidup (aktif, selesai, atau belum selesai). Yang batal, ditolak, atau uangnya kembali tidak ikut.
// open = belum selesai: boleh dibuatkan dokumen kalau JOB REG belum mencatatnya. Pengajuan yang sudah PAID tidak boleh dibuat dari v1,
// karena uang yang sudah keluar hanya dari JOB REG. Invoice v1 tidak punya status, tagihan baru masuk JOB REG setelah dibayar.
export function liveBatches(t) {
  const out = [];
  const PHASE = { DP_70: "DP", SETTLEMENT_30: "SETTLEMENT", FULL: "FULL" };
  const add = (b, type, phase, number, date, items, extra) => {
    if (b.cancelled_at || !items.length) return;
    items.sort((a, c) => Number(a.item_no) - Number(c.item_no));
    out.push({ number, type, phase, date: String(date || "").slice(0, 10) || null, items, billTo: null, status: null, channel: "NORMAL", open: false, ...extra });
  };
  const byBatch = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.batch_id)) m.set(r.batch_id, []); m.get(r.batch_id).push(r); } return m; };
  const pi = byBatch(t.payment_request_items.filter((i) => !i.cancelled_at && !i.refunded_at && (i.cost_type ?? "TRUCKING") === "TRUCKING"));
  for (const b of t.payment_request_batches) {
    if (!PHASE[b.request_type] || ["CANCELLED", "REJECTED", "DRAFT", "REFUNDED"].includes(b.status)) continue;
    add(b, "in_invoice", PHASE[b.request_type], b.batch_number, b.created_at, pi.get(b.id) || [],
      { status: b.status, channel: b.payment_channel === "TRANSFER_MALAM" ? "TRANSFER_MALAM" : "NORMAL", open: b.status !== "PAID" });
  }
  const ci = byBatch(t.customer_invoice_items.filter((i) => !i.cancelled_at));
  for (const b of t.customer_invoice_batches) {
    if (!PHASE[b.invoice_type]) continue;
    add(b, "out_invoice", PHASE[b.invoice_type], b.invoice_number, b.invoice_date, ci.get(b.id) || [],
      { billTo: { name: b.bill_to_name, address: b.bill_to_address, npwp: b.bill_to_npwp }, open: true });
  }
  return out;
}

// Sidik uang: yang dibayar, jurnal kas, mutasi rekening, dan sisa per job harus sama persis sebelum & sesudah.
// Dokumen baru hanya memindahkan sisa dari "belum ditagih" ke "sudah ditagih", jadi kolom itu dicocokkan sebagai jumlah.
async function moneyPrint(t, newLineIds = []) {
  const q = async (sql, p) => JSON.stringify(await t.query(sql, p));
  const n = (v) => Number(v || 0);
  const sisa = (await t.query("select * from v_utang_piutang order by job_id")).map(({ utang_70, utang_30_belum_bayar, piutang_70_belum_tertagih, piutang_70_tertagih, piutang_30_belum_tertagih, piutang_30_tertagih, ...r }) => ({
    ...r, utang_dp_pelunasan: n(utang_70) + n(utang_30_belum_bayar),
    piutang_dp_pelunasan: n(piutang_70_belum_tertagih) + n(piutang_70_tertagih) + n(piutang_30_belum_tertagih) + n(piutang_30_tertagih),
  }));
  return {
    per_job: await q(`select ml.job_id, m.move_type, m.phase, m.state, sum(ml.amount)::text as amount,
        sum(coalesce((select sum(pl.amount) from account_payment_line pl where pl.move_line_id = ml.id), 0))::text as paid
      from account_move_line ml join account_move m on m.id = ml.move_id where ml.cancelled_at is null and not (ml.id = any($1::int[])) group by 1, 2, 3, 4 order by 1, 2, 3, 4`, [newLineIds]),
    utang_piutang: JSON.stringify(sisa),
    jurnal: await q("select job_id, tanggal, arah, jenis, sum(nominal)::text as nominal from v_cash_ledger group by 1, 2, 3, 4 order by 1, 2, 3, 4"),
    rekening: await q("select bank_account_id, mutasi_bersih::text from v_bank_balance order by 1"),
  };
}

const SCHEME_OK = (phase, scheme) => (phase === "FULL") === (scheme === "FULL");

// dryRun: dijalankan penuh lalu dibatalkan, jadi hitungannya sama dengan yang sungguhan
export async function groupByV1Batch({ tables, target, log = () => {}, dryRun = false }) {
  const STOP = new Error("pratinjau");
  const batches = liveBatches(tables);
  const stats = { batch_v1: batches.length, batch_cocok: 0, dokumen_digabung: 0, dokumen_jadi: 0, nomor_diganti: 0, pembayaran_digabung: 0, dokumen_baru: 0, baris_baru: 0, full_di_jobreg_dp: 0,
    job_tidak_ketemu: 0, customer_beda: 0, nomor_sudah_dipakai: 0, nominal_beda: 0, v1_belum_bayar_jobreg_lunas: 0 };
  const issues = [];
  const note = (job, batch, masalah) => issues.push({ job, batch, masalah });
  const newLineIds = [];
  await target.tx(async (t) => {
    const before = await moneyPrint(t);
    const docs = await t.query(
      `select m.id, m.number, m.move_type, m.phase, m.partner_id, m.tax_basis, m.ppn_amount, m.pph23_amount, m.due_date::text as due_date, j.job_number, ml.job_id, sum(ml.amount)::float8 as amount,
         (select coalesce(sum(pl.amount), 0)::float8 from account_payment_line pl join account_move_line l2 on l2.id = pl.move_line_id where l2.move_id = m.id and l2.job_id = ml.job_id) as paid
       from account_move m join account_move_line ml on ml.move_id = m.id join job j on j.id = ml.job_id
       where m.number like 'JR/%' and m.state = 'posted' group by m.id, j.job_number, ml.job_id order by m.id`);
    const pool = new Map();
    for (const d of docs) {
      const k = `${d.move_type}|${d.phase}|${d.job_number}`;
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(d);
    }
    const jobs = new Map((await t.query("select id, job_number, customer_id, customer_scheme, vendor_scheme, state from job")).map((j) => [j.job_number, j]));
    // Job yang fasenya sudah punya dokumen tidak dibuatkan lagi, termasuk dokumen buatan tim di aplikasi. Baris yang dibatalkan tim juga tidak dihidupkan lagi.
    const billed = new Set((await t.query(
      `select distinct m.move_type, m.phase, ml.job_id from account_move_line ml join account_move m on m.id = ml.move_id where m.state <> 'cancelled' and ml.cancelled_at is null`)).map((x) => `${x.move_type}|${x.phase}|${x.job_id}`));
    // batch yang sudah terbentuk pada pemakaian sebelumnya tidak digabung lagi, tapi job yang belum tertagih tetap bisa masuk
    const done = new Map((await t.query("select id, number, legacy_number, state from account_move where legacy_source = 'V1_BATCH'")).map((x) => [x.legacy_number, x]));
    const formedBefore = new Set(done.keys());   // catatan masalah tidak diulang untuk batch dari pemakaian sebelumnya
    const inDone = async (id) => new Set((await t.query("select distinct job_id from account_move_line where move_id = $1", [id])).map((x) => x.job_id));
    const defaultBank = (await t.query("select id from res_bank_account where kind = 'BANK' order by is_default desc, id limit 1"))[0]?.id ?? null;

    // Gabungkan dokumen JOB REG satu batch menjadi satu dokumen bernomor batch. Mengembalikan id dokumennya.
    async function mergeDocs(b, group) {
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
         `Batch ERP v1 ${b.batchNote || b.number}, ${perJob.size} job. Nominal dari JOB REG.`, keep]);
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
      return keep;
    }

    // Dokumen untuk batch yang isinya belum ada di JOB REG sama sekali. Tanpa pembayaran.
    async function newDoc(b, partnerId) {
      const sale = b.type === "out_invoice";
      const terms = sale ? Number((await t.query("select payment_terms_days from res_partner where id = $1", [partnerId]))[0]?.payment_terms_days || 0) : 0;
      const date = b.date || new Date().toISOString().slice(0, 10);
      const [{ id }] = await t.query(
        `insert into account_move (number, move_type, phase, partner_id, move_date, due_date, bank_account_id, state, approval_state, payment_channel, bill_to_name, bill_to_address, bill_to_npwp,
           note, legacy_source, legacy_number, posted_at, approved_at)
         values ($1, $2, $3, $4, $5::date, case when $6::int > 0 then $5::date + $6::int end, $7, 'posted', $8, $9, $10, $11, $12, $13, 'V1_BATCH', $1, ($5 || ' 00:00:00+07')::timestamptz,
           case when $8 = 'APPROVED' then ($5 || ' 00:00:00+07')::timestamptz end) returning id`,
        [b.number, b.type, b.phase, sale ? partnerId : null, date, terms, sale ? defaultBank : null, sale ? "NOT_REQUIRED" : (b.status === "PENDING_APPROVAL" ? "PENDING" : "APPROVED"), b.channel,
         b.billTo?.name || null, b.billTo?.address || null, b.billTo?.npwp || null, `Batch ERP v1 ${b.number}, belum ada di JOB REG (status v1: ${b.status || "invoice aktif"}).`]);
      stats.dokumen_baru++;
      return id;
    }

    // Nominal job yang belum tertagih: invoice mengikuti sisa rencana dari JOB REG, pengajuan mengikuti permintaan v1 dibatasi sisa cost.
    // Mengembalikan 0 kalau tidak boleh ditambahkan, alasannya dicatat.
    async function openAmount(b, it, job, silent) {
      const sale = b.type === "out_invoice";
      const skip = (why) => { if (!silent) { stats.job_tidak_ketemu++; note(it.job_number, b.number, why); } return 0; };
      if (job.state === "cancelled") return skip("Job sudah dibatalkan di ERP, tidak dibuatkan dokumen");
      if (!SCHEME_OK(b.phase, sale ? job.customer_scheme : job.vendor_scheme)) return skip(`Batch v1 fase ${b.phase}, tapi skema ${sale ? "customer" : "vendor"} job ini ${sale ? job.customer_scheme : job.vendor_scheme}. Tidak dibuatkan dokumen, perlu dicek`);
      if ((await t.query("select 1 from v_kurang_transfer where job_id = $1 and side = $2", [job.id, sale ? "SALE" : "PURCHASE"])).length) return skip("Job ini tercatat kurang transfer di JOB REG, tidak dibuatkan dokumen, perlu dicek");
      if (sale) {
        const [pos] = await t.query("select not_billed::float8 as v from v_job_phase_position where job_id = $1 and side = 'SALE' and phase = $2", [job.id, b.phase]);
        return Number(pos?.v || 0) > 0 ? Number(pos.v) : skip("Tidak ada sisa yang bisa ditagih untuk fase ini");
      }
      const [rem] = await t.query(
        `select coalesce(sum(jl.amount - coalesce((select sum(ml.amount) from account_move_line ml join account_move m on m.id = ml.move_id where ml.job_line_id = jl.id and ml.cancelled_at is null and m.state = 'posted'), 0)), 0)::float8 as v
         from job_line jl join product p on p.id = jl.product_id where jl.job_id = $1 and jl.side = 'PURCHASE' and p.kind = 'TRUCKING'`, [job.id]);
      const want = Number(it.request_amount || 0);
      const take = Math.min(want, Math.max(Number(rem?.v || 0), 0));
      if (!(take > 0)) return skip("Tidak ada sisa cost yang bisa diajukan untuk job ini");
      if (take < want - 1) { stats.nominal_beda++; note(it.job_number, b.number, `Pengajuan v1 ${want}, sisa cost di JOB REG hanya ${take}. Dipakai ${take}`); }
      return take;
    }

    async function addLines(moveId, b, job, amount) {
      const sale = b.type === "out_invoice";
      const rows = await t.query(
        `select jl.id, jl.amount::float8 as amount, jl.partner_id, jl.description, pb.bank_name, pb.account_number, pb.holder, pt.name as partner_name,
           coalesce((select sum(ml.amount) from account_move_line ml join account_move m on m.id = ml.move_id where ml.job_line_id = jl.id and ml.cancelled_at is null and m.state = 'posted'), 0)::float8 as billed
         from job_line jl join product p on p.id = jl.product_id left join res_partner pt on pt.id = jl.partner_id left join res_partner_bank pb on pb.id = jl.partner_bank_id
         where jl.job_id = $1 and jl.side = $2 and ($3 or p.kind = 'TRUCKING') order by (p.kind <> 'TRUCKING'), jl.id`, [job.id, sale ? "SALE" : "PURCHASE", sale]);
      if (!rows.length) return false;
      let [{ no }] = await t.query("select coalesce(max(line_no), 0)::int as no from account_move_line where move_id = $1", [moveId]);
      let left = amount;
      for (const [i, r] of rows.entries()) {
        // Tagihan setelah pajak bisa lebih besar dari baris selling: sisanya masuk baris terakhir.
        const take = i === rows.length - 1 ? left : Math.min(left, Math.max(r.amount - r.billed, 0));
        if (!(take > 0)) continue;
        const [{ id }] = await t.query(
          `insert into account_move_line (move_id, line_no, job_line_id, job_id, amount, description, payee_partner_id, payee_bank_name, payee_account_number, payee_holder)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [moveId, ++no, r.id, job.id, take, r.description, sale ? null : r.partner_id, sale ? null : r.bank_name, sale ? null : r.account_number, sale ? null : (r.holder || r.partner_name)]);
        newLineIds.push(id);
        left -= take;
      }
      if (sale && b.phase !== "DP") {
        // pajak dihitung per job, sama dengan dokumen hasil impor JOB REG
        await t.query(
          `update account_move m set tax_basis = m.tax_basis + x.basis, ppn_amount = m.ppn_amount + round(x.basis * c.ppn_pct / 100), pph23_amount = m.pph23_amount + round(x.basis * c.pph_pct / 100)
           from (select sum(amount) as basis from job_line where job_id = $2 and side = 'SALE') x, res_partner c where m.id = $1 and c.id = m.partner_id`, [moveId, job.id]);
      }
      stats.baris_baru++;
      billed.add(`${b.type}|${b.phase}|${job.id}`);
      return true;
    }

    // Saluran & status persetujuan mengikuti v1. Yang sudah ada pembayaran, atau sudah disetujui tim di aplikasi, tidak diubah.
    async function followV1(moveId, b) {
      if (b.type !== "in_invoice") return;
      await t.query("update account_move set payment_channel = $1 where id = $2 and payment_channel <> $1", [b.channel, moveId]);
      if (b.status === "PENDING_APPROVAL") {
        await t.query(
          `update account_move m set approval_state = 'PENDING', approved_at = null where m.id = $1 and m.approved_by is null and m.approval_state = 'APPROVED'
             and not exists (select 1 from account_move_line ml join account_payment_line pl on pl.move_line_id = ml.id where ml.move_id = m.id)`, [moveId]);
      }
    }

    const fullLeftovers = [];
    async function processBatch(b) {
      const prior = done.get(b.number);
      if (prior && prior.state !== "posted") return;   // ditolak / dibatalkan tim di aplikasi: dibiarkan
      const picked = [], missing = [], seen = new Set();
      const priorJobs = prior ? await inDone(prior.id) : new Set();
      for (const it of b.items) {
        const job = jobs.get(it.job_number);
        if (!job || seen.has(it.job_number)) continue;   // job di luar rentang impor memang tidak ada di ERP
        seen.add(it.job_number);
        if (priorJobs.has(job.id)) continue;
        const found = pool.get(`${b.type}|${b.phase}|${it.job_number}`);
        if (found?.length) {
          if (prior) continue;
          for (const d of found) {
            const paid = Number(d.paid || 0), amount = Number(d.amount || 0);
            if (b.type === "in_invoice" && it.request_amount != null && Math.abs(Number(it.request_amount) - amount) > 1) {
              stats.nominal_beda++;
              note(it.job_number, b.number, `Nominal v1 ${Number(it.request_amount)}, JOB REG ${amount}. Dipakai nominal JOB REG`);
            }
            if (b.open && b.type === "in_invoice" && paid > 0) {
              stats.v1_belum_bayar_jobreg_lunas++;
              note(it.job_number, b.number, `Di v1 masih ${b.status}, tapi JOB REG mencatat sudah dibayar ${paid}`);
            }
          }
          picked.push(...found.splice(0));
        } else missing.push({ it, job });
      }
      let moveId = prior?.id ?? null;
      if (picked.length) {
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
          return;
        }
        moveId = await mergeDocs(b, group);
        done.set(b.number, { id: moveId, number: b.number, legacy_number: b.number, state: "posted" });
      }
      for (const { it, job } of missing) {
        const hasDoc = billed.has(`${b.type}|${b.phase}|${job.id}`);
        if (hasDoc) {
          if (!prior) { stats.job_tidak_ketemu++; note(it.job_number, b.number, "Fase ini sudah ada di dokumen lain, tidak dibuat dua kali"); }
          continue;
        }
        if (!b.open) {
          if (b.type === "in_invoice" && b.phase === "FULL" && !b.virtual) fullLeftovers.push({ b, it, job });
          else if (!prior) { stats.job_tidak_ketemu++; note(it.job_number, b.number, `Di v1 sudah dibayar ${Number(it.request_amount || 0)}, tapi JOB REG tidak mencatatnya. Tidak dibuatkan dokumen, perlu dicek finance`); }
          continue;
        }
        const amount = await openAmount(b, it, job, !!prior);
        if (!(amount > 0)) continue;
        if (b.type === "out_invoice" && moveId) {
          const [own] = await t.query("select partner_id from account_move where id = $1", [moveId]);
          if (own.partner_id !== job.customer_id) {
            stats.customer_beda++;
            if (!prior) note(it.job_number, b.number, "Customer job beda dengan customer dokumen batch ini, tidak ditambahkan");
            continue;
          }
        }
        if (!moveId) {
          if ((await t.query("select 1 from account_move where number = $1", [b.number])).length) {
            stats.nomor_sudah_dipakai++;
            note(it.job_number, b.number, "Nomor batch sudah dipakai dokumen lain, dokumen tidak dibuat");
            return;
          }
          moveId = await newDoc(b, job.customer_id);
          done.set(b.number, { id: moveId, number: b.number, legacy_number: b.number, state: "posted" });
        }
        await addLines(moveId, b, job, amount);
      }
      if (moveId) await followV1(moveId, b);
    }

    for (const b of batches) await processBatch(b);

    // Batch FULL v1 yang di JOB REG tercatat di kolom 70%: dibiarkan fase DP supaya uang tidak berubah, tapi tetap dikumpulkan dengan nomor batch + /DP.
    const byBatch = new Map();
    for (const x of fullLeftovers) { if (!byBatch.has(x.b.number)) byBatch.set(x.b.number, { b: x.b, list: [] }); byBatch.get(x.b.number).list.push(x); }
    for (const { b, list } of byBatch.values()) {
      const number = `${b.number}/DP`;
      const already = formedBefore.has(number);
      const items = [];
      for (const { it, job } of list) {
        const d = pool.get(`in_invoice|DP|${it.job_number}`);
        if (d?.length === 1 && Math.abs(Number(d[0].amount) - Number(it.request_amount)) <= 1) items.push(it);
        else if (!already && !formedBefore.has(b.number)) { stats.job_tidak_ketemu++; note(it.job_number, b.number, `Di v1 sudah dibayar ${Number(it.request_amount || 0)}, tapi JOB REG tidak mencatat nominal yang sama. Tidak dibuatkan dokumen, perlu dicek finance`); }
      }
      if (!items.length || already) continue;
      stats.full_di_jobreg_dp += items.length;
      for (const it of items) note(it.job_number, b.number, `Di v1 pengajuan FULL, di JOB REG tercatat di kolom 70%. Dikumpulkan sebagai ${number}, fase tetap DP`);
      await processBatch({ ...b, number, phase: "DP", items, virtual: true, batchNote: `${b.number} (FULL di v1)` });
    }

    const after = await moneyPrint(t, newLineIds);
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

// Cek harga jual: job yang selling trucking-nya beda dari price book pada TANGGAL JOB, dan menyamakannya sekaligus.
//
// Latar: harga berubah per tanggal tertentu (mis. mulai 15 Oktober 15.000.000 -> 14.500.000). Finance mencatatnya di
// Master Data > Price Book (kolom "Berlaku dari"). Job yang sudah telanjur dibuat dengan harga lama TIDAK berubah sendiri
// (perubahan price book tidak boleh diam-diam mengubah job); halaman ini menampilkan job yang beda dan menyamakannya
// dengan satu tindakan yang tercatat di audit.
import express from "express";
import { requireRole, ROLES } from "../lib/auth.js";
import { route, fail, audit, rupiah } from "../lib/util.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Aturan pilih harga sama dengan findPrice (routes/master.js): harga khusus customer dulu, lalu harga umum;
// hanya yang berlaku pada tanggal job; "berlaku dari" paling baru menang.
export async function priceMismatch(q, { from, to, customer_id, job_ids } = {}) {
  // job berharga 0 (harga belum diketahui saat job dibuat / diimpor) ikut tampil: begitu price book diisi, tinggal disamakan
  const where = ["j.state <> 'cancelled'", "pb.selling <> s.amount"];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (DATE.test(from || "")) add("j.job_date >= ?", from);
  if (DATE.test(to || "")) add("j.job_date <= ?", to);
  if (customer_id) add("j.customer_id = ?", Number(customer_id));
  if (job_ids) add("j.id = any(?::int[])", job_ids.map(Number));
  const rows = await q.query(
    `select distinct on (j.id)
            j.id as job_id, j.job_number, j.job_date, j.customer_id, c.name as customer, lp.code as pol, ld.code as pod,
            j.trip_type, j.truck_type, j.selling_mode, j.selling_after_tax, j.customer_scheme,
            s.job_line_id, s.amount as selling, s.billed, s.paid,
            pb.id as pricelist_id, pb.selling as book, pb.effective_from, pb.effective_to, pb.customer_id is not null as khusus
     from job j
     join res_partner c on c.id = j.customer_id
     join location lp on lp.id = j.pol_id
     join location ld on ld.id = j.pod_id
     join v_job_line_status s on s.job_id = j.id and s.side = 'SALE' and s.kind = 'TRUCKING'
     join lateral (
       select pi.* from pricelist_item pi
       where pi.active and pi.selling is not null
         and pi.pol_id = j.pol_id and pi.pod_id = j.pod_id and upper(pi.truck_type) = upper(j.truck_type) and pi.trip_type = j.trip_type
         and (pi.customer_id = j.customer_id or pi.customer_id is null)
         and (pi.effective_from is null or pi.effective_from <= j.job_date)
         and (pi.effective_to is null or pi.effective_to >= j.job_date)
       order by pi.customer_id is null, pi.effective_from desc nulls last
       limit 1
     ) pb on true
     where ${where.join(" and ")}
     order by j.id, s.job_line_id`, params);
  for (const r of rows) {
    r.selisih = r.book - r.selling;
    // harga tidak boleh turun di bawah yang sudah ditagih (aturan yang sama dengan edit job)
    r.blocked = r.book < r.billed - 0.004;
    r.keterangan = r.blocked
      ? `Sudah ditagih ${rupiah(r.billed)}, lebih besar dari harga price book. Batalkan / koreksi invoicenya dulu.`
      : [r.billed > 0 ? `Sudah ditagih ${rupiah(r.billed)}; sisanya menyesuaikan di tagihan berikutnya` : "",
         r.selling_after_tax != null ? "Selling setelah pajak diisi manual, akan dihitung ulang dari pajak customer" : ""].filter(Boolean).join(". ");
  }
  return rows.sort((a, b) => String(b.job_date).localeCompare(String(a.job_date)) || b.job_id - a.job_id);
}

export default function priceCheckRoutes(db) {
  const r = express.Router();

  r.get("/price-check", requireRole(ROLES.READ), route((req) => priceMismatch(db, req.query)));

  // Samakan selling job dengan price book. Per job: dikunci dulu, harga dicek ulang, yang tidak bisa dilewati dengan alasannya.
  r.post("/price-check/apply", requireRole(ROLES.FINANCE), route((req) => db.tx(async (t) => {
    const ids = [...new Set((Array.isArray(req.body?.job_ids) ? req.body.job_ids : []).map(Number).filter(Boolean))];
    const reason = String(req.body?.reason || "").trim();
    if (!ids.length) fail("Pilih minimal 1 job");
    if (!reason) fail("Alasan wajib diisi (mis. harga baru per 15 Oktober)");
    // kunci job + baris ordernya: tidak bisa bertabrakan dengan edit job atau posting invoice job yang sama
    await t.query("select id from job where id = any($1::int[]) order by id for update", [ids]);
    await t.query("select id from job_line where job_id = any($1::int[]) order by id for update", [ids]);
    const rows = await priceMismatch(t, { job_ids: ids });
    const updated = [], skipped = [];
    for (const x of rows) {
      if (x.blocked) { skipped.push({ job_number: x.job_number, alasan: x.keterangan }); continue; }
      await t.query("update job_line set amount = $1 where id = $2", [x.book, x.job_line_id]);
      await t.query("update job set selling_mode = 'PRICE_BOOK', selling_after_tax = null, updated_at = now() where id = $1", [x.job_id]);
      await audit(t, req, "job", x.job_id, "reprice", {
        dari: x.selling, ke: x.book, alasan: reason, price_book_id: x.pricelist_id, berlaku_dari: x.effective_from,
        ...(x.selling_after_tax != null ? { selling_setelah_pajak_lama: x.selling_after_tax } : {}) });
      updated.push(x.job_number);
    }
    return { updated: updated.length, jobs: updated, skipped, unchanged: ids.length - rows.length };
  })));

  return r;
}

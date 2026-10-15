// Tes ujung-ke-ujung lewat HTTP di database PostgreSQL tertanam (memori). Data asli tidak tersentuh.
//   npm test
import assert from "node:assert/strict";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { hashPassword } from "../lib/auth.js";
import { createApp } from "../server.js";
const tgl = (v) => (v ? String(v).slice(0, 10) : "");

const db = await openDb({ memory: true });
await migrate(db, { log: () => {} });
for (const [u, role] of [["admin", "ADMIN"], ["fin", "FINANCE"], ["ops", "OPERATIONAL"], ["viewer", "VIEWER"]]) {
  await db.query("insert into app_user (username, display_name, role, password_hash) values ($1, $1, $2, $3)", [u, role, hashPassword("rahasia123")]);
}
const app = await createApp(db);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

function client() {
  let cookie = "";
  const call = async (method, url, body, expect = "ok") => {
    const res = await fetch(base + url, {
      method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.arrayBuffer();
    if (expect === "ok") assert.ok(res.ok, `${method} ${url} -> ${res.status} ${data.error || ""}`);
    else assert.equal(res.status, expect, `${method} ${url} seharusnya ${expect}, dapat ${res.status} ${data.error || ""}`);
    return expect === "ok" ? data : data.error;
  };
  return { call, login: (u) => call("POST", "/login", { username: u, password: "rahasia123" }) };
}
const admin = client(), fin = client(), ops = client(), viewer = client(), anon = client();
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log("  ok -", name); };

try {
  await step("login, salah password ditolak, tanpa login ditolak", async () => {
    assert.match(await anon.call("POST", "/login", { username: "admin", password: "salah" }, 401), /salah/);
    assert.match(await anon.call("GET", "/jobs", null, 401), /login/);
    for (const [c, u] of [[admin, "admin"], [fin, "fin"], [ops, "ops"], [viewer, "viewer"]]) await c.login(u);
    assert.equal((await fin.call("GET", "/me")).role, "FINANCE");
  });

  const id = {};
  await step("master data per role", async () => {
    for (const [code, name] of [["JRT", "Jakarta"], ["MES", "Medan"], ["SBY", "Surabaya"], ["CKR", "Cikarang"], ["CKG", "Cakung"]]) {
      id[code] = (await ops.call("POST", "/locations", { code, name })).id;
    }
    assert.match(await ops.call("POST", "/partners", { code: "X", name: "X" }, 403), /akses/);
    const partner = async (code, name, extra) => (await fin.call("POST", "/partners", { code, name, ...extra })).id;
    id.LINTAS = await partner("LINTAS", "LINTAS", { is_customer: true, pph_pct: 2, ppn_pct: 1.1 });
    id.KOTA = await partner("KOTA", "KOTA JAYA", { is_customer: true });
    id.SINAR = await partner("SINAR", "CV Sinar Jaya", { is_vendor: true });
    id.AGUS = await partner("AGUS", "Agus (calo)", { is_vendor: true });
    id.SINAR_BANK = (await ops.call("POST", "/partner-banks", { partner_id: id.SINAR, bank_name: "BCA", account_number: "123", holder: "CV Sinar Jaya", is_default: true })).id;
    id.BCA = (await fin.call("POST", "/banks", { name: "BCA AMICO", bank_name: "BCA", account_number: "001", holder: "PT AMICO", kind: "BANK", is_default: true })).id;
    id.KASOP = (await fin.call("POST", "/banks", { name: "Kas Operasional", bank_name: "BCA", account_number: "009", holder: "Ops", kind: "OPERATIONAL" })).id;
    await fin.call("POST", "/pricelist", { pol_id: id.JRT, pod_id: id.MES, truck_type: "CDDL", trip_type: "ROUND_TRIP", selling: 19500000, cost: 18000000 });
    await fin.call("POST", "/pricelist", { pol_id: id.JRT, pod_id: id.SBY, truck_type: "CDDL", trip_type: "ONE_WAY", selling: 8500000, cost: 7600000 });
    await fin.call("POST", "/pricelist", { customer_id: id.KOTA, pol_id: id.CKR, pod_id: id.CKG, truck_type: "CDDL", trip_type: "ONE_WAY", selling: 2000000, cost: 1700000 });
    await ops.call("POST", "/route-sla", { pol_id: id.JRT, pod_id: id.MES, trip_type: "ROUND_TRIP", sla_hours: 120 });
    await ops.call("POST", "/vehicles", { plate_number: "b 9123 abc", truck_type: "CDDL", owner_partner_id: id.SINAR });
    // aturan "tagihan perlu kode tugas + gate out" diuji tersendiri di langkah job rencana
    await admin.call("PUT", "/settings", { require_gate_for_billing: false });
  });

  const job = (c, extra, expect = "ok") => c.call("POST", "/jobs", {
    job_date: "2026-09-14", customer_id: id.LINTAS, vendor_id: id.SINAR, vendor_bank_id: id.SINAR_BANK, pol_id: id.JRT, pod_id: id.MES,
    trip_type: "ROUND_TRIP", truck_type: "CDDL", plate_number: "b 9123 abc", driver1_name: "Budi", ...extra }, expect);
  const line = async (jobId, side, kind) => (await fin.call("GET", `/jobs/${jobId}`)).lines.find((l) => l.side === side && l.kind === kind).job_line_id;
  const createMove = (body, c = fin) => c.call("POST", "/moves", { post: true, ...body });

  let J1, J2;
  await step("job: dibuat OPERATIONAL dari price book, VIEWER ditolak, skema dari dalam kota", async () => {
    assert.match(await viewer.call("POST", "/jobs", {}, 403), /akses/);
    J1 = await job(ops);
    assert.equal(J1.job_number, "AMC/2609/0001");
    const d = await fin.call("GET", `/jobs/${J1.id}`);
    assert.deepEqual([d.balance.selling, d.balance.cost, d.job.plate_number, d.job.customer_scheme], [19500000, 18000000, "B 9123 ABC", "70_30"]);
    assert.match(await job(ops, { pod_id: id.SBY, trip_type: "ROUND_TRIP" }, 400), /Price book/);
    J2 = await ops.call("POST", "/jobs", { job_date: "2026-09-20", customer_id: id.KOTA, vendor_id: id.SINAR, pol_id: id.CKR, pod_id: id.CKG,
      truck_type: "CDDL", delivery_scope: "INNERCITY", rit_number: 1 });
    const d2 = await fin.call("GET", `/jobs/${J2.id}`);
    assert.deepEqual([d2.job.customer_scheme, d2.balance.selling], ["FULL", 2000000]);
  });

  const P1 = await line(J1.id, "PURCHASE", "TRUCKING");
  let dpV, stlV;
  await step("pengajuan DP vendor: posting -> menunggu ADMIN -> FINANCE tidak bisa setuju -> ADMIN setuju -> bayar", async () => {
    const el = await fin.call("GET", "/moves/eligible?move_type=in_invoice&phase=DP");
    assert.equal(el.find((e) => e.job_line_id === P1).suggested, 12600000);
    dpV = await createMove({ move_type: "in_invoice", phase: "DP", move_date: "2026-09-15", lines: [{ job_id: J1.id, amount: 12600000 }] });
    assert.deepEqual([dpV.number, dpV.approval_state, dpV.lines[0].payee_holder], ["REQ/2026/0001", "PENDING", "CV Sinar Jaya"]);
    assert.match(await fin.call("POST", `/moves/${dpV.id}/pay`, { bank_account_id: id.BCA }, 400), /belum disetujui/);
    assert.match(await fin.call("POST", `/moves/${dpV.id}/approve`, {}, 403), /akses/);
    await admin.call("POST", `/moves/${dpV.id}/approve`, {});
    dpV = await fin.call("POST", `/moves/${dpV.id}/pay`, { bank_account_id: id.BCA, pay_date: "2026-09-16" });
    assert.equal(dpV.amount_residual, 0);
  });

  await step("DP melebihi 70% cost ditolak, pelunasan melebihi sisa ditolak", async () => {
    assert.match(await fin.call("POST", "/moves", { move_type: "in_invoice", phase: "DP", lines: [{ job_id: J1.id, amount: 100 }] }, 400), /melebihi 70% cost/);
    assert.match(await fin.call("POST", "/moves", { move_type: "in_invoice", phase: "SETTLEMENT", lines: [{ job_id: J1.id, amount: 5400001 }] }, 400), /melebihi sisa/);
  });

  await step("invoice DP customer + dibayar; pelunasan vendor dibayar", async () => {
    const inv = await createMove({ move_type: "out_invoice", phase: "DP", move_date: "2026-09-15", bank_account_id: id.BCA, lines: [{ job_id: J1.id, amount: 13650000 }] });
    assert.equal(inv.approval_state, "NOT_REQUIRED");
    await fin.call("POST", `/moves/${inv.id}/pay`, { pay_date: "2026-09-17" });
    stlV = await createMove({ move_type: "in_invoice", phase: "SETTLEMENT", move_date: "2026-09-21", lines: [{ job_id: J1.id, amount: 5400000 }] });
    await admin.call("POST", `/moves/${stlV.id}/approve`, {});
    await fin.call("POST", `/moves/${stlV.id}/pay`, { bank_account_id: id.BCA, pay_date: "2026-09-21" });
  });

  await step("calo 75rb salah -> balik bayar -> batal (wajib alasan) -> koreksi 50rb", async () => {
    await fin.call("POST", `/jobs/${J1.id}/lines`, { kind: "CALO", partner_id: id.AGUS, amount: 75000, description: "Calo pelabuhan" });
    const C1 = await line(J1.id, "PURCHASE", "CALO");
    assert.match(await fin.call("POST", "/moves", { move_type: "in_invoice", phase: "SETTLEMENT", lines: [{ job_id: J1.id, job_line_id: C1, amount: 75000 }] }, 400), /Calo \/ biaya lain/);
    let calo = await createMove({ move_type: "in_invoice", phase: "OTHER", move_date: "2026-09-22", lines: [{ job_id: J1.id, job_line_id: C1, amount: 75000 }] });
    await admin.call("POST", `/moves/${calo.id}/approve`, {});
    calo = await fin.call("POST", `/moves/${calo.id}/pay`, { bank_account_id: id.BCA, pay_date: "2026-09-22" });
    assert.match(await fin.call("POST", `/moves/${calo.id}/cancel`, { reason: "x" }, 400), /Balik dulu/);
    assert.match(await fin.call("POST", `/payments/${calo.payments[0].id}/reverse`, {}, 400), /Alasan/);
    await fin.call("POST", `/payments/${calo.payments[0].id}/reverse`, { reason: "salah ketik", pay_date: "2026-09-22" });
    assert.match(await fin.call("POST", `/moves/${calo.id}/cancel`, {}, 400), /Alasan/);
    await fin.call("POST", `/moves/${calo.id}/cancel`, { reason: "salah nominal" });
    await fin.call("PUT", `/job-lines/${C1}`, { amount: 50000 });
    const again = await createMove({ move_type: "in_invoice", phase: "OTHER", move_date: "2026-09-22", lines: [{ job_id: J1.id, job_line_id: C1, amount: 50000 }] });
    await admin.call("POST", `/moves/${again.id}/approve`, {});
    await fin.call("POST", `/moves/${again.id}/pay`, { bank_account_id: id.BCA, pay_date: "2026-09-22" });
  });

  await step("cost / selling tidak bisa diturunkan di bawah yang sudah diajukan", async () => {
    assert.match(await fin.call("PUT", `/jobs/${J1.id}`, { selling_mode: "CUSTOM", selling: 19500000, cost: 17000000 }, 400), /lebih kecil/);
  });

  await step("pelunasan customer = selling setelah pajak - DP, info pajak invoice, dicicil 2x", async () => {
    const el = await fin.call("GET", `/moves/eligible?move_type=out_invoice&phase=SETTLEMENT&partner_id=${id.LINTAS}`);
    assert.equal(el.find((e) => e.job_id === J1.id).suggested, 5674500);
    let inv = await createMove({ move_type: "out_invoice", phase: "SETTLEMENT", move_date: "2026-09-22", bank_account_id: id.BCA, lines: [{ job_id: J1.id, amount: 5674500 }] });
    assert.deepEqual([inv.tax_basis, inv.ppn_amount, inv.pph23_amount, inv.bill_to_name], [19500000, 214500, 390000, "LINTAS"]);
    await fin.call("POST", `/moves/${inv.id}/pay`, { amount: 674500, pay_date: "2026-09-30" });
    inv = await fin.call("POST", `/moves/${inv.id}/pay`, { pay_date: "2026-10-02" });
    assert.deepEqual([inv.amount_residual, inv.payments.length], [0, 2]);
  });

  await step("job FULL: DP ditolak, FULL boleh", async () => {
    assert.match(await fin.call("POST", "/moves", { move_type: "out_invoice", phase: "DP", lines: [{ job_id: J2.id, amount: 1000 }] }, 400), /tidak cocok|skema customer 100%/);
    const b = await createMove({ move_type: "in_invoice", phase: "FULL", move_date: "2026-09-23", lines: [{ job_id: J2.id, amount: 1700000 }] });
    await admin.call("POST", `/moves/${b.id}/approve`, {});
    await fin.call("POST", `/moves/${b.id}/pay`, { bank_account_id: id.BCA, pay_date: "2026-09-23" });
    const i = await createMove({ move_type: "out_invoice", phase: "FULL", move_date: "2026-09-23", bank_account_id: id.BCA, lines: [{ job_id: J2.id, amount: 2000000 }] });
    await fin.call("POST", `/moves/${i.id}/pay`, { pay_date: "2026-09-24" });
  });

  await step("UTANG PIUTANG + jurnal kas", async () => {
    const up = await viewer.call("GET", "/utang-piutang");
    const a = up.find((x) => x.job_id === J1.id), b = up.find((x) => x.job_id === J2.id);
    assert.deepEqual(
      ["utang_70", "utang_70_terbayar", "utang_30_belum_bayar", "utang_30_terbayar", "piutang_70_terbayar", "piutang_30_terbayar", "piutang_30_belum_tertagih", "calo_lain_terbayar"].map((k) => a[k]),
      [0, 12600000, 0, 5450000, 13650000, 5674500, 0, 50000]);
    assert.deepEqual(["utang_100", "utang_100_terbayar", "piutang_100_terbayar"].map((k) => b[k]), [0, 1700000, 2000000]);
    const d = await viewer.call("GET", `/jobs/${J1.id}`);
    const sum = (arah) => d.ledger.filter((l) => l.arah === arah).reduce((s, l) => s + l.nominal, 0);
    assert.equal(sum("MASUK") - sum("KELUAR"), 19324500 - 18050000);
    assert.ok(d.ledger.some((l) => l.nominal === -75000 && l.membalik));
  });

  await step("kurang transfer: DP kurang 20rb + pelunasan kurang 30rb", async () => {
    const J3 = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-10-01" });
    const pay = async (phase, amount) => {
      const m = await createMove({ move_type: "in_invoice", phase, lines: [{ job_id: J3.id, amount }] });
      await admin.call("POST", `/moves/${m.id}/approve`, {});
      await fin.call("POST", `/moves/${m.id}/pay`, { bank_account_id: id.BCA });
    };
    await pay("DP", 5300000);
    await pay("SETTLEMENT", 2250000);
    const k = (await viewer.call("GET", "/kurang-transfer")).filter((r) => r.job_id === J3.id);
    assert.deepEqual(k.map((r) => [r.side, r.dp_kurang, r.pelunasan_kurang, r.kurang, r.selisih_kas]), [["PURCHASE", 20000, 30000, 50000, 50000]]);
    const list = await viewer.call("GET", "/jobs?state=kurang_transfer");
    assert.deepEqual(list.map((r) => r.job_number), [J3.job_number]);
  });

  await step("transfer malam: kirim dana ke kas operasional -> salurkan sebagian -> sisa dikembalikan", async () => {
    const J4 = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-10-02" });
    let m = await createMove({ move_type: "in_invoice", phase: "DP", payment_channel: "TRANSFER_MALAM", lines: [{ job_id: J4.id, amount: 5320000 }] });
    await admin.call("POST", `/moves/${m.id}/approve`, {});
    assert.match(await fin.call("POST", `/moves/${m.id}/pay`, { bank_account_id: id.BCA }, 400), /kas operasional/);
    assert.match(await fin.call("POST", `/moves/${m.id}/pay`, { bank_account_id: id.KASOP }, 400), /Kirim dana dulu/);
    m = await fin.call("POST", `/moves/${m.id}/fund`, { from_account_id: id.BCA, to_account_id: id.KASOP });
    assert.equal(m.titipan, 5320000);
    assert.equal((await viewer.call("GET", "/titipan")).find((x) => x.move_id === m.id).titipan, 5320000);
    m = await fin.call("POST", `/moves/${m.id}/pay`, { bank_account_id: id.KASOP, amount: 5000000 });
    assert.deepEqual([m.titipan, m.amount_residual], [320000, 320000]);
    m = await fin.call("POST", `/moves/${m.id}/return-fund`, { note: "sisa tidak jadi disalurkan" });
    assert.equal(m.titipan, 0);
    const bal = await viewer.call("GET", "/bank-balance");
    const kas = bal.find((x) => x.bank_account_id === id.KASOP);
    assert.deepEqual([kas.transfer_masuk, kas.transfer_keluar, kas.dibayar_ke_vendor, kas.mutasi_bersih], [5320000, 320000, 5000000, 0]);
    // sisa 320rb pengajuan: batalkan barisnya tidak bisa (sudah dibayar sebagian), jadi tetap "diajukan belum dibayar"
    assert.equal((await viewer.call("GET", `/moves/${m.id}`)).amount_residual, 320000);
  });

  await step("batal per baris: satu job di batch dibatalkan, job lain tetap", async () => {
    const A = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-10-03" });
    const B = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-10-03" });
    let m = await createMove({ move_type: "in_invoice", phase: "DP", lines: [{ job_id: A.id, amount: 5320000 }, { job_id: B.id, amount: 5320000 }] });
    const lineB = m.lines.find((l) => l.job_id === B.id).id;
    m = await fin.call("POST", `/move-lines/${lineB}/cancel`, { reason: "job B batal berangkat" });
    assert.deepEqual([m.state, m.amount_total], ["posted", 5320000]);
    const again = await createMove({ move_type: "in_invoice", phase: "DP", lines: [{ job_id: B.id, amount: 5320000 }] });
    assert.equal(again.amount_total, 5320000, "job B bisa diajukan lagi");
  });

  await step("top-up cost (wajib alasan, tercatat di audit)", async () => {
    assert.match(await ops.call("POST", `/jobs/${J1.id}/topup`, { amount: 500000 }, 400), /Alasan/);
    await ops.call("POST", `/jobs/${J1.id}/topup`, { amount: 500000, reason: "Tambahan inap 1 malam" });
    const d = await viewer.call("GET", `/jobs/${J1.id}`);
    assert.equal(d.balance.cost_trucking, 18500000);
    assert.ok(d.audit.some((a) => a.action === "topup" && a.detail.reason === "Tambahan inap 1 malam"));
    // sisa top-up bisa diajukan
    const el = await fin.call("GET", `/moves/eligible?move_type=in_invoice&phase=SETTLEMENT&job_ids=${J1.id}`);
    assert.equal(el[0].remaining, 500000);
  });

  await step("tracker: gate out -> dalam perjalanan + update posisi -> gate in -> selesai", async () => {
    await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_out_at: "2026-09-14T08:00:00+07:00" });
    await ops.call("POST", `/jobs/${J1.id}/trip-updates`, { location: "Lampung", note: "istirahat" });
    let t = (await viewer.call("GET", "/tracker?search=9123")).find((x) => x.job_id === J1.id);
    assert.deepEqual([t.trip_status, t.posisi_terakhir, t.sla_hours], ["DALAM PERJALANAN", "Lampung", 120]);
    assert.match(await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_in_at: "2026-09-13T08:00:00+07:00", gate_out_at: "2026-09-14T08:00:00+07:00" }, 400), /Gate in/);
    await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_in_at: "2026-09-18T20:00:00+07:00", sj_number: "SJ-001" });
    t = (await viewer.call("GET", "/tracker?status=SELESAI")).find((x) => x.job_id === J1.id);
    assert.deepEqual([t.durasi_jam, t.lewat_sla], [108, false]);
    assert.equal((await viewer.call("GET", `/jobs/${J1.id}`)).job.state, "done");
  });

  await step("tanggal job salah ketik (tahun 2926, tanggal tidak ada) ditolak saat buat & ubah job", async () => {
    const base = { customer_id: id.LINTAS, pol_id: id.JRT, pod_id: id.MES, trip_type: "ROUND_TRIP", truck_type: "CDDL" };
    assert.match(await ops.call("POST", "/jobs", { ...base, job_date: "2926-07-31" }, 400), /terlalu jauh di depan/);
    assert.match(await ops.call("POST", "/jobs", { ...base, job_date: "1926-07-31" }, 400), /terlalu lama/);
    assert.match(await ops.call("POST", "/jobs", { ...base, job_date: "2026-02-31" }, 400), /tidak terbaca/);
    assert.match(await ops.call("PUT", `/jobs/${J1.id}`, { job_date: "2926-09-12" }, 400), /terlalu jauh di depan/);
    assert.equal((await viewer.call("GET", `/jobs/${J1.id}`)).job.job_number, J1.job_number);
  });

  await step("dua orang mengedit job yang sama: form yang sudah basi ditolak, isi gate tidak dianggap bentrok", async () => {
    const load = async (c) => (await c.call("GET", `/jobs/${J1.id}`)).job;
    const a = await load(ops), b = await load(fin);            // dua orang membuka form edit bersamaan
    assert.equal(a.version, b.version);
    await fin.call("PUT", `/jobs/${J1.id}`, { driver2_name: "Kernet Baru", expected_version: b.version });
    // orang pertama menyimpan form lama (driver2 masih kosong): ditolak, perubahan orang kedua tidak tertimpa
    assert.match(await ops.call("PUT", `/jobs/${J1.id}`, { driver2_name: "", note: "catatan", expected_version: a.version }, 409), /sudah diubah oleh fin/);
    let now = await load(ops);
    assert.deepEqual([now.driver2_name, now.note], ["Kernet Baru", null]);
    // gate / SJ bukan bagian form: mengisinya tidak membuat form orang lain jadi basi
    await ops.call("PUT", `/jobs/${J1.id}/trip`, { sj_number: "SJ-001" });
    assert.equal((await load(ops)).version, now.version);
    // top-up cost oleh orang lain = bentrok (form lama akan mengembalikan cost lama)
    await fin.call("POST", `/jobs/${J1.id}/topup`, { amount: 1000, reason: "tes bentrok" });
    assert.match(await ops.call("PUT", `/jobs/${J1.id}`, { note: "x", expected_version: now.version }, 409), /sudah diubah/);
    now = await load(ops);
    await ops.call("PUT", `/jobs/${J1.id}`, { driver2_name: "", expected_version: now.version });
    assert.equal((await load(ops)).driver2_name, null);
  });

  await step("kode tugas unik: satu kode tugas satu job (huruf besar/kecil & spasi diabaikan), job batal dan isian kosong tidak dihitung", async () => {
    const base = { job_date: "2026-10-01", customer_id: id.LINTAS, pol_id: id.JRT, pod_id: id.SBY, trip_type: "ONE_WAY", truck_type: "CDDL", selling_mode: "CUSTOM", selling: 1000000, cost: 900000 };
    const A = await ops.call("POST", "/jobs", { ...base, do_number: "KTU-0001" });
    assert.match(await ops.call("POST", "/jobs", { ...base, do_number: " ktu-0001 " }, 400), new RegExp(`dipakai ${A.job_number}`));
    // isian "tidak ada" / kosong boleh berulang
    await ops.call("POST", "/jobs", { ...base, do_number: "TIDAK ADA KODE TUGAS" });
    await ops.call("POST", "/jobs", { ...base, do_number: "TIDAK ADA KODE TUGAS" });
    await ops.call("POST", "/jobs", { ...base, do_number: "TIDAK JADI JALAN" });
    await ops.call("POST", "/jobs", { ...base, do_number: "tidak jadi jalan" });
    const B = await ops.call("POST", "/jobs", { ...base });
    // ganti kode tugas ke yang sudah dipakai ditolak
    let v = (await ops.call("GET", `/jobs/${B.id}`)).job.version;
    assert.match(await ops.call("PUT", `/jobs/${B.id}`, { do_number: "ktu -0001", expected_version: v }, 400), /sudah dipakai/);
    // job batal: kodenya boleh dipakai job pengganti; job batal itu tidak bisa dibuka lagi selama kodenya dipakai
    await ops.call("POST", `/jobs/${A.id}/state`, { state: "cancelled", reason: "tidak jadi muat" });
    v = (await ops.call("GET", `/jobs/${B.id}`)).job.version;
    await ops.call("PUT", `/jobs/${B.id}`, { do_number: "KTU-0001", expected_version: v });
    assert.match(await ops.call("POST", `/jobs/${A.id}/state`, { state: "confirmed" }, 400), /sudah dipakai/);
    // data lama yang terlanjur dobel (mis. dari impor) tampil di daftar untuk dibetulkan, dan tetap bisa diedit
    await db.query("update job set do_number = 'KTU-0001' where id = $1", [A.id]);
    await db.query("update job set state = 'confirmed' where id = $1", [A.id]);
    const dup = (await viewer.call("GET", "/jobs/duplicate-do")).find((x) => x.kode_tugas === "KTU-0001");
    assert.deepEqual(dup.jobs.map((x) => x.id).sort(), [A.id, B.id].sort());
    v = (await ops.call("GET", `/jobs/${A.id}`)).job.version;
    await ops.call("PUT", `/jobs/${A.id}`, { note: "edit lain tetap bisa", expected_version: v });
    v = (await ops.call("GET", `/jobs/${A.id}`)).job.version;
    await ops.call("PUT", `/jobs/${A.id}`, { do_number: "KTU-0002", expected_version: v });
    assert.equal((await viewer.call("GET", "/jobs/duplicate-do")).some((x) => x.kode_tugas === "KTU-0001"), false);
  });

  await step("gate diisi dari daftar job: satu per satu, dicek terhadap yang tersimpan, salah ketik tahun ditolak, durasi & SLA di daftar", async () => {
    const row = async () => (await viewer.call("POST", "/jobs/query", { numbers: [J1.job_number] }))[0];
    let r = await row();
    assert.deepEqual([r.durasi_jam, r.sla_hours, r.lewat_sla, r.stage !== "JALAN"], [108, 120, false, true]);
    assert.match(await viewer.call("PUT", `/jobs/${J1.id}/trip`, { gate_in_at: null }, 403), /akses/);
    // hanya gate in yang dikirim: tetap dibandingkan dengan gate out yang sudah tersimpan
    assert.match(await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_in_at: "2026-09-13T08:00:00+07:00" }, 400), /sebelum gate out/);
    assert.match(await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_in_at: "2926-09-18T20:00:00+07:00" }, 400), /masa depan/);
    assert.match(await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_out_at: "2025-09-14T08:00:00+07:00" }, 400), /jauh sebelum tanggal job/);
    assert.match(await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_out_at: null }, 400), /Hapus gate in dulu/);
    // gate in dihapus -> trip jalan lagi; diisi ulang -> selesai. Isian SJ saja tidak mengubah status trip.
    await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_in_at: null });
    r = await row();
    assert.deepEqual([r.state, r.stage, r.gate_in_at], ["confirmed", "JALAN", null]);
    assert.ok(r.durasi_jam > 108 && r.lewat_sla === true);          // masih jalan sejak 14 Sep -> sudah lewat SLA 120 jam
    await ops.call("PUT", `/jobs/${J1.id}/trip`, { sj_number: "SJ-001" });
    assert.equal((await row()).state, "confirmed");
    await ops.call("PUT", `/jobs/${J1.id}/trip`, { gate_in_at: "2026-09-18T20:00:00+07:00" });
    r = await row();
    assert.deepEqual([r.state, r.durasi_jam, r.lewat_sla], ["done", 108, false]);
  });

  let J50, REQ50;
  await step("skema 50/50 customer (dari setting customer), vendor tetap 70/30", async () => {
    id.CINTA = (await fin.call("POST", "/partners", { code: "CINTA", name: "CINTA", is_customer: true, payment_scheme: "50_50" })).id;
    J50 = await job(ops, { customer_id: id.CINTA, pod_id: id.SBY, trip_type: "ONE_WAY" });
    const d = await fin.call("GET", `/jobs/${J50.id}`);
    assert.deepEqual([d.job.customer_scheme, d.job.vendor_scheme, d.balance.selling, d.balance.cost], ["50_50", "70_30", 8500000, 7600000]);
    let el = await fin.call("GET", `/moves/eligible?move_type=out_invoice&phase=DP&job_ids=${J50.id}`);
    assert.equal(el[0].suggested, 4250000);
    el = await fin.call("GET", `/moves/eligible?move_type=in_invoice&phase=DP&job_ids=${J50.id}`);
    assert.equal(el[0].suggested, 5320000);
    assert.match(await fin.call("POST", "/moves", { move_type: "out_invoice", phase: "FULL", lines: [{ job_id: J50.id, amount: 1000 }] }, 400),
      /skema customer 50\/50, tidak bisa FULL/);
    await createMove({ move_type: "out_invoice", phase: "DP", bank_account_id: id.BCA, lines: [{ job_id: J50.id, amount: 4250000 }] });
    el = await fin.call("GET", `/moves/eligible?move_type=out_invoice&phase=SETTLEMENT&job_ids=${J50.id}`);
    assert.equal(el[0].suggested, 4250000);
    const pos = (await fin.call("GET", `/jobs/${J50.id}`)).position;
    assert.deepEqual(pos.filter((p) => p.side === "SALE").map((p) => [p.phase, p.planned, p.billed]), [["DP", 4250000, 4250000], ["SETTLEMENT", 4250000, 0]]);
    assert.deepEqual(pos.filter((p) => p.side === "PURCHASE").map((p) => [p.phase, p.planned]), [["DP", 5320000], ["SETTLEMENT", 2280000]]);
    assert.match(await ops.call("PUT", `/jobs/${J50.id}`, { customer_scheme: "70_30" }, 400), /sudah ditagih/);
    assert.match(await ops.call("PUT", `/jobs/${J50.id}`, { vendor_scheme: "50_50" }, 400), /70\/30 atau 100%/);
    REQ50 = await createMove({ move_type: "in_invoice", phase: "DP", lines: [{ job_id: J50.id, amount: 5320000 }] });
    await admin.call("POST", `/moves/${REQ50.id}/approve`, {});
    await fin.call("POST", `/moves/${REQ50.id}/pay`, { bank_account_id: id.BCA });
  });

  await step("selisih tanpa tujuan: tidak menambah cost job, diarahkan / jadi saldo partner / dibatalkan", async () => {
    // baris tanpa tujuan hanya lahir dari impor; di sini ditiru langsung di database
    const loose = async (moveId, amount) => (await db.query(
      "insert into account_move_line (move_id, line_no, job_line_id, job_id, amount, description) values ($1, 99, null, $2, $3, 'Selisih tanpa tujuan (tes)') returning id",
      [moveId, J50.id, amount]))[0].id;
    const L1 = await loose(REQ50.id, 50000);
    await fin.call("POST", `/moves/${REQ50.id}/pay`, { bank_account_id: id.BCA });            // sisa 50.000 = baris tanpa tujuan
    const u = (await viewer.call("GET", "/unassigned")).find((x) => x.move_line_id === L1);
    assert.deepEqual([u.status, u.amount, u.paid, u.selisih_kas], ["OPEN", 50000, 50000, -50000]);   // vendor dibayar lebih = minus
    let d = await fin.call("GET", `/jobs/${J50.id}`);
    assert.deepEqual([d.balance.cost, d.balance.requested, d.balance.paid, d.unassigned.length], [7600000, 5320000, 5320000, 1]);
    assert.ok(d.ledger.some((x) => x.jenis === "TANPA TUJUAN" && x.nominal === 50000));
    assert.equal((await viewer.call("GET", "/dashboard")).totals.tanpa_tujuan_total, 50000);
    const xl = await viewer.call("GET", "/selisih/excel");            // belum ada angka Excel
    assert.deepEqual([xl.info, xl.columns.length], [null, 15]);
    assert.match(await viewer.call("POST", "/selisih/excel", null, 403), /akses/);
    const s = (await viewer.call("GET", "/unassigned")).find((x) => x.move_line_id === L1);
    assert.deepEqual([s.seharusnya, s.dibayar_job], [7600000, 5320000]);

    assert.match(await fin.call("POST", `/unassigned/${L1}/partner-balance`, {}, 400), /wajib/);
    await fin.call("POST", `/unassigned/${L1}/partner-balance`, { reason: "vendor lebih dibayar, dipotong pembayaran berikutnya" });
    assert.deepEqual((await viewer.call("GET", "/partner-balances")).map((x) => [x.side, x.amount]), [["VENDOR", 50000]]);
    assert.equal((await viewer.call("GET", "/unassigned")).filter((x) => x.move_line_id === L1).length, 0);
    await fin.call("POST", `/unassigned/${L1}/reopen`, {});
    assert.match(await ops.call("POST", `/unassigned/${L1}/assign`, { kind: "CALO" }, 403), /akses/);
    await fin.call("POST", `/unassigned/${L1}/assign`, { kind: "CALO", description: "Calo ternyata" });
    d = await fin.call("GET", `/jobs/${J50.id}`);
    const calo = d.lines.find((l) => l.kind === "CALO");
    assert.deepEqual([calo.amount, calo.billed, calo.paid, d.balance.cost, d.unassigned.length], [50000, 50000, 50000, 7650000, 0]);

    // belum dibayar: tidak bisa jadi saldo partner; sisa baris order kurang -> ditolak; dibatalkan saja
    const L2 = await loose(REQ50.id, 3000000);
    assert.match(await fin.call("POST", `/unassigned/${L2}/partner-balance`, { reason: "x" }, 400), /Belum ada pembayaran/);
    const truck = await line(J50.id, "PURCHASE", "TRUCKING");
    assert.match(await fin.call("POST", `/unassigned/${L2}/assign`, { job_line_id: truck }, 400), /Sisa baris order/);
    await fin.call("POST", `/move-lines/${L2}/cancel`, { reason: "salah input" });
    assert.equal((await viewer.call("GET", "/unassigned?status=all")).filter((x) => x.move_line_id === L2).length, 0);
  });

  await step("job rencana -> jalan -> SJ (resi, diterima, dikirim ke customer); tagihan perlu kode tugas + gate out", async () => {
    await admin.call("PUT", "/settings", { require_gate_for_billing: true });
    const JR = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-10-03",
      new_bank_name: "bca", new_account_number: "777 888", new_holder: "Fulan" });
    let d = await fin.call("GET", `/jobs/${JR.id}`);
    const truck = d.lines.find((l) => l.side === "PURCHASE" && l.kind === "TRUCKING");
    assert.deepEqual([truck.holder, truck.account_number, d.status.stage], ["Fulan", "777888", "RENCANA"]);
    // job rencana: DP vendor (operasional) boleh, invoice customer belum boleh
    await createMove({ move_type: "in_invoice", phase: "DP", lines: [{ job_id: JR.id, amount: 5320000 }] });
    assert.match(await fin.call("POST", "/moves", { move_type: "out_invoice", phase: "DP", lines: [{ job_id: JR.id, amount: 5950000 }] }, 400), /kode tugas dan jam gate out/);
    await ops.call("PUT", `/jobs/${JR.id}`, { do_number: "KT-777" });
    await ops.call("PUT", `/jobs/${JR.id}/trip`, { gate_out_at: "2026-10-03T08:00:00+07:00" });
    assert.equal((await fin.call("GET", `/jobs/${JR.id}`)).status.stage, "JALAN");
    await createMove({ move_type: "out_invoice", phase: "DP", bank_account_id: id.BCA, lines: [{ job_id: JR.id, amount: 5950000 }] });
    await ops.call("PUT", `/jobs/${JR.id}/trip`, { gate_in_at: "2026-10-03T20:00:00+07:00" });
    d = await fin.call("GET", `/jobs/${JR.id}`);
    assert.deepEqual([d.status.stage, d.status.sj_status], ["MENUNGGU_SJ", "BELUM_ADA_RESI"]);

    // input massal: resi dari driver, lalu SJ diterima (tanpa buka detail job)
    let res = await ops.call("POST", "/sj/bulk", { mode: "resi", text: `${JR.job_number} JNE123 03/10/2026\nAMC/9999/0001 X`, dry_run: true });
    assert.deepEqual(res.rows.map((x) => [x.status, x.resi, x.date]), [["OK", "JNE123", "2026-10-03"], ["TIDAK_KETEMU", null, res.rows[1].date]]);
    assert.equal((await fin.call("GET", `/jobs/${JR.id}`)).status.sj_status, "BELUM_ADA_RESI");   // pratinjau tidak menyimpan
    res = await ops.call("POST", "/sj/bulk", { mode: "resi", text: `${JR.job_number}\tJNE123\t03/10/2026` });
    assert.equal(res.saved, 1);
    assert.equal((await fin.call("GET", `/jobs/${JR.id}`)).status.sj_status, "DI_KURIR");
    // cari sebagian kode tugas, lalu simpan dari daftar (bentuk kolom di layar)
    const found = await ops.call("GET", "/sj/search?q=777");
    assert.deepEqual([found[0].job_id, found[0].plate_number, found[0].pod], [JR.id, "B 9123 ABC", "SBY"]);
    res = await ops.call("POST", "/sj/bulk", { mode: "received", items: [{ job_id: JR.id, date: "2026-10-05" }] });
    assert.equal(res.saved, 1);
    // tempelan dengan label di depan tetap ketemu
    res = await ops.call("POST", "/sj/bulk", { mode: "received", text: "SJ diterima : KT-777 05/10/2026", dry_run: true });
    assert.deepEqual([res.rows[0].key, res.rows[0].date, res.rows[0].status], ["KT-777", "2026-10-05", "SUDAH"]);
    d = await fin.call("GET", `/jobs/${JR.id}`);
    assert.deepEqual([d.status.sj_status, d.status.lead_time_sj, d.status.hari_di_kurir, d.status.stage], ["DITERIMA", 2, 2, "SIAP_TAGIH"]);
    const el = await fin.call("GET", `/moves/eligible?move_type=out_invoice&phase=SETTLEMENT&partner_id=${id.LINTAS}&sj_received=1`);
    assert.ok(el.some((x) => x.job_id === JR.id) && el.every((x) => x.sj_received_at));
    assert.ok((await viewer.call("GET", "/sj/tracking?status=DITERIMA")).some((x) => x.job_id === JR.id));

    // pengiriman SJ ke customer: satu resi kurir untuk banyak SJ, nomor SJD otomatis
    assert.ok((await ops.call("GET", `/sj/ready?customer_id=${id.LINTAS}`)).some((x) => x.job_id === JR.id));
    let sd = await ops.call("POST", "/sj/deliveries", { customer_id: id.LINTAS, job_ids: [JR.id], delivery_date: "2026-10-06", courier: "JNE", resi_number: "CUST-1" });
    assert.match(sd.number, /^SJD\/2610\/0001$/);
    assert.match(await ops.call("POST", "/sj/deliveries", { customer_id: id.LINTAS, job_ids: [JR.id] }, 400), /sudah ada di pengiriman lain/);
    await ops.call("POST", `/sj/deliveries/${sd.id}/cancel`, { reason: "salah resi" });
    assert.equal((await fin.call("GET", `/jobs/${JR.id}`)).job.sj_delivered_at, null);
    sd = await ops.call("POST", "/sj/deliveries", { customer_id: id.LINTAS, job_ids: [JR.id], delivery_date: "2026-10-06", courier: "JNE", resi_number: "CUST-2" });
    await ops.call("POST", `/sj/deliveries/${sd.id}/received`, { date: "2026-10-08" });
    d = await fin.call("GET", `/jobs/${JR.id}`);
    assert.deepEqual([d.job.sj_delivered_resi_number, d.status.sj_status, d.sj_deliveries.at(-1).state], ["CUST-2", "DIKIRIM", "received"]);
    assert.ok((await viewer.call("GET", `/sj/deliveries/${sd.id}`)).lines.some((l) => l.job_id === JR.id));
    assert.ok((await viewer.call("GET", "/jobs?stage=SIAP_TAGIH")).some((x) => x.id === JR.id));
    const sum = await viewer.call("GET", "/sj/summary");
    assert.ok(sum.stages.SIAP_TAGIH >= 1);
    assert.ok((await viewer.call("GET", "/export/job-list.xlsx")).byteLength > 5000);
    await admin.call("PUT", "/settings", { require_gate_for_billing: false });
  });

  await step("reroute di tengah jalan: ganti rute wajib alasan, DP tambahan sampai 70% cost baru, pelunasan = sisa", async () => {
    const JX = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-10-04" });   // JRT - SBY, cost 7.600.000
    const dp1 = await createMove({ move_type: "in_invoice", phase: "DP", lines: [{ job_id: JX.id, amount: 5320000 }] });
    await admin.call("POST", `/moves/${dp1.id}/approve`, {});
    await fin.call("POST", `/moves/${dp1.id}/pay`, { bank_account_id: id.BCA });
    // reroute ke Medan PP: tanpa alasan ditolak, dengan alasan cost ikut price book baru
    assert.match(await ops.call("PUT", `/jobs/${JX.id}`, { pod_id: id.MES, trip_type: "ROUND_TRIP" }, 400), /alasan ganti rute/);
    await ops.call("PUT", `/jobs/${JX.id}`, { pod_id: id.MES, trip_type: "ROUND_TRIP", reason: "reroute permintaan gudang" });
    let d = await fin.call("GET", `/jobs/${JX.id}`);
    assert.deepEqual([d.balance.cost, d.balance.paid], [18000000, 5320000]);   // DP lama tidak dibalik
    assert.deepEqual([d.reroutes[0].detail.dari, d.reroutes[0].detail.ke, d.reroutes[0].detail.cost_dari, d.reroutes[0].detail.cost_ke, d.reroutes[0].detail.alasan],
      ["JRT - SBY", "JRT - MES PP", 7600000, 18000000, "reroute permintaan gudang"]);
    // DP tambahan = 70% x 18.000.000 - 5.320.000
    const el = await fin.call("GET", `/moves/eligible?move_type=in_invoice&phase=DP&job_ids=${JX.id}`);
    assert.equal(el[0].suggested, 7280000);
    assert.match(await fin.call("POST", "/moves", { move_type: "in_invoice", phase: "DP", lines: [{ job_id: JX.id, amount: 7280001 }] }, 400), /melebihi 70% cost/);
    const dp2 = await createMove({ move_type: "in_invoice", phase: "DP", lines: [{ job_id: JX.id, amount: 7280000 }] });
    const m = await fin.call("GET", `/moves/${dp2.id}`);
    assert.deepEqual([m.lines[0].dp_prev, m.lines[0].reroute.ke], [5320000, "JRT - MES PP"]);   // ditandai DP tambahan karena reroute
    const st = await fin.call("GET", `/moves/eligible?move_type=in_invoice&phase=SETTLEMENT&job_ids=${JX.id}`);
    assert.equal(st[0].suggested, 5400000);   // pelunasan = 18.000.000 - 12.600.000
    // ganti rute sebelum ada dokumen tidak perlu alasan
    const JY = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-10-04" });
    await ops.call("PUT", `/jobs/${JY.id}`, { pod_id: id.MES, trip_type: "ROUND_TRIP" });
    assert.equal((await fin.call("GET", `/jobs/${JY.id}`)).reroutes.length, 1);
  });

  await step("unit sewa: biaya per hari, sewa dibagi per trip (hari bersama dibagi rata), untung per unit, tagihan sewa prorata", async () => {
    // kontrak: B 1234 HQ disewa 15.000.000 / bulan mulai 1 Sep (September 30 hari -> 500.000 / hari)
    assert.match(await ops.call("POST", "/units/contracts", { plate_number: "B 1234 HQ", date_start: "2026-09-01", monthly_rent: 15000000 }, 403), /akses/);
    const c1 = await fin.call("POST", "/units/contracts", { plate_number: "b 1234 hq", truck_type: "CDDL", partner_id: id.SINAR, date_start: "2026-09-01", monthly_rent: "15.000.000" });
    assert.match(await fin.call("POST", "/units/contracts", { plate_number: "B 1234 HQ", date_start: "2026-10-01", monthly_rent: 14000000 }, 400), /tumpang tindih/);
    await fin.call("POST", "/units/contracts", { plate_number: "B 7777 XY", date_start: "2026-09-16", monthly_rent: 6000000 });
    // dua trip: 3-5 Sep dan 5-6 Sep (tanggal 5 dipakai dua job -> sewa hari itu dibagi dua). Cost job = uang jalan 2.500.000
    const T1 = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-09-03", plate_number: "B1234HQ", cost: 2500000 });
    const T2 = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-09-05", plate_number: "B 1234 HQ", cost: 2500000 });
    await ops.call("PUT", `/jobs/${T1.id}/trip`, { gate_out_at: "2026-09-03T08:00:00+07:00", gate_in_at: "2026-09-05T07:00:00+07:00" });
    await ops.call("PUT", `/jobs/${T2.id}/trip`, { gate_out_at: "2026-09-05T10:00:00+07:00", gate_in_at: "2026-09-06T20:00:00+07:00" });
    const d1 = await viewer.call("GET", `/jobs/${T1.id}`);
    assert.deepEqual([d1.unit.days, d1.unit.rent_cost], [3, 1250000]);
    const sum = await viewer.call("GET", "/units/summary?month=2026-09");
    const u = sum.units.find((x) => x.plate_number === "B 1234 HQ");
    assert.deepEqual([u.hari_kontrak, u.hari_jalan, u.hari_menganggur, u.biaya_per_hari, u.trips, u.selling, u.uang_jalan, u.kontribusi, u.sewa_bulan, u.untung, u.biaya_menganggur, u.titik_impas],
      [30, 4, 26, 500000, 2, 17000000, 5000000, 12000000, 15000000, -3000000, 13000000, 2.5]);
    // periode rentang & keseluruhan + rincian per bulan
    const rangeSum = await viewer.call("GET", "/units/summary?from=2026-09-01&to=2026-10-31");
    assert.equal(rangeSum.period.kind, "range");
    assert.ok(rangeSum.per_bulan.some((x) => x.bulan === "2026-09" && x.plate_number === "B 1234 HQ" && x.trips === 2 && x.untung === -3000000));
    assert.ok(rangeSum.per_bulan.some((x) => x.bulan === "2026-10" && x.plate_number === "B 1234 HQ"));
    const allSum = await viewer.call("GET", "/units/summary?all=1");
    assert.deepEqual([allSum.period.kind, allSum.period.from], ["all", "2026-09-01"]);
    assert.equal(allSum.units.find((x) => x.plate_number === "B 1234 HQ").trips, 2);
    assert.match(await viewer.call("GET", "/units/summary?from=2026-10-31&to=2026-09-01", null, 400), /Tanggal awal/);
    assert.ok((await viewer.call("GET", "/units/rent-bills?all=1")).length >= 0);
    const det = await viewer.call("GET", `/units/${u.vehicle_id}/detail?month=2026-09`);
    assert.deepEqual(det.trips.map((x) => [x.job_number, x.days, x.rent_cost, x.untung]),
      [[T1.job_number, 3, 1250000, 4750000], [T2.job_number, 2, 750000, 5250000]]);
    assert.equal(det.days.find((x) => x.day === "2026-09-05").jobs, [T1.job_number, T2.job_number].sort().join(", "));
    // semua trip lintas unit + Excel (RINGKASAN UNIT, TRIP, HARIAN) persis yang tampil
    const all = await viewer.call("GET", "/units/trips?month=2026-09");
    assert.ok(all.trips.some((x) => x.job_id === T1.id && x.plate_number === "B 1234 HQ" && x.status === "Selesai"));
    assert.ok((await viewer.call("POST", "/units/export.xlsx", { month: "2026-09", job_ids: [T1.id] })).byteLength > 3000);
    assert.ok((await viewer.call("GET", "/units/export.xlsx?month=2026-09")).byteLength > 3000);
    // tagihan sewa per periode kontrak yang mulai di September: B 1234 HQ (mulai 1 Sep) 15.000.000, B 7777 XY (mulai 16 Sep,
    // periode 16 Sep - 15 Okt) sebulan penuh 6.000.000; jatuh tempo = tanggal mulai periode tiap unit; tidak dobel kalau dibuat lagi
    const g = await fin.call("POST", "/units/rent-bills/generate", { month: "2026-09" });
    assert.deepEqual([g.count, g.total], [2, 21000000]);
    assert.deepEqual((await viewer.call("GET", "/units/rent-bills?month=2026-09")).map((x) => [x.plate_number, tgl(x.due_date), x.days, x.amount]).sort(),
      [["B 1234 HQ", "2026-09-01", 30, 15000000], ["B 7777 XY", "2026-09-16", 30, 6000000]]);
    assert.equal((await fin.call("POST", "/units/rent-bills/generate", { month: "2026-09" })).count, 0);
    const bills = await viewer.call("GET", "/units/rent-bills?month=2026-09");
    const b1 = bills.find((x) => x.plate_number === "B 1234 HQ");
    assert.match(b1.number, /^SWA\/2609\/\d{4}$/);
    await fin.call("POST", `/units/rent-bills/${b1.id}/pay`, { bank_account_id: id.BCA, amount: 10000000, pay_date: "2026-10-01" });
    assert.match(await fin.call("POST", `/units/rent-bills/${b1.id}/pay`, { bank_account_id: id.BCA, amount: 6000000 }, 400), /Melebihi sisa/);
    assert.match(await fin.call("POST", `/units/rent-bills/${b1.id}/cancel`, { reason: "salah" }, 400), /pembayaran/);
    let after = (await viewer.call("GET", "/units/rent-bills?month=2026-09")).find((x) => x.id === b1.id);
    assert.deepEqual([after.paid, after.residual], [10000000, 5000000]);
    await fin.call("POST", `/units/rent-payments/${after.payments[0].id}/reverse`, { reason: "salah rekening" });
    after = (await viewer.call("GET", "/units/rent-bills?month=2026-09")).find((x) => x.id === b1.id);
    assert.deepEqual([after.paid, after.residual], [0, 15000000]);
    // harga sewa sudah ditagih tidak bisa diubah di kontrak yang sama
    assert.match(await fin.call("PUT", `/units/contracts/${c1.id}`, { vehicle_id: u.vehicle_id, date_start: "2026-09-01", monthly_rent: 16000000 }, 400), /sudah ditagih/);
    // ubah jenis truk / plat dari form kontrak, hapus kontrak (yang sudah ditagih tidak bisa)
    await fin.call("PUT", `/units/contracts/${c1.id}`, { vehicle_id: u.vehicle_id, plate_number: "B 1234 HQ", truck_type: "cdel", date_start: "2026-09-01", monthly_rent: 15000000 });
    assert.equal((await viewer.call("GET", "/vehicles")).find((v) => v.id === u.vehicle_id).truck_type, "CDEL");
    const c3 = await fin.call("POST", "/units/contracts", { plate_number: "B 5555 ZZ", truck_type: "CDDL", date_start: "2026-11-01", monthly_rent: 1000000 });
    await fin.call("PUT", `/units/contracts/${c3.id}`, { vehicle_id: (await viewer.call("GET", "/units/contracts")).find((x) => x.id === c3.id).vehicle_id,
      plate_number: "b 5556 zz", truck_type: "CDDL", date_start: "2026-11-01", monthly_rent: 1000000 });
    assert.equal((await viewer.call("GET", "/units/contracts")).find((x) => x.id === c3.id).plate_number, "B 5556 ZZ");
    assert.match(await fin.call("DELETE", `/units/contracts/${c3.id}`, {}, 400), /Alasan/);
    await fin.call("DELETE", `/units/contracts/${c3.id}`, { reason: "salah input" });
    assert.ok(!(await viewer.call("GET", "/units/contracts")).some((x) => x.id === c3.id));
    assert.match(await fin.call("DELETE", `/units/contracts/${c1.id}`, { reason: "coba" }, 400), /tagihan sewa/);
  });

  await step("dashboard, rekap, aging, export Excel", async () => {
    const dash = await viewer.call("GET", "/dashboard");
    assert.ok(dash.totals.jobs >= 6);
    const rekap = await viewer.call("GET", "/rekap");
    assert.ok(rekap.some((r) => r.side === "PURCHASE" && r.phase === "DP"));
    await viewer.call("GET", "/aging?move_type=in_invoice");
    // AR / AP per job: tiap fase dengan rencana, ditagih, dibayar, nomor dokumen
    const ar = await viewer.call("GET", "/billing?side=SALE");
    const ap = await viewer.call("GET", "/billing?side=PURCHASE");
    const j1 = ap.find((r) => r.job_number === "AMC/2609/0001");
    assert.ok(ar.length > 0 && j1 && j1.phases.some((p) => p.phase === "DP" && p.planned === 12600000));
    const pos = await viewer.call("GET", "/rekap");
    const sumAp = (f) => ap.reduce((a, r) => a + r.phases.reduce((x, p) => x + p[f], 0), 0);
    assert.equal(sumAp("not_billed"), pos.filter((r) => r.side === "PURCHASE").reduce((a, r) => a + r.not_billed, 0), "sama dengan Rekap Posisi");
    assert.ok((await viewer.call("GET", "/moves?move_type=in_invoice")).some((m) => m.schemes === "70_30"));
    // tempel daftar no job / kode tugas (huruf kecil, spasi, koma), export persis job yang tampil
    const all = await viewer.call("GET", "/jobs?limit=5000");
    const [x, y] = all;
    const byNo = await viewer.call("POST", "/jobs/query", { numbers: `${x.job_number.toLowerCase()}, ${y.job_number}
 AMC/0000/9999`, limit: 5000 });
    assert.deepEqual(byNo.map((j) => j.id).sort(), [x.id, y.id].sort());
    const withDo = all.find((j) => j.do_number);
    if (withDo) assert.ok((await viewer.call("POST", "/jobs/query", { numbers: [withDo.do_number], by: "do" })).some((j) => j.id === withDo.id));
    assert.ok((await viewer.call("POST", "/export/job-list.xlsx", { ids: [x.id, y.id] })).byteLength > 3000);
    for (const f of ["utang-piutang", "jurnal-kas", "posisi", "kurang-transfer", "tracker"]) {
      const buf = await viewer.call("GET", `/export/${f}.xlsx`);
      assert.ok(buf.byteLength > 1000, f);
    }
  });

  await step("cek harga jual: harga baru berlaku per tanggal, job yang telanjur dibuat disamakan sekaligus", async () => {
    await admin.call("PUT", "/settings", { require_gate_for_billing: false });
    const job = (job_date) => ops.call("POST", "/jobs", { job_date, customer_id: id.KOTA, pol_id: id.JRT, pod_id: id.SBY, trip_type: "ONE_WAY", truck_type: "CDDL", selling_mode: "PRICE_BOOK" });
    const A = await job("2026-10-08"), B = await job("2026-10-10"), C = await job("2026-10-11");     // semua masih harga lama 8.500.000
    const sellingOf = async (j) => (await viewer.call("GET", `/jobs/${j.id}`)).balance.selling;
    assert.equal(await sellingOf(C), 8500000);
    assert.equal((await viewer.call("GET", `/price-check?customer_id=${id.KOTA}`)).length, 0);
    // finance baru mencatat: mulai 10 Oktober harga jadi 8.000.000. Job lama tidak berubah sendiri.
    const p1 = (await fin.call("POST", "/pricelist", { pol_id: id.JRT, pod_id: id.SBY, truck_type: "CDDL", trip_type: "ONE_WAY", selling: 8000000, effective_from: "2026-10-10" })).id;
    assert.equal(await sellingOf(C), 8500000);
    let beda = await viewer.call("GET", `/price-check?customer_id=${id.KOTA}`);
    assert.deepEqual(beda.map((x) => x.job_number).sort(), [B.job_number, C.job_number].sort());     // job 8 Okt (sebelum tanggal berlaku) tidak ikut
    assert.deepEqual([beda[0].selling, beda[0].book, beda[0].selisih, beda[0].blocked], [8500000, 8000000, -500000, false]);
    // C sudah ditagih DP 70% dari harga lama (5.950.000): tetap bisa, karena masih di bawah harga baru
    const dp = await fin.call("POST", "/moves", { move_type: "out_invoice", phase: "DP", partner_id: id.KOTA, post: true, lines: [{ job_id: C.id, amount: 5950000 }] });
    assert.equal(dp.state, "posted");
    // hanya FINANCE / ADMIN, wajib alasan
    assert.match(await ops.call("POST", "/price-check/apply", { job_ids: [B.id], reason: "x" }, 403), /akses/);
    assert.match(await fin.call("POST", "/price-check/apply", { job_ids: [B.id] }, 400), /Alasan/);
    // job yang dibuat saat harganya belum diketahui (selling 0) ikut tampil dan terisi dari price book
    const Z = await ops.call("POST", "/jobs", { job_date: "2026-10-12", customer_id: id.KOTA, pol_id: id.JRT, pod_id: id.SBY, trip_type: "ONE_WAY", truck_type: "CDDL", selling_mode: "ZERO" });
    const z = (await viewer.call("GET", `/price-check?customer_id=${id.KOTA}`)).find((x) => x.job_id === Z.id);
    assert.deepEqual([z.selling, z.book, z.selling_mode], [0, 8000000, "ZERO"]);
    await fin.call("POST", "/price-check/apply", { job_ids: [Z.id], reason: "harga sudah keluar" });
    assert.deepEqual([await sellingOf(Z), (await viewer.call("GET", `/jobs/${Z.id}`)).job.selling_mode], [8000000, "PRICE_BOOK"]);
    let r = await fin.call("POST", "/price-check/apply", { job_ids: [A.id, B.id, C.id], reason: "harga baru per 10 Oktober" });
    assert.deepEqual([r.updated, r.skipped.length, r.unchanged], [2, 0, 1]);
    assert.deepEqual([await sellingOf(A), await sellingOf(B), await sellingOf(C)], [8500000, 8000000, 8000000]);
    assert.equal((await viewer.call("GET", `/price-check?customer_id=${id.KOTA}`)).length, 0);
    assert.ok((await admin.call("GET", `/audit?entity=job&entity_id=${B.id}`)).some((a) => a.action === "reprice" && a.detail.dari === 8500000 && a.detail.ke === 8000000));
    // sisa tagihan C menyesuaikan: harga baru - DP yang sudah ditagih
    const sisa = (await fin.call("GET", `/moves/eligible?move_type=out_invoice&phase=SETTLEMENT&partner_id=${id.KOTA}&job_ids=${C.id}`))[0];
    assert.equal(sisa.suggested, 8000000 - 5950000);
    // harga turun di bawah yang sudah ditagih: ditandai tidak bisa dan dilewati, bukan dipaksa
    const p2 = (await fin.call("POST", "/pricelist", { customer_id: id.KOTA, pol_id: id.JRT, pod_id: id.SBY, truck_type: "CDDL", trip_type: "ONE_WAY", selling: 5000000, effective_from: "2026-10-11" })).id;
    beda = await viewer.call("GET", `/price-check?customer_id=${id.KOTA}`);
    // C (sudah ditagih 5.950.000) tidak bisa turun ke 5.000.000; Z (belum ditagih) bisa
    assert.deepEqual(beda.map((x) => [x.job_number, x.blocked, x.khusus]).sort(), [[C.job_number, true, true], [Z.job_number, false, true]].sort());
    r = await fin.call("POST", "/price-check/apply", { job_ids: [C.id], reason: "coba" });
    assert.deepEqual([r.updated, r.skipped.length], [0, 1]);
    assert.equal(await sellingOf(C), 8000000);
    // rapikan supaya langkah lain tidak terpengaruh
    for (const pid of [p1, p2]) await fin.call("PUT", `/pricelist/${pid}`, { active: false });
    assert.equal((await viewer.call("GET", `/price-check?customer_id=${id.KOTA}`)).length, 3);       // B, C, Z sekarang beda lagi dari harga lama (wajar)
  });

  await step("unit sewa per periode kontrak: siklus ikut tanggal mulai kontrak, sewa per siklus, untung dibanding periode sebelumnya", async () => {
    // B 5555 PR: 1 Agu - 30 Sep, 9.000.000 / bulan -> periode 1 = 1-31 Agu, periode 2 = 1-30 Sep
    await fin.call("POST", "/units/contracts", { plate_number: "B 5555 PR", truck_type: "CDDL", date_start: "2026-08-01", date_end: "2026-09-30", monthly_rent: 9000000 });
    // kontrak "6 Agu - 6 Sep" = satu periode (ekor 1 hari digabung), sewa tetap sebulan penuh
    await fin.call("POST", "/units/contracts", { plate_number: "B 5556 PR", truck_type: "CDDL", date_start: "2026-08-06", date_end: "2026-09-06", monthly_rent: 9000000 });
    // kontrak berhenti di tengah: 1-15 Agu = periode terpotong, sewa sebanding hari (15/31)
    await fin.call("POST", "/units/contracts", { plate_number: "B 5557 PR", truck_type: "CDDL", date_start: "2026-08-01", date_end: "2026-08-15", monthly_rent: 9000000 });
    // satu trip di September: selling 3.000.000 - uang jalan 1.000.000 = kontribusi 2.000.000
    const T = await ops.call("POST", "/jobs", { job_date: "2026-09-10", customer_id: id.KOTA, pol_id: id.JRT, pod_id: id.SBY, trip_type: "ONE_WAY", truck_type: "CDDL",
      plate_number: "B 5555 PR", selling_mode: "CUSTOM", selling: 3000000, cost: 1000000 });
    await ops.call("PUT", `/jobs/${T.id}/trip`, { gate_out_at: "2026-09-10T08:00:00+07:00", gate_in_at: "2026-09-11T18:00:00+07:00" });
    const { periods } = await viewer.call("GET", "/units/periods");
    const of = (plate) => periods.filter((x) => x.plate_number === plate).map((x) =>
      [x.ke, x.from, x.to, x.status, x.sewa_periode, x.trips, x.kontribusi, x.untung, x.selisih_sebelumnya]);
    assert.deepEqual(of("B 5555 PR"), [
      [1, "2026-08-01", "2026-08-31", "SELESAI", 9000000, 0, 0, -9000000, null],
      [2, "2026-09-01", "2026-09-30", "SELESAI", 9000000, 1, 2000000, -7000000, 2000000],
    ]);
    assert.deepEqual(of("B 5556 PR").map((x) => x.slice(0, 5)), [[1, "2026-08-06", "2026-09-06", "SELESAI", 9000000]]);
    assert.deepEqual(of("B 5557 PR").map((x) => x.slice(0, 5)), [[1, "2026-08-01", "2026-08-15", "SELESAI", Math.round(9000000 * 15 / 31)]]);
    // utilisasi periode 2: trip 10-11 Sep = 2 dari 30 hari dipakai
    const p2 = periods.find((x) => x.plate_number === "B 5555 PR" && x.ke === 2);
    assert.deepEqual([p2.hari_jalan, p2.hari_menganggur, p2.utilisasi, p2.biaya_menganggur], [2, 28, 7, 8400000]);
    // tagihan sewa semua periode yang sudah mulai: satu per periode, jatuh tempo per unit = tanggal mulai periodenya
    await fin.call("POST", "/units/rent-bills/generate", {});
    const tagihan = (await viewer.call("GET", "/units/rent-bills?all=1")).filter((x) => / PR$/.test(x.plate_number))
      .map((x) => [x.plate_number, tgl(x.period), tgl(x.due_date), x.days, x.amount]).sort();
    assert.deepEqual(tagihan, [
      ["B 5555 PR", "2026-08-01", "2026-08-01", 31, 9000000], ["B 5555 PR", "2026-09-01", "2026-09-01", 30, 9000000],
      ["B 5556 PR", "2026-08-06", "2026-08-06", 32, 9000000], ["B 5557 PR", "2026-08-01", "2026-08-01", 15, Math.round(9000000 * 15 / 31)],
    ]);
    // tagihan model lama per bulan kalender (mulai tanggal 1) yang menutupi tanggal periode: periode itu tidak ditagih lagi
    await fin.call("POST", "/units/contracts", { plate_number: "B 5558 PR", truck_type: "CDDL", date_start: "2026-09-21", date_end: "2026-10-20", monthly_rent: 9000000 });
    const cid = (await fin.call("GET", "/units/contracts")).find((x) => x.plate_number === "B 5558 PR").id;
    const lama = await fin.call("POST", "/units/rent-bills/generate", { month: "2026-09" });   // periode 21 Sep - 20 Okt mulai di September -> dibuat
    assert.equal(lama.count, 1);
    const dobel = await fin.call("POST", "/units/rent-bills/generate", {});
    assert.equal(dobel.skipped.filter((x) => x.plate_number === "B 5558 PR").length, 0);   // periode yang sama tidak dibuat ulang, bukan "tumpang tindih"
    const b5558 = (await viewer.call("GET", "/units/rent-bills?all=1")).find((x) => x.plate_number === "B 5558 PR");
    assert.deepEqual([tgl(b5558.dari), tgl(b5558.sampai), b5558.amount], ["2026-09-21", "2026-10-20", 9000000]);
    await fin.call("POST", `/units/rent-bills/${b5558.id}/cancel`, { reason: "uji tagihan model lama" });
    // tiru tagihan lama: periode 1 Okt, 20 hari (1-20 Okt)
    const { insertRow } = await import("../lib/util.js");
    await db.tx((t) => insertRow(t, "vehicle_rent_bill", { number: "SWA/LAMA/0001", contract_id: cid, period: "2026-10-01", days: 20, amount: 6000000, due_date: "2026-10-15" }));
    const r2 = await fin.call("POST", "/units/rent-bills/generate", {});
    assert.deepEqual(r2.skipped.filter((x) => x.plate_number === "B 5558 PR").map((x) => [x.dari, x.sampai, x.karena]), [["2026-09-21", "2026-10-20", "SWA/LAMA/0001"]]);
    // jatuh tempo bisa diubah per tagihan (FINANCE)
    const satu = (await viewer.call("GET", "/units/rent-bills?all=1")).find((x) => x.plate_number === "B 5556 PR");
    assert.match(await ops.call("PUT", `/units/rent-bills/${satu.id}`, { due_date: "2026-08-10" }, 403), /akses/);
    await fin.call("PUT", `/units/rent-bills/${satu.id}`, { due_date: "2026-08-10" });
    assert.equal(tgl((await viewer.call("GET", "/units/rent-bills?all=1")).find((x) => x.id === satu.id).due_date), "2026-08-10");
  });

  await step("periode per unit: kontrak bulanan yang bersambung tetap periode 1, 2, ...; perpanjang 1 bulan di kontrak yang sama", async () => {
    // cara 1: kontrak dibuat per bulan (16 Jul - 15 Agu, lalu 16 Agu - 15 Sep dengan harga baru)
    await fin.call("POST", "/units/contracts", { plate_number: "B 7001 PP", truck_type: "CDDL", date_start: "2026-07-16", date_end: "2026-08-15", monthly_rent: 9000000 });
    await fin.call("POST", "/units/contracts", { plate_number: "B 7001 PP", truck_type: "CDDL", date_start: "2026-08-16", date_end: "2026-09-15", monthly_rent: 8000000 });
    const T = await ops.call("POST", "/jobs", { job_date: "2026-08-20", customer_id: id.KOTA, pol_id: id.JRT, pod_id: id.SBY, trip_type: "ONE_WAY", truck_type: "CDDL",
      plate_number: "B 7001 PP", selling_mode: "CUSTOM", selling: 3000000, cost: 1000000 });
    await ops.call("PUT", `/jobs/${T.id}/trip`, { gate_out_at: "2026-08-20T08:00:00+07:00", gate_in_at: "2026-08-20T20:00:00+07:00" });
    let ps = (await viewer.call("GET", "/units/periods")).periods.filter((x) => x.plate_number === "B 7001 PP");
    assert.deepEqual(ps.map((x) => [x.ke, x.from, x.to, x.sewa_periode, x.untung, x.selisih_sebelumnya]), [
      [1, "2026-07-16", "2026-08-15", 9000000, -9000000, null],
      [2, "2026-08-16", "2026-09-15", 8000000, -6000000, 3000000],     // dibanding periode 1 walau beda kontrak
    ]);
    // cara 2: satu kontrak "habis tanggal 16" diperpanjang sebulan-sebulan
    const c = await fin.call("POST", "/units/contracts", { plate_number: "B 7002 PP", truck_type: "CDDL", date_start: "2026-07-16", date_end: "2026-08-16", monthly_rent: 9000000 });
    assert.match(await ops.call("POST", `/units/contracts/${c.id}/extend`, {}, 403), /akses/);
    assert.equal((await fin.call("POST", `/units/contracts/${c.id}/extend`, {})).date_end, "2026-09-16");
    ps = (await viewer.call("GET", "/units/periods")).periods.filter((x) => x.plate_number === "B 7002 PP");
    assert.deepEqual(ps.map((x) => [x.ke, x.from, x.to, x.sewa_periode]), [
      [1, "2026-07-16", "2026-08-15", 9000000], [2, "2026-08-16", "2026-09-16", 9000000]]);   // ekor 16 Sep ikut periode 2, sewa tetap sebulan
    // kontrak yang belum mulai: periode pertamanya sudah tampil sebagai "belum mulai" (angka 0), nomornya lanjut per unit
    const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
    await fin.call("POST", "/units/contracts", { plate_number: "B 7003 PP", truck_type: "CDDL", date_start: day(-10), date_end: day(0), monthly_rent: 9000000 });
    await fin.call("POST", "/units/contracts", { plate_number: "B 7003 PP", truck_type: "CDDL", date_start: day(1), monthly_rent: 9000000 });
    const p7003 = (await viewer.call("GET", "/units/periods")).periods.filter((x) => x.plate_number === "B 7003 PP");
    assert.deepEqual(p7003.map((x) => [x.ke, x.status, x.from, x.mulai_dalam ?? null, x.untung]),
      [[1, "BERJALAN", day(-10), null, p7003[0].untung], [2, "BELUM_MULAI", day(1), 1, 0]]);
    assert.equal((await viewer.call("GET", "/units/contracts")).find((x) => x.plate_number === "B 7003 PP" && tgl(x.date_start) === day(1)).belum_mulai, true);
    // diperpanjang: periode berikutnya langsung ada; selama belum mulai statusnya "belum mulai", bukan "berjalan hari ke-0"
    const c4 = await fin.call("POST", "/units/contracts", { plate_number: "B 7004 PP", truck_type: "CDDL", date_start: day(-29), date_end: day(0), monthly_rent: 9000000 });
    await fin.call("POST", `/units/contracts/${c4.id}/extend`, {});
    const p7004 = (await viewer.call("GET", "/units/periods")).periods.filter((x) => x.plate_number === "B 7004 PP");
    assert.deepEqual(p7004.map((x) => [x.ke, x.status]), [[1, "BERJALAN"], [2, "BELUM_MULAI"]]);
    assert.equal(p7004[1].from, day(1));
    // tidak bisa menabrak kontrak berikutnya; kontrak tanpa tanggal selesai tidak perlu diperpanjang
    await fin.call("POST", "/units/contracts", { plate_number: "B 7002 PP", truck_type: "CDDL", date_start: "2026-09-17", monthly_rent: 9500000 });
    assert.match(await fin.call("POST", `/units/contracts/${c.id}/extend`, {}, 400), /berikutnya mulai 2026-09-17/);
    const open = (await fin.call("GET", "/units/contracts")).find((x) => x.plate_number === "B 7002 PP" && !x.date_end);
    assert.match(await fin.call("POST", `/units/contracts/${open.id}/extend`, {}, 400), /tidak perlu diperpanjang/);
  });

  await step("peringatan unit sewa: kontrak mau habis, kontrak habis tapi unit masih jalan, tagihan sewa telat", async () => {
    const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
    await fin.call("POST", "/units/contracts", { plate_number: "B 6000 AL", truck_type: "CDDL", date_start: day(-20), date_end: day(3), monthly_rent: 9000000 });
    await fin.call("POST", "/units/contracts", { plate_number: "B 6001 AL", truck_type: "CDDL", date_start: day(-40), date_end: day(-2), monthly_rent: 9000000 });
    // kontrak berikutnya baru mulai jauh sesudahnya = ada jeda, tetap diperingatkan
    await fin.call("POST", "/units/contracts", { plate_number: "B 6003 AL", truck_type: "CDDL", date_start: day(-20), date_end: day(1), monthly_rent: 9000000 });
    await fin.call("POST", "/units/contracts", { plate_number: "B 6003 AL", truck_type: "CDDL", date_start: day(30), monthly_rent: 9000000 });
    // sudah diperpanjang = tidak diperingatkan
    await fin.call("POST", "/units/contracts", { plate_number: "B 6002 AL", truck_type: "CDDL", date_start: day(-20), date_end: day(2), monthly_rent: 9000000 });
    await fin.call("POST", "/units/contracts", { plate_number: "B 6002 AL", truck_type: "CDDL", date_start: day(3), monthly_rent: 9000000 });
    const T = await ops.call("POST", "/jobs", { job_date: day(-1), customer_id: id.KOTA, pol_id: id.JRT, pod_id: id.SBY, trip_type: "ONE_WAY", truck_type: "CDDL",
      plate_number: "B 6001 AL", selling_mode: "CUSTOM", selling: 3000000, cost: 1000000 });
    await ops.call("PUT", `/jobs/${T.id}/trip`, { gate_out_at: `${day(-1)}T08:00:00+07:00`, gate_in_at: `${day(-1)}T20:00:00+07:00` });
    await fin.call("POST", "/units/rent-bills/generate", {});
    const a = await viewer.call("GET", "/units/alerts");
    assert.deepEqual(a.ending.filter((x) => / AL$/.test(x.plate_number)).map((x) => [x.plate_number, x.sisa_hari, x.kontrak_berikutnya ? tgl(x.kontrak_berikutnya) : null]),
      [["B 6003 AL", 1, day(30)], ["B 6000 AL", 3, null]]);
    assert.deepEqual(a.ended.filter((x) => / AL$/.test(x.plate_number)).map((x) => [x.plate_number, x.lewat_hari, x.trip_setelah]), [["B 6001 AL", 2, 1]]);
    const telat = a.bills.find((x) => x.plate_number === "B 6000 AL");
    // kontrak 24 hari = periode terpotong: tagihannya sebanding hari, telat sejak tanggal mulai periodenya
    const bill = (await viewer.call("GET", "/units/rent-bills?all=1")).find((x) => x.plate_number === "B 6000 AL");
    assert.deepEqual([telat.sisa_hari, telat.residual, bill.days], [-20, bill.amount, 24]);
    assert.ok(bill.amount < 9000000);
  });

  await step("kelola user (ADMIN saja) + audit", async () => {
    assert.match(await fin.call("GET", "/users", null, 403), /akses/);
    await admin.call("POST", "/users", { username: "budi.ops", display_name: "Budi", role: "OPERATIONAL", password: "panjang123" });
    assert.ok((await admin.call("GET", "/users")).some((u) => u.username === "budi.ops"));
    assert.ok((await admin.call("GET", "/audit?entity=account_move")).length > 0);
    assert.match(await fin.call("GET", "/export/semua.xlsx", null, 403), /akses/);
    assert.ok((await admin.call("GET", "/export/semua.xlsx")).byteLength > 20000);
  });

  await step("pengajuan / invoice baru: tempel daftar no job atau kode tugas", async () => {
    let rows = [], phase = "";
    for (phase of ["DP", "SETTLEMENT", "FULL", "OTHER"]) {
      rows = (await fin.call("GET", `/moves/eligible?move_type=in_invoice&phase=${phase}`)).filter((r) => r.suggested > 0);
      if (new Set(rows.map((r) => r.job_id)).size >= 2) break;
    }
    const jobs = [...new Map(rows.map((r) => [r.job_id, r])).values()];
    assert.ok(jobs.length >= 2, "butuh minimal 2 job yang masih bisa diajukan");
    const [a, b] = jobs;
    const idsOf = (list) => [...new Set(list.map((r) => r.job_id))].sort();
    // huruf kecil, spasi, baris baru, nomor yang tidak ada: hanya 2 job itu yang keluar
    const got = await viewer.call("POST", "/moves/eligible", { move_type: "in_invoice", phase,
      numbers: `${a.job_number.toLowerCase()}\n\n ${b.job_number} , AMC/0000/9999` });
    assert.deepEqual(idsOf(got), [a.job_id, b.job_id].sort());
    assert.deepEqual(idsOf(await viewer.call("GET", `/moves/eligible?move_type=in_invoice&phase=${phase}&numbers=${encodeURIComponent(a.job_number)}`)), [a.job_id]);
    // kode tugas juga cocok
    const withDo = jobs.find((r) => r.do_number);
    if (withDo) {
      const byDo = await viewer.call("POST", "/moves/eligible", { move_type: "in_invoice", phase, numbers: [withDo.do_number.toLowerCase()] });
      assert.ok(byDo.some((r) => r.job_id === withDo.job_id));
    }
    // tanpa daftar tetap seperti biasa (semua), dan POST ini tidak menyimpan apa pun
    assert.ok((await viewer.call("POST", "/moves/eligible", { move_type: "in_invoice", phase })).length >= rows.length);
  });

  await step("ringan: jawaban dikompresi, file tampilan tanpa cek sesi, ringkasan status cocok dengan daftar job", async () => {
    const root = base.replace(/\/api$/, "");
    const login = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "rahasia123" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    // jawaban besar dikirim gzip (fetch membukanya lagi otomatis)
    const list = await fetch(`${base}/jobs?limit=5000`, { headers: { cookie, "accept-encoding": "gzip" } });
    assert.equal(list.headers.get("content-encoding"), "gzip");
    const jobs = await list.json();
    assert.ok(jobs.length > 3);
    // file tampilan bisa dibuka tanpa login, juga dikompresi
    const file = await fetch(`${root}/lib.js`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-encoding"), "gzip");
    // ringkasan (satu query, dikelompokkan per tahap) = hitung ulang dari daftar job
    const sum = await viewer.call("GET", "/sj/summary");
    const count = (fn) => jobs.filter(fn).length;
    for (const [stage, n] of Object.entries(sum.stages)) assert.equal(n, count((j) => j.stage === stage), stage);
    assert.equal(Object.values(sum.stages).reduce((a, b) => a + b, 0), jobs.length);
    const live = (j) => j.state !== "cancelled";
    assert.equal(sum.belum_ada_resi, count((j) => live(j) && j.sj_status === "BELUM_ADA_RESI"));
    assert.equal(sum.di_kurir, count((j) => live(j) && j.sj_status === "DI_KURIR"));
    assert.equal(sum.diterima_belum_kirim, count((j) => live(j) && j.sj_status === "DITERIMA"));
    assert.equal(sum.resi_terlambat, count((j) => live(j) && j.sj_late === "RESI_TERLAMBAT"));
    const lead = jobs.filter((j) => live(j) && j.lead_time_sj !== null).map((j) => Number(j.lead_time_sj));
    assert.equal(sum.rata_lead_time, lead.length ? Math.round((lead.reduce((a, b) => a + b, 0) / lead.length) * 10) / 10 : null);
  });

  console.log(`\nSemua ${passed} langkah lolos.`);
} finally {
  server.close();
  await db.close();
}

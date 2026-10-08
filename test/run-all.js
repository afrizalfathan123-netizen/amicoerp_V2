// Tes ujung-ke-ujung lewat HTTP di database PostgreSQL tertanam (memori). Data asli tidak tersentuh.
//   npm test
import assert from "node:assert/strict";
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { hashPassword } from "../lib/auth.js";
import { createApp } from "../server.js";

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

  await step("dashboard, rekap, aging, export Excel", async () => {
    const dash = await viewer.call("GET", "/dashboard");
    assert.ok(dash.totals.jobs >= 6);
    const rekap = await viewer.call("GET", "/rekap");
    assert.ok(rekap.some((r) => r.side === "PURCHASE" && r.phase === "DP"));
    await viewer.call("GET", "/aging?move_type=in_invoice");
    for (const f of ["utang-piutang", "jurnal-kas", "posisi", "kurang-transfer", "tracker"]) {
      const buf = await viewer.call("GET", `/export/${f}.xlsx`);
      assert.ok(buf.byteLength > 1000, f);
    }
  });

  await step("kelola user (ADMIN saja) + audit", async () => {
    assert.match(await fin.call("GET", "/users", null, 403), /akses/);
    await admin.call("POST", "/users", { username: "budi.ops", display_name: "Budi", role: "OPERATIONAL", password: "panjang123" });
    assert.ok((await admin.call("GET", "/users")).some((u) => u.username === "budi.ops"));
    assert.ok((await admin.call("GET", "/audit?entity=account_move")).length > 0);
    assert.match(await fin.call("GET", "/export/semua.xlsx", null, 403), /akses/);
    assert.ok((await admin.call("GET", "/export/semua.xlsx")).byteLength > 20000);
  });

  console.log(`\nSemua ${passed} langkah lolos.`);
} finally {
  server.close();
  await db.close();
}

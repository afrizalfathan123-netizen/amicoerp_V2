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
    assert.deepEqual([d.balance.selling, d.balance.cost, d.job.plate_number, d.job.payment_scheme], [19500000, 18000000, "B 9123 ABC", "70_30"]);
    assert.match(await job(ops, { pod_id: id.SBY, trip_type: "ROUND_TRIP" }, 400), /Price book/);
    J2 = await ops.call("POST", "/jobs", { job_date: "2026-09-20", customer_id: id.KOTA, vendor_id: id.SINAR, pol_id: id.CKR, pod_id: id.CKG,
      truck_type: "CDDL", delivery_scope: "INNERCITY", rit_number: 1 });
    const d2 = await fin.call("GET", `/jobs/${J2.id}`);
    assert.deepEqual([d2.job.payment_scheme, d2.balance.selling], ["FULL", 2000000]);
  });

  const P1 = await line(J1.id, "PURCHASE", "TRUCKING");
  let dpV, stlV;
  await step("pengajuan DP vendor: posting -> menunggu ADMIN -> FINANCE tidak bisa setuju -> ADMIN setuju -> bayar", async () => {
    const el = await fin.call("GET", "/moves/eligible?move_type=in_invoice&phase=DP_70");
    assert.equal(el.find((e) => e.job_line_id === P1).suggested, 12600000);
    dpV = await createMove({ move_type: "in_invoice", phase: "DP_70", move_date: "2026-09-15", lines: [{ job_id: J1.id, amount: 12600000 }] });
    assert.deepEqual([dpV.number, dpV.approval_state, dpV.lines[0].payee_holder], ["REQ/2026/0001", "PENDING", "CV Sinar Jaya"]);
    assert.match(await fin.call("POST", `/moves/${dpV.id}/pay`, { bank_account_id: id.BCA }, 400), /belum disetujui/);
    assert.match(await fin.call("POST", `/moves/${dpV.id}/approve`, {}, 403), /akses/);
    await admin.call("POST", `/moves/${dpV.id}/approve`, {});
    dpV = await fin.call("POST", `/moves/${dpV.id}/pay`, { bank_account_id: id.BCA, pay_date: "2026-09-16" });
    assert.equal(dpV.amount_residual, 0);
  });

  await step("DP kedua ditolak, pelunasan melebihi sisa ditolak", async () => {
    assert.match(await fin.call("POST", "/moves", { move_type: "in_invoice", phase: "DP_70", lines: [{ job_id: J1.id, amount: 100 }] }, 400), /DP 70% sudah/);
    assert.match(await fin.call("POST", "/moves", { move_type: "in_invoice", phase: "SETTLEMENT_30", lines: [{ job_id: J1.id, amount: 5400001 }] }, 400), /melebihi sisa/);
  });

  await step("invoice DP customer + dibayar; pelunasan vendor dibayar", async () => {
    const inv = await createMove({ move_type: "out_invoice", phase: "DP_70", move_date: "2026-09-15", bank_account_id: id.BCA, lines: [{ job_id: J1.id, amount: 13650000 }] });
    assert.equal(inv.approval_state, "NOT_REQUIRED");
    await fin.call("POST", `/moves/${inv.id}/pay`, { pay_date: "2026-09-17" });
    stlV = await createMove({ move_type: "in_invoice", phase: "SETTLEMENT_30", move_date: "2026-09-21", lines: [{ job_id: J1.id, amount: 5400000 }] });
    await admin.call("POST", `/moves/${stlV.id}/approve`, {});
    await fin.call("POST", `/moves/${stlV.id}/pay`, { bank_account_id: id.BCA, pay_date: "2026-09-21" });
  });

  await step("calo 75rb salah -> balik bayar -> batal (wajib alasan) -> koreksi 50rb", async () => {
    await fin.call("POST", `/jobs/${J1.id}/lines`, { kind: "CALO", partner_id: id.AGUS, amount: 75000, description: "Calo pelabuhan" });
    const C1 = await line(J1.id, "PURCHASE", "CALO");
    assert.match(await fin.call("POST", "/moves", { move_type: "in_invoice", phase: "SETTLEMENT_30", lines: [{ job_id: J1.id, job_line_id: C1, amount: 75000 }] }, 400), /Calo \/ biaya lain/);
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
    const el = await fin.call("GET", `/moves/eligible?move_type=out_invoice&phase=SETTLEMENT_30&partner_id=${id.LINTAS}`);
    assert.equal(el.find((e) => e.job_id === J1.id).suggested, 5674500);
    let inv = await createMove({ move_type: "out_invoice", phase: "SETTLEMENT_30", move_date: "2026-09-22", bank_account_id: id.BCA, lines: [{ job_id: J1.id, amount: 5674500 }] });
    assert.deepEqual([inv.tax_basis, inv.ppn_amount, inv.pph23_amount, inv.bill_to_name], [19500000, 214500, 390000, "LINTAS"]);
    await fin.call("POST", `/moves/${inv.id}/pay`, { amount: 674500, pay_date: "2026-09-30" });
    inv = await fin.call("POST", `/moves/${inv.id}/pay`, { pay_date: "2026-10-02" });
    assert.deepEqual([inv.amount_residual, inv.payments.length], [0, 2]);
  });

  await step("job FULL: DP ditolak, FULL boleh", async () => {
    assert.match(await fin.call("POST", "/moves", { move_type: "out_invoice", phase: "DP_70", lines: [{ job_id: J2.id, amount: 1000 }] }, 400), /tidak cocok|skema 100%/);
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
    await pay("DP_70", 5300000);
    await pay("SETTLEMENT_30", 2250000);
    const k = (await viewer.call("GET", "/kurang-transfer")).filter((r) => r.job_id === J3.id);
    assert.deepEqual(k.map((r) => [r.side, r.dp_kurang, r.pelunasan_kurang, r.kurang]), [["PURCHASE", 20000, 30000, 50000]]);
    const list = await viewer.call("GET", "/jobs?state=kurang_transfer");
    assert.deepEqual(list.map((r) => r.job_number), [J3.job_number]);
  });

  await step("transfer malam: kirim dana ke kas operasional -> salurkan sebagian -> sisa dikembalikan", async () => {
    const J4 = await job(ops, { pod_id: id.SBY, trip_type: "ONE_WAY", job_date: "2026-10-02" });
    let m = await createMove({ move_type: "in_invoice", phase: "DP_70", payment_channel: "TRANSFER_MALAM", lines: [{ job_id: J4.id, amount: 5320000 }] });
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
    let m = await createMove({ move_type: "in_invoice", phase: "DP_70", lines: [{ job_id: A.id, amount: 5320000 }, { job_id: B.id, amount: 5320000 }] });
    const lineB = m.lines.find((l) => l.job_id === B.id).id;
    m = await fin.call("POST", `/move-lines/${lineB}/cancel`, { reason: "job B batal berangkat" });
    assert.deepEqual([m.state, m.amount_total], ["posted", 5320000]);
    const again = await createMove({ move_type: "in_invoice", phase: "DP_70", lines: [{ job_id: B.id, amount: 5320000 }] });
    assert.equal(again.amount_total, 5320000, "job B bisa diajukan lagi");
  });

  await step("top-up cost (wajib alasan, tercatat di audit)", async () => {
    assert.match(await ops.call("POST", `/jobs/${J1.id}/topup`, { amount: 500000 }, 400), /Alasan/);
    await ops.call("POST", `/jobs/${J1.id}/topup`, { amount: 500000, reason: "Tambahan inap 1 malam" });
    const d = await viewer.call("GET", `/jobs/${J1.id}`);
    assert.equal(d.balance.cost_trucking, 18500000);
    assert.ok(d.audit.some((a) => a.action === "topup" && a.detail.reason === "Tambahan inap 1 malam"));
    // sisa top-up bisa diajukan
    const el = await fin.call("GET", `/moves/eligible?move_type=in_invoice&phase=SETTLEMENT_30&job_ids=${J1.id}`);
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

  await step("dashboard, rekap, aging, export Excel", async () => {
    const dash = await viewer.call("GET", "/dashboard");
    assert.ok(dash.totals.jobs >= 6);
    const rekap = await viewer.call("GET", "/rekap");
    assert.ok(rekap.some((r) => r.side === "PURCHASE" && r.phase === "DP_70"));
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
  });

  console.log(`\nSemua ${passed} langkah lolos.`);
} finally {
  server.close();
  await db.close();
}

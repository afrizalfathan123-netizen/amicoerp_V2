// Isi database DEMO (bukan data asli) untuk mencoba tampilan: master data, beberapa job, pengajuan, invoice, pembayaran,
// transfer malam, dan akun uji per role.
//
//   node scripts/demo-seed.js --data-dir=data/demo
//
// Akun uji (HANYA untuk database demo lokal): admin, finance, ops, viewer. Password semua akun: DEMO_PASSWORD di bawah.
import { openDb } from "../lib/db.js";
import { migrate } from "../lib/migrate.js";
import { hashPassword } from "../lib/auth.js";
import { createApp } from "../server.js";
import { CONFIG } from "../config.js";

const DEMO_PASSWORD = "demo-amico-2026";

const db = await openDb();
await migrate(db, { log: () => {} });
const [{ n }] = await db.query("select count(*)::int as n from job");
if (n > 0) {
  console.log(`Database ${CONFIG.dataDir} sudah berisi ${n} job, seed dilewati.`);
  await db.close();
  process.exit(0);
}
for (const [u, name, role] of [["admin", "Admin Demo", "ADMIN"], ["finance", "Finance Demo", "FINANCE"], ["ops", "Operasional Demo", "OPERATIONAL"], ["viewer", "Viewer Demo", "VIEWER"]]) {
  await db.query("insert into app_user (username, display_name, role, password_hash) values ($1, $2, $3, $4) on conflict (username) do nothing",
    [u, name, role, hashPassword(DEMO_PASSWORD)]);
}

const app = await createApp(db);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
function client() {
  let cookie = "";
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${url}: ${data.error}`);
    return data;
  };
}
const admin = client(), fin = client(), ops = client();
await admin("POST", "/login", { username: "admin", password: DEMO_PASSWORD });
await fin("POST", "/login", { username: "finance", password: DEMO_PASSWORD });
await ops("POST", "/login", { username: "ops", password: DEMO_PASSWORD });

try {
  await admin("PUT", "/settings", { company_name: "PT AMICO (DEMO)", company_address: "Jakarta", company_npwp: "00.000.000.0-000.000" });
  const L = {};
  for (const [code, name] of [["JRT", "Jakarta (Tanjung Priok)"], ["MES", "Medan"], ["SBY", "Surabaya"], ["SOC", "Solo"], ["JST", "Jakarta Selatan"], ["CKR", "Cikarang"], ["CKG", "Cakung"]]) {
    L[code] = (await ops("POST", "/locations", { code, name })).id;
  }
  const P = {};
  const partner = async (key, body) => (P[key] = (await fin("POST", "/partners", body)).id);
  await partner("LINTAS", { code: "LINTAS", name: "LINTAS (demo)", is_customer: true, pph_pct: 2, ppn_pct: 1.1, payment_terms_days: 8 });
  await partner("GARBA", { code: "GARBANTARA", name: "GARBANTARA (demo)", is_customer: true, pph_pct: 2, ppn_pct: 1.1 });
  await partner("FORTIS", { code: "FORTIS", name: "FORTIS (demo)", is_customer: true });
  await partner("SINAR", { code: "V-SINAR", name: "CV Sinar Jaya (demo)", is_vendor: true });
  await partner("DALAM", { code: "V-DALAMKOTA", name: "CV Dalam Kota (demo)", is_vendor: true });
  await partner("AGUS", { code: "V-AGUS", name: "Agus - calo (demo)", is_vendor: true });
  const bank = async (partner_id, bank_name, account_number, holder) => (await fin("POST", "/partner-banks", { partner_id, bank_name, account_number, holder, is_default: true })).id;
  const SB = await bank(P.SINAR, "BCA", "1234567890", "CV Sinar Jaya");
  const DB = await bank(P.DALAM, "Mandiri", "1122334455", "CV Dalam Kota");
  await bank(P.AGUS, "BRI", "0987654321", "Agus");
  const BCA = (await fin("POST", "/banks", { name: "BCA AMICO", bank_name: "BCA", account_number: "0000000001", holder: "PT AMICO", kind: "BANK", is_default: true, for_tax_invoice: true })).id;
  const KAS = (await fin("POST", "/banks", { name: "Kas Operasional", bank_name: "BCA", account_number: "0000000009", holder: "Operasional AMICO", kind: "OPERATIONAL" })).id;
  for (const [pol, pod, trip, selling, cost, customer] of [
    ["JRT", "MES", "ROUND_TRIP", 19500000, 18000000, null], ["JRT", "SBY", "ONE_WAY", 8500000, 7600000, null],
    ["JST", "SOC", "ONE_WAY", 3500000, 3000000, null], ["CKR", "CKG", "ONE_WAY", 550000, 450000, "FORTIS"]]) {
    await fin("POST", "/pricelist", { pol_id: L[pol], pod_id: L[pod], truck_type: "CDDL", trip_type: trip, selling, cost, customer_id: customer ? P[customer] : null });
  }
  await ops("POST", "/route-sla", { pol_id: L.JRT, pod_id: L.MES, trip_type: "ROUND_TRIP", sla_hours: 120 });
  await ops("POST", "/route-sla", { pol_id: L.JRT, pod_id: L.SBY, trip_type: "ONE_WAY", sla_hours: 30 });
  await ops("POST", "/route-sla", { pol_id: L.JST, pod_id: L.SOC, trip_type: "ONE_WAY", sla_hours: 18 });
  for (const plate of ["B 9123 ABC", "B 9456 DEF", "H 9269 GC", "AB 8125 KA"]) await ops("POST", "/vehicles", { plate_number: plate, truck_type: "CDDL", owner_partner_id: P.SINAR });

  const job = (extra) => ops("POST", "/jobs", { job_date: "2026-09-14", customer_id: P.LINTAS, vendor_id: P.SINAR, vendor_bank_id: SB,
    pol_id: L.JRT, pod_id: L.MES, trip_type: "ROUND_TRIP", truck_type: "CDDL", driver1_name: "Budi", driver1_phone: "081200000001", ...extra });
  const request = async (phase, lines, extra = {}) => {
    const m = await fin("POST", "/moves", { move_type: "in_invoice", phase, lines, post: true, ...extra });
    await admin("POST", `/moves/${m.id}/approve`, {});
    return m;
  };

  // Job 1: lunas semua (DP + pelunasan + calo), perjalanan selesai
  const j1 = await job({ plate_number: "B 9123 ABC", do_number: "DKGX26091401234" });
  const d1 = await request("DP", [{ job_id: j1.id, amount: 12600000 }], { move_date: "2026-09-15" });
  await fin("POST", `/moves/${d1.id}/pay`, { bank_account_id: BCA, pay_date: "2026-09-16" });
  const i1 = await fin("POST", "/moves", { move_type: "out_invoice", phase: "DP", bank_account_id: BCA, move_date: "2026-09-15", post: true, lines: [{ job_id: j1.id, amount: 13650000 }] });
  await fin("POST", `/moves/${i1.id}/pay`, { pay_date: "2026-09-17" });
  await ops("PUT", `/jobs/${j1.id}/trip`, { gate_out_at: "2026-09-14T08:00:00+07:00" });
  await ops("POST", `/jobs/${j1.id}/trip-updates`, { location: "Lampung", at: "2026-09-15T10:00:00+07:00" });
  await ops("PUT", `/jobs/${j1.id}/trip`, { gate_in_at: "2026-09-18T20:00:00+07:00", sj_number: "SJ-0001" });
  const s1 = await request("SETTLEMENT", [{ job_id: j1.id, amount: 5400000 }], { move_date: "2026-09-21" });
  await fin("POST", `/moves/${s1.id}/pay`, { bank_account_id: BCA, pay_date: "2026-09-21" });
  await fin("POST", `/jobs/${j1.id}/lines`, { kind: "CALO", partner_id: P.AGUS, amount: 50000, description: "Calo pelabuhan" });
  const calo = (await fin("GET", `/jobs/${j1.id}`)).lines.find((l) => l.kind === "CALO");
  const c1 = await request("OTHER", [{ job_id: j1.id, job_line_id: calo.job_line_id, amount: 50000 }], { move_date: "2026-09-22" });
  await fin("POST", `/moves/${c1.id}/pay`, { bank_account_id: BCA, pay_date: "2026-09-22" });
  const st1 = await fin("POST", "/moves", { move_type: "out_invoice", phase: "SETTLEMENT", bank_account_id: BCA, move_date: "2026-09-22", post: true, lines: [{ job_id: j1.id, amount: 5674500 }] });
  await fin("POST", `/moves/${st1.id}/pay`, { pay_date: "2026-10-02" });

  // Job 2: DP dibayar, pelunasan kurang 50rb (ditandai kurang transfer)
  const j2 = await job({ plate_number: "H 9269 GC", customer_id: P.GARBA, pol_id: L.JST, pod_id: L.SOC, trip_type: "ONE_WAY", job_date: "2026-09-20" });
  const d2 = await request("DP", [{ job_id: j2.id, amount: 2100000 }], { move_date: "2026-09-20" });
  await fin("POST", `/moves/${d2.id}/pay`, { bank_account_id: BCA, pay_date: "2026-09-20" });
  const s2 = await request("SETTLEMENT", [{ job_id: j2.id, amount: 850000 }], { move_date: "2026-09-24" });
  await fin("POST", `/moves/${s2.id}/pay`, { bank_account_id: BCA, pay_date: "2026-09-24" });

  // Job 3: sedang jalan, DP via transfer malam (dana masih di kas operasional), invoice DP belum dibayar
  const j3 = await job({ plate_number: "B 9456 DEF", pod_id: L.SBY, trip_type: "ONE_WAY", job_date: "2026-10-04" });
  await ops("PUT", `/jobs/${j3.id}/trip`, { gate_out_at: "2026-10-04T20:00:00+07:00" });
  await ops("POST", `/jobs/${j3.id}/trip-updates`, { location: "Kendal", note: "foto Timemark" });
  const d3 = await request("DP", [{ job_id: j3.id, amount: 5320000 }], { move_date: "2026-10-04", payment_channel: "TRANSFER_MALAM" });
  await fin("POST", `/moves/${d3.id}/fund`, { from_account_id: BCA, to_account_id: KAS, transfer_date: "2026-10-04" });
  await fin("POST", "/moves", { move_type: "out_invoice", phase: "DP", bank_account_id: BCA, move_date: "2026-10-05", post: true, lines: [{ job_id: j3.id, amount: 5950000 }] });

  // Job 4: dalam kota FULL, lunas; Job 5: baru dibuat, pengajuan menunggu persetujuan
  const j4 = await ops("POST", "/jobs", { job_date: "2026-10-05", customer_id: P.FORTIS, vendor_id: P.DALAM, vendor_bank_id: DB, pol_id: L.CKR, pod_id: L.CKG,
    truck_type: "CDDL", delivery_scope: "INNERCITY", rit_number: 1, plate_number: "AB 8125 KA" });
  const f4 = await request("FULL", [{ job_id: j4.id, amount: 450000 }], { move_date: "2026-10-05" });
  await fin("POST", `/moves/${f4.id}/pay`, { bank_account_id: BCA, pay_date: "2026-10-05" });
  const fi4 = await fin("POST", "/moves", { move_type: "out_invoice", phase: "FULL", bank_account_id: BCA, move_date: "2026-10-05", post: true, lines: [{ job_id: j4.id, amount: 550000 }] });
  await fin("POST", `/moves/${fi4.id}/pay`, { pay_date: "2026-10-06" });
  const j5 = await job({ job_date: "2026-10-06", plate_number: "B 9123 ABC" });
  await fin("POST", "/moves", { move_type: "in_invoice", phase: "DP", move_date: "2026-10-06", post: true, lines: [{ job_id: j5.id, amount: 12600000 }] });

  console.log(`Data demo dibuat di ${CONFIG.dataDir}. Akun uji: admin / finance / ops / viewer (password di scripts/demo-seed.js).`);
} finally {
  server.close();
  await db.close();
}

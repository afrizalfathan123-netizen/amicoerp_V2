// Job: daftar, form (operasional + harga), detail (perjalanan, baris order, dokumen, jurnal kas, riwayat).
import {
  state, api, get, view, esc, rp, tgl, jam, kv, tile, badge, options, enumOptions, table, toast, openModal, askReason,
  action, customers, vendors, partnerBanksOf, locLabel, num, today, debounce, bindRows, canJob, canFinance, canRequest,
  KIND_LABEL, PHASE_LABEL, phaseLabel, SELLING_MODES, STAGE_LABEL, stageBadge, SJ_STATUS_LABEL, SJ_LATE_LABEL, BILL_LABEL, isAdmin, SCHEME_LABEL, SCHEME_SHORT, dtLocal, fromDtLocal, loadMaster,
  latest, skelTable, skelTiles,
} from "../lib.js";
import { gateModal, positionModal } from "./tracker.js";
import { ledgerTable, shortPanel } from "./reports.js";
import { unassignedTable } from "./unassigned.js";
import { xlTable } from "../xlfilter.js";
import { parseWaJob } from "../wa-paste.js";
import { batchJobForm } from "./jobs-batch.js";

const SCOPE = { INTERCITY: "Antar kota", INNERCITY: "Dalam kota" };
const TRIP = { ONE_WAY: "One way", ROUND_TRIP: "PP / round trip" };

function shortBadge(j) {
  const parts = [];
  if (j.kurang_transfer_vendor > 0) parts.push(`ke vendor ${rp(j.kurang_transfer_vendor)}`);
  if (j.kurang_bayar_customer > 0) parts.push(`dari customer ${rp(j.kurang_bayar_customer)}`);
  return parts.length ? `<br><span class="badge warn" title="Kurang transfer ${esc(parts.join(", "))}">Kurang transfer</span>` : "";
}

// Kolom daftar job: filter & urut ala Excel di header (lihat xlfilter.js)
const routeOf = (j) => `${j.pol} - ${j.pod}${j.trip_type === "ROUND_TRIP" ? " PP" : ""}`;
const JOB_COLUMNS = [
  { key: "job_number", label: "No job", value: (j) => j.job_number },
  { key: "do_number", label: "Kode tugas", value: (j) => j.do_number },
  { key: "job_date", label: "Tgl", value: (j) => tgl(j.job_date) },
  // filter per tanggal (dan "(Kosong)" = belum diisi), urut per jam
  { key: "gate_out", label: "Gate out", value: (j) => j.gate_out_at || "", text: (j) => dtLocal(j.gate_out_at).slice(0, 10) },
  { key: "gate_in", label: "Gate in", value: (j) => j.gate_in_at || "", text: (j) => dtLocal(j.gate_in_at).slice(0, 10) },
  { key: "customer", label: "Customer", value: (j) => j.customer },
  { key: "route", label: "Rute", value: routeOf },
  { key: "truck_type", label: "Truk", value: (j) => j.truck_type },
  { key: "plate_number", label: "Plat", value: (j) => j.plate_number },
  { key: "driver", label: "Driver", value: (j) => j.driver1_name },
  { key: "scheme", label: "Skema", value: (j) => SCHEME_SHORT[j.customer_scheme] },
  { key: "selling", label: "Selling", num: true, value: (j) => j.selling },
  { key: "cost", label: "Cost", num: true, value: (j) => j.cost },
  { key: "piutang", label: "Piutang", num: true, value: (j) => j.selling - j.received },
  { key: "utang", label: "Utang", num: true, value: (j) => j.cost - j.paid },
  { key: "stage", label: "Status", value: (j) => STAGE_LABEL[j.stage] || j.stage },
];
// Gate out / gate in diisi langsung di daftar job (disimpan saat pindah dari kotaknya). Gate out = unit selesai muat & berangkat, gate in = sampai.
const gateNote = (j) => {
  if (!j.gate_out_at) return "";
  const dur = j.durasi_jam == null ? "" : `${rp(j.durasi_jam)} jam`;
  const txt = j.gate_in_at ? `selesai ${dur}` : `jalan ${dur}`;
  return `<span class="${j.lewat_sla ? "warn-text" : "muted"}">${esc(txt)}${j.sla_hours ? ` / SLA ${rp(j.sla_hours)}` : ""}${j.lewat_sla ? " · lewat SLA" : ""}</span>`;
};
const gateCell = (j, field) => {
  const v = dtLocal(j[field]);
  if (!canJob() || j.state === "cancelled") return `<td class="nowrap">${jam(j[field])}</td>`;
  const blocked = field === "gate_in_at" && !j.gate_out_at;
  return `<td class="gate-cell" data-noclick><span class="gate-box"><input type="datetime-local" data-gate="${field}" value="${v}" ${blocked ? "disabled" : ""}
      title="${field === "gate_out_at" ? "Gate out: unit selesai muat dan berangkat" : blocked ? "Isi gate out dulu" : "Gate in: unit sudah sampai"}">
    <button type="button" class="small" data-gate-now="${field}" title="Isi dengan jam sekarang" ${v || blocked ? "hidden" : ""}>Kini</button></span>
    ${field === "gate_in_at" ? `<div class="gate-note">${gateNote(j)}</div>` : ""}</td>`;
};
const stageCell = (j) => `${stageBadge(j.stage)}${j.sj_late ? `<br><span class="badge warn" title="${esc(SJ_LATE_LABEL[j.sj_late])}">SJ terlambat</span>` : ""}${shortBadge(j)}`;
const jobRow = (j) => `<tr class="click" data-href="#/jobs/${j.id}" data-job="${j.id}">
  <td><b>${esc(j.job_number)}</b></td><td>${esc(j.do_number || "")}</td><td class="nowrap">${tgl(j.job_date)}</td>${gateCell(j, "gate_out_at")}${gateCell(j, "gate_in_at")}<td>${esc(j.customer)}</td>
  <td>${esc(routeOf(j))}${j.delivery_scope === "INNERCITY" ? `<br><span class="muted">dalam kota${j.rit_number ? ` rit ${j.rit_number}` : ""}</span>` : ""}</td>
  <td>${esc(j.truck_type)}</td><td class="nowrap">${esc(j.plate_number || "")}</td><td>${esc(j.driver1_name || "")}</td>
  <td>${SCHEME_SHORT[j.customer_scheme]}${j.vendor_scheme !== j.customer_scheme ? `<br><span class="muted">vendor ${SCHEME_SHORT[j.vendor_scheme]}</span>` : ""}</td>
  <td class="num">${rp(j.selling)}</td><td class="num">${rp(j.cost)}</td>
  <td class="num">${rp(j.selling - j.received)}</td><td class="num">${rp(j.cost - j.paid)}</td>
  <td class="c-stage">${stageCell(j)}</td></tr>`;
const PASTE_BY = { job: "No job", do: "Kode tugas" };
const norm = (v) => String(v || "").replace(/\s/g, "").toUpperCase();
const LIMIT = 5000;

export async function renderJobs() {
  const f = JSON.parse(sessionStorage.getItem("jobFilter") || "{}");
  let paste = JSON.parse(sessionStorage.getItem("jobPaste") || "null");   // { by, numbers }
  view().innerHTML = `
    <div class="page-head"><h1>Job</h1><div class="spacer"></div>
      <div class="actions"><a class="btn" id="exportJobs" title="Export job yang tampil di tabel">Export Excel</a>
        ${isAdmin() ? `<label class="btn" style="flex-direction:row" title="Lengkapi job dari export Job List ERP AMICO v1 (driver, gate, SJ, vendor, rekening) dan tambah job yang belum ada">Impor Job List v1<input type="file" id="importV1" accept=".xlsx" hidden></label>` : ""}
        ${canJob() ? `<button id="batchJob" title="Tempel absen WhatsApp (RIT 1, RIT 2, ...): satu job per rit">Buat banyak job</button>
          <button class="primary" id="newJob">+ Job baru</button>` : ""}</div></div>
    <div class="tiles" id="stageTiles">${skelTiles(7)}</div>
    <div class="panel">
      <div class="filters">
        <label>Cari<input id="jSearch" placeholder="No job, plat, DO, customer, driver" value="${esc(f.search || "")}"></label>
        <label>Status<select id="jStage"><option value="">Semua</option>${enumOptions(STAGE_LABEL, f.stage)}</select></label>
        <label>Lainnya<select id="jState"><option value="">-</option>${enumOptions({ kurang_transfer: "Kurang transfer", cancelled: "Dibatalkan" }, f.state)}</select></label>
        <label>Lingkup<select id="jScope"><option value="">Semua</option>${enumOptions(SCOPE, f.scope)}</select></label>
        <label>Dari<input type="date" id="jFrom" value="${esc(f.from || "")}"></label>
        <label>Sampai<input type="date" id="jTo" value="${esc(f.to || "")}"></label>
        <button id="jPaste" title="Tempel daftar no job / kode tugas dari Excel atau WhatsApp">Tempel daftar</button>
      </div>
      <div id="dupDoBox"></div>
      <div id="pasteBox"></div>
      <div id="jobTable">${skelTable(10, 8)}</div>
    </div>`;
  document.getElementById("newJob")?.addEventListener("click", () => jobForm());
  document.getElementById("batchJob")?.addEventListener("click", () => batchJobForm());
  const el = (id) => document.getElementById(id);
  const topIds = ["jSearch", "jStage", "jState", "jScope", "jFrom", "jTo"];
  // urutan bawaan: sesuai urutan tempelan kalau sedang memakai daftar tempel
  const pos = () => new Map((paste?.numbers || []).map((n, i) => [n, i]));
  let posMap = pos();
  const keyOf = (j) => norm(paste?.by === "do" ? j.do_number : j.job_number);
  const grid = xlTable(el("jobTable"), {
    id: "jobs", columns: JOB_COLUMNS, rowHtml: jobRow, empty: "Tidak ada job",
    order: (a, b) => (paste ? (posMap.get(keyOf(a)) ?? 1e9) - (posMap.get(keyOf(b)) ?? 1e9) : 0),
    onChange: () => bindRows(el("jobTable")),
  });

  const showPaste = (rows) => {
    for (const k of topIds) el(k).disabled = !!paste;
    if (!paste) { el("pasteBox").innerHTML = ""; return; }
    const found = new Map();
    for (const j of rows) found.set(keyOf(j), (found.get(keyOf(j)) || 0) + 1);
    const missing = paste.numbers.filter((n) => !found.has(n));
    const dup = [...found.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    el("pasteBox").innerHTML = `<div class="note-box warn-box paste-box"><span>
      Menampilkan <b>${rp(paste.numbers.length)} ${esc(PASTE_BY[paste.by].toLowerCase())}</b> dari daftar tempel:
      ${rp(paste.numbers.length - missing.length)} ketemu${missing.length ? `, <b>${rp(missing.length)} tidak ketemu</b>` : ""}${dup.length ? `, ${rp(dup.length)} dipakai lebih dari satu job` : ""}.
      Filter di atas tidak dipakai selama daftar tempel aktif.</span>
      <span class="spacer"></span>
      ${missing.length ? `<button type="button" class="small" id="pMissing">Lihat yang tidak ketemu</button>` : ""}
      <button type="button" class="small" id="pEdit">Ubah daftar</button><button type="button" class="small" id="pClear">Hapus daftar</button></div>`;
    el("pClear").onclick = () => { paste = null; sessionStorage.removeItem("jobPaste"); load(); };
    el("pEdit").onclick = pasteModal;
    el("pMissing")?.addEventListener("click", () => openModal({
      title: `${rp(missing.length)} ${PASTE_BY[paste.by].toLowerCase()} tidak ketemu`,
      body: `<textarea rows="12" style="width:100%" readonly>${esc(missing.join("\n"))}</textarea>
        <div class="note-box">${paste.by === "do" ? "Kode tugas harus sama persis dengan yang tercatat di job (huruf besar / kecil dan spasi diabaikan)." : "Cek salah ketik nomor, atau job memang belum ada di ERP."}</div>`,
    }));
  };

  // ---- gate out / gate in langsung di tabel: simpan saat keluar dari kotak (bukan tiap ketikan, supaya tahun setengah jadi tidak tersimpan)
  let current = [];
  const saveGate = async (input) => {
    const tr = input.closest("tr[data-job]");
    const j = current.find((x) => x.id === Number(tr?.dataset.job));
    if (!j) return;
    const field = input.dataset.gate;
    const label = field === "gate_out_at" ? "gate out" : "gate in";
    if (input._saving) return;                          // tempel lalu langsung pindah kotak: jangan simpan dua kali
    // tanggal / jam baru terisi sebagian (browser memberi nilai kosong): jangan dianggap "hapus"
    if (input.validity?.badInput) {
      input.value = dtLocal(j[field]);
      return toast(`${j.job_number}: ${label} belum lengkap (tanggal dan jam), tidak disimpan`, true);
    }
    if (input.value === dtLocal(j[field])) return;
    input._saving = true;
    try {
      // mengosongkan gate yang sudah terisi = menghapus: minta kepastian dulu
      if (!input.value && !window.confirm(`Hapus ${label} ${j.job_number} (${jam(j[field])})?`)) {
        input.value = dtLocal(j[field]);
        return;
      }
      await api("PUT", `/jobs/${j.id}/trip`, { [field]: fromDtLocal(input.value) });
      // baris itu saja yang diperbarui (status, durasi, SLA), tabel tidak digambar ulang supaya bisa lanjut ke kotak berikutnya
      const [fresh] = await api("POST", "/jobs/query", { numbers: [j.job_number], by: "job" });
      if (fresh) Object.assign(j, fresh);
      toast(`${j.job_number}: ${label} ${input.value ? "dicatat" : "dihapus"}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      input._saving = false;
    }
    if (!tr.isConnected) return;
    tr.querySelector(".c-stage").innerHTML = stageCell(j);
    tr.querySelector(".gate-note").innerHTML = gateNote(j);
    tr.querySelectorAll("[data-gate]").forEach((i) => {
      if (i !== document.activeElement || i === input) i.value = dtLocal(j[i.dataset.gate]);
      i.disabled = i.dataset.gate === "gate_in_at" && !j.gate_out_at;
      i.title = i.dataset.gate === "gate_out_at" ? "Gate out: unit selesai muat dan berangkat" : i.disabled ? "Isi gate out dulu" : "Gate in: unit sudah sampai";
      tr.querySelector(`[data-gate-now="${i.dataset.gate}"]`).hidden = !!i.value || i.disabled;
    });
    tiles().catch(() => {});
  };
  el("jobTable").addEventListener("focusout", (e) => { if (e.target.matches?.("[data-gate]")) saveGate(e.target); });
  el("jobTable").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches?.("[data-gate]")) e.target.blur(); });
  // tempel "14/10/2026 03:32" (lihat app.js): nilainya sudah lengkap, langsung simpan
  el("jobTable").addEventListener("amico:pasted", (e) => { if (e.target.matches?.("[data-gate]")) saveGate(e.target); });
  el("jobTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-gate-now]");
    if (!b) return;
    const input = b.parentElement.querySelector("[data-gate]");
    input.value = dtLocal(new Date().toISOString());
    saveGate(input);
  });

  const only = latest();   // mengetik cepat di kotak cari: hanya jawaban terakhir yang dipakai
  const load = async () => {
    const flt = Object.fromEntries(topIds.map((k) => [k.slice(1).toLowerCase(), el(k).value]));
    sessionStorage.setItem("jobFilter", JSON.stringify(flt));
    const rows = await only(paste
      ? api("POST", "/jobs/query", { numbers: paste.numbers, by: paste.by, limit: LIMIT })
      : get(`/jobs?${new URLSearchParams({ ...flt, limit: LIMIT })}`));
    current = rows;
    posMap = pos();
    showPaste(rows);
    grid.setRows(rows);
    if (rows.length >= LIMIT) el("jobTable").insertAdjacentHTML("beforeend", `<div class="note-box">Ditampilkan ${rp(LIMIT)} job terbaru. Persempit dengan filter tanggal.</div>`);
  };

  function pasteModal() {
    openModal({
      title: "Tempel daftar job",
      body: `<div class="form-grid">
          <label>Cari berdasarkan<select name="by">${enumOptions(PASTE_BY, paste?.by || "job")}</select></label></div>
        <label>Daftar (satu per baris, atau dipisah koma / spasi)<textarea name="list" rows="12" style="width:100%" placeholder="AMC/2610/0288&#10;AMC/2610/0289&#10;...">${esc((paste?.numbers || []).join("\n"))}</textarea></label>
        <div class="note-box">Tempel langsung dari kolom Excel atau chat WhatsApp. Tabel menampilkan job sesuai urutan daftar; filter & urut per kolom tetap bisa dipakai, dan Export Excel mengikuti yang tampil.</div>`,
      submitLabel: "Tampilkan",
      onSubmit: async (d) => {
        const numbers = [...new Set(String(d.list).split(/[\s,;]+/).map(norm).filter(Boolean))];
        if (!numbers.length) throw new Error("Daftar masih kosong");
        paste = { by: d.by, numbers };
        sessionStorage.setItem("jobPaste", JSON.stringify(paste));
        await load();
      },
    });
  }
  el("jPaste").onclick = pasteModal;
  el("jSearch").oninput = debounce(load);
  for (const k of ["jStage", "jState", "jScope", "jFrom", "jTo"]) el(k).onchange = load;
  el("exportJobs").onclick = async () => {
    // ada filter kolom / daftar tempel -> export persis yang tampil; selain itu pakai filter tanggal & status
    if (paste || grid.active() || el("jSearch").value || el("jState").value || el("jScope").value) {
      const ids = grid.visible().map((j) => j.id);
      if (!ids.length) return toast("Tidak ada job yang tampil", true);
      try {
        const res = await fetch("/api/export/job-list.xlsx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Export gagal");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(await res.blob());
        a.download = `job-list-${today()}.xlsx`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (e) { toast(e.message, true); }
      return;
    }
    const q = new URLSearchParams(Object.fromEntries(Object.entries({ stage: el("jStage").value, from: el("jFrom").value, to: el("jTo").value }).filter(([, v]) => v)));
    location.href = `/api/export/job-list.xlsx?${q}`;
  };
  el("importV1")?.addEventListener("change", (e) => importV1Modal(e.target.files[0], load));
  // ringkasan per status, klik untuk memfilter. Dimuat bersamaan dengan daftar job, tidak saling menunggu.
  // kode tugas dobel (data lama): satu kode tugas hanya untuk satu job -> tunjukkan supaya dibetulkan
  get("/jobs/duplicate-do").then((d) => {
    const box = el("dupDoBox");
    if (!box || !d.length) return;
    box.innerHTML = `<div class="note-box warn-box paste-box"><span><b>${rp(d.length)} kode tugas dipakai lebih dari satu job</b>
      (${rp(d.reduce((a, x) => a + x.jobs.length, 0))} job). Satu kode tugas hanya untuk satu job (one way walau banyak titik bongkar; round trip cukup kode tugas pergi).
      Betulkan di menu Sisihkan.</span><span class="spacer"></span><a class="btn small" href="#/sisihkan">Buka Sisihkan</a>
      <button type="button" class="small" id="dupDoShow">Tampilkan di tabel ini</button></div>`;
    el("dupDoShow").onclick = () => {
      paste = { by: "do", numbers: d.map((x) => x.kode_tugas) };
      sessionStorage.setItem("jobPaste", JSON.stringify(paste));
      load();
    };
  }).catch(() => {});
  const tiles = async () => {
    const sum = await get("/sj/summary");
    el("stageTiles").innerHTML = ["RENCANA", "JALAN", "MENUNGGU_SJ", "SIAP_TAGIH", "KIRIM_SJ", "MENUNGGU_BAYAR", "SELESAI"].map((s) =>
      `<a href="#" class="tile" data-stage="${s}"><div class="label">${esc(STAGE_LABEL[s])}</div><div class="value">${rp(sum.stages[s] || 0)}</div></a>`).join("");
    el("stageTiles").querySelectorAll("[data-stage]").forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      if (paste) return toast("Hapus daftar tempel dulu untuk memfilter per status", true);
      el("jStage").value = el("jStage").value === a.dataset.stage ? "" : a.dataset.stage;
      load();
    }));
  };
  await Promise.all([tiles(), load()]);
}

// Impor export Job List v1: pratinjau dulu, lalu simpan
function importV1Modal(file, reload) {
  if (!file) return;
  const send = async (params) => {
    const res = await fetch(`/api/import/joblist-v1?${new URLSearchParams({ name: file.name, ...params })}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Gagal");
    return data;
  };
  const show = (r) => {
    const s = r.stats;
    return `<div class="kv">
      ${kv("Baris di file v1", rp(r.rows))}${kv("Job dilengkapi", rp(s.jobs_updated))}${kv("Kolom diisi", rp(s.fields_filled))}
      ${kv("Job baru (harga 0)", rp(s.new_jobs))}${kv("Vendor baru", rp(s.vendors_created))}${kv("Rekening baru", rp(s.banks))}
      ${kv("Job yang vendornya diisi", rp(s.vendor_set))}${kv("Isian buatan v1 diabaikan", rp(s.fake_skipped))}${kv("Beda v1 vs v2 (tidak ditimpa)", rp(s.conflicts))}${kv("Perlu dicek", rp(r.issues))}
    </div>
    <div class="note-box">Uang (invoice, pengajuan, pembayaran) tidak diubah. Kolom v2 yang kosong diisi dari v1; yang beda dibiarkan dan dicatat.
      <a href="/api/import/reports/${encodeURIComponent(r.report)}">Unduh laporan lengkap</a></div>`;
  };
  openModal({
    title: `Impor Job List v1: ${file.name}`, wide: true, submitLabel: "Simpan impor",
    body: `<div id="v1Box"><p class="muted">Membaca file dan membuat pratinjau...</p></div>
      <label class="check"><input type="checkbox" name="timpa"> Timpa juga kolom yang beda dengan nilai v1 (gate, plat, jenis truk, SJ)</label>`,
    onOpen: async () => {
      try { document.getElementById("v1Box").innerHTML = `<h4>Pratinjau (belum disimpan)</h4>${show(await send({ pratinjau: "1" }))}`; }
      catch (err) { document.getElementById("v1Box").innerHTML = `<div class="modal-error">${esc(err.message)}</div>`; }
    },
    onSubmit: async (d) => {
      const r = await send(d.timpa ? { timpa: "1" } : {});
      document.getElementById("v1Box").innerHTML = `<h4>Tersimpan</h4>${show(r)}`;
      toast("Impor Job List v1 selesai");
      reload();
      return true;
    },
  });
}

export function jobForm(job = null, balance = null) {
  const j = job || { job_date: today(), trip_type: "ONE_WAY", truck_type: "CDDL", delivery_scope: "INTERCITY", service_type: "TRUCKING", selling_mode: "PRICE_BOOK" };
  const locked = balance && (balance.invoiced > 0 || balance.requested > 0);
  const lockCust = balance && balance.invoiced > 0;
  const lockVend = balance && balance.requested > 0;
  const VENDOR_SCHEME = { "70_30": SCHEME_LABEL["70_30"], FULL: SCHEME_LABEL.FULL };
  const c = state.cache;
  const purchase = job?.lines?.find((l) => l.side === "PURCHASE" && l.kind === "TRUCKING");
  openModal({
    title: job ? `Edit ${job.job_number}` : "Job baru",
    wide: true,
    body: `
      ${job ? "" : `<div class="wa-paste">
        <div class="wa-head"><b>Tempel dari WhatsApp</b>
          <span class="muted">Tempel teks unit dari chat (Tanggal, Rute, Nama / Driver, Nopol, No HP, Kode Tugas): form langsung terisi. Customer, rekening, dan harga tetap Anda isi.</span></div>
        <textarea id="waText" rows="4" placeholder="Tanggal : 12/10/2026&#10;Rute : JST-SOC&#10;Nama : Ananda&#10;Nopol : H 1234 OC&#10;No hp : 0812xxxxxxxx&#10;Kode Tugas : ..."></textarea>
        <div class="wa-foot"><button type="button" class="small" id="waApply">Isi form dari teks</button><span id="waInfo"></span></div>
      </div>`}
      <h4>Order</h4>
      <div class="form-grid">
        <label>Tanggal<input type="date" name="job_date" value="${tgl(j.job_date)}" required></label>
        <label>Customer<select name="customer_id" required ${locked ? "disabled" : ""}>${options(customers(), j.customer_id, undefined, "- pilih -")}</select></label>
        <label>Lingkup<select name="delivery_scope">${enumOptions(SCOPE, j.delivery_scope)}</select></label>
        <label>Rit ke- (dalam kota)<input type="number" min="1" name="rit_number" value="${esc(j.rit_number ?? "")}"></label>
        <label>POL<select name="pol_id" required>${options(c.locations.filter((l) => l.active), j.pol_id, locLabel, "- pilih -")}</select></label>
        <label>POD<select name="pod_id" required>${options(c.locations.filter((l) => l.active), j.pod_id, locLabel, "- pilih -")}</select></label>
        <label>Trip<select name="trip_type">${enumOptions(TRIP, j.trip_type)}</select></label>
        <label>DO / kode tugas<input name="do_number" value="${esc(j.do_number || "")}"></label>
      </div>
      <h4>Unit & driver</h4>
      <div class="form-grid">
        <label>Plat<input name="plate_number" list="plates" value="${esc(j.plate_number || "")}" placeholder="B 1234 ABC"></label>
        <label>Jenis truk<input name="truck_type" list="truckTypes" value="${esc(j.truck_type)}" required></label>
        <label>Vendor trucking<select name="vendor_id">${options(vendors(), j.vendor_id, undefined, "- belum ditentukan -")}</select></label>
        <label>Rekening vendor<select name="vendor_bank_id"></select></label>
        <label>atau rekening baru: bank<input name="new_bank_name" placeholder="BCA"></label>
        <label>No rekening<input name="new_account_number"></label>
        <label>Atas nama<input name="new_holder" placeholder="boleh beda dengan vendor"></label>
        <label>Driver 1<input name="driver1_name" value="${esc(j.driver1_name || "")}"></label>
        <label>HP driver 1<input name="driver1_phone" value="${esc(j.driver1_phone || "")}"></label>
        <label>Driver 2<input name="driver2_name" value="${esc(j.driver2_name || "")}"></label>
        <label>HP driver 2<input name="driver2_phone" value="${esc(j.driver2_phone || "")}"></label>
      </div>
      <h4>Harga</h4>
      <div class="form-grid">
        <div class="wide price-info" id="priceInfo">Pilih customer, rute, truk, dan trip untuk melihat price book.</div>
        <label>Skema bayar customer<select name="customer_scheme" ${lockCust ? "disabled" : ""}>${enumOptions(SCHEME_LABEL, j.customer_scheme || "70_30")}</select></label>
        <label>Skema bayar vendor<select name="vendor_scheme" ${lockVend ? "disabled" : ""}>${enumOptions(VENDOR_SCHEME, j.vendor_scheme || "70_30")}</select></label>
        <label>Selling<select name="selling_mode">${enumOptions(SELLING_MODES, j.selling_mode)}</select></label>
        <label>Nominal selling<input class="num" name="selling" value="${balance ? (job.lines.find((l) => l.side === "SALE" && l.kind === "TRUCKING")?.amount ?? "") : ""}"></label>
        <label>Cost truk<input class="num" name="cost" value="${purchase?.amount ?? ""}" placeholder="Kosong = dari price book"></label>
        <label>Selling setelah pajak<input class="num" name="selling_after_tax" value="${j.selling_after_tax ?? ""}" placeholder="Kosong = dari pajak customer"></label>
        <label class="wide">Catatan<textarea name="note" rows="2">${esc(j.note || "")}</textarea></label>
      </div>
      <datalist id="truckTypes">${[...new Set(c.pricelist.map((p) => p.truck_type).concat(c.vehicles.map((v) => v.truck_type), ["CDD", "CDDL", "FUSO", "TRONTON", "WINGBOX"]))].map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      <datalist id="plates">${c.vehicles.filter((v) => v.active).map((v) => `<option value="${esc(v.plate_number)}">${esc(v.truck_type)}</option>`).join("")}</datalist>
      ${locked ? `<div class="note-box">Customer dan skema bayar sisi yang sudah ditagih / diajukan terkunci. Harga tidak bisa diturunkan di bawah yang sudah ditagih / diajukan.</div>
        <div class="form-grid" id="rerouteBox" hidden>
          <div class="wide note-box warn-box">Reroute: rute / truk berubah setelah ada pengajuan / invoice. Pengajuan lama <b>tidak dibalik</b>.
            Cost & selling diambil dari price book rute baru (kosongkan = price book, atau isi manual). Selisihnya diajukan sebagai
            <b>DP tambahan</b> (sampai 70% cost baru) dan sisanya di pelunasan.</div>
          <label class="wide">Alasan reroute (wajib)<input name="reason" placeholder="contoh: reroute permintaan gudang JST - SOC ke JST - MDN"></label>
        </div>` : ""}`,
    onOpen: (form) => {
      let price = null;
      const E = form.elements;
      const fillBanks = () => {
        const banks = partnerBanksOf(E.vendor_id.value);
        E.vendor_bank_id.innerHTML = options(banks, purchase?.partner_bank_id || banks.find((b) => b.is_default)?.id, (b) => `${b.bank_name} ${b.account_number} a.n. ${b.holder}`, banks.length ? "- pilih -" : "- belum ada rekening -");
      };
      const applyMode = () => {
        const mode = E.selling_mode.value;
        E.selling.disabled = mode !== "CUSTOM";
        if (mode === "ZERO") E.selling.value = 0;
        if (mode === "PRICE_BOOK") E.selling.value = price?.selling ?? "";
      };
      const lookup = async () => {
        const info = form.querySelector("#priceInfo");
        if (!E.pol_id.value || !E.pod_id.value || !E.truck_type.value) return applyMode();
        price = await get(`/price-lookup?${new URLSearchParams({ customer_id: E.customer_id.value || j.customer_id || "", pol_id: E.pol_id.value, pod_id: E.pod_id.value, truck_type: E.truck_type.value, trip_type: E.trip_type.value, date: E.job_date.value })}`);
        if (price && (price.selling != null || price.cost != null)) {
          info.className = "wide price-info";
          info.textContent = `Price book: selling ${price.selling != null ? `${rp(price.selling)} (${price.selling_source})` : "-"}, cost ${price.cost != null ? `${rp(price.cost)} (${price.cost_source})` : "-"}`;
          if (!job && !E.cost.value && price.cost != null) E.cost.placeholder = `${rp(price.cost)} (price book)`;
        } else {
          info.className = "wide price-info missing";
          info.textContent = "Belum ada price book untuk kombinasi ini. Pilih Custom atau isi price book di Master Data.";
        }
        applyMode();
      };
      E.plate_number.addEventListener("change", () => {
        const v = c.vehicles.find((x) => x.plate_number === E.plate_number.value.trim().toUpperCase());
        if (v) {
          E.truck_type.value = v.truck_type;
          if (v.owner_partner_id && !E.vendor_id.value) { E.vendor_id.value = v.owner_partner_id; fillBanks(); }
          lookup();
        }
      });
      // skema default: setting partner, kalau kosong dalam kota 100% / antar kota 70/30
      const partnerScheme = (id) => state.cache.partners.find((p) => p.id === Number(id))?.payment_scheme || null;
      const scopeScheme = () => (E.delivery_scope.value === "INNERCITY" ? "FULL" : "70_30");
      const applySchemes = () => {
        if (!lockCust) E.customer_scheme.value = partnerScheme(E.customer_id.value) || scopeScheme();
        const v = partnerScheme(E.vendor_id.value);
        if (!lockVend) E.vendor_scheme.value = v === "FULL" || v === "70_30" ? v : scopeScheme();
      };
      for (const n of ["delivery_scope", "customer_id", "vendor_id"]) E[n].addEventListener("change", applySchemes);
      E.vendor_id.addEventListener("change", fillBanks);
      E.selling_mode.onchange = applyMode;
      for (const n of ["customer_id", "pol_id", "pod_id", "truck_type", "trip_type", "job_date"]) E[n].addEventListener("change", lookup);
      // job lama ganti rute: cost lama dikosongkan supaya ikut price book rute baru, alasan wajib kalau sudah ada dokumen
      if (job) for (const n of ["pol_id", "pod_id", "truck_type", "trip_type"]) E[n].addEventListener("change", () => {
        const moved = ["pol_id", "pod_id", "truck_type", "trip_type"].some((k) => String(E[k].value) !== String(job[k] ?? ""));
        if (moved) E.cost.value = "";
        const box = document.getElementById("rerouteBox");
        if (box) { box.hidden = !moved; E.reason.required = moved; }
      });
      fillBanks();
      lookup();

      // tempel teks WhatsApp -> isi form (hanya job baru). Yang tidak cocok dengan master tidak diisi, hanya diberi catatan.
      const wa = form.querySelector("#waText");
      if (wa) {
        const info = form.querySelector("#waInfo");
        const applyWa = () => {
          const r = parseWaJob(wa.value, { locations: c.locations, vehicles: c.vehicles, customers: customers() });
          form.querySelectorAll(".wa-filled").forEach((x) => x.classList.remove("wa-filled"));
          if (!r.hasData) {
            info.innerHTML = wa.value.trim() ? `<span class="warn-text">Belum ada yang terbaca. Formatnya "Label : isi" per baris, mis. "Nopol : B 1234 ABC".</span>` : "";
            return;
          }
          for (const k of r.clear) if (E[k]) E[k].value = "";
          for (const [k, v] of Object.entries(r.fields)) {
            if (!E[k]) continue;
            E[k].value = v;
            E[k].classList.add("wa-filled");
          }
          // plat yang ada di Master Kendaraan: jenis truk & vendor pemilik ikut terisi (kalau teks tidak menyebut jenis truk)
          if (r.vehicle) {
            if (!r.fields.truck_type) { E.truck_type.value = r.vehicle.truck_type; E.truck_type.classList.add("wa-filled"); }
            if (r.vehicle.owner_partner_id && !E.vendor_id.value) { E.vendor_id.value = r.vehicle.owner_partner_id; E.vendor_id.classList.add("wa-filled"); fillBanks(); }
          }
          // skema hanya disetel ulang kalau customer / vendor ikut berubah, supaya pilihan skema yang sudah dibuat tidak tertimpa
          if (r.fields.customer_id || form.querySelector('[name="vendor_id"].wa-filled')) applySchemes();
          lookup();
          const missing = [["customer_id", "customer"], ["pol_id", "POL"], ["pod_id", "POD"]].filter(([k]) => !E[k].value).map(([, l]) => l);
          info.innerHTML = `<span class="ok-text">Terisi: ${esc(r.read.join(", "))}.</span>
            ${missing.length ? ` Masih perlu dipilih: <b>${esc(missing.join(", "))}</b>.` : ""}
            ${r.warn.map((w) => `<div class="warn-text">${esc(w)}</div>`).join("")}
            ${r.unknown.length ? `<div class="muted">Tidak dipakai: ${esc(r.unknown.join(" | "))}</div>` : ""}`;
        };
        form.querySelector("#waApply").onclick = applyWa;
        wa.addEventListener("paste", () => setTimeout(applyWa, 0));   // tempel = langsung terisi
      }
    },
    onSubmit: async (d) => {
      for (const k of ["selling", "cost", "selling_after_tax"]) d[k] = num(d[k]);
      if (lockCust) { delete d.customer_id; delete d.customer_scheme; }
      if (lockVend) delete d.vendor_scheme;
      // cost dikosongkan saat ganti rute = ambil dari price book rute baru
      const rerouted = job && ["pol_id", "pod_id", "trip_type", "truck_type"].some((k) => String(d[k] ?? "") !== String(job[k] ?? ""));
      if (job && !d.cost && purchase && !rerouted) d.cost = purchase.amount;
      if (!d.reason) delete d.reason;
      if (job) {
        d.expected_version = job.version;     // ditolak server kalau job sudah diubah orang lain sejak form dibuka
        await api("PUT", `/jobs/${job.id}`, d);
        toast("Job disimpan");
        window.dispatchEvent(new Event("hashchange"));
      } else {
        const r = await api("POST", "/jobs", d);
        toast(`Job ${r.job_number} dibuat`);
        location.hash = `#/jobs/${r.id}`;
      }
    },
  });
}

export async function renderJobDetail(id) {
  const d = await get(`/jobs/${id}`);
  const { job: j, balance: b } = d;
  const kas = b.received - b.paid;
  const sale = d.position.filter((p) => p.side === "SALE");
  const purch = d.position.filter((p) => p.side === "PURCHASE");
  view().innerHTML = `
    <div class="page-head">
      <a href="#/jobs" class="btn">&larr;</a>
      <h1>${esc(j.job_number)}</h1>${stageBadge(d.status?.stage)}
      <span class="sub">${esc(j.customer)} &middot; ${esc(j.pol)} - ${esc(j.pod)}${j.trip_type === "ROUND_TRIP" ? " PP" : ""} &middot; ${esc(j.plate_number || "")}</span>
      <div class="spacer"></div>
      <div class="actions">${canJob() && j.state !== "cancelled" ? `
        <button id="editJob">Edit / ganti rute</button>
        <button id="topup">Top-up cost</button>
        ${j.state === "confirmed" ? `<button id="doneJob">Tandai selesai</button>` : `<button id="reopenJob">Buka lagi</button>`}
        <button class="danger" id="cancelJob">Batalkan job</button>` : ""}
        ${canRequest() && j.state !== "cancelled" && b.paid > 0 ? `<button id="vendorRefund" title="Uang yang sudah dibayar ke vendor / driver dikembalikan (trip tidak jadi jalan, atau hanya terpakai sebagian)">${canFinance() ? "Uang kembali dari vendor" : "Ajukan uang kembali"}</button>` : ""}
      </div>
    </div>
    ${d.status ? `<div class="steps">${[
      ["Trip", { BELUM_BERANGKAT: "Belum berangkat", JALAN: "Dalam perjalanan", SAMPAI: "Sampai (gate in)" }[d.status.trip_status], d.status.trip_status === "SAMPAI"],
      ["Surat jalan", d.status.sj_status ? SJ_STATUS_LABEL[d.status.sj_status] : "Tidak dilacak", !d.status.sj_status || d.status.sj_status === "DIKIRIM"],
      ["Tagihan customer", BILL_LABEL[d.status.customer_status], ["LUNAS", "TANPA_TAGIHAN"].includes(d.status.customer_status)],
      ["Pembayaran vendor", BILL_LABEL[d.status.vendor_status], ["LUNAS", "TANPA_TAGIHAN"].includes(d.status.vendor_status)],
    ].map(([k, v, ok]) => `<div class="step ${ok ? "ok" : ""}"><span>${esc(k)}</span><b>${esc(v || "-")}</b></div>`).join("")}</div>
    ${d.status.sj_late ? `<div class="note-box warn-box">SJ terlambat: ${esc(SJ_LATE_LABEL[d.status.sj_late])}. Cek ke driver / kurir.</div>` : ""}` : ""}
    ${shortPanel(d.kurang_transfer)}
    <div class="tiles">
      ${tile("Selling", b.selling)}${tile("Cost (truk + biaya)", b.cost)}${tile("Margin rencana", b.selling - b.cost)}
      ${tile("Sudah ditagih", b.invoiced)}${tile("Diterima", b.received, "in")}
      ${tile("Sudah diajukan", b.requested)}${tile("Dibayar ke vendor", b.paid, "out")}
      ${tile("Saldo kas job", kas, "", "Masuk - keluar")}
    </div>
    <div class="grid-2">
      <div class="panel"><h2>Info job</h2><div class="kv">
        ${kv("Tanggal", tgl(j.job_date))}${kv("Customer", j.customer)}${kv("Vendor", j.vendor)}
        ${kv("Rute", `${j.pol_name} - ${j.pod_name}${j.trip_type === "ROUND_TRIP" ? " (PP)" : ""}`)}
        ${kv("Lingkup", `${SCOPE[j.delivery_scope]}${j.rit_number ? `, rit ${j.rit_number}` : ""}`)}
        ${kv("Skema customer", SCHEME_LABEL[j.customer_scheme])}${kv("Skema vendor", SCHEME_LABEL[j.vendor_scheme])}${kv("Truk", j.truck_type)}${kv("Plat", j.plate_number)}
        ${kv("Driver", [j.driver1_name, j.driver1_phone].filter(Boolean).join(" / "))}${kv("Driver 2", [j.driver2_name, j.driver2_phone].filter(Boolean).join(" / "))}
        ${kv("DO", j.do_number)}${kv("Selling", SELLING_MODES[j.selling_mode])}
        ${kv("Pajak customer", j.pph_pct || j.ppn_pct ? `PPh ${j.pph_pct}% / PPN ${j.ppn_pct}%` : "Tanpa pajak")}
        ${kv("Selling setelah pajak", j.selling_after_tax != null ? `${rp(j.selling_after_tax)} (manual)` : "Dihitung dari pajak customer")}
        ${kv("Catatan", j.note)}
      </div></div>
      ${d.unit ? `<div class="panel wide-panel"><h2>Unit sewa ${esc(d.unit.plate_number)} <span class="hint">sewa dibagi per hari trip (gate out s/d gate in)</span>
          <span class="spacer"></span><a class="btn small" href="#/units" onclick="sessionStorage.setItem('units', JSON.stringify({ tab: 'profit', month: '${String(d.unit.day_from).slice(0, 7)}', unit: '${d.unit.vehicle_id}' }))">Lihat unit</a></h2>
        <div class="kv">${kv("Hari trip", `${d.unit.days} hari (${tgl(d.unit.day_from)} s/d ${tgl(d.unit.day_to)})${d.unit.masih_jalan ? ", masih jalan" : ""}${d.unit.tanpa_gate ? ", tanpa gate: pakai tanggal job" : ""}`)}
          ${kv("Kontribusi (selling - uang jalan)", rp(d.balance.selling - d.balance.cost))}${kv("Sewa teralokasi", rp(d.unit.rent_cost))}
          ${kv("Untung trip setelah sewa", rp(d.balance.selling - d.balance.cost - d.unit.rent_cost))}</div></div>` : ""}
      ${d.reroutes.length ? `<div class="panel wide-panel"><h2>Riwayat reroute</h2>${table(
        "<th>Waktu</th><th>Dari</th><th>Ke</th><th class='num'>Cost</th><th class='num'>Selling</th><th>Alasan</th><th>Oleh</th>",
        d.reroutes.map((r) => { const x = r.detail || {}; return `<tr><td class="nowrap">${jam(r.at)}</td><td>${esc(x.dari)}${x.truk_dari !== x.truk_ke ? ` · ${esc(x.truk_dari)}` : ""}</td>
          <td><b>${esc(x.ke)}</b>${x.truk_dari !== x.truk_ke ? ` · ${esc(x.truk_ke)}` : ""}</td>
          <td class="num">${rp(x.cost_dari)} &rarr; <b>${rp(x.cost_ke)}</b></td><td class="num">${rp(x.selling_dari)} &rarr; <b>${rp(x.selling_ke)}</b></td>
          <td>${esc(x.alasan || "-")}</td><td>${esc(r.by_name || "")}</td></tr>`; }).join(""))}</div>` : ""}
      <div class="panel"><h2>Perjalanan & SJ <div class="spacer"></div>${canJob() ? `
        ${!j.gate_out_at ? `<button class="small" id="gateOut">Gate out</button>` : ""}
        ${j.gate_out_at && !j.gate_in_at ? `<button class="small" id="pos">Update posisi</button> <button class="small" id="gateIn">Gate in</button>` : ""}
        <button class="small" id="editTrip">Edit</button>` : ""}</h2>
        <div class="kv">
          ${kv("Gate out", jam(j.gate_out_at))}${kv("Gate in", jam(j.gate_in_at))}
          ${kv("SJ", j.sj_number)}${kv("Resi SJ diterima", tgl(j.sj_resi_received_at))}${kv("SJ diterima", tgl(j.sj_received_at))}
          ${kv("No resi SJ", j.sj_resi_number)}${kv("SJ dikirim ke customer", tgl(j.sj_delivered_at))}${kv("Resi kirim SJ", j.sj_delivered_resi_number)}
          ${kv("Lead time SJ (gate in - diterima)", d.status?.lead_time_sj != null ? `${d.status.lead_time_sj} hari` : "")}
          ${kv("Lama di kurir", d.status?.hari_di_kurir != null ? `${d.status.hari_di_kurir} hari` : "")}
          ${kv("Pengiriman SJ", d.sj_deliveries.map((x) => `${x.number}${x.state === "cancelled" ? " (batal)" : x.state === "received" ? " (diterima)" : ""}`).join(", "))}
        </div>
        ${d.trip_updates.length ? `<h4>Posisi</h4>${table("<th>Waktu</th><th>Posisi</th><th>Catatan</th><th>Oleh</th>",
          d.trip_updates.map((u) => `<tr><td>${jam(u.at)}</td><td>${esc(u.location)}</td><td>${esc(u.note || "")}</td><td>${esc(u.by_name || "")}</td></tr>`).join(""))}` : ""}
      </div>
    </div>
    <div class="panel"><h2>Posisi per fase <span class="hint">rencana, sudah ditagih / diajukan, dan dibayar</span></h2>
      ${table(`<th>Sisi</th><th>Fase</th><th class="num">Rencana</th><th class="num">Belum ditagih / diajukan</th><th class="num">Ditagih / diajukan, belum dibayar</th><th class="num">Dibayar</th>`,
        [...sale, ...purch].map((p) => `<tr><td>${p.side === "SALE" ? "Customer" : "Vendor"}</td><td>${esc(phaseLabel(p.phase, p.scheme))}</td>
          <td class="num">${rp(p.planned)}</td><td class="num">${rp(p.not_billed)}</td><td class="num">${rp(p.outstanding)}</td><td class="num">${rp(p.paid)}</td></tr>`).join(""))}
    </div>
    <div class="panel"><h2>Baris order <span class="hint">rencana uang job: selling, cost truk, calo, tol, parkir, dll</span>
      <div class="spacer"></div>${canJob() && j.state !== "cancelled" ? `<button class="small" id="addCost">+ Biaya vendor</button> <button class="small" id="addSell">+ Selling tambahan</button>` : ""}</h2>
      ${table(`<th>Sisi</th><th>Jenis</th><th>Pihak / rekening</th><th>Keterangan</th><th class="num">Nominal</th><th class="num">Ditagih / diajukan</th><th class="num">Dibayar</th><th class="num">Sisa</th><th></th>`,
        d.lines.map((l) => `<tr>
          <td>${l.side === "SALE" ? "Jual" : "Beli"}</td><td>${esc(KIND_LABEL[l.kind])}</td>
          <td>${esc(l.partner || "")}${l.bank_name ? `<br><span class="muted">${esc(l.bank_name)} ${esc(l.account_number)} a.n. ${esc(l.holder)}</span>` : ""}</td>
          <td>${esc(l.description || "")}</td>
          <td class="num">${rp(l.amount)}</td><td class="num">${rp(l.billed)}</td><td class="num">${rp(l.paid)}</td><td class="num">${rp(l.amount - l.paid)}</td>
          <td class="nowrap">${canJob() && j.state !== "cancelled" ? `<button class="small" data-edit-line="${l.job_line_id}">Ubah</button>
            ${l.billed === 0 && l.kind !== "TRUCKING" ? `<button class="small danger" data-del-line="${l.job_line_id}">Hapus</button>` : ""}` : ""}</td>
        </tr>`).join(""))}
    </div>
    ${d.unassigned.length ? `<div class="panel warn-panel"><h2>Selisih tanpa tujuan <span class="hint">uang di dokumen job ini yang belum jelas untuk apa; tidak dihitung di selling / cost</span></h2>
      <div id="unassignedBox"></div></div>` : ""}
    <div class="panel"><h2>Invoice & pengajuan</h2>
      ${table(`<th>Dokumen</th><th>Jenis</th><th>Fase</th><th>Tgl</th><th>Partner</th><th class="num">Nominal job ini</th><th>Status</th>`,
        d.moves.map((m) => `<tr class="click" data-href="#/moves/${m.id}">
          <td><b>${esc(m.number || "(draft)")}</b></td><td>${m.move_type === "out_invoice" ? "Invoice customer" : m.credit_note_of ? "Nota kredit vendor<br><span class='muted'>uang kembali</span>" : "Pengajuan vendor"}${m.payment_channel === "TRANSFER_MALAM" ? "<br><span class='muted'>transfer malam</span>" : ""}</td>
          <td>${esc(PHASE_LABEL[m.phase])}</td><td>${tgl(m.move_date)}</td><td>${esc(m.partner || "")}</td>
          <td class="num">${m.cancelled_at ? `<s>${rp(m.amount)}</s>` : rp(m.amount)}${m.tanpa_tujuan ? `<br><span class="badge warn">tanpa tujuan</span>` : ""}</td><td>${badge(m.state)} ${badge(m.approval_state)}</td></tr>`).join(""), "Belum ada")}
    </div>
    ${d.refund_requests?.length ? `<div class="panel"><h2>Pengajuan uang kembali <span class="hint">diajukan operasional, dikonfirmasi finance setelah uangnya masuk</span></h2>
      <div id="jobRefundReq">${refundRequestTable(d.refund_requests, false)}</div></div>` : ""}
    <div class="panel"><h2>Jurnal kas job ini <span class="hint">uang benar-benar masuk / keluar</span></h2>${ledgerTable(d.ledger, false)}</div>
    <div class="panel"><h2>Riwayat perubahan</h2>
      ${table("<th>Waktu</th><th>Aksi</th><th>Oleh</th><th>Detail</th>",
        d.audit.map((a) => `<tr><td>${jam(a.at)}</td><td>${esc(a.action)}</td><td>${esc(a.by_name || "")}</td><td class="muted small-text">${esc(JSON.stringify(a.detail || {}))}</td></tr>`).join(""), "Belum ada")}
    </div>`;
  bindRows();
  const reload = () => window.dispatchEvent(new Event("hashchange"));
  if (d.unassigned.length) unassignedTable(document.getElementById("unassignedBox"), d.unassigned, reload, { showJob: false });
  const on = (sel, fn) => document.getElementById(sel)?.addEventListener("click", fn);
  on("editJob", () => jobForm({ ...j, lines: d.lines }, { ...b, invoiced: b.invoiced, requested: b.requested }));
  on("doneJob", action(() => api("POST", `/jobs/${id}/state`, { state: "done" }), "Job selesai"));
  on("reopenJob", action(() => api("POST", `/jobs/${id}/state`, { state: "confirmed" }), "Job dibuka lagi"));
  on("cancelJob", () => askReason("Batalkan job", "Hanya bisa kalau belum ada invoice / pengajuan aktif. Uang yang sudah dibayar ke vendor dicatat dulu lewat \"Uang kembali dari vendor\".",
    (reason) => api("POST", `/jobs/${id}/state`, { state: "cancelled", reason }), "Batalkan job"));
  on("vendorRefund", () => (canFinance() ? vendorRefundForm(j) : vendorRefundRequestForm(j)));
  bindRefundRequests(document.getElementById("jobRefundReq"));
  on("gateOut", () => gateModal(id, "gate_out_at", "Gate out", reload));
  on("gateIn", () => gateModal(id, "gate_in_at", "Gate in", reload));
  on("pos", () => positionModal(id, reload));
  on("editTrip", () => tripForm(j));
  on("topup", () => openModal({
    title: "Top-up cost truk",
    body: `<div class="form-grid"><label>Tambahan cost<input class="num" name="amount" required></label>
      <label class="wide">Alasan<input name="reason" placeholder="contoh: inap 1 malam, ganti rute" required></label></div>
      <div class="note-box">Cost truk sekarang ${rp(b.cost_trucking)}. Setelah top-up, sisanya bisa diajukan lewat Pengajuan Vendor (pelunasan).</div>`,
    onSubmit: async (f) => { await api("POST", `/jobs/${id}/topup`, { amount: num(f.amount), reason: f.reason }); toast("Top-up dicatat"); reload(); },
  }));
  on("addCost", () => lineForm(j, "PURCHASE"));
  on("addSell", () => lineForm(j, "SALE"));
  view().querySelectorAll("[data-edit-line]").forEach((btn) => (btn.onclick = () => {
    const l = d.lines.find((x) => x.job_line_id === Number(btn.dataset.editLine));
    lineForm(j, l.side, l);
  }));
  view().querySelectorAll("[data-del-line]").forEach((btn) => (btn.onclick = action(() => api("DELETE", `/job-lines/${btn.dataset.delLine}`), "Baris dihapus")));
}

function lineForm(job, side, line = null) {
  const kinds = side === "SALE" ? { TOL: "Tol", CALO: "Calo", PARKIR: "Parkir", BONGKAR: "Bongkar muat", LAINNYA: "Lainnya" }
    : { CALO: "Calo", TOL: "Tol", PARKIR: "Parkir", BONGKAR: "Bongkar muat", LAINNYA: "Biaya lain" };
  openModal({
    title: line ? `Ubah ${KIND_LABEL[line.kind]}` : side === "SALE" ? "Tambah selling (ditagih ke customer)" : "Tambah biaya vendor (calo, tol, ...)",
    body: `<div class="form-grid">
      ${line ? "" : `<label>Jenis<select name="kind">${enumOptions(kinds, "CALO")}</select></label>`}
      ${side === "PURCHASE" ? `<label>Dibayar ke<select name="partner_id">${options(vendors(), line?.partner_id, undefined, "- pilih -")}</select></label>
        <label>Rekening<select name="partner_bank_id"></select></label>` : ""}
      <label>Nominal<input class="num" name="amount" value="${line?.amount ?? ""}" required></label>
      <label class="wide">Keterangan<input name="description" value="${esc(line?.description || "")}"></label>
      ${line ? `<label class="wide">Alasan perubahan<input name="reason"></label>` : ""}</div>
      ${side === "PURCHASE" && !line ? `<div class="note-box">Diajukan lewat Pengajuan Vendor dengan fase "Calo / biaya lain".</div>` : ""}`,
    onOpen: (form) => {
      const E = form.elements;
      if (!E.partner_id) return;
      const fill = () => {
        const banks = partnerBanksOf(E.partner_id.value);
        E.partner_bank_id.innerHTML = options(banks, line?.partner_bank_id || banks.find((x) => x.is_default)?.id, (x) => `${x.bank_name} ${x.account_number} a.n. ${x.holder}`, banks.length ? "- pilih -" : "- belum ada rekening -");
      };
      E.partner_id.onchange = fill;
      fill();
    },
    onSubmit: async (f) => {
      f.amount = num(f.amount);
      if (line) await api("PUT", `/job-lines/${line.job_line_id}`, f);
      else await api("POST", `/jobs/${job.id}/lines`, { ...f, side });
      toast("Tersimpan");
      window.dispatchEvent(new Event("hashchange"));
    },
  });
}

function tripForm(j) {
  openModal({
    title: "Perjalanan & surat jalan",
    wide: true,
    body: `<div class="form-grid">
      <label>Gate out<input type="datetime-local" name="gate_out_at" value="${dtLocal(j.gate_out_at)}"></label>
      <label>Gate in<input type="datetime-local" name="gate_in_at" value="${dtLocal(j.gate_in_at)}"></label>
      <label>No SJ<input name="sj_number" value="${esc(j.sj_number || "")}"></label>
      <label>Resi SJ diterima<input type="date" name="sj_resi_received_at" value="${tgl(j.sj_resi_received_at)}"></label>
      <label>SJ diterima<input type="date" name="sj_received_at" value="${tgl(j.sj_received_at)}"></label>
      <label>No resi SJ<input name="sj_resi_number" value="${esc(j.sj_resi_number || "")}"></label>
      <label>SJ dikirim ke customer<input type="date" name="sj_delivered_at" value="${tgl(j.sj_delivered_at)}"></label>
      <label>Resi kirim SJ<input name="sj_delivered_resi_number" value="${esc(j.sj_delivered_resi_number || "")}"></label></div>`,
    onSubmit: async (f) => {
      f.gate_out_at = fromDtLocal(f.gate_out_at);
      f.gate_in_at = fromDtLocal(f.gate_in_at);
      await api("PUT", `/jobs/${j.id}/trip`, f);
      toast("Perjalanan disimpan");
      window.dispatchEvent(new Event("hashchange"));
    },
  });
}

export { loadMaster, canFinance };

// ---------------------------------------------------------------- uang kembali dari vendor
// Uang yang sudah dibayar ke vendor / driver dikembalikan. Server membuat nota kredit vendor (NKV) + uang kembali (RFD)
// sekaligus, per job (walau dulu dibayar dalam satu batch), boleh sebagian, masuk ke rekening yang dipilih.
async function vendorRefundForm(j) {
  const rows = (await get(`/jobs/${j.id}/vendor-refund`)).filter((r) => r.bisa > 0.004);
  if (!rows.length) return toast("Tidak ada pembayaran vendor job ini yang bisa dikembalikan", true);
  const banks = state.cache.banks.filter((x) => x.active);
  const AFTER = {
    CANCEL_JOB: "Trip tidak jadi jalan: batalkan job",
    REDUCE_COST: "Hanya terpakai sebagian: cost job dikurangi sebesar uang kembali",
    KEEP_COST: "Cost tetap: nanti diajukan & dibayar lagi (mis. ganti driver / trip ditunda)",
  };
  openModal({
    title: `Uang kembali dari vendor · ${j.job_number}`,
    submitLabel: "Catat uang kembali",
    body: `
      <label>Pembayaran yang uangnya kembali<select name="move_line_id">${rows.map((r) => `<option value="${r.move_line_id}">${esc(r.number)} · ${esc(PHASE_LABEL[r.phase] || r.phase)} · ${esc(r.pihak || "-")} · dibayar ${rp(r.dibayar)}${r.dikembalikan ? `, sudah kembali ${rp(r.dikembalikan)}` : ""}</option>`).join("")}</select></label>
      <div class="form-grid">
        <label>Nominal kembali<input class="num" name="amount" required></label>
        <label>Tanggal uang masuk<input type="date" name="date" value="${today()}" max="${today()}"></label>
        <label>Masuk ke rekening<select name="bank_account_id">${options(banks, banks.find((x) => x.is_default)?.id, (x) => `${x.name}${x.kind === "OPERATIONAL" ? " (kas operasional)" : ""}`, "- pilih -")}</select></label>
        <label class="wide">Alasan<input name="reason" required placeholder="mis. trip tidak jadi jalan, uang jalan dikembalikan driver"></label>
      </div>
      <h4>Sesudah uang kembali</h4>
      <div class="radio-list">${Object.entries(AFTER).map(([k, l], i) => `<label class="radio"><input type="radio" name="after" value="${k}" ${i === 0 ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>
      <div class="note-box" id="vrInfo"></div>
      <div class="note-box">Dicatat sebagai <b>nota kredit vendor</b> (mengurangi pengajuan) + <b>uang kembali</b> (uang masuk ke rekening di atas, tampil
        MASUK di Jurnal Kas untuk dicocokkan dengan mutasi bank). Pembayaran asli tetap tercatat. Beda dengan <b>batal bayar</b>, yang dipakai
        kalau transfer salah / gagal dan uang tidak pernah sampai.</div>`,
    onOpen: (form) => {
      const E = form.elements;
      const info = () => {
        const r = rows.find((x) => String(x.move_line_id) === E.move_line_id.value);
        if (document.activeElement !== E.amount && (!E.amount.value || E.amount.dataset.auto)) { E.amount.value = rp(r.bisa); E.amount.dataset.auto = "1"; }
        form.querySelector("#vrInfo").innerHTML = `Dibayar ${rp(r.dibayar)} ${r.tgl_bayar ? `pada ${tgl(r.tgl_bayar)}` : ""}${r.rekening_bayar ? ` dari ${esc(r.rekening_bayar)}` : ""}.
          Bisa dikembalikan paling banyak <b>${rp(r.bisa)}</b>. Cost baris ini ${rp(r.line_amount)}.`;
      };
      E.move_line_id.onchange = () => { E.amount.dataset.auto = "1"; E.amount.value = ""; info(); };
      E.amount.oninput = () => { delete E.amount.dataset.auto; };
      info();
    },
    onSubmit: async (d) => {
      d.amount = num(d.amount);
      const r = await api("POST", `/jobs/${j.id}/vendor-refund`, d);
      toast(`Uang kembali dicatat: nota kredit ${r.credit_note}, ${r.payment}`);
      window.dispatchEvent(new Event("hashchange"));
    },
  });
}

// ---------------------------------------------------------------- pengajuan uang kembali (OPERATIONAL -> FINANCE)
const REFUND_AFTER = {
  CANCEL_JOB: "Trip tidak jadi jalan: batalkan job",
  REDUCE_COST: "Hanya terpakai sebagian: cost job dikurangi sebesar uang kembali",
  KEEP_COST: "Cost tetap: nanti diajukan & dibayar lagi (mis. ganti driver / trip ditunda)",
};
const REFUND_STATE = { PENDING: ["Menunggu konfirmasi", "draft"], CONFIRMED: ["Dikonfirmasi", "posted"], REJECTED: ["Ditolak", "cancelled"], CANCELLED: ["Ditarik", "cancelled"] };

// OPERATIONAL mengajukan: tanpa rekening & tanggal (itu diisi finance saat uangnya sudah masuk)
async function vendorRefundRequestForm(j) {
  const rows = (await get(`/jobs/${j.id}/vendor-refund`)).filter((r) => r.bisa > 0.004);
  if (!rows.length) return toast("Tidak ada pembayaran vendor job ini yang bisa dikembalikan", true);
  openModal({
    title: `Ajukan uang kembali · ${j.job_number}`,
    submitLabel: "Ajukan ke finance",
    body: `
      <label>Pembayaran yang uangnya kembali<select name="move_line_id">${rows.map((r) => `<option value="${r.move_line_id}">${esc(r.number)} · ${esc(PHASE_LABEL[r.phase] || r.phase)} · ${esc(r.pihak || "-")} · dibayar ${rp(r.dibayar)}${r.dikembalikan ? `, sudah kembali ${rp(r.dikembalikan)}` : ""}</option>`).join("")}</select></label>
      <div class="form-grid">
        <label>Nominal kembali<input class="num" name="amount" required></label>
        <label class="wide">Alasan<input name="reason" required placeholder="mis. trip tidak jadi jalan, uang jalan dikembalikan driver"></label>
      </div>
      <h4>Sesudah uang kembali</h4>
      <div class="radio-list">${Object.entries(REFUND_AFTER).map(([k, l], i) => `<label class="radio"><input type="radio" name="after" value="${k}" ${i === 0 ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>
      <div class="note-box">Finance mengonfirmasi setelah uangnya benar-benar masuk (rekening &amp; tanggal diisi finance). Sebelum dikonfirmasi, pengajuan
        bisa Anda tarik lagi.</div>`,
    onOpen: (form) => {
      const E = form.elements;
      const fill = () => { E.amount.value = rp(rows.find((x) => String(x.move_line_id) === E.move_line_id.value).bisa); };
      E.move_line_id.onchange = fill;
      fill();
    },
    onSubmit: async (d) => {
      d.amount = num(d.amount);
      await api("POST", `/jobs/${j.id}/vendor-refund-requests`, d);
      toast("Pengajuan uang kembali dikirim ke finance");
      window.dispatchEvent(new Event("hashchange"));
    },
  });
}

// Tabel pengajuan uang kembali (halaman job & halaman Pengajuan Vendor) + tombol sesuai hak
export function refundRequestTable(rows, withJob = true) {
  return table(`${withJob ? "<th>Job</th>" : ""}<th>Pengajuan</th><th>Penerima</th><th class="num">Nominal</th><th>Sesudahnya</th><th>Alasan</th><th>Diajukan</th><th>Status</th><th></th>`,
    rows.map((r) => `<tr>${withJob ? `<td><a href="#/jobs/${r.job_id}"><b>${esc(r.job_number)}</b></a></td>` : ""}
      <td>${esc(r.pengajuan)}</td><td>${esc(r.pihak || "-")}</td><td class="num">${rp(r.amount)}</td>
      <td class="small-text">${esc(REFUND_AFTER[r.after] || r.after)}</td><td class="small-text">${esc(r.reason)}</td>
      <td class="nowrap">${esc(r.requested_by_name || "")}<br><span class="muted">${jam(r.requested_at)}</span></td>
      <td><span class="badge ${REFUND_STATE[r.state][1]}">${REFUND_STATE[r.state][0]}</span>${r.credit_note ? `<br><a href="#/moves/${r.credit_note_id}">${esc(r.credit_note)}</a>` : ""}
        ${r.decision_note ? `<br><span class="muted small-text">${esc(r.decision_note)}</span>` : ""}${r.decided_by_name && r.state !== "PENDING" ? `<br><span class="muted small-text">${esc(r.decided_by_name)}</span>` : ""}</td>
      <td class="nowrap">${r.state !== "PENDING" ? "" : `${canFinance() ? `<button type="button" class="small primary" data-rr-confirm="${r.id}">Konfirmasi</button>
          <button type="button" class="small danger" data-rr-reject="${r.id}">Tolak</button>` : ""}
        ${r.requested_by === state.user.id || canFinance() ? `<button type="button" class="small" data-rr-cancel="${r.id}">Tarik</button>` : ""}`}</td></tr>`).join(""),
    "Belum ada pengajuan");
}

export function bindRefundRequests(box) {
  if (!box) return;
  const reload = () => window.dispatchEvent(new Event("hashchange"));
  const find = async (id) => (await get(`/vendor-refund-requests`)).find((x) => String(x.id) === String(id));
  box.querySelectorAll("[data-rr-confirm]").forEach((b) => (b.onclick = async () => {
    const r = await find(b.dataset.rrConfirm);
    const banks = state.cache.banks.filter((x) => x.active);
    openModal({
      title: `Konfirmasi uang kembali · ${r.job_number}`,
      submitLabel: "Uang sudah masuk, catat",
      body: `<div class="note-box">${esc(r.requested_by_name || "")} mengajukan uang kembali <b>${rp(r.amount)}</b> dari ${esc(r.pihak || "-")} (${esc(r.pengajuan)}).
          Alasan: ${esc(r.reason)}.</div>
        <div class="form-grid">
          <label>Nominal yang benar-benar masuk<input class="num" name="amount" value="${rp(r.amount)}" required></label>
          <label>Tanggal uang masuk<input type="date" name="date" value="${today()}" max="${today()}"></label>
          <label>Masuk ke rekening<select name="bank_account_id">${options(banks, banks.find((x) => x.is_default)?.id, (x) => `${x.name}${x.kind === "OPERATIONAL" ? " (kas operasional)" : ""}`, "- pilih -")}</select></label>
          <label class="wide">Catatan finance (opsional)<input name="note"></label>
        </div>
        <h4>Sesudah uang kembali</h4>
        <div class="radio-list">${Object.entries(REFUND_AFTER).map(([k, l]) => `<label class="radio"><input type="radio" name="after" value="${k}" ${k === r.after ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>`,
      onSubmit: async (d) => {
        d.amount = num(d.amount);
        const x = await api("POST", `/vendor-refund-requests/${r.id}/confirm`, d);
        toast(`Uang kembali dicatat: ${x.credit_note}, ${x.payment}`);
        reload();
      },
    });
  }));
  box.querySelectorAll("[data-rr-reject]").forEach((b) => (b.onclick = () => askReason("Tolak pengajuan uang kembali", "Mis. uangnya belum / tidak masuk. Operasional bisa mengajukan lagi.",
    (reason) => api("POST", `/vendor-refund-requests/${b.dataset.rrReject}/reject`, { reason }), "Tolak")));
  box.querySelectorAll("[data-rr-cancel]").forEach((b) => (b.onclick = action(() => api("POST", `/vendor-refund-requests/${b.dataset.rrCancel}/cancel`, {}), "Pengajuan ditarik")));
}

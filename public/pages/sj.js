// Surat jalan: pemantauan lead time & keterlambatan, input cepat (tempel daftar), pengiriman SJ ke customer (+ cetak).
// Alur: gate in -> driver kirim SJ lewat kurir (resi) -> SJ diterima di AMICO -> siap ditagih -> dikirim ke customer.
import {
  api, get, view, esc, rp, tgl, jam, tile, table, toast, openModal, askReason, enumOptions, options, customers, debounce, bindRows,
  canJob, today, state, SJ_STATUS_LABEL, SJ_LATE_LABEL, BILL_LABEL,
} from "../lib.js";

const TABS = { track: "Pemantauan", quick: "Input cepat", send: "Pengiriman ke customer" };
const days = (n) => (n == null ? "" : `${n} hari`);

export async function renderSj() {
  const tab = sessionStorage.getItem("sjTab") || "track";
  const [s, settings] = [await get("/sj/summary"), state.cache.settings];
  view().innerHTML = `
    <div class="page-head"><h1>Surat Jalan</h1>
      <span class="sub">Gate in &rarr; driver kirim SJ (resi) &rarr; SJ diterima AMICO &rarr; siap ditagih &rarr; dikirim ke customer.
        Target: resi ${settings.sj_target_resi_days ?? 2} hari setelah gate in, di kurir maks ${settings.sj_target_kurir_days ?? 4} hari,
        kirim ke customer maks ${settings.sj_target_kirim_days ?? 3} hari (ubah di Master Data &rsaquo; Perusahaan).</span></div>
    <div class="tiles">
      ${tile("Belum ada resi", s.belum_ada_resi, s.resi_terlambat ? "warn" : "", `${rp(s.resi_terlambat)} lewat target`)}
      ${tile("Di kurir", s.di_kurir, s.kurir_nyangkut ? "warn" : "", `${rp(s.kurir_nyangkut)} resi nyangkut`)}
      ${tile("Diterima, belum dikirim", s.diterima_belum_kirim, s.terlambat_kirim ? "warn" : "", `${rp(s.terlambat_kirim)} lewat target`)}
      ${tile("Rata-rata lead time SJ", s.rata_lead_time ?? 0, "", "hari, gate in sampai SJ diterima")}
    </div>
    <div class="tabs">${Object.entries(TABS).map(([k, l]) => `<a href="#" data-tab="${k}" class="${k === tab ? "active" : ""}">${esc(l)}</a>`).join("")}</div>
    <div id="sjBox"></div>`;
  view().querySelectorAll("[data-tab]").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    sessionStorage.setItem("sjTab", a.dataset.tab);
    renderSj();
  }));
  const box = document.getElementById("sjBox");
  if (tab === "quick") return renderQuick(box);
  if (tab === "send") return renderDeliveries(box);
  return renderTracking(box);
}

// ---------------------------------------------------------------- pemantauan
async function renderTracking(box) {
  const f = JSON.parse(sessionStorage.getItem("sjFilter") || '{"late":"1"}');
  box.innerHTML = `<div class="panel">
    <div class="filters">
      <label>Status SJ<select id="sStatus"><option value="">Semua</option>${enumOptions(SJ_STATUS_LABEL, f.status)}</select></label>
      <label>Customer<select id="sCust">${options(customers(), f.customer_id, undefined, "Semua customer")}</select></label>
      <label>Cari<input id="sSearch" placeholder="No job, SJ, plat, resi" value="${esc(f.search || "")}"></label>
      <label class="check"><input type="checkbox" id="sLate" ${f.late === "1" ? "checked" : ""}> Hanya yang terlambat</label>
    </div><div id="sTable"></div>
    <div class="note-box">Customer yang SJ-nya tidak dikirim lewat kurir (mis. dalam kota) bisa dimatikan "Lacak SJ"-nya di Master Data &rsaquo; Partner.</div></div>`;
  const el = (k) => document.getElementById(k);
  const load = async () => {
    const flt = { status: el("sStatus").value, customer_id: el("sCust").value, search: el("sSearch").value, late: el("sLate").checked ? "1" : "" };
    sessionStorage.setItem("sjFilter", JSON.stringify(flt));
    const rows = await get(`/sj/tracking?${new URLSearchParams(flt)}`);
    el("sTable").innerHTML = table(
      `<th>Job</th><th>Customer / rute</th><th>Driver</th><th>Gate in</th><th>Resi dari driver</th><th>SJ diterima</th>
       <th class="num">Lead time</th><th class="num">Di kurir</th><th>Status</th>`,
      rows.map((r) => `<tr class="click" data-href="#/jobs/${r.job_id}">
        <td><b>${esc(r.job_number)}</b><br><span class="muted">${esc(r.sj_number || "")}</span></td>
        <td>${esc(r.customer)}<br><span class="muted">${esc(r.pol)} - ${esc(r.pod)} · ${esc(r.plate_number || "")}</span></td>
        <td>${esc(r.driver1_name || "")}<br><span class="muted">${esc(r.driver1_phone || "")}</span></td>
        <td class="nowrap">${jam(r.gate_in_at)}</td>
        <td>${esc(r.sj_resi_number || "")}<br><span class="muted">${tgl(r.sj_resi_received_at)}</span></td>
        <td>${tgl(r.sj_received_at)}</td>
        <td class="num">${days(r.lead_time_sj)}</td><td class="num">${days(r.hari_di_kurir)}</td>
        <td>${esc(SJ_STATUS_LABEL[r.sj_status] || "")}${r.sj_late ? `<br><span class="badge warn">${esc(SJ_LATE_LABEL[r.sj_late])}</span>` : ""}</td></tr>`).join(""),
      "Tidak ada");
    bindRows(el("sTable"));
  };
  for (const k of ["sStatus", "sCust", "sLate"]) el(k).onchange = load;
  el("sSearch").oninput = debounce(load);
  await load();
}

// ---------------------------------------------------------------- input cepat
// Daftar yang sedang disiapkan (bertahan saat pindah tab)
const queue = [];

function renderQuick(box) {
  if (!canJob()) { box.innerHTML = `<div class="panel muted">Hanya operasional / finance / admin.</div>`; return; }
  box.innerHTML = `<div class="panel">
    <div class="form-grid">
      <label>Yang dicatat<select id="qMode">${enumOptions({ received: "SJ diterima di AMICO", resi: "Resi dari driver (SJ dikirim lewat kurir)" }, sessionStorage.getItem("sjMode") || "received")}</select></label>
      <label>Tanggal default<input type="date" id="qDate" value="${today()}"></label>
      <label class="wide">Cari job: ketik kode tugas (cukup 5 digit terakhir), no job, no SJ, atau plat, lalu Enter
        <input id="qSearch" class="big-search" placeholder="contoh: 01123   atau   AMC/2610/0243   atau   B 9238" autocomplete="off"></label>
    </div>
    <div id="qFound"></div>
    <h3 class="sub-h">Akan disimpan <span class="muted" id="qCount"></span></h3>
    <div id="qList"></div>
    <div class="actions" style="margin-top:12px"><button class="primary" id="qSave">Simpan semua</button><button id="qClear">Kosongkan daftar</button></div>
    <details style="margin-top:16px"><summary>Tempel banyak sekaligus dari Excel</summary>
      <p class="muted">Satu job per baris: kode tugas / no job / no SJ, boleh diikuti tanggal (dan no resi). Contoh: <code>DBGX26090101123&nbsp;&nbsp;08/10/2026</code></p>
      <textarea id="qText" rows="6"></textarea>
      <div class="actions"><button id="qPaste">Masukkan ke daftar</button></div>
    </details>
  </div>`;
  const el = (k) => document.getElementById(k);
  const mode = () => el("qMode").value;
  let found = [];
  const mark = (v, q) => {
    const s = String(v || "");
    const i = q ? s.toUpperCase().indexOf(q.toUpperCase()) : -1;
    return i < 0 ? esc(s) : `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, i + q.length))}</mark>${esc(s.slice(i + q.length))}`;
  };
  const route = (j) => `${esc(j.pol)} &rarr; ${esc(j.pod)}${j.trip_type === "ROUND_TRIP" ? " PP" : ""}`;
  const already = (j) => (mode() === "received" ? j.sj_received_at && `sudah diterima ${tgl(j.sj_received_at)}` : j.sj_resi_number && `resi ${j.sj_resi_number}`);

  const showFound = () => {
    const q = el("qSearch").value.trim();
    el("qFound").innerHTML = !q ? "" : found.length ? table(
      `<th>Kode tugas</th><th>No job</th><th>Plat</th><th>Tujuan</th><th>Customer</th><th>Gate in</th><th>Status SJ</th><th></th>`,
      found.map((j, i) => `<tr class="${i === 0 ? "pick" : ""}">
        <td><b>${mark(j.do_number, q)}</b></td><td>${mark(j.job_number, q)}</td><td>${mark(j.plate_number, q)}</td><td>${route(j)}</td>
        <td>${esc(j.customer)}</td><td class="nowrap">${j.gate_in_at ? jam(j.gate_in_at) : `<span class="muted">belum gate in</span>`}</td>
        <td>${esc(SJ_STATUS_LABEL[j.sj_status] || "-")}${already(j) ? `<br><span class="warn-text">${esc(already(j))}</span>` : ""}</td>
        <td>${queue.some((x) => x.job_id === j.job_id) ? `<span class="muted">di daftar</span>` : `<button class="small primary" data-add="${i}">Tambah</button>`}</td></tr>`).join(""))
      : `<p class="muted">Tidak ada job yang cocok dengan "${esc(q)}".</p>`;
    el("qFound").querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => add(found[Number(b.dataset.add)])));
  };
  const showList = () => {
    el("qCount").textContent = queue.length ? `(${queue.length} job)` : "";
    el("qList").innerHTML = table(
      `<th>No</th><th>Kode tugas</th><th>No job</th><th>Plat</th><th>Tujuan</th><th>Gate in</th><th>Tanggal ${mode() === "received" ? "SJ diterima" : "resi"}</th>
       ${mode() === "resi" ? "<th>No resi</th>" : ""}<th></th>`,
      queue.map((j, i) => `<tr>
        <td>${i + 1}</td><td><b>${esc(j.do_number || "-")}</b></td><td>${esc(j.job_number)}</td><td>${esc(j.plate_number || "")}</td><td>${route(j)}</td>
        <td class="nowrap">${jam(j.gate_in_at)}</td>
        <td><input type="date" data-date="${i}" value="${esc(j.date)}"></td>
        ${mode() === "resi" ? `<td><input data-resi="${i}" value="${esc(j.resi || "")}" placeholder="no resi kurir"></td>` : ""}
        <td><button class="small danger" data-del="${i}" title="Hapus dari daftar">&times;</button></td></tr>`).join(""),
      "Belum ada. Cari job di atas lalu tekan Enter / Tambah.");
    el("qList").querySelectorAll("[data-date]").forEach((x) => (x.onchange = () => (queue[x.dataset.date].date = x.value)));
    el("qList").querySelectorAll("[data-resi]").forEach((x) => (x.oninput = () => (queue[x.dataset.resi].resi = x.value)));
    el("qList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { queue.splice(Number(b.dataset.del), 1); showList(); showFound(); }));
  };
  const add = (j, date, resi) => {
    if (!j || queue.some((x) => x.job_id === j.job_id)) return;
    queue.push({ ...j, date: date || el("qDate").value, resi: resi || "" });
    el("qSearch").value = "";
    found = [];
    showFound();
    showList();
    el("qSearch").focus();
  };
  const search = debounce(async () => {
    const q = el("qSearch").value.trim();
    found = q.length >= 3 ? await get(`/sj/search?q=${encodeURIComponent(q)}`) : [];
    showFound();
  }, 200);
  el("qSearch").oninput = search;
  el("qSearch").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); if (found.length) add(found[0]); } };
  el("qMode").onchange = () => { sessionStorage.setItem("sjMode", mode()); showList(); showFound(); };
  el("qClear").onclick = () => { queue.length = 0; showList(); showFound(); };
  el("qSave").onclick = async () => {
    if (!queue.length) return toast("Daftar masih kosong", true);
    try {
      const r = await api("POST", "/sj/bulk", { mode: mode(), items: queue.map((j) => ({ job_id: j.job_id, date: j.date, resi: j.resi })) });
      const bad = r.rows.filter((x) => x.status !== "OK");
      toast(`${r.saved} job disimpan${bad.length ? `, ${bad.length} dilewati (${bad.map((x) => `${x.key || "?"}: ${x.status}`).join(", ")})` : ""}`, bad.length > 0);
      queue.length = 0;
      showList();
    } catch (err) { toast(err.message, true); }
  };
  el("qPaste").onclick = async () => {
    try {
      const r = await api("POST", "/sj/bulk", { mode: mode(), date: el("qDate").value, text: el("qText").value, dry_run: true });
      let n = 0;
      for (const x of r.rows.filter((y) => y.job && ["OK", "SUDAH"].includes(y.status))) {
        const [j] = (await get(`/sj/search?q=${encodeURIComponent(x.job.job_number)}`)).filter((y) => y.job_id === x.job.id);
        if (j) { add(j, x.date, x.resi); n++; }
      }
      const miss = r.rows.filter((y) => !["OK", "SUDAH"].includes(y.status));
      el("qText").value = miss.map((y) => y.line).join("\n");
      toast(`${n} job masuk daftar${miss.length ? `; ${miss.length} baris tidak ketemu / ganda (tetap di kotak tempel)` : ""}`, miss.length > 0);
    } catch (err) { toast(err.message, true); }
  };
  showList();
  el("qSearch").focus();
}

// ---------------------------------------------------------------- pengiriman ke customer
async function renderDeliveries(box) {
  const rows = await get("/sj/deliveries");
  const ST = { sent: "Dikirim", received: "Diterima customer", cancelled: "Batal" };
  box.innerHTML = `<div class="panel">
    <h2>Pengiriman SJ ke customer <span class="hint">satu kiriman / satu resi kurir bisa berisi banyak SJ</span><div class="spacer"></div>
      ${canJob() ? `<button class="primary small" id="newDelivery">+ Pengiriman baru</button>` : ""}</h2>
    ${table(`<th>No</th><th>Tanggal</th><th>Customer</th><th class="num">Job</th><th>Kurir / resi</th><th>Status</th><th class="num">Umur</th><th></th>`,
      rows.map((d) => `<tr><td><b>${esc(d.number)}</b></td><td>${tgl(d.delivery_date)}</td><td>${esc(d.customer)}</td><td class="num">${d.jobs}</td>
        <td>${esc(d.courier || "")}<br><span class="muted">${esc(d.resi_number || "")}</span></td>
        <td><span class="badge ${d.state === "received" ? "posted" : d.state === "cancelled" ? "cancelled" : "draft"}">${esc(ST[d.state])}</span>${d.received_at ? `<br><span class="muted">${tgl(d.received_at)}</span>` : ""}</td>
        <td class="num">${d.state === "sent" ? days(d.umur_hari) : ""}</td>
        <td class="nowrap"><a class="btn small" href="#/sj/deliveries/${d.id}/cetak">Cetak</a>
          ${canJob() && d.state === "sent" ? `<button class="small" data-recv="${d.id}">Diterima</button> <button class="small danger" data-cancel="${d.id}">Batal</button>` : ""}</td></tr>`).join(""),
      "Belum ada pengiriman")}</div>`;
  const reload = () => renderSj();
  document.getElementById("newDelivery")?.addEventListener("click", () => deliveryForm(reload));
  box.querySelectorAll("[data-recv]").forEach((b) => (b.onclick = () => openModal({
    title: "SJ diterima customer", submitLabel: "Simpan",
    body: `<label>Tanggal diterima<input type="date" name="date" value="${today()}"></label>`,
    onSubmit: async (d) => { await api("POST", `/sj/deliveries/${b.dataset.recv}/received`, d); toast("Dicatat"); reload(); },
  })));
  box.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => askReason("Batalkan pengiriman SJ",
    "Tanggal & resi kirim di job ikut dikosongkan, SJ bisa dikirim ulang.", (reason) => api("POST", `/sj/deliveries/${b.dataset.cancel}/cancel`, { reason }), "Batalkan")));
}

function deliveryForm(reload) {
  openModal({
    title: "Pengiriman SJ ke customer", wide: true, submitLabel: "Simpan pengiriman",
    body: `<div class="form-grid">
        <label>Customer<select name="customer_id" required>${options(customers(), "", undefined, "- pilih -")}</select></label>
        <label>Tanggal kirim<input type="date" name="delivery_date" value="${today()}"></label>
        <label>Kurir<input name="courier" placeholder="JNE / J&T / kurir sendiri"></label>
        <label>No resi kurir<input name="resi_number" placeholder="kosong = pakai nomor SJD"></label>
        <label class="wide">Catatan<input name="note"></label>
      </div><div id="readyBox" class="muted">Pilih customer untuk melihat SJ yang sudah diterima dan belum dikirim.</div>`,
    onOpen: (f) => {
      f.customer_id.onchange = async () => {
        const rows = await get(`/sj/ready?customer_id=${f.customer_id.value}`);
        document.getElementById("readyBox").innerHTML = table(
          `<th><input type="checkbox" id="allReady" checked></th><th>Job</th><th>No SJ</th><th>Rute</th><th>SJ diterima</th><th>Tagihan</th>`,
          rows.map((r) => `<tr><td><input type="checkbox" data-job="${r.job_id}" checked></td><td><b>${esc(r.job_number)}</b></td><td>${esc(r.sj_number || "")}</td>
            <td>${esc(r.pol)} - ${esc(r.pod)} · ${esc(r.plate_number || "")}</td><td>${tgl(r.sj_received_at)}</td><td>${esc(BILL_LABEL[r.customer_status] || "")}</td></tr>`).join(""),
          "Tidak ada SJ yang siap dikirim");
        document.getElementById("allReady")?.addEventListener("change", (e) => f.querySelectorAll("[data-job]").forEach((c) => (c.checked = e.target.checked)));
      };
    },
    onSubmit: async (d, f) => {
      const job_ids = [...f.querySelectorAll("[data-job]:checked")].map((c) => Number(c.dataset.job));
      const r = await api("POST", "/sj/deliveries", { ...d, job_ids });
      toast(`${r.number} dibuat (${job_ids.length} SJ)`);
      reload();
    },
  });
}

// ---------------------------------------------------------------- cetak tanda pengiriman
export async function renderDeliveryPrint(id) {
  const d = await get(`/sj/deliveries/${id}`);
  const s = state.cache.settings;
  view().innerHTML = `
    <div class="page-head no-print"><a href="#/sj" class="btn">&larr; Kembali</a><div class="spacer"></div><button class="primary" onclick="window.print()">Cetak / simpan PDF</button></div>
    <div class="print-doc">
      <div class="print-head"><div><div class="print-company">${esc(s.company_name || "PT AMICO")}</div><div class="muted">${esc(s.company_address || "")}</div></div>
        <div class="print-title">TANDA PENGIRIMAN SURAT JALAN<div class="print-number">${esc(d.number)}</div></div></div>
      <div class="print-meta">
        <div>Kepada<span>${esc(d.customer)}</span></div><div>Tanggal kirim<span>${tgl(d.delivery_date)}</span></div>
        <div>Kurir<span>${esc(d.courier || "-")}</span></div><div>No resi<span>${esc(d.resi_number || "-")}</span></div><div>Jumlah SJ<span>${d.lines.length}</span></div>
      </div>
      ${table(`<th>No</th><th>No job</th><th>No SJ</th><th>Tanggal</th><th>Rute</th><th>Nopol</th><th>Kode tugas</th>`,
        d.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.job_number)}</td><td>${esc(l.sj_number || "")}</td><td>${tgl(l.job_date)}</td>
          <td>${esc(l.pol)} - ${esc(l.pod)}</td><td>${esc(l.plate_number || "")}</td><td>${esc(l.do_number || "")}</td></tr>`).join(""))}
      ${d.note ? `<p>${esc(d.note)}</p>` : ""}
      <div class="print-meta" style="margin-top:48px"><div>Dikirim oleh<span style="margin-top:56px">(.............................)</span></div>
        <div>Diterima oleh<span style="margin-top:56px">(.............................)</span></div></div>
    </div>`;
}

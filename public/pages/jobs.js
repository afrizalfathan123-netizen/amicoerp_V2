// Job: daftar, form (operasional + harga), detail (perjalanan, baris order, dokumen, jurnal kas, riwayat).
import {
  state, api, get, view, esc, rp, tgl, jam, kv, tile, badge, options, enumOptions, table, toast, openModal, askReason,
  action, customers, vendors, partnerBanksOf, locLabel, num, today, debounce, bindRows, canJob, canFinance,
  KIND_LABEL, PHASE_LABEL, SELLING_MODES, dtLocal, fromDtLocal, loadMaster,
} from "../lib.js";
import { gateModal, positionModal } from "./tracker.js";
import { ledgerTable, shortPanel } from "./reports.js";

const SCOPE = { INTERCITY: "Antar kota", INNERCITY: "Dalam kota" };
const TRIP = { ONE_WAY: "One way", ROUND_TRIP: "PP / round trip" };
const SCHEME = { "70_30": "DP 70% + pelunasan 30%", FULL: "Langsung 100%" };

function shortBadge(j) {
  const parts = [];
  if (j.kurang_transfer_vendor > 0) parts.push(`ke vendor ${rp(j.kurang_transfer_vendor)}`);
  if (j.kurang_bayar_customer > 0) parts.push(`dari customer ${rp(j.kurang_bayar_customer)}`);
  return parts.length ? `<br><span class="badge warn" title="Kurang transfer ${esc(parts.join(", "))}">Kurang transfer</span>` : "";
}

export async function renderJobs() {
  const f = JSON.parse(sessionStorage.getItem("jobFilter") || "{}");
  view().innerHTML = `
    <div class="page-head"><h1>Job</h1><div class="spacer"></div>
      <div class="actions">${canJob() ? `<button class="primary" id="newJob">+ Job baru</button>` : ""}</div></div>
    <div class="panel">
      <div class="filters">
        <label>Cari<input id="jSearch" placeholder="No job, plat, DO, customer, driver" value="${esc(f.search || "")}"></label>
        <label>Status<select id="jState"><option value="">Semua</option>${enumOptions({ confirmed: "Berjalan", done: "Selesai", cancelled: "Dibatalkan", kurang_transfer: "Kurang transfer" }, f.state)}</select></label>
        <label>Lingkup<select id="jScope"><option value="">Semua</option>${enumOptions(SCOPE, f.scope)}</select></label>
        <label>Dari<input type="date" id="jFrom" value="${esc(f.from || "")}"></label>
        <label>Sampai<input type="date" id="jTo" value="${esc(f.to || "")}"></label>
      </div>
      <div id="jobTable"></div>
    </div>`;
  document.getElementById("newJob")?.addEventListener("click", () => jobForm());
  const el = (id) => document.getElementById(id);
  const load = async () => {
    const flt = { search: el("jSearch").value, state: el("jState").value, scope: el("jScope").value, from: el("jFrom").value, to: el("jTo").value };
    sessionStorage.setItem("jobFilter", JSON.stringify(flt));
    const rows = await get(`/jobs?${new URLSearchParams(flt)}`);
    el("jobTable").innerHTML = table(
      `<th>No job</th><th>Tgl</th><th>Customer</th><th>Rute</th><th>Truk / plat</th><th>Driver</th><th>Skema</th>
       <th class="num">Selling</th><th class="num">Cost</th><th class="num">Piutang</th><th class="num">Utang</th><th>Status</th>`,
      rows.map((j) => `<tr class="click" data-href="#/jobs/${j.id}">
        <td><b>${esc(j.job_number)}</b></td><td>${tgl(j.job_date)}</td><td>${esc(j.customer)}</td>
        <td>${esc(j.pol)} - ${esc(j.pod)}${j.trip_type === "ROUND_TRIP" ? " PP" : ""}${j.delivery_scope === "INNERCITY" ? `<br><span class="muted">dalam kota${j.rit_number ? ` rit ${j.rit_number}` : ""}</span>` : ""}</td>
        <td>${esc(j.truck_type)}<br><span class="muted">${esc(j.plate_number || "")}</span></td>
        <td>${esc(j.driver1_name || "")}</td>
        <td>${j.payment_scheme === "FULL" ? "100%" : "70/30"}</td>
        <td class="num">${rp(j.selling)}</td><td class="num">${rp(j.cost)}</td>
        <td class="num">${rp(j.selling - j.received)}</td><td class="num">${rp(j.cost - j.paid)}</td>
        <td>${badge(j.state)}${shortBadge(j)}</td></tr>`).join(""),
      "Belum ada job") + (rows.length >= 300 ? `<div class="note-box">Ditampilkan 300 job terbaru. Persempit dengan filter.</div>` : "");
    bindRows(el("jobTable"));
  };
  el("jSearch").oninput = debounce(load);
  for (const k of ["jState", "jScope", "jFrom", "jTo"]) el(k).onchange = load;
  await load();
}

export function jobForm(job = null, balance = null) {
  const j = job || { job_date: today(), trip_type: "ONE_WAY", truck_type: "CDDL", delivery_scope: "INTERCITY", service_type: "TRUCKING", selling_mode: "PRICE_BOOK" };
  const locked = balance && (balance.invoiced > 0 || balance.requested > 0);
  const c = state.cache;
  const purchase = job?.lines?.find((l) => l.side === "PURCHASE" && l.kind === "TRUCKING");
  openModal({
    title: job ? `Edit ${job.job_number}` : "Job baru",
    wide: true,
    body: `
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
        <label>Driver 1<input name="driver1_name" value="${esc(j.driver1_name || "")}"></label>
        <label>HP driver 1<input name="driver1_phone" value="${esc(j.driver1_phone || "")}"></label>
        <label>Driver 2<input name="driver2_name" value="${esc(j.driver2_name || "")}"></label>
        <label>HP driver 2<input name="driver2_phone" value="${esc(j.driver2_phone || "")}"></label>
      </div>
      <h4>Harga</h4>
      <div class="form-grid">
        <div class="wide price-info" id="priceInfo">Pilih customer, rute, truk, dan trip untuk melihat price book.</div>
        <label>Skema bayar<select name="payment_scheme" ${locked ? "disabled" : ""}>${enumOptions(SCHEME, j.payment_scheme || "70_30")}</select></label>
        <label>Selling<select name="selling_mode">${enumOptions(SELLING_MODES, j.selling_mode)}</select></label>
        <label>Nominal selling<input class="num" name="selling" value="${balance ? (job.lines.find((l) => l.side === "SALE" && l.kind === "TRUCKING")?.amount ?? "") : ""}"></label>
        <label>Cost truk<input class="num" name="cost" value="${purchase?.amount ?? ""}" placeholder="Kosong = dari price book"></label>
        <label>Selling setelah pajak<input class="num" name="selling_after_tax" value="${j.selling_after_tax ?? ""}" placeholder="Kosong = dari pajak customer"></label>
        <label class="wide">Catatan<textarea name="note" rows="2">${esc(j.note || "")}</textarea></label>
      </div>
      <datalist id="truckTypes">${[...new Set(c.pricelist.map((p) => p.truck_type).concat(c.vehicles.map((v) => v.truck_type), ["CDD", "CDDL", "FUSO", "TRONTON", "WINGBOX"]))].map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      <datalist id="plates">${c.vehicles.filter((v) => v.active).map((v) => `<option value="${esc(v.plate_number)}">${esc(v.truck_type)}</option>`).join("")}</datalist>
      ${locked ? `<div class="note-box">Customer dan skema bayar terkunci karena job ini sudah punya invoice / pengajuan. Harga tidak bisa diturunkan di bawah yang sudah ditagih / diajukan.</div>` : ""}`,
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
      E.delivery_scope.addEventListener("change", () => { if (!locked) E.payment_scheme.value = E.delivery_scope.value === "INNERCITY" ? "FULL" : "70_30"; });
      E.vendor_id.addEventListener("change", fillBanks);
      E.selling_mode.onchange = applyMode;
      for (const n of ["customer_id", "pol_id", "pod_id", "truck_type", "trip_type", "job_date"]) E[n].addEventListener("change", lookup);
      fillBanks();
      lookup();
    },
    onSubmit: async (d) => {
      for (const k of ["selling", "cost", "selling_after_tax"]) d[k] = num(d[k]);
      if (locked) { delete d.customer_id; delete d.payment_scheme; }
      if (job && !d.cost && purchase) d.cost = purchase.amount;
      if (job) {
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
      <h1>${esc(j.job_number)}</h1>${badge(j.state)}
      <span class="sub">${esc(j.customer)} &middot; ${esc(j.pol)} - ${esc(j.pod)}${j.trip_type === "ROUND_TRIP" ? " PP" : ""} &middot; ${esc(j.plate_number || "")}</span>
      <div class="spacer"></div>
      <div class="actions">${canJob() && j.state !== "cancelled" ? `
        <button id="editJob">Edit / ganti rute</button>
        <button id="topup">Top-up cost</button>
        ${j.state === "confirmed" ? `<button id="doneJob">Tandai selesai</button>` : `<button id="reopenJob">Buka lagi</button>`}
        <button class="danger" id="cancelJob">Batalkan job</button>` : ""}
      </div>
    </div>
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
        ${kv("Skema bayar", SCHEME[j.payment_scheme])}${kv("Truk", j.truck_type)}${kv("Plat", j.plate_number)}
        ${kv("Driver", [j.driver1_name, j.driver1_phone].filter(Boolean).join(" / "))}${kv("Driver 2", [j.driver2_name, j.driver2_phone].filter(Boolean).join(" / "))}
        ${kv("DO", j.do_number)}${kv("Selling", SELLING_MODES[j.selling_mode])}
        ${kv("Pajak customer", j.pph_pct || j.ppn_pct ? `PPh ${j.pph_pct}% / PPN ${j.ppn_pct}%` : "Tanpa pajak")}
        ${kv("Selling setelah pajak", j.selling_after_tax != null ? `${rp(j.selling_after_tax)} (manual)` : "Dihitung dari pajak customer")}
        ${kv("Catatan", j.note)}
      </div></div>
      <div class="panel"><h2>Perjalanan & SJ <div class="spacer"></div>${canJob() ? `
        ${!j.gate_out_at ? `<button class="small" id="gateOut">Gate out</button>` : ""}
        ${j.gate_out_at && !j.gate_in_at ? `<button class="small" id="pos">Update posisi</button> <button class="small" id="gateIn">Gate in</button>` : ""}
        <button class="small" id="editTrip">Edit</button>` : ""}</h2>
        <div class="kv">
          ${kv("Gate out", jam(j.gate_out_at))}${kv("Gate in", jam(j.gate_in_at))}
          ${kv("SJ", j.sj_number)}${kv("Resi SJ diterima", tgl(j.sj_resi_received_at))}${kv("SJ diterima", tgl(j.sj_received_at))}
          ${kv("No resi SJ", j.sj_resi_number)}${kv("SJ dikirim ke customer", tgl(j.sj_delivered_at))}${kv("Resi kirim SJ", j.sj_delivered_resi_number)}
        </div>
        ${d.trip_updates.length ? `<h4>Posisi</h4>${table("<th>Waktu</th><th>Posisi</th><th>Catatan</th><th>Oleh</th>",
          d.trip_updates.map((u) => `<tr><td>${jam(u.at)}</td><td>${esc(u.location)}</td><td>${esc(u.note || "")}</td><td>${esc(u.by_name || "")}</td></tr>`).join(""))}` : ""}
      </div>
    </div>
    <div class="panel"><h2>Posisi per fase <span class="hint">rencana, sudah ditagih / diajukan, dan dibayar</span></h2>
      ${table(`<th>Sisi</th><th>Fase</th><th class="num">Rencana</th><th class="num">Belum ditagih / diajukan</th><th class="num">Ditagih / diajukan, belum dibayar</th><th class="num">Dibayar</th>`,
        [...sale, ...purch].map((p) => `<tr><td>${p.side === "SALE" ? "Customer" : "Vendor"}</td><td>${esc(PHASE_LABEL[p.phase])}</td>
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
    <div class="panel"><h2>Invoice & pengajuan</h2>
      ${table(`<th>Dokumen</th><th>Jenis</th><th>Fase</th><th>Tgl</th><th>Partner</th><th class="num">Nominal job ini</th><th>Status</th>`,
        d.moves.map((m) => `<tr class="click" data-href="#/moves/${m.id}">
          <td><b>${esc(m.number || "(draft)")}</b></td><td>${m.move_type === "out_invoice" ? "Invoice customer" : "Pengajuan vendor"}${m.payment_channel === "TRANSFER_MALAM" ? "<br><span class='muted'>transfer malam</span>" : ""}</td>
          <td>${esc(PHASE_LABEL[m.phase])}</td><td>${tgl(m.move_date)}</td><td>${esc(m.partner || "")}</td>
          <td class="num">${m.cancelled_at ? `<s>${rp(m.amount)}</s>` : rp(m.amount)}</td><td>${badge(m.state)} ${badge(m.approval_state)}</td></tr>`).join(""), "Belum ada")}
    </div>
    <div class="panel"><h2>Jurnal kas job ini <span class="hint">uang benar-benar masuk / keluar</span></h2>${ledgerTable(d.ledger, false)}</div>
    <div class="panel"><h2>Riwayat perubahan</h2>
      ${table("<th>Waktu</th><th>Aksi</th><th>Oleh</th><th>Detail</th>",
        d.audit.map((a) => `<tr><td>${jam(a.at)}</td><td>${esc(a.action)}</td><td>${esc(a.by_name || "")}</td><td class="muted small-text">${esc(JSON.stringify(a.detail || {}))}</td></tr>`).join(""), "Belum ada")}
    </div>`;
  bindRows();
  const reload = () => window.dispatchEvent(new Event("hashchange"));
  const on = (sel, fn) => document.getElementById(sel)?.addEventListener("click", fn);
  on("editJob", () => jobForm({ ...j, lines: d.lines }, { ...b, invoiced: b.invoiced, requested: b.requested }));
  on("doneJob", action(() => api("POST", `/jobs/${id}/state`, { state: "done" }), "Job selesai"));
  on("reopenJob", action(() => api("POST", `/jobs/${id}/state`, { state: "confirmed" }), "Job dibuka lagi"));
  on("cancelJob", () => askReason("Batalkan job", "Hanya bisa kalau belum ada invoice / pengajuan aktif.", (reason) => api("POST", `/jobs/${id}/state`, { state: "cancelled", reason }), "Batalkan job"));
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

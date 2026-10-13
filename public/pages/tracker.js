// Tracker perjalanan: belum berangkat / dalam perjalanan / selesai, durasi vs SLA, posisi terakhir.
import { get, api, view, esc, rp, tgl, jam, toast, openModal, canJob, enumOptions, debounce, fromDtLocal, dtLocal, latest, skelTable, pagedTable } from "../lib.js";

const STATUS = { "": "Semua", "DALAM PERJALANAN": "Dalam perjalanan", "BELUM BERANGKAT": "Belum berangkat", SELESAI: "Selesai" };

export async function renderTracker() {
  const f = JSON.parse(sessionStorage.getItem("trackerFilter") || '{"status":"DALAM PERJALANAN"}');
  view().innerHTML = `
    <div class="page-head"><h1>Tracker</h1><span class="sub">Gate out sampai gate in, dibandingkan SLA rute</span>
      <div class="spacer"></div><div class="actions"><a class="btn" href="/api/export/tracker.xlsx">Export Excel</a></div></div>
    <div class="panel">
      <div class="filters">
        <label>Status<select id="tStatus">${enumOptions(STATUS, f.status ?? "")}</select></label>
        <label>Cari<input id="tSearch" placeholder="Job, plat, driver, customer" value="${esc(f.search || "")}"></label>
        <label>Tgl job dari<input type="date" id="tFrom" value="${esc(f.from || "")}"></label>
        <label>Sampai<input type="date" id="tTo" value="${esc(f.to || "")}"></label>
      </div>
      <div id="tBox">${skelTable(8, 8)}</div>
    </div>`;
  const el = (id) => document.getElementById(id);
  const only = latest();
  const load = async () => {
    const flt = { status: el("tStatus").value, search: el("tSearch").value, from: el("tFrom").value, to: el("tTo").value };
    sessionStorage.setItem("trackerFilter", JSON.stringify(flt));
    const rows = await only(get(`/tracker?${new URLSearchParams(flt)}`));
    pagedTable(el("tBox"), { rows, empty: "Tidak ada perjalanan",
      head: `<th>Job</th><th>Tgl</th><th>Customer</th><th>Rute</th><th>Truk / plat</th><th>Driver</th><th>Status</th>
       <th>Gate out</th><th>Gate in</th><th class="num">Durasi (jam)</th><th class="num">SLA</th><th>Posisi terakhir</th>${canJob() ? "<th></th>" : ""}`,
      row: (r) => `<tr class="${r.lewat_sla ? "late" : ""}">
        <td><a href="#/jobs/${r.job_id}">${esc(r.job_number)}</a></td><td>${tgl(r.job_date)}</td><td>${esc(r.customer)}</td>
        <td>${esc(r.pol)} - ${esc(r.pod)}${r.trip_type === "ROUND_TRIP" ? " PP" : ""}${r.delivery_scope === "INNERCITY" ? `<br><span class="muted">dalam kota${r.rit_number ? ` rit ${r.rit_number}` : ""}</span>` : ""}</td>
        <td>${esc(r.truck_type)}<br><b>${esc(r.plate_number || "")}</b></td>
        <td>${esc(r.driver1_name || "")}<br><span class="muted">${esc(r.driver1_phone || "")}</span></td>
        <td><span class="badge ${r.trip_status === "SELESAI" ? "done" : r.trip_status === "DALAM PERJALANAN" ? "open" : "draft"}">${esc(r.trip_status)}</span>
          ${r.lewat_sla ? `<br><span class="badge warn">Lewat SLA</span>` : ""}</td>
        <td>${jam(r.gate_out_at)}</td><td>${jam(r.gate_in_at)}</td>
        <td class="num">${r.durasi_jam ?? ""}</td><td class="num">${r.sla_hours ?? "-"}</td>
        <td>${esc(r.posisi_terakhir || "")}<br><span class="muted">${jam(r.update_terakhir_at)}</span></td>
        ${canJob() ? `<td class="nowrap">${r.trip_status === "BELUM BERANGKAT" ? `<button class="small" data-out="${r.job_id}">Gate out</button>` : ""}
          ${r.trip_status === "DALAM PERJALANAN" ? `<button class="small" data-pos="${r.job_id}">Update posisi</button> <button class="small" data-in="${r.job_id}">Gate in</button>` : ""}</td>` : ""}
      </tr>`,
      after: (box) => {
        box.querySelectorAll("[data-out]").forEach((b) => (b.onclick = () => gateModal(b.dataset.out, "gate_out_at", "Gate out", load)));
        box.querySelectorAll("[data-in]").forEach((b) => (b.onclick = () => gateModal(b.dataset.in, "gate_in_at", "Gate in", load)));
        box.querySelectorAll("[data-pos]").forEach((b) => (b.onclick = () => positionModal(b.dataset.pos, load)));
      } });
  };
  el("tStatus").onchange = load; el("tFrom").onchange = load; el("tTo").onchange = load;
  el("tSearch").oninput = debounce(load);
  await load();
}

export function gateModal(jobId, field, label, after) {
  openModal({
    title: label,
    body: `<label>Waktu<input type="datetime-local" name="at" value="${dtLocal(new Date().toISOString())}" required></label>`,
    onSubmit: async (d) => {
      await api("PUT", `/jobs/${jobId}/trip`, { [field]: fromDtLocal(d.at) });
      toast(`${label} dicatat`);
      await after?.();
    },
  });
}

export function positionModal(jobId, after) {
  openModal({
    title: "Update posisi truk",
    body: `<div class="form-grid"><label>Posisi<input name="location" placeholder="contoh: Kendal" required></label>
      <label>Waktu<input type="datetime-local" name="at" value="${dtLocal(new Date().toISOString())}"></label>
      <label class="wide">Catatan<input name="note"></label></div>`,
    onSubmit: async (d) => {
      await api("POST", `/jobs/${jobId}/trip-updates`, { location: d.location, note: d.note, at: fromDtLocal(d.at) });
      toast("Posisi dicatat");
      await after?.();
    },
  });
}

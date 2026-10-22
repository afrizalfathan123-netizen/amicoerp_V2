// Sisihkan: job yang perlu dibetulkan dulu (kode tugas dobel, trip "tidak jadi jalan" yang masih aktif).
// Kode tugas bisa diganti langsung di sini; aturan "satu kode tugas satu job" tetap dijaga server.
import { get, api, view, esc, tgl, jam, toast, canJob, askReason, skelTable } from "../lib.js";

const rute = (j) => `${j.pol} - ${j.pod}${j.trip_type === "ROUND_TRIP" ? " PP" : ""}${j.delivery_scope === "INNERCITY" ? " (dalam kota)" : ""}`;
const info = (j) => `<td><a href="#/jobs/${j.id}"><b>${esc(j.job_number)}</b></a><br><span class="muted">${tgl(j.job_date)}</span></td>
  <td>${esc(j.customer)}<br><span class="muted">${esc(rute(j))}</span></td>
  <td>${esc(j.plate_number || "-")}<br><span class="muted">${esc(j.driver1_name || "")}</span></td>
  <td class="nowrap">${j.gate_out_at ? `out ${jam(j.gate_out_at)}` : `<span class="muted">belum gate out</span>`}${j.gate_in_at ? `<br>in ${jam(j.gate_in_at)}` : ""}</td>
  <td class="num">${j.dokumen ? `${j.dokumen} baris<br><span class="muted">invoice / pengajuan</span>` : "-"}</td>`;
const aksi = (j) => (canJob() ? `<td class="nowrap"><span class="gate-box"><input data-do="${j.id}" value="${esc(j.do_number || "")}" placeholder="kode tugas benar" style="width:170px">
  <button type="button" class="small primary" data-save="${j.id}">Simpan</button></span>
  <br><button type="button" class="small danger" data-cancel="${j.id}" ${j.dokumen ? 'title="Batalkan dulu invoice / pengajuannya"' : ""}>Batalkan job</button></td>` : "<td></td>");

export async function renderSisihkan() {
  view().innerHTML = `
    <div class="page-head"><h1>Sisihkan</h1>
      <span class="sub">Job yang perlu dibetulkan dulu. Satu kode tugas hanya untuk satu job: one way tetap satu kode tugas walau banyak titik bongkar / muat,
        round trip cukup kode tugas pergi. Ganti kode tugas yang salah langsung di sini, atau batalkan job yang trip-nya memang tidak jalan.</span></div>
    <div id="sBox">${skelTable(6, 6)}</div>`;
  const s = await get("/jobs/sisihkan");
  const groups = new Map();
  for (const j of s.dobel) groups.set(j.kode_tugas, [...(groups.get(j.kode_tugas) || []), j]);
  const head = `<th>Job</th><th>Customer / rute</th><th>Plat / driver</th><th>Gate</th><th class="num">Dokumen</th><th>Betulkan</th>`;
  document.getElementById("sBox").innerHTML = `
    <div class="tiles">
      <div class="tile ${groups.size ? "warn" : ""}"><div class="label">Kode tugas dobel</div><div class="value">${groups.size}</div><div class="note">${s.dobel.length} job</div></div>
      <div class="tile ${s.tidak_jalan.length ? "warn" : ""}"><div class="label">Trip "tidak jadi jalan" masih aktif</div><div class="value">${s.tidak_jalan.length}</div><div class="note">sebaiknya dibatalkan</div></div>
    </div>
    <div class="panel"><h2>Kode tugas dipakai lebih dari satu job <span class="hint">ganti kode tugas job yang salah; yang benar biarkan</span></h2>
      ${groups.size ? [...groups].map(([kode, jobs]) => `<h3 class="sub-h">${esc(kode)} <span class="muted">(${jobs.length} job)</span></h3>
        <div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${jobs.map((j) => `<tr>${info(j)}${aksi(j)}</tr>`).join("")}</tbody></table></div>`).join("")
        : `<p class="empty">Tidak ada kode tugas yang dobel.</p>`}
    </div>
    <div class="panel"><h2>Trip "tidak jadi jalan" yang masih aktif <span class="hint">kode tugasnya berisi "TIDAK JADI ...", "CANCEL", atau "BATAL"; batalkan job-nya supaya tidak ikut dihitung</span></h2>
      ${s.tidak_jalan.length ? `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${s.tidak_jalan.map((j) => `<tr>${info(j)}${aksi(j)}</tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">Tidak ada.</p>`}
    </div>`;
  const box = document.getElementById("sBox");
  const save = async (id) => {
    const input = box.querySelector(`[data-do="${id}"]`);
    try {
      const d = await get(`/jobs/${id}`);
      await api("PUT", `/jobs/${id}`, { do_number: input.value.trim(), expected_version: d.job.version });
      toast(`${d.job.job_number}: kode tugas disimpan`);
      window.dispatchEvent(new Event("hashchange"));
    } catch (e) { toast(e.message, true); }
  };
  box.querySelectorAll("[data-save]").forEach((b) => (b.onclick = () => save(b.dataset.save)));
  box.querySelectorAll("[data-do]").forEach((i) => (i.onkeydown = (e) => { if (e.key === "Enter") save(i.dataset.do); }));
  box.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => askReason("Batalkan job", "Hanya bisa kalau job ini belum punya invoice / pengajuan aktif.",
    (reason) => api("POST", `/jobs/${b.dataset.cancel}/state`, { state: "cancelled", reason }), "Batalkan job")));
}

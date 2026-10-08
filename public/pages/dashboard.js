import { get, view, tile, rp, esc, table, isAdmin, state } from "../lib.js";

function greeting() {
  const h = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta", hour: "numeric", hour12: false }));
  return h < 11 ? "Selamat pagi" : h < 15 ? "Selamat siang" : h < 18 ? "Selamat sore" : "Selamat malam";
}

export async function renderDashboard() {
  const { totals: t, monthly } = await get("/dashboard");
  const date = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", weekday: "long", day: "2-digit", month: "long", year: "numeric" })
    .replace(",", " ·");
  const todo = (t.menunggu_persetujuan || 0) + (t.kurang_transfer_jobs || 0) + (t.trip_lewat_sla || 0) + (t.tanpa_tujuan || 0);
  const name = String(state.user.display_name || "").split(/\s+/)[0];
  view().innerHTML = `
    <section class="hero">
      <div class="eyebrow">${esc(date)}</div>
      <h1>Setiap job jalan,<br><em>setiap rupiah tercatat.</em></h1>
      <p>${greeting()}, ${esc(name)}. ${todo
        ? `Ada <b>${rp(todo)} hal</b> yang perlu ditinjau: ${[
            t.menunggu_persetujuan ? `${rp(t.menunggu_persetujuan)} pengajuan menunggu persetujuan` : "",
            t.kurang_transfer_jobs ? `${rp(t.kurang_transfer_jobs)} job kurang transfer` : "",
            t.trip_lewat_sla ? `${rp(t.trip_lewat_sla)} truk lewat SLA` : "",
            t.tanpa_tujuan ? `${rp(t.tanpa_tujuan)} selisih tanpa tujuan` : ""].filter(Boolean).join(", ")}.`
        : "Tidak ada yang menunggu tindakan hari ini."} ${rp(t.jobs)} job aktif, ${rp(t.trip_jalan)} truk dalam perjalanan.</p>
      <div class="chips">
        <a class="btn brass" href="#/jobs">Lihat job &nearr;</a>
        <a class="btn ghost" href="#/rekap">Rekap posisi</a>
        ${t.kurang_transfer_jobs ? `<a class="btn ghost" href="#/jobs" onclick="sessionStorage.setItem('jobFilter', JSON.stringify({ state: 'kurang_transfer' }))">Job kurang transfer</a>` : ""}
      </div>
    </section>
    <div class="page-head"><h1>Ringkasan</h1><span class="sub">Semua angka dihitung dari dokumen dan pembayaran</span></div>
    <div class="tiles">
      ${tile("Selling", t.selling)}${tile("Cost", t.cost)}${tile("Margin rencana", t.selling - t.cost)}
      ${tile("Perlu ditagih", t.perlu_ditagih, "", "Selling yang belum dibuatkan invoice", "#/rekap")}
      ${tile("Piutang", t.piutang, "in", "Sudah ditagih, belum dibayar customer", "#/rekap")}
      ${tile("Belum diajukan", t.belum_diajukan, "", "Cost yang belum masuk pengajuan", "#/rekap")}
      ${tile("Utang", t.utang, "out", "Sudah diajukan, belum ditransfer", "#/rekap")}
      ${tile("Kas bersih", t.kas, "", "Uang masuk - uang keluar")}
    </div>
    <div class="tiles">
      ${tile("Menunggu persetujuan", t.menunggu_persetujuan_total, t.menunggu_persetujuan ? "warn" : "",
        `${t.menunggu_persetujuan} pengajuan${isAdmin() ? " - klik untuk menyetujui" : ""}`, "#/requests")}
      ${tile("Titipan kas operasional", t.titipan, t.titipan ? "warn" : "", "Dana transfer malam belum disalurkan ke vendor", "#/kas")}
      ${tile("Truk dalam perjalanan", t.trip_jalan, "", `${t.trip_lewat_sla} lewat SLA`, "#/tracker")}
      ${tile("Kurang transfer", t.kurang_transfer_total, t.kurang_transfer_jobs ? "warn" : "", `${t.kurang_transfer_jobs} job`, "#/rekap")}
      ${tile("Selisih tanpa tujuan", t.tanpa_tujuan_total, t.tanpa_tujuan ? "warn" : "", `${t.tanpa_tujuan} baris belum diarahkan`, "#/unassigned")}
    </div>
    <div class="panel"><div class="eyebrow">Arus kas</div><h2>Uang masuk / keluar per bulan</h2>
      ${table(`<th>Bulan</th><th class="num">Masuk</th><th class="num">Keluar</th><th class="num">Bersih</th>`,
        monthly.map((m) => `<tr><td>${esc(m.bulan)}</td><td class="num">${rp(m.masuk)}</td><td class="num">${rp(m.keluar)}</td><td class="num"><b>${rp(m.masuk - m.keluar)}</b></td></tr>`).join(""),
        "Belum ada pembayaran")}
    </div>`;
}

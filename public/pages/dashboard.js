import { get, view, tile, rp, esc, table, isAdmin } from "../lib.js";

export async function renderDashboard() {
  const { totals: t, monthly } = await get("/dashboard");
  view().innerHTML = `
    <div class="page-head"><h1>Dashboard</h1><span class="sub">${rp(t.jobs)} job aktif</span></div>
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
    </div>
    <div class="panel"><h2>Uang masuk / keluar per bulan</h2>
      ${table(`<th>Bulan</th><th class="num">Masuk</th><th class="num">Keluar</th><th class="num">Bersih</th>`,
        monthly.map((m) => `<tr><td>${esc(m.bulan)}</td><td class="num">${rp(m.masuk)}</td><td class="num">${rp(m.keluar)}</td><td class="num"><b>${rp(m.masuk - m.keluar)}</b></td></tr>`).join(""),
        "Belum ada pembayaran")}
    </div>`;
}

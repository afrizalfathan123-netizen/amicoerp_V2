// Unit sewa: untung rugi per unit per bulan (+ rincian trip & kalender hari), kontrak sewa, tagihan sewa bulanan.
import { get, api, view, esc, rp, tgl, jam, kv, table, tile, toast, openModal, askReason, options, vendors, bankLabel, num, state,
  canFinance, bindRows, skelTable } from "../lib.js";
import { xlTable } from "../xlfilter.js";

const TABS = { profit: "Untung rugi", periods: "Per periode kontrak", contracts: "Kontrak sewa", bills: "Tagihan sewa" };
const thisMonth = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 7);
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
const banks = () => state.cache.banks.filter((b) => b.active);
const reload = () => window.dispatchEvent(new Event("hashchange"));
const tglId = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
// periode tampilan: per bulan, rentang tanggal bebas, atau keseluruhan (sejak kontrak pertama s/d hari ini)
function periodOf(saved) {
  const mode = ["month", "range", "all"].includes(saved.mode) ? saved.mode : "month";
  const month = saved.month || thisMonth();
  const from = saved.from || `${month}-01`;
  const to = saved.to || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
  const P = { mode, month, from, to };
  P.qs = mode === "all" ? "all=1" : mode === "range" ? `from=${from}&to=${to}` : `month=${month}`;
  P.body = mode === "all" ? { all: 1 } : mode === "range" ? { from, to } : { month };
  P.label = mode === "all" ? "keseluruhan" : mode === "range" ? `${tglId(from)} – ${tglId(to)}` : monthName(month);
  return P;
}
// untung (hijau) / rugi (merah, tanda minus)
const pl = (v) => `<span class="sign ${Number(v) >= 0 ? "plus" : "minus"}">${Number(v) < 0 ? "&minus;" : ""}${rp(Math.abs(Number(v)))}</span>`;

export async function renderUnits() {
  const saved = JSON.parse(sessionStorage.getItem("units") || "{}");
  const tab = TABS[saved.tab] ? saved.tab : "profit";
  const P = periodOf(saved);
  const save = (x) => sessionStorage.setItem("units", JSON.stringify({ ...saved, tab, ...x }));
  view().innerHTML = `
    <div class="page-head"><h1>Unit Sewa</h1>
      <span class="sub">Unit yang disewa bulanan: biaya per hari, untung per trip, dan untung per unit. Trip diambil otomatis dari job dengan plat yang sama.</span>
      <div class="spacer"></div>
      <div class="period-pick" ${tab === "periods" || tab === "contracts" ? "hidden" : ""}>
        <label>Periode<select id="uMode">${[["month", "Per bulan"], ["range", "Rentang tanggal"], ["all", "Keseluruhan"]]
          .map(([v, l]) => `<option value="${v}" ${P.mode === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        ${P.mode === "month" ? `<label>Bulan<input type="month" id="uMonth" value="${esc(P.month)}"></label>` : ""}
        ${P.mode === "range" ? `<label>Dari<input type="date" id="uFrom" value="${esc(P.from)}"></label>
          <label>Sampai<input type="date" id="uTo" value="${esc(P.to)}"></label>` : ""}
      </div></div>
    <div id="uAlerts"></div>
    <div class="tabs">${Object.entries(TABS).map(([k, l]) => `<a href="#" data-tab="${k}" class="${k === tab ? "active" : ""}">${esc(l)}</a>`).join("")}</div>
    <div id="uBox">${skelTable(6, 7)}</div>`;
  showAlerts();
  view().querySelectorAll("[data-tab]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); save({ tab: a.dataset.tab }); renderUnits(); }));
  document.getElementById("uMode").onchange = (e) => { save({ mode: e.target.value }); renderUnits(); };
  document.getElementById("uMonth")?.addEventListener("change", (e) => { save({ month: e.target.value || thisMonth() }); renderUnits(); });
  const range = () => {
    const from = document.getElementById("uFrom").value, to = document.getElementById("uTo").value;
    if (from && to && from <= to) { save({ from, to }); renderUnits(); } else if (from && to) toast("Tanggal awal harus sebelum tanggal akhir", true);
  };
  document.getElementById("uFrom")?.addEventListener("change", range);
  document.getElementById("uTo")?.addEventListener("change", range);
  const box = document.getElementById("uBox");
  if (tab === "contracts") return renderContracts(box);
  if (tab === "periods") return renderPeriods(box);
  if (tab === "bills") return renderBills(box, P);
  return renderProfit(box, P, saved.unit);
}

// ---------------------------------------------------------------- peringatan
const hariLagi = (n) => (n === 0 ? "hari ini" : n === 1 ? "besok" : `${n} hari lagi`);
async function showAlerts() {
  const a = await get("/units/alerts").catch(() => null);
  const box = document.getElementById("uAlerts");
  if (!a || !box) return;
  const items = [
    ...a.ending.map((x) => `<li><b>Kontrak ${esc(x.plate_number)} habis ${tglId(x.date_end)}</b> (${hariLagi(x.sisa_hari)}). ${x.kontrak_berikutnya
      ? `Kontrak berikutnya baru mulai ${tglId(x.kontrak_berikutnya)}, jadi ada jeda tanpa kontrak.`
      : `Biarkan kalau unit dikembalikan.${canFinance() ? ` <button type="button" class="small primary" data-alert-extend="${x.contract_id}" data-plate="${esc(x.plate_number)}" data-end="${tgl(x.date_end)}">Perpanjang 1 bulan</button>` : ""}`}</li>`),
    ...a.ended.map((x) => `<li><b>Kontrak ${esc(x.plate_number)} sudah habis ${tglId(x.date_end)}</b>${x.trip_setelah ? `, tapi masih ada <b>${x.trip_setelah} trip</b> setelahnya (sewanya tidak terhitung).` : "."}
      ${x.kontrak_berikutnya ? `Kontrak berikutnya baru mulai ${tglId(x.kontrak_berikutnya)}.` : "Belum diperpanjang."}</li>`),
    ...a.bills.map((x) => `<li>Tagihan sewa <b>${esc(x.number)}</b> (${esc(x.plate_number)}) ${x.sisa_hari < 0 ? `<b>telat ${-x.sisa_hari} hari</b> (jatuh tempo ${tglId(x.due_date)})` : `jatuh tempo ${hariLagi(x.sisa_hari)} (${tglId(x.due_date)})`}, sisa ${rp(x.residual)}.</li>`),
  ];
  box.innerHTML = items.length ? `<div class="note-box warn-box unit-alerts"><b>Perlu perhatian</b><ul>${items.join("")}</ul></div>` : "";
  box.querySelectorAll("[data-alert-extend]").forEach((b) => (b.onclick = () =>
    extendContract({ id: Number(b.dataset.alertExtend), plate_number: b.dataset.plate, date_end: b.dataset.end })));
}

// perpanjang kontrak 1 bulan (tanggal yang sama bulan berikutnya)
function extendContract(c) {
  const [y, m, d] = tgl(c.date_end).split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const baru = new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
  openModal({
    title: `Perpanjang kontrak ${c.plate_number}`,
    body: `<div class="kv">${kv("Selesai sekarang", tglId(tgl(c.date_end)))}${kv("Selesai baru", tglId(baru))}</div>
      <div class="note-box">Kontrak yang sama diperpanjang sebulan dengan harga sewa yang sama. Harga berubah? Batalkan, isi tanggal selesai kontrak ini lalu buat kontrak baru.</div>`,
    submitLabel: "Perpanjang",
    onSubmit: async () => { const r = await api("POST", `/units/contracts/${c.id}/extend`, { months: 1 }); toast(`Kontrak ${c.plate_number} diperpanjang sampai ${tglId(r.date_end)}`); reload(); },
  });
}

// ---------------------------------------------------------------- per periode kontrak
const PERIOD_COLS = [
  { key: "plate_number", label: "Unit", value: (x) => x.plate_number },
  { key: "ke", label: "Periode", num: true, value: (x) => x.ke, text: (x) => `Periode ${x.ke}` },
  { key: "from", label: "Tanggal", value: (x) => x.from, text: (x) => `${tglId(x.from)} – ${tglId(x.to)}` },
  { key: "status", label: "Status", value: (x) => ({ SELESAI: "Selesai", BERJALAN: "Berjalan", BELUM_MULAI: "Belum mulai" }[x.status]) },
  { key: "pemilik", label: "Pemilik", value: (x) => x.pemilik },
  { key: "sewa_periode", label: "Sewa periode", num: true, value: (x) => x.sewa_periode },
  { key: "trips", label: "Trip", num: true, value: (x) => x.trips, text: (x) => String(x.trips) },
  { key: "selling", label: "Selling", num: true, value: (x) => x.selling },
  { key: "uang_jalan", label: "Uang jalan", num: true, value: (x) => x.uang_jalan },
  { key: "kontribusi", label: "Kontribusi", num: true, value: (x) => x.kontribusi },
  { key: "untung", label: "Untung / rugi", num: true, value: (x) => x.untung },
  { key: "selisih", label: "vs periode sebelumnya", num: true, value: (x) => x.selisih_sebelumnya },
  { key: "utilisasi", label: "Utilisasi", num: true, value: (x) => x.utilisasi, text: (x) => `${x.utilisasi}%` },
  { key: "biaya_menganggur", label: "Biaya menganggur", num: true, value: (x) => x.biaya_menganggur },
];

async function renderPeriods(box) {
  const [s, al] = await Promise.all([get("/units/periods"), get("/units/alerts").catch(() => ({ ending: [], ended: [] }))]);
  // periode terakhir kontrak yang mau / sudah habis diberi tanda
  const lastKe = new Map();
  for (const x of s.periods) lastKe.set(x.contract_id, Math.max(lastKe.get(x.contract_id) || 0, x.ke));
  const endNote = (x) => {
    if (lastKe.get(x.contract_id) !== x.ke) return "";
    const e = al.ending.find((y) => y.contract_id === x.contract_id);
    if (e) return `<br><span class="badge warn">Kontrak habis ${hariLagi(e.sisa_hari)}</span>`;
    const d = al.ended.find((y) => y.contract_id === x.contract_id);
    return d ? `<br><span class="badge cancelled">Kontrak sudah habis</span>` : "";
  };
  box.innerHTML = `
    <div class="note-box" style="margin:0 0 14px">Satu <b>periode</b> = satu bulan sewa mengikuti tanggal mulai kontrak (mulai 21 Sep: periode 1 = 21 Sep – 20 Okt,
      periode 2 = 21 Okt – 20 Nov, ...), bukan bulan kalender. <b>Sewa periode</b> = sewa bulanan penuh (periode yang terpotong tanggal selesai kontrak dihitung sebanding harinya).
      <b>Untung / rugi</b> = kontribusi trip yang berangkat di periode itu - sewa periode${s.periods.some((x) => x.status === "BERJALAN") ? "; periode yang masih berjalan dihitung sampai hari ini" : ""}.
      <b>vs periode sebelumnya</b> = naik / turunnya untung dibanding periode sebelumnya unit yang sama.</div>
    <div class="tiles" id="pTiles"></div>
    <div class="panel"><h2>Per unit per periode <span class="hint">klik baris untuk melihat trip di periode itu</span></h2><div id="pTable"></div></div>
    <div id="pDetail"></div>`;
  const tiles = (rows) => {
    const done = rows.filter((x) => x.status === "SELESAI"), run = rows.filter((x) => x.status === "BERJALAN");
    const rugi = done.filter((x) => x.untung < 0);
    document.getElementById("pTiles").innerHTML =
      tile("Untung periode selesai", sumOf(done, "untung"), sumOf(done, "untung") >= 0 ? "plus" : "minus", `${done.length} periode selesai`) +
      tile("Periode berjalan (s/d hari ini)", sumOf(run, "untung"), sumOf(run, "untung") >= 0 ? "plus" : "minus", `${run.length} periode, sewa s/d hari ini ${rp(sumOf(run, "sewa_sd_hari_ini"))}`) +
      tile("Periode rugi", rugi.length, rugi.length ? "warn" : "", rugi.length ? `total rugi ${rp(Math.abs(sumOf(rugi, "untung")))}` : "dari periode yang sudah selesai") +
      tile("Kontribusi trip", sumOf(rows, "kontribusi"), "in", `${sumOf(rows, "trips")} trip, selling ${rp(sumOf(rows, "selling"))}`);
  };
  const delta = (v) => (v == null ? `<span class="muted">-</span>`
    : `<span class="sign ${v >= 0 ? "plus" : "minus"}">${v >= 0 ? "+" : "&minus;"}${rp(Math.abs(v))}</span>`);
  const grid = xlTable(document.getElementById("pTable"), {
    id: "unit-periods", columns: PERIOD_COLS, empty: "Belum ada kontrak sewa. Tambahkan di tab Kontrak sewa.",
    order: (a, b) => a.plate_number.localeCompare(b.plate_number) || a.ke - b.ke,
    rowHtml: (x) => `<tr class="click" data-period="${x.contract_id}:${x.ke}">
      <td><b>${esc(x.plate_number)}</b><br><span class="muted">${esc(x.truck_type)}</span></td><td class="num">${x.ke}</td>
      <td class="nowrap">${tglId(x.from)} –<br>${tglId(x.to)} <span class="muted">(${x.hari} hari)</span></td>
      <td>${x.status === "SELESAI" ? `<span class="badge done">Selesai</span>`
        : x.status === "BELUM_MULAI" ? `<span class="badge draft">Belum mulai</span><br><span class="muted">mulai ${hariLagi(x.mulai_dalam)}</span>`
        : `<span class="badge open">Berjalan</span><br><span class="muted">hari ke-${x.hari_berjalan}</span>`}${endNote(x)}</td>
      <td>${esc(x.pemilik || "-")}</td>
      <td class="num">${rp(x.sewa_periode)}${x.status === "BERJALAN" ? `<br><span class="muted">s/d hari ini ${rp(x.sewa_sd_hari_ini)}</span>` : ""}</td>
      ${x.status === "BELUM_MULAI" ? `<td class="muted" colspan="8">Kontrak berikutnya, mulai ${tglId(x.from)}. Angka terisi begitu periodenya berjalan.</td>` : `
      <td class="num">${x.trips}${x.masih_jalan ? `<br><span class="muted">${x.masih_jalan} masih jalan</span>` : ""}</td>
      <td class="num">${rp(x.selling)}</td><td class="num">${rp(x.uang_jalan)}</td><td class="num">${rp(x.kontribusi)}</td>
      <td class="num"><b>${pl(x.untung)}</b></td><td class="num">${delta(x.selisih_sebelumnya)}</td>
      <td class="num">${x.utilisasi}%</td><td class="num">${rp(x.biaya_menganggur)}</td>`}</tr>`,
    onChange: (vis) => {
      tiles(vis);
      box.querySelectorAll("[data-period]").forEach((tr) => (tr.onclick = () => {
        const [cid, ke] = tr.dataset.period.split(":");
        const x = s.periods.find((p) => String(p.contract_id) === cid && String(p.ke) === ke);
        box.querySelectorAll("[data-period]").forEach((r) => r.classList.toggle("selected", r === tr));
        // trip di periode itu: pakai rincian unit yang sudah ada dengan rentang tanggal periode
        const P = periodOf({ mode: "range", from: x.from, to: x.to });
        const d = document.getElementById("pDetail");
        renderDetail(x.vehicle_id, P, d).then(() => d.scrollIntoView({ behavior: "smooth", block: "start" }));
      }));
    },
  });
  grid.setRows(s.periods);
}

// ---------------------------------------------------------------- untung rugi
const SUMMARY_COLS = [
  { key: "plate_number", label: "Unit", value: (x) => x.plate_number },
  { key: "truck_type", label: "Truk", value: (x) => x.truck_type },
  { key: "pemilik", label: "Pemilik", value: (x) => x.pemilik },
  { key: "sewa_bulanan", label: "Sewa / bulan", num: true, value: (x) => x.sewa_bulanan },
  { key: "biaya_per_hari", label: "Biaya / hari", num: true, value: (x) => x.biaya_per_hari },
  { key: "hari_jalan", label: "Hari jalan", num: true, value: (x) => x.hari_jalan, text: (x) => String(x.hari_jalan) },
  { key: "hari_menganggur", label: "Menganggur", num: true, value: (x) => x.hari_menganggur, text: (x) => String(x.hari_menganggur) },
  { key: "utilisasi", label: "Utilisasi", num: true, value: (x) => x.utilisasi, text: (x) => `${x.utilisasi}%` },
  { key: "trips", label: "Trip", num: true, value: (x) => x.trips, text: (x) => String(x.trips) },
  { key: "selling", label: "Selling", num: true, value: (x) => x.selling },
  { key: "uang_jalan", label: "Uang jalan", num: true, value: (x) => x.uang_jalan },
  { key: "kontribusi", label: "Kontribusi", num: true, value: (x) => x.kontribusi },
  { key: "sewa_sd_hari_ini", label: "Sewa", num: true, value: (x) => x.sewa_sd_hari_ini },
  { key: "untung", label: "Untung bersih", num: true, value: (x) => x.untung },
  { key: "biaya_menganggur", label: "Biaya menganggur", num: true, value: (x) => x.biaya_menganggur },
  { key: "titik_impas", label: "Titik impas", num: true, value: (x) => x.titik_impas, text: (x) => (x.titik_impas == null ? "" : `${String(x.titik_impas).replace(".", ",")} trip`) },
];
const TRIP_COLS = [
  { key: "plate_number", label: "Unit", value: (x) => x.plate_number },
  { key: "job_number", label: "Job", value: (x) => x.job_number },
  { key: "do_number", label: "Kode tugas", value: (x) => x.do_number },
  { key: "job_date", label: "Tgl job", value: (x) => tgl(x.job_date) },
  { key: "customer", label: "Customer", value: (x) => x.customer },
  { key: "rute", label: "Rute", value: (x) => x.rute },
  { key: "driver", label: "Driver", value: (x) => x.driver1_name },
  { key: "status", label: "Gate / status", value: (x) => x.status },
  { key: "days", label: "Hari", num: true, value: (x) => x.days, text: (x) => String(x.days) },
  { key: "selling", label: "Selling", num: true, value: (x) => x.selling },
  { key: "cost", label: "Uang jalan", num: true, value: (x) => x.cost },
  { key: "kontribusi", label: "Kontribusi", num: true, value: (x) => x.kontribusi },
  { key: "rent_cost", label: "Sewa teralokasi", num: true, value: (x) => x.rent_cost },
  { key: "untung", label: "Untung trip", num: true, value: (x) => x.untung },
];
const sumOf = (rows, k) => rows.reduce((a, x) => a + Number(x[k] || 0), 0);

// unduh Excel (POST: ikut filter yang sedang tampil)
async function downloadExcel(body) {
  try {
    const res = await fetch("/api/units/export.xlsx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Export gagal");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "unit-sewa.xlsx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { toast(e.message, true); }
}

const PER_BULAN_COLS = [
  { key: "bulan", label: "Bulan", value: (x) => x.bulan, text: (x) => monthName(x.bulan) },
  { key: "plate_number", label: "Unit", value: (x) => x.plate_number },
  { key: "hari_jalan", label: "Hari jalan", num: true, value: (x) => x.hari_jalan, text: (x) => String(x.hari_jalan) },
  { key: "hari_menganggur", label: "Menganggur", num: true, value: (x) => x.hari_menganggur, text: (x) => String(x.hari_menganggur) },
  { key: "utilisasi", label: "Utilisasi", num: true, value: (x) => x.utilisasi, text: (x) => `${x.utilisasi}%` },
  { key: "trips", label: "Trip", num: true, value: (x) => x.trips, text: (x) => String(x.trips) },
  { key: "selling", label: "Selling", num: true, value: (x) => x.selling },
  { key: "uang_jalan", label: "Uang jalan", num: true, value: (x) => x.uang_jalan },
  { key: "kontribusi", label: "Kontribusi", num: true, value: (x) => x.kontribusi },
  { key: "sewa_sd_hari_ini", label: "Sewa", num: true, value: (x) => x.sewa_sd_hari_ini },
  { key: "untung", label: "Untung bersih", num: true, value: (x) => x.untung },
  { key: "biaya_menganggur", label: "Biaya menganggur", num: true, value: (x) => x.biaya_menganggur },
];

async function renderProfit(box, P, openUnit) {
  const s = await get(`/units/summary?${P.qs}`);
  const current = s.period.from <= s.today && s.today <= s.period.to;
  box.innerHTML = `
    <details class="panel legend" ${sessionStorage.getItem("unitsLegendClosed") ? "" : "open"} id="uLegend"><summary><b>Cara baca</b></summary><ul>
      <li><b>Biaya per hari</b> = (sewa + biaya tetap lain) dibagi jumlah hari bulan itu. Contoh: sewa 15.000.000 di bulan 30 hari = 500.000 per hari.</li>
      <li><b>Kontribusi trip</b> = selling - cost job (uang jalan, sudah termasuk tol, makan, gaji driver). <b>Untung trip</b> = kontribusi - sewa hari-hari trip itu
        (gate out sampai gate in). Kalau satu hari dipakai dua job, sewa hari itu dibagi dua.</li>
      <li><b>Untung bersih unit</b> = kontribusi semua trip yang berangkat di periode ini - sewa periode ini${current ? " sampai hari ini" : ""}. Sewa tetap dibayar walau unit
        menganggur, jadi <b>biaya menganggur</b> = sewa di hari tanpa trip.</li>
      <li><b>Titik impas</b> = berapa trip dalam periode ini (dengan kontribusi rata-rata periode ini) supaya sewa periode ini tertutup.</li>
      <li>Ganti <b>Periode</b> di kanan atas: per bulan, rentang tanggal bebas, atau keseluruhan. Untuk rentang / keseluruhan muncul tabel tren per bulan.</li>
      <li>Klik &#9662; di judul kolom untuk filter / urut seperti Excel. Ringkasan di atas dan Export Excel mengikuti yang tampil.</li></ul></details>
    <div class="tiles" id="uTiles"></div>
    <div class="panel"><h2>Per unit <span class="hint">klik unit untuk melihat trip dan kalendernya</span><span class="spacer"></span>
        <button class="small" id="uAllTrips">Semua trip bulan ini</button><button class="small" id="uExport">Export Excel</button></h2>
      <div id="uTable"></div></div>
    <div id="uMonths"></div>
    <div id="uDetail"></div>`;
  document.getElementById("uLegend").addEventListener("toggle", (e) => {
    if (e.target.open) sessionStorage.removeItem("unitsLegendClosed"); else sessionStorage.setItem("unitsLegendClosed", "1");
  });
  const open = (id) => {
    box.querySelectorAll("[data-unit]").forEach((x) => x.classList.toggle("selected", x.dataset.unit === String(id)));
    const st = JSON.parse(sessionStorage.getItem("units") || "{}");
    sessionStorage.setItem("units", JSON.stringify({ ...st, unit: String(id) }));
    renderDetail(id, P);
  };
  const tiles = (u) => {
    const hb = sumOf(u, "hari_berjalan");
    document.getElementById("uTiles").innerHTML =
      tile(`Sewa ${P.label}`, sumOf(u, current ? "sewa_sd_hari_ini" : "sewa_bulan"), "out", `${u.length} unit${current ? ", sampai hari ini" : ""}`) +
      tile("Kontribusi trip", sumOf(u, "kontribusi"), "in", `${sumOf(u, "trips")} trip, selling ${rp(sumOf(u, "selling"))}`) +
      tile(current ? "Untung bersih s/d hari ini" : "Untung bersih", sumOf(u, "untung"), sumOf(u, "untung") >= 0 ? "plus" : "minus", "kontribusi - sewa") +
      tile("Biaya menganggur", sumOf(u, "biaya_menganggur"), sumOf(u, "biaya_menganggur") > 0 ? "warn" : "", `${sumOf(u, "hari_menganggur")} hari unit tidak jalan`) +
      tile("Utilisasi", hb ? Math.round((sumOf(u, "hari_jalan") / hb) * 100) : 0, "", "% hari unit dipakai trip");
  };
  const grid = xlTable(document.getElementById("uTable"), {
    id: "unit-summary", columns: SUMMARY_COLS, empty: `Belum ada unit sewa di periode ${P.label}. Tambahkan di tab Kontrak sewa.`,
    rowHtml: (x) => `<tr class="click ${String(x.vehicle_id) === String(openUnit) ? "selected" : ""}" data-unit="${x.vehicle_id}">
      <td><b>${esc(x.plate_number)}</b></td><td>${esc(x.truck_type)}</td><td>${esc(x.pemilik || "-")}</td>
      <td class="num">${rp(x.sewa_bulanan)}</td><td class="num">${rp(x.biaya_per_hari)}</td>
      <td class="num">${x.hari_jalan}</td><td class="num">${x.hari_menganggur}</td><td class="num">${x.utilisasi}%</td>
      <td class="num">${x.trips}${x.masih_jalan ? `<br><span class="muted">${x.masih_jalan} masih jalan</span>` : ""}</td>
      <td class="num">${rp(x.selling)}</td><td class="num">${rp(x.uang_jalan)}</td><td class="num">${rp(x.kontribusi)}</td>
      <td class="num">${rp(x.sewa_sd_hari_ini)}</td><td class="num"><b>${pl(x.untung)}</b></td><td class="num">${rp(x.biaya_menganggur)}</td>
      <td class="num">${x.titik_impas == null ? "-" : `${String(x.titik_impas).replace(".", ",")} trip`}</td></tr>`,
    onChange: (vis) => {
      tiles(vis);
      box.querySelectorAll("[data-unit]").forEach((tr) => (tr.onclick = () => open(tr.dataset.unit)));
    },
  });
  grid.setRows(s.units);
  document.getElementById("uAllTrips").onclick = () => open("all");
  document.getElementById("uExport").onclick = () => {
    if (!grid.visible().length) return toast("Tidak ada unit yang tampil", true);
    downloadExcel({ ...P.body, vehicle_ids: grid.visible().map((x) => x.vehicle_id) });
  };
  // tren per bulan (rentang / keseluruhan)
  if (s.per_bulan.length) {
    const months = [...new Set(s.per_bulan.map((x) => x.bulan))];
    const agg = months.map((m) => {
      const r = s.per_bulan.filter((x) => x.bulan === m);
      const hb = sumOf(r, "hari_berjalan");
      return { m, units: r.length, trips: sumOf(r, "trips"), selling: sumOf(r, "selling"), uang_jalan: sumOf(r, "uang_jalan"), kontribusi: sumOf(r, "kontribusi"),
        sewa: sumOf(r, "sewa_sd_hari_ini"), untung: sumOf(r, "untung"), idle: sumOf(r, "biaya_menganggur"), util: hb ? Math.round((sumOf(r, "hari_jalan") / hb) * 100) : 0 };
    });
    document.getElementById("uMonths").innerHTML = `
      <div class="panel"><h2>Tren per bulan <span class="hint">semua unit, ${esc(P.label)}</span></h2>
        ${table(`<th>Bulan</th><th class="num">Unit</th><th class="num">Trip</th><th class="num">Selling</th><th class="num">Uang jalan</th><th class="num">Kontribusi</th>
          <th class="num">Sewa</th><th class="num">Untung bersih</th><th class="num">Biaya menganggur</th><th class="num">Utilisasi</th>`,
          agg.map((a) => `<tr><td><b>${esc(monthName(a.m))}</b></td><td class="num">${a.units}</td><td class="num">${a.trips}</td><td class="num">${rp(a.selling)}</td>
            <td class="num">${rp(a.uang_jalan)}</td><td class="num">${rp(a.kontribusi)}</td><td class="num">${rp(a.sewa)}</td><td class="num"><b>${pl(a.untung)}</b></td>
            <td class="num">${rp(a.idle)}</td><td class="num">${a.util}%</td></tr>`).join(""), "Belum ada data",
          `<tr><td>Total</td><td></td><td class="num">${sumOf(agg, "trips")}</td><td class="num">${rp(sumOf(agg, "selling"))}</td><td class="num">${rp(sumOf(agg, "uang_jalan"))}</td>
            <td class="num">${rp(sumOf(agg, "kontribusi"))}</td><td class="num">${rp(sumOf(agg, "sewa"))}</td><td class="num"><b>${pl(sumOf(agg, "untung"))}</b></td>
            <td class="num">${rp(sumOf(agg, "idle"))}</td><td></td></tr>`)}
        <h3>Per unit per bulan</h3><div id="uMonthTable"></div>
      </div>`;
    xlTable(document.getElementById("uMonthTable"), {
      id: "unit-per-bulan", columns: PER_BULAN_COLS, empty: "Belum ada data",
      rowHtml: (x) => `<tr><td>${esc(monthName(x.bulan))}</td><td><b>${esc(x.plate_number)}</b></td><td class="num">${x.hari_jalan}</td>
        <td class="num">${x.hari_menganggur}</td><td class="num">${x.utilisasi}%</td><td class="num">${x.trips}</td><td class="num">${rp(x.selling)}</td>
        <td class="num">${rp(x.uang_jalan)}</td><td class="num">${rp(x.kontribusi)}</td><td class="num">${rp(x.sewa_sd_hari_ini)}</td>
        <td class="num"><b>${pl(x.untung)}</b></td><td class="num">${rp(x.biaya_menganggur)}</td></tr>`,
    }).setRows(s.per_bulan);
  }
  if (openUnit === "all" || s.units.some((x) => String(x.vehicle_id) === String(openUnit))) renderDetail(openUnit, P);
}

async function renderDetail(vehicleId, P, box = document.getElementById("uDetail")) {
  box.innerHTML = `${skelTable(6, 7)}`;
  const all = vehicleId === "all";
  const d = all ? await get(`/units/trips?${P.qs}`) : await get(`/units/${vehicleId}/detail?${P.qs}`);
  const dayClass = (x) => !x.day_cost && x.day_cost !== 0 ? "none" : x.day > d.today ? "future" : x.jobs ? "used" : "idle";
  box.innerHTML = `
    <div class="panel"><h2>${all ? "Semua trip unit sewa" : esc(d.vehicle.plate_number)} &middot; ${esc(P.label)}
        ${all ? "" : `<span class="hint">${d.contracts.map((c) => `sewa ${rp(c.monthly_rent)}${c.other_monthly_cost > 0 ? ` + biaya lain ${rp(c.other_monthly_cost)}` : ""} / bulan dari ${esc(c.partner || "-")}, ${tgl(c.date_start)} s/d ${c.date_end ? tgl(c.date_end) : "sekarang"}`).join("; ")}</span>`}
        <span class="spacer"></span><button class="small" id="tripExport">Export Excel</button></h2>
      ${all ? "" : `<div class="unit-cal">${d.days.map((x) => `<div class="day ${dayClass(x)}" title="${esc(x.day)}${x.day_cost ? ` · sewa ${rp(x.day_cost)}` : " · di luar kontrak"}${x.jobs ? ` · ${x.jobs}` : dayClass(x) === "idle" ? " · menganggur" : ""}">
        <b>${Number(x.day.slice(8))}</b>${x.jobs ? `<small>${esc(x.jobs.split(", ").map((n) => n.slice(-4)).join(" "))}</small>` : ""}</div>`).join("")}</div>
      <div class="unit-cal-legend"><span class="day used"></span> dipakai trip <span class="day idle"></span> menganggur (sewa tetap jalan)
        <span class="day future"></span> belum terjadi <span class="day none"></span> di luar kontrak</div>`}
      <h3>Trip</h3>
      <div id="tripTable"></div>
      <div class="trip-total" id="tripTotal"></div>
      <div class="note-box">Trip yang melewati pergantian bulan ikut tampil di kedua bulan; sewanya dihitung per hari, selling & uang jalan dihitung di bulan berangkat.
        Pastikan plat di job sama dengan plat unit (spasi dan huruf besar / kecil tidak masalah).</div>
    </div>`;
  const grid = xlTable(document.getElementById("tripTable"), {
    id: "unit-trips", columns: TRIP_COLS, empty: "Belum ada trip di bulan ini",
    rowHtml: (x) => `<tr class="click" data-href="#/jobs/${x.job_id}">
      <td>${esc(x.plate_number)}</td><td><b>${esc(x.job_number)}</b></td><td>${esc(x.do_number || "")}</td><td class="nowrap">${tgl(x.job_date)}</td>
      <td>${esc(x.customer)}</td><td>${esc(x.rute)}</td><td>${esc(x.driver1_name || "")}</td>
      <td class="nowrap">${x.gate_out_at ? `${jam(x.gate_out_at)}<br>${x.gate_in_at ? jam(x.gate_in_at) : `<span class="badge draft">masih jalan</span>`}`
        : `<span class="muted">tanpa gate, tgl job</span>`}</td>
      <td class="num">${x.days}</td><td class="num">${rp(x.selling)}</td><td class="num">${rp(x.cost)}</td><td class="num">${rp(x.kontribusi)}</td>
      <td class="num">${rp(x.rent_cost)}</td><td class="num"><b>${pl(x.untung)}</b></td></tr>`,
    onChange: (vis) => {
      bindRows(document.getElementById("tripTable"));
      document.getElementById("tripTotal").innerHTML = vis.length ? `<b>Total ${vis.length} trip yang tampil:</b>
        <span>hari ${rp(sumOf(vis, "days"))}</span><span>selling ${rp(sumOf(vis, "selling"))}</span><span>uang jalan ${rp(sumOf(vis, "cost"))}</span>
        <span>kontribusi ${rp(sumOf(vis, "kontribusi"))}</span><span>sewa teralokasi ${rp(sumOf(vis, "rent_cost"))}</span>
        <span>untung ${pl(sumOf(vis, "untung"))}</span>
        <span>rata-rata untung / trip ${pl(Math.round(sumOf(vis, "untung") / vis.length))}</span>` : "";
    },
  });
  grid.setRows(d.trips);
  document.getElementById("tripExport").onclick = () => {
    if (!grid.visible().length) return toast("Tidak ada trip yang tampil", true);
    downloadExcel({ ...P.body, vehicle_id: all ? undefined : Number(vehicleId), job_ids: grid.visible().map((x) => x.job_id) });
  };
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------- kontrak sewa
async function renderContracts(box) {
  const list = await get("/units/contracts");
  box.innerHTML = `
    <div class="panel"><h2>Kontrak sewa unit ${canFinance() ? `<span class="spacer"></span><button class="primary small" id="newContract">+ Kontrak sewa</button>` : ""}</h2>
      ${table(`<th>Unit</th><th>Pemilik</th><th>Mulai</th><th>Selesai</th><th class="num">Sewa / bulan</th><th class="num">Biaya tetap lain</th><th>Status</th><th>Catatan</th><th></th>`,
        list.map((c) => `<tr><td><b>${esc(c.plate_number)}</b><br><span class="muted">${esc(c.truck_type)}</span></td><td>${esc(c.partner || "-")}</td>
          <td>${tgl(c.date_start)}</td><td>${c.date_end ? tgl(c.date_end) : "-"}</td><td class="num">${rp(c.monthly_rent)}</td><td class="num">${rp(c.other_monthly_cost)}</td>
          <td>${c.belum_mulai ? `<span class="badge draft">Belum mulai</span><br><span class="muted">mulai ${tglId(tgl(c.date_start))}</span>`
            : c.berjalan ? `<span class="badge posted">Berjalan</span>` : `<span class="badge cancelled">Selesai</span>`}</td><td class="small-text">${esc(c.note || "")}</td>
          <td class="nowrap">${canFinance() ? `${c.date_end ? `<button class="small primary" data-extend="${c.id}">Perpanjang 1 bulan</button> ` : ""}<button class="small" data-edit="${c.id}">Ubah</button> <button class="small danger" data-del="${c.id}">Hapus</button>` : ""}</td></tr>`).join(""), "Belum ada kontrak sewa")}
      <div class="note-box"><b>Sewa diperpanjang dengan harga sama?</b> Klik <b>Perpanjang 1 bulan</b> (tanggal selesai mundur sebulan, misalnya habis 16 Okt jadi 16 Nov),
        tidak perlu membuat kontrak baru. Periodenya tetap mengikuti tanggal mulai (16 Sep - 15 Okt, 16 Okt - 15 Nov, ...). Unit yang disewa terus tanpa tanggal kembali:
        kosongkan <b>Selesai sewa</b>, periode baru muncul sendiri tiap bulan.<br>
        <b>Harga sewa berubah?</b> Isi tanggal selesai di kontrak lama, lalu buat kontrak baru mulai sehari sesudahnya. Di tab Per periode kontrak, periodenya tetap
        bersambung dan dibandingkan dengan periode sebelumnya unit itu.</div>
    </div>`;
  const form = (c = {}) => openModal({
    title: c.id ? `Ubah kontrak ${c.plate_number}` : "Kontrak sewa baru",
    body: `<div class="form-grid">
      ${c.id ? `<input type="hidden" name="vehicle_id" value="${c.vehicle_id}">
           <label>Plat<input name="plate_number" value="${esc(c.plate_number)}" required></label>
           <label>Jenis truk<input name="truck_type" list="truckTypesU" value="${esc(c.truck_type || "")}"><datalist id="truckTypesU">${["CDD", "CDDL", "CDEL", "FUSO", "TRONTON", "WINGBOX"].map((x) => `<option value="${x}">`).join("")}</datalist></label>`
        : `<label>Unit (dari master)<select name="vehicle_id">${options(state.cache.vehicles.filter((v) => v.active), "", (v) => `${v.plate_number} - ${v.truck_type}`, "- unit baru, isi plat -")}</select></label>
           <label>Plat unit baru<input name="plate_number" placeholder="B 1234 HQ"></label>
           <label>Jenis truk<input name="truck_type" list="truckTypesU" placeholder="CDDL"><datalist id="truckTypesU">${["CDD", "CDDL", "FUSO", "TRONTON", "WINGBOX"].map((x) => `<option value="${x}">`).join("")}</datalist></label>`}
      <label>Pemilik / yang menyewakan<select name="partner_id">${options(vendors(), c.partner_id, undefined, "-")}</select></label>
      <label>Mulai sewa<input type="date" name="date_start" value="${tgl(c.date_start)}" required></label>
      <label>Selesai sewa (kosong = masih berjalan)<input type="date" name="date_end" value="${tgl(c.date_end)}"></label>
      <label>Sewa per bulan<input class="num" name="monthly_rent" value="${c.monthly_rent ? rp(c.monthly_rent) : ""}" required></label>
      <label>Biaya tetap lain per bulan<input class="num" name="other_monthly_cost" value="${c.other_monthly_cost ? rp(c.other_monthly_cost) : ""}" placeholder="asuransi, GPS (opsional)"></label>
      <label class="wide">Catatan<input name="note" value="${esc(c.note || "")}"></label></div>
      <div class="note-box">Biaya per hari = (sewa + biaya tetap lain) / jumlah hari di bulan itu. Tagihan sewa ke pemilik hanya dari kolom sewa.
        ${c.id ? "<br>Ganti plat = trip diambil dari job dengan plat baru. Kalau plat itu sudah ada di Master Data &rsaquo; Kendaraan, kontrak pindah ke unit tersebut; plat & jenis truk juga ikut berubah di master." : ""}</div>`,
    onSubmit: async (d) => {
      d.monthly_rent = num(d.monthly_rent);
      d.other_monthly_cost = num(d.other_monthly_cost);
      await api(c.id ? "PUT" : "POST", c.id ? `/units/contracts/${c.id}` : "/units/contracts", d);
      state.cache.vehicles = await get("/vehicles");
      toast("Kontrak disimpan");
      reload();
    },
  });
  document.getElementById("newContract")?.addEventListener("click", () => form());
  box.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => form(list.find((c) => c.id === Number(b.dataset.edit)))));
  box.querySelectorAll("[data-extend]").forEach((b) => (b.onclick = () => extendContract(list.find((c) => c.id === Number(b.dataset.extend)))));
  box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => {
    const c = list.find((x) => x.id === Number(b.dataset.del));
    askReason(`Hapus kontrak ${c.plate_number}`, "Hanya bisa kalau kontrak belum punya tagihan sewa. Unit tetap ada di Master Data > Kendaraan.",
      (reason) => api("DELETE", `/units/contracts/${c.id}`, { reason }), "Hapus kontrak");
  }));
}

// ---------------------------------------------------------------- tagihan sewa
async function renderBills(box, P) {
  const list = await get(`/units/rent-bills?${P.qs}`);
  const now = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
  const dueCell = (b) => {
    if (!b.due_date) return "-";
    const late = b.state === "posted" && b.residual > 0.004 && tgl(b.due_date) < now;
    return `${tglId(tgl(b.due_date))}${late ? `<br><span class="badge warn">Telat</span>` : ""}
      ${canFinance() && b.state === "posted" && b.residual > 0.004 ? `<br><a href="#" data-due="${b.id}">ubah</a>` : ""}`;
  };
  const total = (k) => list.filter((b) => b.state === "posted").reduce((a, b) => a + Number(b[k]), 0);
  box.innerHTML = `
    <div class="tiles">${tile(`Tagihan sewa ${P.label}`, total("amount"), "out", `${list.filter((b) => b.state === "posted").length} tagihan`)}
      ${tile("Sudah dibayar", total("paid"), "")}${tile("Belum dibayar", total("residual"), total("residual") > 0 ? "warn" : "")}</div>
    <div class="panel"><h2>Tagihan sewa ${esc(P.label)}
        ${canFinance() ? `<span class="spacer"></span><button class="primary small" id="genBills">Buat tagihan periode yang sudah mulai</button>` : ""}</h2>
      ${table(`<th>Nomor</th><th>Unit</th><th>Pemilik</th><th>Periode sewa</th><th class="num">Hari</th><th class="num">Tagihan</th><th class="num">Dibayar</th><th class="num">Sisa</th><th>Jatuh tempo</th><th>Status</th><th></th>`,
        list.map((b) => `<tr class="${b.state === "cancelled" ? "rev" : ""}"><td><b>${esc(b.number)}</b></td><td>${esc(b.plate_number)}</td><td>${esc(b.partner || "-")}</td>
          <td class="nowrap">${tglId(tgl(b.dari))} –<br>${tglId(tgl(b.sampai))}</td>
          <td class="num">${b.days}</td><td class="num">${rp(b.amount)}</td><td class="num">${rp(b.paid)}</td><td class="num">${rp(b.residual)}</td>
          <td class="nowrap">${dueCell(b)}</td>
          <td>${b.state === "cancelled" ? `<span class="badge cancelled">Batal</span><br><span class="muted">${esc(b.cancel_reason || "")}</span>`
            : b.residual <= 0.004 ? `<span class="badge lunas">Lunas</span>` : `<span class="badge open">Belum lunas</span>`}
            ${(b.payments || []).map((p) => `<div class="muted small-text">${tgl(p.pay_date)} ${rp(p.amount)} ${esc(p.bank || "")}${p.note ? ` · ${esc(p.note)}` : ""}
              ${canFinance() && !p.reversed && p.amount > 0 ? ` <a href="#" data-rev="${p.id}">batal bayar</a>` : ""}</div>`).join("")}</td>
          <td class="nowrap">${canFinance() && b.state === "posted" && b.residual > 0.004 ? `<button class="small primary" data-pay="${b.id}">Bayar</button>` : ""}
            ${canFinance() && b.state === "posted" && Math.abs(b.paid) < 0.005 ? `<button class="small danger" data-cancel="${b.id}">Batalkan</button>` : ""}</td></tr>`).join(""),
        `Belum ada tagihan sewa yang periodenya mulai di ${P.label}`)}
      <div class="note-box">Tagihan dibuat satu per kontrak per <b>periode sewa</b> (mengikuti tanggal mulai kontrak, sama dengan tab Per periode kontrak).
        <b>Jatuh tempo</b> bawaan = tanggal mulai periode unit itu, jadi tiap unit beda (mulai tanggal 21 = jatuh tempo tiap tanggal 21); klik "ubah" untuk
        tagihan yang dibayar di tanggal lain. Periode yang terpotong tanggal selesai kontrak ditagih sebanding harinya. Tabel ini menampilkan tagihan yang
        periodenya mulai di ${esc(P.label)}. Pembayaran sewa belum masuk ke Kas &amp; Rekening / Jurnal Kas (menunggu keputusan finance cara pencatatannya).</div>
    </div>`;
  document.getElementById("genBills")?.addEventListener("click", () => openModal({
    title: "Buat tagihan sewa",
    body: `<label class="wide">Catatan (opsional)<input name="note"></label>
      <div class="note-box">Dibuat untuk semua kontrak, satu tagihan per periode sewa yang sudah mulai (sampai hari ini) dan belum punya tagihan.
        Jatuh tempo tiap tagihan = tanggal mulai periode unitnya.</div>`,
    submitLabel: "Buat tagihan",
    onSubmit: async (d) => {
      const r = await api("POST", "/units/rent-bills/generate", d);
      toast(r.count ? `${r.count} tagihan dibuat, total ${rp(r.total)}`
        : r.skipped?.length ? "Tidak ada tagihan baru" : "Semua periode yang sudah mulai sudah punya tagihan");
      // periode yang tanggalnya sudah tercakup tagihan lain (mis. tagihan lama per bulan) tidak dibuat supaya tidak dobel
      if (r.skipped?.length) openModal({
        title: `${r.skipped.length} periode tidak ditagih supaya tidak dobel`,
        body: `${table("<th>Unit</th><th>Periode</th><th>Sudah tercakup tagihan</th>",
          r.skipped.map((x) => `<tr><td><b>${esc(x.plate_number)}</b></td><td>${tglId(x.dari)} – ${tglId(x.sampai)}</td><td>${esc(x.karena)}</td></tr>`).join(""))}
          <div class="note-box">Tagihan itu dibuat dengan cara lama (per bulan kalender). Kalau mau pindah ke tagihan per periode kontrak,
            batalkan tagihan lama yang belum dibayar, lalu klik "Buat tagihan periode yang sudah mulai" lagi.</div>`,
      });
      reload();
      return r.skipped?.length ? true : undefined;     // true = jendela daftar di atas tetap terbuka
    },
  }));
  box.querySelectorAll("[data-due]").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    const b = list.find((x) => x.id === Number(a.dataset.due));
    openModal({
      title: `Jatuh tempo ${b.number} (${b.plate_number})`,
      body: `<label>Jatuh tempo<input type="date" name="due_date" value="${esc(tgl(b.due_date))}" required></label>`,
      onSubmit: async (d) => { await api("PUT", `/units/rent-bills/${b.id}`, d); toast("Jatuh tempo diubah"); reload(); },
    });
  }));
  box.querySelectorAll("[data-pay]").forEach((btn) => (btn.onclick = () => {
    const b = list.find((x) => x.id === Number(btn.dataset.pay));
    openModal({
      title: `Bayar ${b.number} (${b.plate_number})`,
      body: `<div class="form-grid">
        <label>Tanggal bayar<input type="date" name="pay_date" value="${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" })}"></label>
        <label>Dari rekening<select name="bank_account_id">${options(banks(), banks().find((x) => x.is_default)?.id, bankLabel, null)}</select></label>
        <label>Nominal<input class="num" name="amount" value="${rp(b.residual)}"></label>
        <label class="wide">Catatan<input name="note"></label></div>`,
      submitLabel: "Catat pembayaran",
      onSubmit: async (d) => { d.amount = num(d.amount); await api("POST", `/units/rent-bills/${b.id}/pay`, d); toast("Pembayaran sewa dicatat"); reload(); },
    });
  }));
  box.querySelectorAll("[data-cancel]").forEach((btn) => (btn.onclick = () => askReason("Batalkan tagihan sewa", "Tagihan bisa dibuat ulang setelah dibatalkan.",
    (reason) => api("POST", `/units/rent-bills/${btn.dataset.cancel}/cancel`, { reason }), "Batalkan")));
  box.querySelectorAll("[data-rev]").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    askReason("Batal bayar sewa", "Dibuat baris pembalik (minus), pembayaran asli tetap tercatat.",
      (reason) => api("POST", `/units/rent-payments/${a.dataset.rev}/reverse`, { reason }), "Batal bayar");
  }));
}

// Laporan: Rekap Posisi, Jurnal Kas, Utang Piutang, Kas & Rekening.
import { signed,
  state, api, get, view, esc, rp, tgl, tile, options, enumOptions, table, toast, openModal, customers, bankLabel, num, today,
  debounce, bindRows, canFinance, PHASE_LABEL, latest, skelTable, pagedTable,
} from "../lib.js";

const SIDES = {
  PURCHASE: { title: "Vendor (utang)", notBilled: "Belum diajukan", outstanding: "Diajukan, belum dibayar", hint: "uang yang harus AMICO bayar ke vendor" },
  SALE: { title: "Customer (piutang)", notBilled: "Belum ditagih", outstanding: "Ditagih, belum dibayar", hint: "uang yang harus customer bayar ke AMICO" },
};

// bagian tabel jurnal kas: total di kaki tabel selalu dari SEMUA baris, bukan hanya halaman yang tampil
function ledgerParts(rows, withJob) {
  let masuk = 0, keluar = 0;
  for (const r of rows) r.arah === "MASUK" ? (masuk += r.nominal) : (keluar += r.nominal);
  return {
    head: `<th>Tgl</th>${withJob ? "<th>Job</th>" : ""}<th>Arah</th><th>Jenis</th><th class="num">Porsi</th><th>Pihak</th><th class="num">Nominal</th><th>Rekening</th><th>No bayar</th><th>Dokumen</th><th>Membalik</th>`,
    row: (r) => `<tr class="${r.membalik ? "rev" : r.arah === "MASUK" ? "in" : "out"}">
      <td>${tgl(r.tanggal)}</td>${withJob ? `<td><a href="#/jobs/${r.job_id}">${esc(r.job_number)}</a></td>` : ""}
      <td>${esc(r.arah)}</td><td>${esc(r.jenis)}</td><td class="num">${r.porsi}%</td><td>${esc(r.pihak || "")}</td>
      <td class="num">${rp(r.nominal)}</td><td>${esc(r.rekening || "")}</td><td>${esc(r.payment_number)}</td><td>${esc(r.move_number || "")}</td><td>${esc(r.membalik || "")}</td>
    </tr>`,
    empty: "Belum ada uang masuk / keluar",
    foot: `<tr><td colspan="${withJob ? 6 : 5}">Masuk ${rp(masuk)} &middot; Keluar ${rp(keluar)} &middot; Saldo</td><td class="num">${rp(masuk - keluar)}</td><td colspan="4"></td></tr>`,
  };
}
export function ledgerTable(rows, withJob = true) {
  const p = ledgerParts(rows, withJob);
  return table(p.head, rows.map(p.row).join(""), p.empty, p.foot);
}

export function shortPanel(rows) {
  if (!rows?.length) return "";
  return `<div class="panel warn-panel"><h2>Kurang transfer <span class="hint">pelunasan sudah dibayar, tapi totalnya kurang dari seharusnya</span></h2>
    ${table(`<th>Arah</th><th class="num">Seharusnya</th><th class="num">DP seharusnya</th><th class="num">DP dibayar</th><th class="num">Pelunasan dibayar</th>
      <th class="num">DP kurang</th><th class="num">Pelunasan kurang</th><th class="num">Total kurang</th><th class="num">Ke kas AMICO</th>`,
      rows.map((r) => `<tr><td>${r.side === "PURCHASE" ? "AMICO kurang transfer ke vendor" : "Customer kurang bayar ke AMICO"}</td>
        <td class="num">${rp(r.seharusnya)}</td><td class="num">${rp(r.dp_seharusnya)}</td><td class="num">${rp(r.dp_dibayar)}</td>
        <td class="num">${rp(r.pelunasan_dibayar)}</td><td class="num">${rp(r.dp_kurang)}</td><td class="num">${rp(r.pelunasan_kurang)}</td>
        <td class="num"><b>${rp(r.kurang)}</b></td><td class="num">${signed(r.selisih_kas)}</td></tr>`).join(""))}</div>`;
}

// ---------------------------------------------------------------- rekap posisi
export async function renderRekap() {
  const f = JSON.parse(sessionStorage.getItem("rekapFilter") || "{}");
  view().innerHTML = `
    <div class="page-head"><h1>Rekap Posisi</h1>
      <span class="sub">Per fase sesuai skema job. Klik angka untuk melihat job-nya.</span>
      <div class="spacer"></div><div class="actions"><a class="btn" id="exportPos">Export Excel per job</a></div></div>
    <div class="panel">
      <div class="filters">
        <label>Tgl job dari<input type="date" id="rFrom" value="${esc(f.from || "")}"></label>
        <label>Sampai<input type="date" id="rTo" value="${esc(f.to || "")}"></label>
        <label>Customer<select id="rCust">${options(customers(), f.customer_id, undefined, "Semua customer")}</select></label>
        <label>Skema<select id="rScheme"><option value="">Semua</option>${enumOptions({ "70_30": "70 / 30", "50_50": "50 / 50", FULL: "Full 100%" }, f.scheme)}</select></label>
      </div>
      <div id="rekapTiles"></div>
    </div>
    <div id="rekapBox"></div>
    <div class="panel"><h2>Kurang transfer <span class="hint">job DP + pelunasan (70/30, 50/50) yang pelunasannya sudah dibayar tapi totalnya kurang</span>
      <div class="spacer"></div><a class="btn" href="/api/export/kurang-transfer.xlsx">Export Excel</a></h2><div id="shortBox"></div></div>
    <div class="panel"><h2>Umur tagihan <span class="hint">dokumen yang sudah diajukan / ditagih tapi belum dibayar</span></h2><div id="agingBox"></div></div>`;
  const el = (id) => document.getElementById(id);
  const filter = () => ({ from: el("rFrom").value, to: el("rTo").value, customer_id: el("rCust").value, scheme: el("rScheme").value });
  const load = async () => {
    const flt = filter();
    sessionStorage.setItem("rekapFilter", JSON.stringify(flt));
    const qs = new URLSearchParams(flt).toString();
    el("exportPos").href = `/api/export/posisi.xlsx?${qs}`;
    const rows = await get(`/rekap?${qs}`);
    const total = (side, k) => rows.filter((r) => r.side === side).reduce((s, r) => s + Number(r[k] || 0), 0);
    el("rekapTiles").innerHTML = `<div class="tiles" style="margin:0">
      ${tile("Utang ke vendor", total("PURCHASE", "outstanding"), "out", "Sudah diajukan, belum ditransfer")}
      ${tile("Belum diajukan ke vendor", total("PURCHASE", "not_billed"), "", "Cost yang belum masuk pengajuan")}
      ${tile("Piutang customer", total("SALE", "outstanding"), "in", "Sudah ditagih, belum dibayar")}
      ${tile("Perlu ditagih", total("SALE", "not_billed"), "", "Selling yang belum dibuatkan invoice")}</div>`;
    el("rekapBox").innerHTML = Object.entries(SIDES).map(([side, s]) => {
      const list = rows.filter((r) => r.side === side);
      const cell = (r, status) => `<td class="num"><a href="#" data-drill="${side}|${r.phase}|${status}">${rp(r[status])}</a>${r[`jobs_${status}`] ? `<br><span class="muted">${r[`jobs_${status}`]} job</span>` : ""}</td>`;
      return `<div class="panel"><h2>${esc(s.title)} <span class="hint">${esc(s.hint)}</span></h2>${table(
        `<th>Fase</th><th class="num">Job</th><th class="num">Rencana</th><th class="num">${esc(s.notBilled)}</th><th class="num">${esc(s.outstanding)}</th><th class="num">Sudah dibayar</th><th class="num">Total belum dibayar</th>`,
        list.map((r) => `<tr><td><b>${esc(PHASE_LABEL[r.phase])}</b></td><td class="num">${rp(r.jobs)}</td><td class="num">${rp(r.planned)}</td>
          ${cell(r, "not_billed")}${cell(r, "outstanding")}${cell(r, "paid")}${cell(r, "unpaid")}</tr>`).join(""), "Tidak ada data",
        `<tr><td>Total</td><td></td>${["planned", "not_billed", "outstanding", "paid", "unpaid"].map((k) => `<td class="num">${rp(total(side, k))}</td>`).join("")}</tr>`)}</div>`;
    }).join("");
    view().querySelectorAll("[data-drill]").forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      const [side, phase, status] = a.dataset.drill.split("|");
      drillJobs({ ...flt, side, phase, status });
    }));
  };
  const loadAside = async () => {
    const [short, pay, rec] = await Promise.all([get("/kurang-transfer"), get("/aging?move_type=in_invoice"), get("/aging?move_type=out_invoice")]);
    const sTable = (title, list) => `<h3 class="sub-h">${esc(title)} (${list.length} job, total ${rp(list.reduce((s, r) => s + r.kurang, 0))})</h3>${table(
      `<th>Job</th><th>Tgl</th><th>Customer</th><th class="num">Seharusnya</th><th class="num">DP dibayar</th><th class="num">Pelunasan dibayar</th><th class="num">DP kurang</th><th class="num">Pelunasan kurang</th><th class="num">Total kurang</th><th class="num">Ke kas AMICO</th>`,
      list.map((r) => `<tr><td><a href="#/jobs/${r.job_id}">${esc(r.job_number)}</a></td><td>${tgl(r.job_date)}</td><td>${esc(r.customer)}</td>
        <td class="num">${rp(r.seharusnya)}</td><td class="num">${rp(r.dp_dibayar)}</td><td class="num">${rp(r.pelunasan_dibayar)}</td>
        <td class="num">${rp(r.dp_kurang)}</td><td class="num">${rp(r.pelunasan_kurang)}</td><td class="num"><b>${rp(r.kurang)}</b></td><td class="num">${signed(r.selisih_kas)}</td></tr>`).join(""), "Tidak ada")}`;
    el("shortBox").innerHTML = sTable("AMICO kurang transfer ke vendor", short.filter((r) => r.side === "PURCHASE")) +
      sTable("Customer kurang bayar ke AMICO", short.filter((r) => r.side === "SALE"));
    const aTable = (title, list) => `<h3 class="sub-h">${esc(title)}</h3>${table(
      `<th>Partner</th><th class="num">Dokumen</th><th class="num">0-30 hari</th><th class="num">31-60</th><th class="num">61-90</th><th class="num">&gt; 90</th><th class="num">Total</th>`,
      list.map((r) => `<tr><td>${esc(r.partner)}</td><td class="num">${r.docs}</td><td class="num">${rp(r.d0_30)}</td><td class="num">${rp(r.d31_60)}</td><td class="num">${rp(r.d61_90)}</td><td class="num">${rp(r.d90)}</td><td class="num"><b>${rp(r.total)}</b></td></tr>`).join(""),
      "Tidak ada yang tertunggak")}`;
    el("agingBox").innerHTML = aTable("Piutang customer", rec) + aTable("Utang ke vendor", pay);
  };
  for (const k of ["rFrom", "rTo", "rCust", "rScheme"]) el(k).onchange = load;
  await Promise.all([load(), loadAside()]);
}

async function drillJobs(flt) {
  const rows = await get(`/rekap/jobs?${new URLSearchParams(flt)}`);
  const s = SIDES[flt.side];
  const label = { not_billed: s.notBilled, outstanding: s.outstanding, paid: "Sudah dibayar", unpaid: "Belum dibayar" }[flt.status];
  openModal({
    title: `${s.title} - ${PHASE_LABEL[flt.phase]} - ${label} (${rows.length} job)`,
    wide: true,
    body: `<div id="drillBox" style="max-height:60vh;overflow:auto"></div>`,
    // klik no job = pindah halaman, modal ditutup oleh router
    onOpen: (form) => pagedTable(form.querySelector("#drillBox"), { rows,
      head: `<th>Job</th><th>Tgl</th><th>Customer</th><th class="num">Rencana</th><th class="num">${esc(s.notBilled)}</th><th class="num">${esc(s.outstanding)}</th><th class="num">Dibayar</th>`,
      row: (r) => `<tr><td><a href="#/jobs/${r.job_id}">${esc(r.job_number)}</a></td><td>${tgl(r.job_date)}</td><td>${esc(r.customer)}</td>
        <td class="num">${rp(r.planned)}</td><td class="num">${rp(r.not_billed)}</td><td class="num">${rp(r.outstanding)}</td><td class="num">${rp(r.paid)}</td></tr>` }),
  });
}

// ---------------------------------------------------------------- jurnal kas
export async function renderLedger() {
  const f = JSON.parse(sessionStorage.getItem("ledgerFilter") || "{}");
  view().innerHTML = `
    <div class="page-head"><h1>Jurnal Kas</h1><span class="sub">1 baris = 1 kali uang masuk / keluar untuk 1 job. Koreksi lewat baris pembalik.</span>
      <div class="spacer"></div><div class="actions"><a class="btn" id="exportLedger">Export Excel</a></div></div>
    <div class="panel">
      <div class="filters">
        <label>Dari<input type="date" id="lFrom" value="${esc(f.from || "")}"></label>
        <label>Sampai<input type="date" id="lTo" value="${esc(f.to || "")}"></label>
        <label>Cari<input id="lSearch" placeholder="Job, pihak, dokumen" value="${esc(f.search || "")}"></label>
      </div>
      <div id="ledgerBox">${skelTable(10, 8)}</div>
    </div>`;
  const el = (id) => document.getElementById(id);
  const only = latest();
  const load = async () => {
    const flt = { from: el("lFrom").value, to: el("lTo").value, search: el("lSearch").value };
    sessionStorage.setItem("ledgerFilter", JSON.stringify(flt));
    const qs = new URLSearchParams(flt).toString();
    el("exportLedger").href = `/api/export/jurnal-kas.xlsx?${qs}`;
    const rows = await only(get(`/ledger?${qs}`));
    pagedTable(el("ledgerBox"), { rows, ...ledgerParts(rows, true) });
  };
  el("lFrom").onchange = load; el("lTo").onchange = load; el("lSearch").oninput = debounce(load);
  await load();
}

// ---------------------------------------------------------------- utang piutang
const UP_COLS = [
  ["UTANG 100%", "utang_100"], ["UTANG 100% TERBAYAR", "utang_100_terbayar"], ["UTANG 70%", "utang_70"], ["UTANG 70% TERBAYAR", "utang_70_terbayar"],
  ["UTANG 30% BELUM BAYAR", "utang_30_belum_bayar"], ["UTANG 30% TERBAYAR", "utang_30_terbayar"],
  ["PIUTANG 100% BELUM TERBAYAR", "piutang_100_belum_terbayar"], ["PIUTANG 100% TERBAYAR", "piutang_100_terbayar"],
  ["PIUTANG DP BELUM TERTAGIH", "piutang_70_belum_tertagih"], ["PIUTANG DP TERTAGIH", "piutang_70_tertagih"], ["PIUTANG DP TERBAYAR", "piutang_70_terbayar"],
  ["PIUTANG PELUNASAN BELUM TERTAGIH", "piutang_30_belum_tertagih"], ["PIUTANG PELUNASAN TERTAGIH", "piutang_30_tertagih"], ["PIUTANG PELUNASAN TERBAYAR", "piutang_30_terbayar"],
  ["CALO / LAIN TERBAYAR", "calo_lain_terbayar"], ["CALO / LAIN BELUM BAYAR", "calo_lain_belum_bayar"],
  ["KURANG TRANSFER KE VENDOR", "kurang_transfer_vendor"], ["KURANG BAYAR DARI CUSTOMER", "kurang_bayar_customer"],
];

export async function renderUtangPiutang() {
  view().innerHTML = `
    <div class="page-head"><h1>Utang Piutang</h1><span class="sub">Format sheet UTANG PIUTANG finance, dihitung langsung dari dokumen & pembayaran</span>
      <div class="spacer"></div><div class="actions"><a class="btn" href="/api/export/utang-piutang.xlsx">Export Excel</a></div></div>
    <div class="panel"><div class="filters"><label>Cari<input id="upSearch" placeholder="Job, customer, rute / plat"></label></div><div id="upBox">${skelTable(10, 8)}</div></div>`;
  const only = latest();
  const load = async () => {
    const rows = await only(get(`/utang-piutang?search=${encodeURIComponent(document.getElementById("upSearch").value)}`));
    // total = semua baris hasil cari, bukan hanya halaman yang tampil
    const sum = Object.fromEntries(UP_COLS.map(([, k]) => [k, rows.reduce((s, r) => s + Number(r[k] || 0), 0)]));
    pagedTable(document.getElementById("upBox"), { rows, empty: "Belum ada job",
      head: `<th>JOB NUMBER</th><th>CUSTOMER</th><th>KETERANGAN</th>${UP_COLS.map(([h]) => `<th class="num">${h}</th>`).join("")}`,
      row: (r) => `<tr class="click" data-href="#/jobs/${r.job_id}"><td><b>${esc(r.job_number)}</b></td><td>${esc(r.customer)}</td><td>${esc(r.keterangan)}</td>
        ${UP_COLS.map(([, k]) => `<td class="num">${rp(r[k])}</td>`).join("")}</tr>`,
      foot: `<tr><td colspan="3">Total</td>${UP_COLS.map(([, k]) => `<td class="num">${rp(sum[k])}</td>`).join("")}</tr>` });
  };
  document.getElementById("upSearch").oninput = debounce(load);
  await load();
}

// ---------------------------------------------------------------- kas & rekening
export async function renderKas() {
  const [bal, titip, transfers] = await Promise.all([get("/bank-balance"), get("/titipan"), get("/transfers")]);
  const banks = state.cache.banks.filter((b) => b.active);
  view().innerHTML = `
    <div class="page-head"><h1>Kas & Rekening</h1><span class="sub">Mutasi per rekening AMICO, titipan kas operasional (transfer malam), transfer internal</span>
      <div class="spacer"></div><div class="actions">${canFinance() ? `<button id="newTransfer">+ Transfer antar rekening</button>` : ""}</div></div>
    <div class="panel"><h2>Mutasi per rekening <span class="hint">dari pembayaran yang dicatat di ERP, bukan saldo bank</span></h2>
      ${table(`<th>Rekening</th><th>Jenis</th><th class="num">Diterima customer</th><th class="num">Dibayar ke vendor</th><th class="num">Transfer masuk</th><th class="num">Transfer keluar</th><th class="num">Mutasi bersih</th>`,
        bal.map((b) => `<tr><td><b>${esc(b.name)}</b><br><span class="muted">${esc(b.bank_name)} ${esc(b.account_number)}</span></td>
          <td>${b.kind === "OPERATIONAL" ? "Kas operasional" : "Bank"}</td><td class="num">${rp(b.diterima_customer)}</td><td class="num">${rp(b.dibayar_ke_vendor)}</td>
          <td class="num">${rp(b.transfer_masuk)}</td><td class="num">${rp(b.transfer_keluar)}</td><td class="num"><b>${rp(b.mutasi_bersih)}</b></td></tr>`).join(""),
        "Belum ada rekening. Tambahkan di Master Data > Rekening AMICO.")}
    </div>
    <div class="panel"><h2>Titipan kas operasional <span class="hint">dana pengajuan transfer malam yang belum disalurkan ke vendor</span></h2>
      ${table(`<th>Pengajuan</th><th>Tgl</th><th>Dana dikirim</th><th class="num">Dana masuk</th><th class="num">Disalurkan</th><th class="num">Titipan</th><th class="num">Sisa pengajuan</th>`,
        titip.map((t) => `<tr class="click" data-href="#/moves/${t.move_id}"><td><b>${esc(t.number)}</b></td><td>${tgl(t.move_date)}</td><td>${tgl(t.tanggal_dana)}</td>
          <td class="num">${rp(t.dana_masuk)}</td><td class="num">${rp(t.disalurkan)}</td><td class="num"><b>${rp(t.titipan)}</b></td><td class="num">${rp(t.sisa_pengajuan)}</td></tr>`).join(""),
        "Tidak ada dana yang mengendap di kas operasional")}
    </div>
    <div class="panel"><h2>Transfer internal</h2>
      ${table(`<th>Nomor</th><th>Tgl</th><th>Dari</th><th>Ke</th><th class="num">Nominal</th><th>Pengajuan</th><th>Catatan</th>`,
        transfers.map((t) => `<tr><td>${esc(t.number)}</td><td>${tgl(t.transfer_date)}</td><td>${esc(t.from_name)}</td><td>${esc(t.to_name)}</td>
          <td class="num">${rp(t.amount)}</td><td>${t.move_id ? `<a href="#/moves/${t.move_id}">${esc(t.move_number)}</a>` : ""}</td><td>${esc(t.note || "")}</td></tr>`).join(""), "Belum ada")}
    </div>`;
  bindRows();
  document.getElementById("newTransfer")?.addEventListener("click", () => openModal({
    title: "Transfer antar rekening AMICO",
    body: `<div class="form-grid">
      <label>Dari<select name="from_account_id">${options(banks, "", bankLabel, null)}</select></label>
      <label>Ke<select name="to_account_id">${options(banks, "", bankLabel, null)}</select></label>
      <label>Tanggal<input type="date" name="transfer_date" value="${today()}"></label>
      <label>Nominal<input class="num" name="amount" required></label>
      <label class="wide">Catatan<input name="note"></label></div>
      <div class="note-box">Untuk dana transfer malam per pengajuan, pakai tombol "Kirim dana ke kas operasional" di halaman pengajuannya.</div>`,
    onSubmit: async (d) => { d.amount = num(d.amount); await api("POST", "/transfers", d); toast("Transfer dicatat"); window.dispatchEvent(new Event("hashchange")); },
  }));
}

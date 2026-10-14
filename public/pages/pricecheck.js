// Cek Harga Jual: job yang selling-nya beda dari price book pada tanggal job, disamakan sekaligus (FINANCE / ADMIN).
import { get, api, view, esc, rp, tgl, tile, toast, options, customers, canFinance, askReason, bindRows, latest, skelTable, skelTiles, signed, SELLING_MODES } from "../lib.js";
import { xlTable } from "../xlfilter.js";

const routeOf = (j) => `${j.pol} - ${j.pod}${j.trip_type === "ROUND_TRIP" ? " PP" : ""}`;
const COLUMNS = [
  { key: "job_number", label: "No job", value: (j) => j.job_number },
  { key: "job_date", label: "Tgl job", value: (j) => tgl(j.job_date) },
  { key: "customer", label: "Customer", value: (j) => j.customer },
  { key: "route", label: "Rute", value: routeOf },
  { key: "truck", label: "Truk", value: (j) => j.truck_type },
  { key: "selling", label: "Selling di job", num: true, value: (j) => j.selling },
  { key: "book", label: "Price book", num: true, value: (j) => j.book },
  { key: "selisih", label: "Selisih", num: true, value: (j) => j.selisih },
  { key: "from", label: "Berlaku dari", value: (j) => tgl(j.effective_from) || "selalu" },
  { key: "mode", label: "Mode selling", value: (j) => SELLING_MODES[j.selling_mode] || j.selling_mode },
  { key: "billed", label: "Sudah ditagih", num: true, value: (j) => j.billed },
  { key: "status", label: "Bisa disamakan?", value: (j) => (j.blocked ? "Tidak (sudah ditagih lebih besar)" : "Ya") },
];
const rowHtml = (j, sel) => `<tr class="click ${j.blocked ? "rev" : ""}" data-href="#/jobs/${j.job_id}">${sel}
  <td><b>${esc(j.job_number)}</b></td><td class="nowrap">${tgl(j.job_date)}</td><td>${esc(j.customer)}</td><td>${esc(routeOf(j))}</td><td>${esc(j.truck_type)}</td>
  <td class="num">${rp(j.selling)}</td><td class="num"><b>${rp(j.book)}</b>${j.khusus ? `<br><span class="muted">khusus customer</span>` : ""}</td>
  <td class="num">${signed(j.selisih).replace(/<small>.*?<\/small>/, "")}</td>
  <td class="nowrap">${tgl(j.effective_from) || `<span class="muted">selalu</span>`}${j.effective_to ? `<br><span class="muted">s/d ${tgl(j.effective_to)}</span>` : ""}</td>
  <td>${esc(SELLING_MODES[j.selling_mode] || j.selling_mode)}</td><td class="num">${j.billed > 0 ? rp(j.billed) : "-"}</td>
  <td class="next-step">${j.blocked ? `<span class="badge warn">Tidak bisa</span>` : `<span class="badge lunas">Bisa</span>`}${j.keterangan ? `<div class="muted">${esc(j.keterangan)}</div>` : ""}</td></tr>`;

export async function renderPriceCheck() {
  const f = JSON.parse(sessionStorage.getItem("priceCheckFilter") || "{}");
  view().innerHTML = `
    <div class="page-head"><h1>Cek Harga Jual</h1>
      <span class="sub">Job yang selling-nya <b>beda dari price book</b> pada tanggal job. Harga per tanggal diisi finance di
        <a href="#/master/pricelist">Master Data &rsaquo; Price Book</a> (kolom "Berlaku dari"). Job lama tidak berubah sendiri: samakan dari sini, tercatat di riwayat job.</span></div>
    <div class="tiles" id="pcTiles">${skelTiles(3)}</div>
    <div class="panel">
      <div class="filters">
        <label>Tgl job dari<input type="date" id="pcFrom" value="${esc(f.from || "")}"></label>
        <label>Sampai<input type="date" id="pcTo" value="${esc(f.to || "")}"></label>
        <label>Customer<select id="pcCust">${options(customers(), f.customer_id, undefined, "Semua customer")}</select></label>
      </div>
      <div id="pcAction"></div>
      <div id="pcTable">${skelTable(6, 8)}</div>
    </div>`;
  const el = (id) => document.getElementById(id);
  const grid = xlTable(el("pcTable"), {
    id: "price-check", columns: COLUMNS, rowHtml, rowId: (j) => j.job_id,
    empty: "Semua selling job sudah sama dengan price book (atau price book untuk rutenya belum diisi)",
    onChange: () => bindRows(el("pcTable")), onSelect: (rows) => actionBar(rows),
  });

  function actionBar(sel) {
    const box = el("pcAction");
    if (!sel.length) { box.innerHTML = ""; return; }
    const ok = sel.filter((j) => !j.blocked);
    const total = ok.reduce((a, j) => a + j.selisih, 0);
    box.innerHTML = `<div class="note-box action-box"><span><b>${rp(sel.length)} job dicentang</b>${sel.length - ok.length ? `, ${rp(sel.length - ok.length)} tidak bisa disamakan (sudah ditagih lebih besar)` : ""}.
      ${ok.length ? `Total selling berubah ${signed(total).replace(/<small>.*?<\/small>/, "")}.` : ""}</span><span class="spacer"></span>
      ${canFinance() && ok.length ? `<button type="button" class="small primary" id="pcApply">Samakan ${rp(ok.length)} job dengan price book</button>` : ""}
      ${canFinance() ? "" : `<span class="muted">Hanya Finance / Admin yang bisa menyamakan.</span>`}
      <button type="button" class="small" id="pcClear">Hapus centang</button></div>`;
    el("pcClear").onclick = () => grid.clearSelection();
    el("pcApply")?.addEventListener("click", () => askReason(
      `Samakan ${rp(ok.length)} job dengan price book`,
      "Selling job diganti dengan harga price book yang berlaku pada tanggal job. DP yang sudah ditagih tidak berubah; sisanya menyesuaikan di tagihan berikutnya. Tercatat di riwayat tiap job.",
      async (reason) => {
        const r = await api("POST", "/price-check/apply", { job_ids: ok.map((j) => j.job_id), reason });
        toast(`${rp(r.updated)} job disamakan${r.skipped.length ? `, ${rp(r.skipped.length)} dilewati` : ""}`);
      }, "Samakan"));
  }

  const only = latest();
  const load = async () => {
    const flt = { from: el("pcFrom").value, to: el("pcTo").value, customer_id: el("pcCust").value };
    sessionStorage.setItem("priceCheckFilter", JSON.stringify(flt));
    const rows = await only(get(`/price-check?${new URLSearchParams(flt)}`));
    const ok = rows.filter((j) => !j.blocked);
    el("pcTiles").innerHTML =
      tile("Job beda dari price book", rows.length, rows.length ? "warn" : "", rows.length ? "selling di job tidak sama dengan price book" : "tidak ada yang beda") +
      tile("Selisih kalau disamakan", ok.reduce((a, j) => a + j.selisih, 0), "", `${rp(ok.length)} job bisa disamakan (+ naik, - turun)`) +
      tile("Tidak bisa disamakan", rows.length - ok.length, rows.length - ok.length ? "out" : "", "sudah ditagih lebih besar dari price book");
    grid.setRows(rows);
  };
  for (const k of ["pcFrom", "pcTo", "pcCust"]) el(k).onchange = load;
  await load();
}

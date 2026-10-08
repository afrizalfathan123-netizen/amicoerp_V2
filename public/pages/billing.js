// AR Customer / AP Vendor per job: mana yang belum ditagih (diajukan), sudah ditagih belum dibayar, belum bisa ditagih, lunas.
// Ditulis untuk orang baru: setiap fase ditulis lengkap (DP 70%, Pelunasan 30%, Full 100%) dengan nominal & langkah berikutnya.
import { get, view, esc, rp, tgl, tile, toast, openModal, enumOptions, canFinance, state, phaseLabel, SCHEME_LABEL, SCHEME_SHORT, STAGE_LABEL, bindRows } from "../lib.js";
import { xlTable } from "../xlfilter.js";
import { moveForm } from "./moves.js";

const T = {
  SALE: {
    title: "AR Customer", nav: "ar", partner: "Customer", value: "Selling", type: "out_invoice", doc: "invoice",
    sub: "Piutang per job: mana yang belum ditagih ke customer, sudah ditagih tapi belum dibayar, dan yang sudah lunas.",
    todo: "Belum ditagih", unpaid: "Ditagih, belum dibayar", act: "Tagih", acting: "ditagih", make: "Buat invoice",
  },
  PURCHASE: {
    title: "AP Vendor", nav: "ap", partner: "Vendor", value: "Cost", type: "in_invoice", doc: "pengajuan",
    sub: "Utang per job: mana yang belum diajukan ke vendor, sudah diajukan tapi belum ditransfer, dan yang sudah lunas.",
    todo: "Belum diajukan", unpaid: "Diajukan, belum ditransfer", act: "Ajukan", acting: "diajukan", make: "Buat pengajuan",
  },
};
const GROUPS = { TODO: "Perlu ditagih sekarang", WAIT: "Belum bisa ditagih", UNPAID: "Menunggu pembayaran", DONE: "Lunas", ALL: "Semua" };
const PHASE_ORDER = ["DP", "SETTLEMENT", "FULL", "OTHER"];
const norm = (v) => String(v || "").replace(/\s/g, "").toUpperCase();

// Status satu fase + alasan kalau belum bisa ditagih
function analyze(j, side) {
  const s = state.cache.settings || {};
  const gateNeeded = s.require_gate_for_billing !== false;
  // isian pengganti seperti "TIDAK ADA KODE TUGAS" dianggap belum ada
  const hasDo = j.do_number && !/TIDAK\s*ADA|^-+$/i.test(j.do_number.trim());
  const gateMissing = !gateNeeded ? null : !hasDo ? "kode tugas belum ada" : !j.gate_out_at ? "truk belum gate out" : null;
  const blocker = (phase) => {
    if (side === "SALE") return gateMissing || (phase !== "DP" && j.sj_tracking && !j.sj_received_at ? "SJ belum diterima" : null);
    return phase === "DP" || phase === "OTHER" ? null : gateMissing;
  };
  const phases = {};
  for (const p of j.phases) {
    const why = p.not_billed > 0.5 ? blocker(p.phase) : null;
    const status = p.not_billed > 0.5 ? (why ? "WAIT" : "TODO") : p.outstanding > 0.5 ? "UNPAID" : "PAID";
    phases[p.phase] = { ...p, status, why, label: phaseLabel(p.phase, j.scheme) };
  }
  const list = PHASE_ORDER.map((k) => phases[k]).filter(Boolean);
  const has = (st) => list.filter((p) => p.status === st);
  const group = has("TODO").length ? "TODO" : has("WAIT").length ? "WAIT" : has("UNPAID").length ? "UNPAID" : "DONE";
  const t = T[side];
  const steps = [
    ...has("TODO").map((p) => `${t.act} ${p.label} ${rp(p.not_billed)}`),
    ...has("UNPAID").map((p) => `Tunggu ${side === "SALE" ? "customer bayar" : "transfer"} ${p.label} (${p.open_docs || "-"})`),
    ...has("WAIT").map((p) => `${p.label} ${rp(p.not_billed)}: belum bisa, ${p.why}`),
  ];
  return {
    ...j, ph: phases, group, steps,
    route: `${j.pol} - ${j.pod}${j.trip_type === "ROUND_TRIP" ? " PP" : ""}`,
    not_billed: list.reduce((a, p) => a + p.not_billed, 0),
    outstanding: list.reduce((a, p) => a + p.outstanding, 0),
    value_total: list.reduce((a, p) => a + p.planned, 0),
  };
}

const STATUS_TEXT = (side, p) => !p ? "-" : { TODO: T[side].todo, WAIT: "Belum bisa", UNPAID: T[side].unpaid, PAID: "Lunas" }[p.status];
const STATUS_CLS = { TODO: "open", WAIT: "draft", UNPAID: "PENDING", PAID: "lunas" };
function phaseCell(side, p, j) {
  if (!p) return `<span class="muted">${j.scheme === "FULL" ? "tidak pakai DP" : "-"}</span>`;
  const part = p.billed > 0.5 && p.not_billed > 0.5;
  return `<div class="ph-cell"><span class="muted">${esc(p.label)}</span> <b>${rp(p.planned)}</b><br>
    <span class="badge ${STATUS_CLS[p.status]}">${esc(STATUS_TEXT(side, p))}${part ? ` kurang ${rp(p.not_billed)}` : ""}</span>
    ${p.why ? `<br><span class="muted">${esc(p.why)}</span>` : ""}
    ${p.docs ? `<br><span class="muted small-text">${esc(p.docs)}</span>` : ""}</div>`;
}

export const renderAr = () => renderBilling("SALE");
export const renderAp = () => renderBilling("PURCHASE");

async function renderBilling(side) {
  const t = T[side];
  const key = `billing-${side}`;
  const saved = JSON.parse(sessionStorage.getItem(key) || "{}");
  let group = saved.group || "TODO";
  let paste = saved.paste || null;   // { by, numbers }
  view().innerHTML = `
    <div class="page-head"><h1>${t.title}</h1><span class="sub">${t.sub}</span></div>
    <details class="panel legend" ${saved.legendClosed ? "" : "open"} id="legend"><summary><b>Baru di sini? Cara baca halaman ini</b></summary>
      ${side === "SALE" ? `<ul>
        <li><b>Skema 70/30</b>: <b>DP 70%</b> dari selling ditagih di awal (setelah truk gate out). <b>Pelunasan 30%</b> = selling setelah pajak dikurangi DP,
          ditagih setelah SJ diterima. Jadi pelunasan tidak selalu tepat 30% karena ikut PPN / PPh customer.</li>
        <li><b>Skema 50/50</b>: sama, tapi DP 50% dan pelunasan 50%.</li>
        <li><b>Skema 100% (Full)</b>: ditagih sekali penuh setelah SJ diterima (biasanya dalam kota). Tidak ada DP.</li>
        <li><b>Belum ditagih</b> = belum dibuatkan invoice. <b>Ditagih, belum dibayar</b> = invoice sudah ada, customer belum transfer.
          <b>Belum bisa</b> = syaratnya belum lengkap (kode tugas, gate out, atau SJ belum diterima).</li></ul>`
      : `<ul>
        <li><b>Skema 70/30</b>: <b>DP 70%</b> dari cost truk ditransfer ke vendor di awal (boleh sebelum berangkat). <b>Pelunasan 30%</b> = sisa cost,
          diajukan setelah truk gate out dan kode tugas ada.</li>
        <li><b>Skema 100% (Full)</b>: cost dibayar sekali penuh setelah gate out (biasanya dalam kota). Tidak ada DP.</li>
        <li><b>Calo / biaya lain</b> (tol, parkir, bongkar, calo) diajukan terpisah dari cost truk.</li>
        <li><b>Belum diajukan</b> = belum masuk pengajuan. <b>Diajukan, belum ditransfer</b> = pengajuan ada (menunggu persetujuan / transfer).
          <b>Belum bisa</b> = syaratnya belum lengkap (kode tugas atau gate out).</li></ul>`}
    </details>
    <div class="tiles" id="bTiles"></div>
    <div class="panel">
      <div class="tabs" id="bTabs"></div>
      <div class="filters">
        <button id="bPaste" title="Tempel daftar no job / kode tugas dari Excel atau WhatsApp">Tempel daftar</button>
        <button id="bCopy" title="Salin no job yang tampil untuk ditempel di WhatsApp / Excel">Salin no job yang tampil</button>
      </div>
      <div id="bPasteBox"></div>
      <div id="bAction"></div>
      <div id="bTable"><p class="muted">Memuat...</p></div>
    </div>`;
  const el = (id) => document.getElementById(id);
  el("legend").addEventListener("toggle", () => save());
  const save = () => sessionStorage.setItem(key, JSON.stringify({ group, paste, legendClosed: !el("legend").open }));

  const all = (await get(`/billing?side=${side}`)).map((j) => analyze(j, side));
  const otherPhase = side === "PURCHASE";
  const columns = [
    { key: "job_number", label: "No job", value: (j) => j.job_number },
    { key: "do_number", label: "Kode tugas", value: (j) => j.do_number },
    { key: "job_date", label: "Tgl", value: (j) => tgl(j.job_date) },
    { key: "customer", label: "Customer", value: (j) => j.customer },
    ...(side === "PURCHASE" ? [{ key: "vendor", label: "Vendor", value: (j) => j.vendor }] : []),
    { key: "route", label: "Rute", value: (j) => j.route },
    { key: "plate", label: "Plat", value: (j) => j.plate_number },
    { key: "scheme", label: "Skema", value: (j) => SCHEME_SHORT[j.scheme] },
    { key: "value", label: side === "SALE" ? "Nilai tagihan" : "Nilai cost", num: true, value: (j) => j.value_total },
    { key: "dp", label: "DP", value: (j) => STATUS_TEXT(side, j.ph.DP), text: (j) => (j.ph.DP ? STATUS_TEXT(side, j.ph.DP) : "Tidak pakai DP") },
    { key: "settle", label: "Pelunasan / Full", value: (j) => STATUS_TEXT(side, j.ph.SETTLEMENT || j.ph.FULL) },
    ...(otherPhase ? [{ key: "other", label: "Calo / biaya lain", value: (j) => (j.ph.OTHER ? STATUS_TEXT(side, j.ph.OTHER) : "") }] : []),
    { key: "not_billed", label: `Belum ${t.acting}`, num: true, value: (j) => j.not_billed },
    { key: "outstanding", label: "Belum dibayar", num: true, value: (j) => j.outstanding },
    { key: "stage", label: "Status job", value: (j) => STAGE_LABEL[j.stage] || j.stage },
    { key: "next", label: "Langkah berikutnya", value: (j) => j.steps[0] || "Selesai" },
  ];
  const rowHtml = (j, sel) => `<tr class="click" data-href="#/jobs/${j.job_id}">${sel}
    <td><b>${esc(j.job_number)}</b></td><td>${esc(j.do_number || "")}</td><td class="nowrap">${tgl(j.job_date)}</td><td>${esc(j.customer)}</td>
    ${side === "PURCHASE" ? `<td>${esc(j.vendor || "-")}</td>` : ""}
    <td>${esc(j.route)}</td><td class="nowrap">${esc(j.plate_number || "")}</td>
    <td title="${esc(SCHEME_LABEL[j.scheme] || "")}">${SCHEME_SHORT[j.scheme] || "-"}</td><td class="num">${rp(j.value_total)}</td>
    <td>${phaseCell(side, j.ph.DP, j)}</td><td>${phaseCell(side, j.ph.SETTLEMENT || j.ph.FULL, j)}</td>
    ${otherPhase ? `<td>${j.ph.OTHER ? phaseCell(side, j.ph.OTHER, j) : ""}</td>` : ""}
    <td class="num">${j.not_billed > 0.5 ? `<b>${rp(j.not_billed)}</b>` : "-"}</td><td class="num">${j.outstanding > 0.5 ? rp(j.outstanding) : "-"}</td>
    <td>${esc(STAGE_LABEL[j.stage] || "")}</td>
    <td class="next-step">${j.steps.length ? j.steps.map((x) => `<div>${esc(x)}</div>`).join("") : `<span class="badge lunas">Selesai</span>`}</td></tr>`;
  const grid = xlTable(el("bTable"), {
    id: `billing-${side}`, columns, rowHtml, empty: "Tidak ada job di kelompok ini", rowId: (j) => j.job_id,
    order: (a, b) => (paste ? (pos.get(keyOf(a)) ?? 1e9) - (pos.get(keyOf(b)) ?? 1e9) : 0),
    onChange: () => bindRows(el("bTable")), onSelect: (rows) => actionBar(rows),
  });
  let pos = new Map();
  const keyOf = (j) => norm(paste?.by === "do" ? j.do_number : j.job_number);

  // ringkasan: berapa yang bisa ditagih sekarang, belum bisa, menunggu bayar
  // satu job bisa ada di "perlu ditagih" dan "menunggu pembayaran" sekaligus (mis. DP belum dibayar, pelunasan belum ditagih)
  const inGroup = (j, g) => g === "ALL" || (g === "DONE" ? j.group === "DONE"
    : g === "UNPAID" ? j.outstanding > 0.5 : PHASE_ORDER.some((k) => j.ph[k]?.status === g));
  const count = (g) => all.filter((j) => inGroup(j, g)).length;
  const SHORT = { DP: "DP", SETTLEMENT: "Pelunasan", FULL: "Full", OTHER: "Calo/lain" };
  const phaseSum = (st) => PHASE_ORDER.map((k) => {
    const v = all.reduce((a, j) => a + (j.ph[k]?.status === st ? j.ph[k].not_billed : 0), 0);
    return v > 0.5 ? `${SHORT[k]} ${rp(v)}` : "";
  }).filter(Boolean).join(" · ");
  el("bTiles").innerHTML =
    tile(`Bisa ${t.acting} sekarang`, all.reduce((a, j) => a + PHASE_ORDER.reduce((s, k) => s + (j.ph[k]?.status === "TODO" ? j.ph[k].not_billed : 0), 0), 0), "warn",
      `${count("TODO")} job · ${phaseSum("TODO")}`) +
    tile(`Belum bisa ${t.acting}`, all.reduce((a, j) => a + PHASE_ORDER.reduce((s, k) => s + (j.ph[k]?.status === "WAIT" ? j.ph[k].not_billed : 0), 0), 0), "",
      `${count("WAIT")} job, menunggu syarat (kode tugas / gate out${side === "SALE" ? " / SJ" : ""})`) +
    tile(side === "SALE" ? "Ditagih, belum dibayar" : "Diajukan, belum ditransfer", all.reduce((a, j) => a + j.outstanding, 0), side === "SALE" ? "in" : "out",
      `${count("UNPAID")} job`) +
    tile("Job lunas", count("DONE"), "", `dari ${rp(all.length)} job`);

  const drawTabs = () => {
    el("bTabs").innerHTML = Object.entries(GROUPS).map(([k, l]) =>
      `<a href="#" data-g="${k}" class="${k === group ? "active" : ""}">${esc(side === "PURCHASE" ? l.replace("ditagih", "diajukan") : l)} (${rp(count(k))})</a>`).join("");
    el("bTabs").querySelectorAll("[data-g]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); group = a.dataset.g; save(); apply(); }));
  };
  const apply = () => {
    drawTabs();
    pos = new Map((paste?.numbers || []).map((n, i) => [n, i]));
    let rows = all;
    if (paste) {
      const set = new Set(paste.numbers);
      rows = all.filter((j) => set.has(keyOf(j)));
      const found = new Set(rows.map(keyOf));
      const missing = paste.numbers.filter((n) => !found.has(n));
      el("bPasteBox").innerHTML = `<div class="note-box warn-box paste-box"><span>Daftar tempel: <b>${rp(paste.numbers.length)} ${paste.by === "do" ? "kode tugas" : "no job"}</b>,
        ${rp(paste.numbers.length - missing.length)} ketemu${missing.length ? `, <b>${rp(missing.length)} tidak ketemu</b> (${esc(missing.slice(0, 8).join(", "))}${missing.length > 8 ? ", ..." : ""})` : ""}.
        Semua kelompok ditampilkan.</span><span class="spacer"></span><button type="button" class="small" id="bPasteClear">Hapus daftar</button></div>`;
      el("bPasteClear").onclick = () => { paste = null; save(); apply(); };
    } else {
      el("bPasteBox").innerHTML = "";
      rows = all.filter((j) => inGroup(j, group));
    }
    grid.setRows(rows);
  };

  // job dicentang -> buat invoice / pengajuan untuk fase yang bisa
  function actionBar(sel) {
    const box = el("bAction");
    if (!sel.length) { box.innerHTML = ""; return; }
    const phases = PHASE_ORDER.filter((k) => sel.some((j) => j.ph[k]?.status === "TODO"));
    const customers = new Set(sel.map((j) => j.customer_id));
    const blockedCust = side === "SALE" && customers.size > 1;
    const amount = (k) => sel.reduce((a, j) => a + (j.ph[k]?.status === "TODO" ? j.ph[k].not_billed : 0), 0);
    const jobsOf = (k) => sel.filter((j) => j.ph[k]?.status === "TODO");
    box.innerHTML = `<div class="note-box action-box"><span><b>${rp(sel.length)} job dicentang.</b>
      ${phases.length ? "" : ` Tidak ada fase yang bisa ${t.acting} sekarang untuk job ini.`}
      ${blockedCust ? " Invoice dibuat per customer: centang job dari satu customer saja." : ""}</span><span class="spacer"></span>
      ${canFinance() ? phases.map((k) => `<button type="button" class="small ${blockedCust ? "" : "primary"}" data-make="${k}" ${blockedCust ? "disabled" : ""}>
        ${t.make} ${esc(k === "OTHER" ? "calo / biaya lain" : phaseLabel(k, sel.find((j) => j.ph[k])?.scheme))} (${jobsOf(k).length} job, ${rp(amount(k))})</button>`).join("") : ""}
      <button type="button" class="small" id="bClearSel">Hapus centang</button></div>`;
    box.querySelectorAll("[data-make]").forEach((b) => (b.onclick = () => {
      const jobs = jobsOf(b.dataset.make);
      moveForm(t.type, { phase: b.dataset.make, partner_id: side === "SALE" ? jobs[0].customer_id : "", job_ids: jobs.map((j) => j.job_id) });
    }));
    el("bClearSel").onclick = () => grid.clearSelection();
  }

  el("bPaste").onclick = () => openModal({
    title: "Tempel daftar job",
    body: `<div class="form-grid"><label>Cari berdasarkan<select name="by">${enumOptions({ job: "No job", do: "Kode tugas" }, paste?.by || "job")}</select></label></div>
      <label>Daftar (satu per baris, atau dipisah koma / spasi)<textarea name="list" rows="12" style="width:100%">${esc((paste?.numbers || []).join("\n"))}</textarea></label>`,
    submitLabel: "Tampilkan",
    onSubmit: (d) => {
      const numbers = [...new Set(String(d.list).split(/[\s,;]+/).map(norm).filter(Boolean))];
      if (!numbers.length) throw new Error("Daftar masih kosong");
      paste = { by: d.by, numbers };
      save();
      apply();
    },
  });
  el("bCopy").onclick = async () => {
    const text = grid.visible().map((j) => j.job_number).join("\n");
    try { await navigator.clipboard.writeText(text); toast(`${grid.visible().length} no job disalin`); }
    catch { openModal({ title: "No job yang tampil", body: `<textarea rows="14" style="width:100%">${esc(text)}</textarea>` }); }
  };
  apply();
}

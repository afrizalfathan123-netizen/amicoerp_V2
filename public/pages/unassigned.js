// Selisih, dilihat dari kas AMICO (+ surplus = uang lebih di AMICO, - minus = uang AMICO kurang):
//   1. kurang transfer / kurang bayar: tujuannya jelas, uangnya kurang dari seharusnya
//   2. tanpa tujuan: uang di dokumen (invoice / pengajuan) yang tidak menempel ke baris order job.
//      Finance mengarahkannya: ke baris order job (calo, biaya / selling tambahan), jadi saldo partner, atau dibatalkan.
import { api, get, view, esc, rp, tgl, tile, table, openModal, toast, canFinance, enumOptions, debounce, KIND_LABEL, phaseLabel, signed } from "../lib.js";

const STATUS = { OPEN: "Belum diarahkan", PARTNER_BALANCE: "Saldo partner", all: "Semua" };
const KINDS = ["TRUCKING", "CALO", "TOL", "PARKIR", "BONGKAR", "LAINNYA"];

export function unassignedTable(el, rows, reload, { showJob = true } = {}) {
  const detail = rows.some((u) => u.seharusnya != null);
  el.innerHTML = table(
    `<th>Tgl</th>${showJob ? "<th>Job</th>" : ""}<th>Dokumen</th><th>Partner</th><th>Keterangan</th>
     ${detail ? `<th class="num">Seharusnya</th><th class="num">Dibayar aktual (Excel)</th><th class="num">ERP ke job</th>` : ""}
     <th class="num">Lebih (tanpa tujuan)</th><th class="num">Sudah dibayar</th><th class="num">Ke kas AMICO</th><th>Status</th><th></th>`,
    rows.map((u) => `<tr>
      <td>${tgl(u.move_date)}</td>
      ${showJob ? `<td><a href="#/jobs/${u.job_id}"><b>${esc(u.job_number)}</b></a><br><span class="muted">${esc(u.customer)}</span></td>` : ""}
      <td><a href="#/moves/${u.move_id}">${esc(u.number)}</a><br><span class="muted">${u.move_type === "out_invoice" ? "Invoice customer" : "Pengajuan vendor"} · ${esc(phaseLabel(u.phase))}</span></td>
      <td>${esc(u.partner || "")}</td>
      <td class="small-text">${esc(u.description || "")}${u.resolution_note ? `<br><span class="muted">${esc(u.resolution_note)}${u.resolved_by_name ? ` (${esc(u.resolved_by_name)})` : ""}</span>` : ""}</td>
      ${detail ? `<td class="num">${rp(u.seharusnya)}<br><span class="muted">${u.move_type === "out_invoice" ? "selling stl pajak" : "cost"}</span></td>
        <td class="num">${rp(u.dibayar_job + u.paid)}</td><td class="num">${rp(u.dibayar_job)}</td>` : ""}
      <td class="num">${rp(u.amount)}</td><td class="num">${rp(u.paid)}</td>
      <td class="num" title="${u.move_type === "out_invoice" ? "Customer membayar lebih: uang masuk lebih, utang ke customer" : "Vendor dibayar lebih: uang keluar lebih, piutang ke vendor"}">${u.paid ? signed(u.selisih_kas) : `<span class="muted">belum dibayar</span>`}</td>
      <td><span class="badge ${u.status === "OPEN" ? "open" : "draft"}">${esc(STATUS[u.status])}</span></td>
      <td class="nowrap">${canFinance() ? (u.status === "OPEN"
        ? `<button class="small primary" data-resolve="${u.move_line_id}">Arahkan</button>`
        : `<button class="small" data-reopen="${u.move_line_id}">Buka lagi</button>`) : ""}</td>
    </tr>`).join(""),
    "Tidak ada selisih tanpa tujuan");
  el.querySelectorAll("[data-resolve]").forEach((b) => (b.onclick = () => resolveModal(rows.find((u) => u.move_line_id === Number(b.dataset.resolve)), reload)));
  el.querySelectorAll("[data-reopen]").forEach((b) => (b.onclick = async () => {
    try { await api("POST", `/unassigned/${b.dataset.reopen}/reopen`, {}); toast("Dibuka lagi"); reload(); } catch (e) { toast(e.message, true); }
  }));
}

async function resolveModal(u, reload) {
  const sale = u.move_type === "out_invoice";
  const { lines } = await get(`/jobs/${u.job_id}`);
  const fits = lines.filter((l) => l.side === (sale ? "SALE" : "PURCHASE") && l.amount - l.billed + 0.004 >= u.amount);
  const actions = {
    NEW: sale ? "Jadikan selling tambahan job ini" : "Jadikan biaya job ini (calo, tol, dll)",
    ...(fits.length ? { EXISTING: "Masukkan ke baris order yang masih bersisa" } : {}),
    ...(u.paid > 0 ? { PARTNER: sale ? "Lebih tagih: jadi saldo customer (dikembalikan / dipotong tagihan berikutnya)" : "Lebih bayar: jadi saldo vendor (dipotong pembayaran berikutnya)" } : {}),
    ...(u.paid === 0 ? { CANCEL: "Batalkan baris ini (salah tagih / salah input)" } : {}),
  };
  openModal({
    title: `Arahkan selisih ${rp(u.amount)} · ${u.job_number}`,
    submitLabel: "Simpan",
    body: `
      <div class="note-box warn-box">${esc(u.number)} · ${esc(u.partner || "")} · ${esc(u.description || "")}. Sudah dibayar ${rp(u.paid)}.</div>
      <div class="form-grid">
        <label class="wide">Tindakan<select name="act">${enumOptions(actions, "NEW")}</select></label>
        <label data-for="NEW">Jenis<select name="kind">${enumOptions(Object.fromEntries(KINDS.map((k) => [k, KIND_LABEL[k]])), sale ? "LAINNYA" : "CALO")}</select></label>
        <label data-for="NEW" class="wide">Keterangan baris<input name="description" placeholder="${sale ? "contoh: biaya inap 1 malam" : "contoh: calo pelabuhan"}"></label>
        <label data-for="EXISTING" class="wide">Baris order<select name="job_line_id">${fits.map((l) =>
          `<option value="${l.job_line_id}">${esc(KIND_LABEL[l.kind])} · ${esc(l.description || "")} · sisa ${rp(l.amount - l.billed)}</option>`).join("")}</select></label>
        <label class="wide">Catatan / alasan<input name="note" placeholder="dari mana selisih ini"></label>
      </div>`,
    onOpen: (f) => {
      const sync = () => f.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== f.act.value));
      f.act.onchange = sync;
      sync();
    },
    onSubmit: async (d) => {
      if (d.act === "NEW") await api("POST", `/unassigned/${u.move_line_id}/assign`, { kind: d.kind, description: d.description, note: d.note });
      else if (d.act === "EXISTING") await api("POST", `/unassigned/${u.move_line_id}/assign`, { job_line_id: Number(d.job_line_id), note: d.note });
      else if (d.act === "PARTNER") await api("POST", `/unassigned/${u.move_line_id}/partner-balance`, { reason: d.note });
      else await api("POST", `/move-lines/${u.move_line_id}/cancel`, { reason: d.note });
      toast("Selisih diarahkan");
      reload();
    },
  });
}

export async function renderUnassigned() {
  const f = JSON.parse(sessionStorage.getItem("unassignedFilter") || '{"status":"OPEN"}');
  const [all, balances, short, xl] = await Promise.all([get("/unassigned?status=all"), get("/partner-balances"), get("/kurang-transfer"), get("/selisih/excel")]);
  const xj = (id) => xl.perJob[id];
  const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const open = all.filter((u) => u.status === "OPEN");
  const items = [...short.map((r) => r.selisih_kas), ...all.map((u) => u.selisih_kas)];
  const plus = items.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const minus = items.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  view().innerHTML = `
    <div class="page-head"><h1>Selisih</h1>
      <span class="sub">Dilihat dari kas AMICO. <b>+ Surplus</b>: uang di AMICO lebih dari seharusnya (mis. belum ditransfer ke vendor, jadi masih utang).
      <b>&minus; Minus</b>: uang di AMICO kurang dari seharusnya (mis. customer kurang bayar, atau vendor dibayar lebih).</span></div>
    <div class="tiles">
      ${tile("Surplus (+)", plus, "plus", "Uang lebih di AMICO, masih harus dibayarkan / dikembalikan")}
      ${tile("Minus (−)", -minus, "minus", "Uang AMICO kurang, masih harus ditagih / diminta kembali")}
      ${tile("Kurang transfer / kurang bayar", sum(short, "kurang"), short.length ? "warn" : "", `${short.length} job, tujuannya jelas`)}
      ${tile("Tanpa tujuan, belum diarahkan", sum(open, "amount"), open.length ? "warn" : "", `${open.length} baris`)}
    </div>
    <div class="panel"><div class="eyebrow">Perbandingan</div><h2>Excel (JOB REGISTRATION) vs ERP
      <span class="hint">${xl.info ? `angka Excel dari ${esc(xl.info.file)}, ${new Date(xl.info.at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" })}, ${rp(xl.info.jobs)} job` : "belum ada angka Excel, unggah file JOB REG"}</span>
      <div class="spacer"></div>${canFinance() ? `<label class="btn small" style="flex-direction:row">Unggah JOB REG<input type="file" id="xlFile" accept=".xlsx" hidden></label>` : ""}</h2>
      <div id="xlBox"></div>
      <div class="note-box">Excel = catatan aktual yang diketik finance. ERP menghitung dari cost / selling job: sisa yang di Excel 0 (dianggap lunas) tapi
        dibayarnya kurang dari cost, di ERP tetap jadi sisa (kurang transfer). Kelebihan di atas cost / selling dipisah ke Tanpa Tujuan. Klik baris untuk melihat job-nya.</div>
    </div>
    <div class="panel"><div class="eyebrow">1. Tujuan jelas, nominal kurang</div><h2>Kurang transfer / kurang bayar
      <span class="hint">pelunasan sudah dibayar, tapi total yang dibayar kurang dari seharusnya</span></h2>
      ${table(`<th>Job</th><th>Customer</th><th>Arah</th><th class="num">Seharusnya</th><th class="num">Dibayar aktual</th>
        <th class="num">Sisa menurut Excel</th><th class="num">Sisa menurut ERP</th><th class="num">DP / pelunasan kurang</th><th class="num">Ke kas AMICO</th><th>Artinya</th>`,
        short.map((r) => { const x = xj(r.job_id); const sisaX = x ? (r.side === "PURCHASE" ? x.sisa_vendor : x.sisa_customer) : null;
          return `<tr><td><a href="#/jobs/${r.job_id}"><b>${esc(r.job_number)}</b></a><br><span class="muted">${tgl(r.job_date)}</span></td>
          <td>${esc(r.customer)}</td><td>${r.side === "PURCHASE" ? "AMICO kurang transfer ke vendor" : "Customer kurang bayar ke AMICO"}</td>
          <td class="num">${rp(r.seharusnya)}</td><td class="num">${rp(r.dp_dibayar + r.pelunasan_dibayar)}</td>
          <td class="num">${sisaX == null ? `<span class="muted">-</span>` : `${rp(sisaX)}${sisaX === 0 ? `<br><span class="muted">dianggap lunas</span>` : ""}`}</td>
          <td class="num"><b>${rp(r.kurang)}</b></td><td class="num">${rp(r.dp_kurang)} / ${rp(r.pelunasan_kurang)}</td><td class="num">${signed(r.selisih_kas)}</td>
          <td class="small-text">${r.side === "PURCHASE" ? "Uang masih di AMICO, belum sampai ke vendor / driver. Utang, harus ditransfer." : "Uang belum masuk dari customer. Piutang, harus ditagih."}</td></tr>`; }).join(""),
        "Tidak ada kurang transfer")}
    </div>
    <div class="panel"><div class="eyebrow">2. Tujuan belum jelas</div><h2>Tanpa tujuan
      <span class="hint">nominal invoice / pengajuan di atas selling / cost job; tidak dihitung di selling, cost, atau margin job sampai diarahkan</span></h2>
      <div class="filters">
        <label>Status<select id="uStatus">${enumOptions(STATUS, f.status)}</select></label>
        <label>Cari<input id="uSearch" placeholder="No job, dokumen, partner" value="${esc(f.search || "")}"></label>
      </div>
      <div id="uTable"></div>
    </div>
    ${balances.length ? `<div class="panel"><div class="eyebrow">Saldo partner</div><h2>Lebih bayar / lebih tagih per partner</h2>
      ${table(`<th>Partner</th><th>Sisi</th><th class="num">Baris</th><th class="num">Saldo</th><th class="num">Ke kas AMICO</th>`,
        balances.map((b) => `<tr><td>${esc(b.partner || "-")}</td><td>${b.side === "VENDOR" ? "Vendor berutang ke AMICO" : "AMICO berutang ke customer"}</td>
          <td class="num">${rp(b.items)}</td><td class="num">${rp(b.amount)}</td><td class="num">${signed(b.side === "VENDOR" ? -b.amount : b.amount)}</td></tr>`).join(""))}
      <div class="note-box">Saldo dicatat supaya tidak hilang. Pengembalian atau pemotongan dari pembayaran berikutnya belum otomatis; untuk sekarang dicatat finance di luar ERP.</div></div>` : ""}`;
  const el = (k) => document.getElementById(k);
  renderExcel(el("xlBox"), xl);
  el("xlFile")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    toast("Membaca file JOB REG...");
    try {
      const res = await fetch(`/api/selisih/excel?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal");
      toast(`Angka Excel diperbarui (${data.info.jobs} job)`);
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) { toast(err.message, true); }
  });
  const load = async () => {
    const flt = { status: el("uStatus").value, search: el("uSearch").value };
    sessionStorage.setItem("unassignedFilter", JSON.stringify(flt));
    const rows = await get(`/unassigned?${new URLSearchParams(flt)}`);
    unassignedTable(el("uTable"), rows, () => window.dispatchEvent(new Event("hashchange")));
  };
  el("uStatus").onchange = load;
  el("uSearch").oninput = debounce(load);
  await load();
}

function renderExcel(el, xl) {
  if (!xl.info) { el.innerHTML = `<p class="muted">Belum ada angka Excel. Impor JOB REG atau unggah file JOB REG di sini.</p>`; return; }
  el.innerHTML = table(`<th>Kolom UTANG PIUTANG</th><th class="num">Excel</th><th class="num">ERP</th><th class="num">Beda (ERP - Excel)</th><th class="num">Job beda</th>`,
    xl.columns.map((c, i) => `<tr class="${c.jobs.length ? "click" : ""}" data-col="${i}">
      <td><b>${esc(c.label)}</b></td><td class="num">${rp(c.excel)}</td><td class="num">${rp(c.erp)}</td>
      <td class="num">${Math.abs(c.beda) < 1 ? `<span class="badge posted">sama</span>` : `<b>${c.beda > 0 ? "+" : "&minus;"}${rp(Math.abs(c.beda))}</b>`}</td>
      <td class="num">${c.jobs.length || ""}</td></tr>
      <tr data-detail="${i}" hidden><td colspan="5">${table(`<th>Job</th><th>Customer</th><th class="num">Excel</th><th class="num">ERP</th><th class="num">Beda</th><th>Kenapa</th>`,
        c.jobs.map((j) => `<tr><td><a href="#/jobs/${j.job_id}">${esc(j.job_number)}</a></td><td>${esc(j.customer)}</td><td class="num">${rp(j.excel)}</td>
          <td class="num">${rp(j.erp)}</td><td class="num">${j.beda > 0 ? "+" : "&minus;"}${rp(Math.abs(j.beda))}</td><td class="small-text">${esc(j.sebab)}</td></tr>`).join(""))}</td></tr>`).join(""));
  el.querySelectorAll("tr[data-col]").forEach((tr) => (tr.onclick = () => {
    const d = el.querySelector(`tr[data-detail="${tr.dataset.col}"]`);
    if (d && xl.columns[tr.dataset.col].jobs.length) d.hidden = !d.hidden;
  }));
}

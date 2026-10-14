// Helper bersama untuk semua halaman.
export const view = () => document.getElementById("view");
const modal = () => document.getElementById("modal");
const modalForm = () => document.getElementById("modalForm");

export const PHASE_LABEL = { DP: "DP", SETTLEMENT: "Pelunasan", FULL: "Full 100%", OTHER: "Calo / biaya lain" };
export const SCHEME_LABEL = { "70_30": "DP 70% + pelunasan 30%", "50_50": "DP 50% + pelunasan 50%", FULL: "Langsung 100%" };
// Status job bertahap (dihitung server) dan status surat jalan
export const STAGE_LABEL = {
  RENCANA: "Rencana", JALAN: "Dalam perjalanan", MENUNGGU_SJ: "Menunggu SJ", SIAP_TAGIH: "Siap ditagih",
  KIRIM_SJ: "SJ belum dikirim", MENUNGGU_BAYAR: "Menunggu pembayaran", SELESAI: "Selesai", BATAL: "Batal",
};
const STAGE_CLASS = { RENCANA: "", JALAN: "draft", MENUNGGU_SJ: "open", SIAP_TAGIH: "draft", KIRIM_SJ: "open", MENUNGGU_BAYAR: "", SELESAI: "posted", BATAL: "cancelled" };
export const stageBadge = (s) => (s ? `<span class="badge ${STAGE_CLASS[s] || ""}">${esc(STAGE_LABEL[s] || s)}</span>` : "");
export const SJ_STATUS_LABEL = { BELUM_ADA_RESI: "Belum ada resi", DI_KURIR: "Di kurir", DITERIMA: "Diterima AMICO", DIKIRIM: "Dikirim ke customer" };
export const SJ_LATE_LABEL = { RESI_TERLAMBAT: "Driver belum kirim SJ", KURIR_NYANGKUT: "Resi nyangkut di kurir", TERLAMBAT_KIRIM: "Belum dikirim ke customer" };
export const BILL_LABEL = { TANPA_TAGIHAN: "-", BELUM: "Belum", SEBAGIAN: "Sebagian", MENUNGGU_BAYAR: "Menunggu bayar", LUNAS: "Lunas" };
export const SCHEME_SHORT = { "70_30": "70/30", "50_50": "50/50", FULL: "100%" };
// "DP 70%", "Pelunasan 50%", dst. sesuai skema sisi itu
export const phaseLabel = (phase, scheme) => {
  if (phase === "DP" && scheme) return `DP ${scheme === "50_50" ? 50 : 70}%`;
  if (phase === "SETTLEMENT" && scheme) return `Pelunasan ${scheme === "50_50" ? 50 : 30}%`;
  return PHASE_LABEL[phase] || phase;
};
export const STATE_LABEL = {
  draft: "Draft", posted: "Posted", cancelled: "Dibatalkan", confirmed: "Berjalan", done: "Trip selesai", reversed: "Dibalik",
  PENDING: "Menunggu persetujuan", APPROVED: "Disetujui", REJECTED: "Ditolak", NOT_REQUIRED: "",
};
export const KIND_LABEL = { TRUCKING: "Trucking", CALO: "Calo", TOL: "Tol", PARKIR: "Parkir", BONGKAR: "Bongkar muat", LAINNYA: "Biaya lain", SELISIH: "Selisih", SELLING: "Selling" };
export const SELLING_MODES = { PRICE_BOOK: "Sesuai price book", CUSTOM: "Custom", ZERO: "0 (tanpa selling)" };
export const ROLE_LABEL = { ADMIN: "Admin", FINANCE: "Finance", OPERATIONAL: "Operasional", VIEWER: "Viewer" };

export const state = { user: null, cache: { partners: [], locations: [], banks: [], vehicles: [], partnerBanks: [], pricelist: [], sla: [], settings: {} } };

// ---------------------------------------------------------------- permintaan ke server
// Tiap pindah halaman, permintaan BACA milik halaman lama dibatalkan dan lanjutannya tidak pernah jalan.
// Tanpa ini jawaban yang telat datang (halaman sudah ganti) mengisi elemen yang sudah tidak ada -> "Gagal memuat".
let navCtl = new AbortController();
export function newNavigation() {
  navCtl.abort();
  navCtl = new AbortController();
}
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// garis tipis di atas layar selama masih ada permintaan yang berjalan
let busy = 0;
const setBusy = (d) => { busy += d; document.documentElement.classList.toggle("busy", busy > 0); };
const READ_POST = new Set(["/jobs/query", "/moves/eligible"]);   // POST yang hanya membaca

export async function api(method, url, body) {
  const read = method === "GET" || READ_POST.has(url);
  const signal = read ? navCtl.signal : undefined;
  setBusy(1);
  try {
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`/api${url}`, {
          method, signal, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        if (signal?.aborted) return never();
        // baca data aman diulang sekali (koneksi putus sesaat / server baru bangun); simpan data tidak diulang supaya tidak dobel
        if (read && attempt < 1) { await sleep(700); continue; }
        throw new Error("Tidak bisa menghubungi server. Cek koneksi internet, lalu coba lagi.");
      }
      if (read && attempt < 1 && [502, 503, 504].includes(res.status)) { await sleep(700); continue; }
      break;
    }
    const data = await res.json().catch(() => ({}));
    if (signal?.aborted) return never();
    if (res.status === 401 && url !== "/login" && url !== "/me") {
      state.user = null;
      location.hash = "#/login";
    }
    if (!res.ok) throw new Error(data.error || `Gagal (${res.status})`);
    return data;
  } finally {
    setBusy(-1);
  }
}
export const get = (url) => api("GET", url);

// Muat ulang yang dipicu filter / kotak cari: hanya jawaban permintaan TERAKHIR yang dipakai.
//   const only = latest();   const rows = await only(get(url));
// Pemanggil yang sudah digantikan ikut menunggu jawaban yang TERBARU (bukan menggantung selamanya), jadi modal yang
// menunggu muat ulang tetap bisa menutup.
export function latest() {
  let n = 0;
  let last = null;
  return (promise) => {
    const my = ++n;
    const mine = promise.then((v) => (my === n ? v : last), (e) => (my === n ? Promise.reject(e) : last));
    last = mine;
    return mine;
  };
}

export const can = (...roles) => !!state.user && roles.includes(state.user.role);
export const canFinance = () => can("ADMIN", "FINANCE");
export const canJob = () => can("ADMIN", "FINANCE", "OPERATIONAL");
export const isAdmin = () => can("ADMIN");

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export const rp = (v) => Number(v || 0).toLocaleString("id-ID", { maximumFractionDigits: 2 });
export const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
export const tgl = (v) => (v ? String(v).slice(0, 10) : "");
export const jam = (v) => (v ? new Date(v).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" }) : "");
// nilai untuk <input type="datetime-local"> (waktu Jakarta)
export const dtLocal = (v) => (v ? new Date(new Date(v).getTime() + 7 * 3600000).toISOString().slice(0, 16) : "");
export const fromDtLocal = (v) => (v ? `${v}:00+07:00` : null);
export const num = (v) => String(v ?? "").replace(/\./g, "").replace(",", ".");
export const badge = (s, cls = s) => (STATE_LABEL[s] === "" ? "" : `<span class="badge ${esc(cls)}">${esc(STATE_LABEL[s] || s)}</span>`);
export const kv = (k, v) => `<div><span>${esc(k)}</span><b>${esc(v || "-")}</b></div>`;
// Selisih dilihat dari kas AMICO: + surplus (uang lebih di AMICO), - minus (uang AMICO kurang)
export const signed = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) < 1) return `<span class="muted">0</span>`;
  return `<span class="sign ${n > 0 ? "plus" : "minus"}">${n > 0 ? "+" : "&minus;"}${rp(Math.abs(n))}<small>${n > 0 ? "surplus" : "minus"}</small></span>`;
};
export const tile = (label, value, cls = "", note = "", href = "") =>
  `<${href ? `a href="${href}"` : "div"} class="tile ${cls}"><div class="label">${esc(label)}</div><div class="value">${rp(value)}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</${href ? "a" : "div"}>`;
export const options = (rows, selected, label = (r) => r.name, empty = "") =>
  (empty !== null ? `<option value="">${esc(empty)}</option>` : "") +
  rows.map((r) => `<option value="${r.id}" ${String(r.id) === String(selected ?? "") ? "selected" : ""}>${esc(label(r))}</option>`).join("");
export const enumOptions = (map, selected) =>
  Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${esc(v)}</option>`).join("");
export const customers = () => state.cache.partners.filter((p) => p.is_customer && p.active);
export const vendors = () => state.cache.partners.filter((p) => p.is_vendor && p.active);
export const partnerName = (id) => state.cache.partners.find((p) => p.id === Number(id))?.name || "";
export const locLabel = (l) => `${l.code} - ${l.name}`;
export const bankLabel = (b) => `${b.name} - ${b.account_number}`;
export const partnerBanksOf = (partnerId) => state.cache.partnerBanks.filter((b) => b.partner_id === Number(partnerId) && b.active);

export function toast(msg, error = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `show${error ? " error" : ""}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = ""), 3500);
  window.dispatchEvent(new CustomEvent("amico:toast", { detail: { error } }));
}

export function formData(form) {
  const out = {};
  for (const el of form.querySelectorAll("[name]")) {
    if (el.type === "checkbox") out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

// Modal generik: onSubmit(data, form, tombol) boleh throw -> pesan muncul di modal. Return true = modal tetap terbuka.
export function openModal({ title, body, submitLabel = "Simpan", onSubmit, onOpen, wide = false, extraButtons = "" }) {
  const m = modal(), f = modalForm();
  m.style.width = wide ? "min(1100px, 96vw)" : "";
  f.innerHTML = `
    <h3>${esc(title)}</h3>
    <div class="modal-body">${body}</div>
    <div class="modal-error"></div>
    <div class="modal-foot">
      <button type="button" data-close>Tutup</button>
      ${extraButtons}
      ${onSubmit ? `<button type="submit" class="primary">${esc(submitLabel)}</button>` : ""}
    </div>`;
  f.querySelector("[data-close]").onclick = () => m.close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btns = f.querySelectorAll("button[type=submit]");
    btns.forEach((b) => (b.disabled = true));
    f.querySelector(".modal-error").textContent = "";
    try {
      const keep = await onSubmit(formData(f), f, e.submitter);
      if (keep !== true) m.close();
    } catch (err) {
      f.querySelector(".modal-error").textContent = err.message;
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  };
  if (!m.open) m.showModal();
  onOpen?.(f);
}
export const closeModal = () => { if (modal().open) modal().close(); };

// Tombol aksi: jalankan, tampilkan pesan, muat ulang halaman
export const action = (fn, msg) => async () => {
  try {
    await fn();
    if (msg) toast(msg);
    window.dispatchEvent(new Event("hashchange"));
  } catch (err) {
    toast(err.message, true);
  }
};

// Minta alasan / konfirmasi lalu jalankan
export function askReason(title, note, fn, label = "Lanjut") {
  openModal({
    title, submitLabel: label,
    body: `<label>Alasan<input name="reason" required></label>${note ? `<div class="note-box">${esc(note)}</div>` : ""}`,
    onSubmit: async (d) => { await fn(d.reason); window.dispatchEvent(new Event("hashchange")); },
  });
}

export async function loadMaster() {
  const [partners, locations, banks, vehicles, partnerBanks, pricelist, sla, settings] = await Promise.all(
    ["/partners", "/locations", "/banks", "/vehicles", "/partner-banks", "/pricelist", "/route-sla", "/settings"].map(get));
  Object.assign(state.cache, { partners, locations, banks, vehicles, partnerBanks, pricelist, sla, settings });
}

// Debounce untuk kotak cari
export function debounce(fn, ms = 250) {
  let h;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

// Baris tabel yang bisa diklik (tr[data-href]). Satu pendengar per wadah, bukan per baris.
export function bindRows(root = view()) {
  if (root._rowsBound) return;
  root._rowsBound = true;
  root.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (!tr || !root.contains(tr) || e.target.closest("a,button,input,select,label,[data-noclick]")) return;
    location.hash = tr.dataset.href;
  });
}

// ---------------------------------------------------------------- kerangka saat memuat (skeleton)
export const skelTable = (rows = 8, cols = 6) =>
  `<div class="skel-table" aria-hidden="true">${`<div class="skel-row">${`<span class="skel"></span>`.repeat(cols)}</div>`.repeat(rows)}</div>`;
export const skelTiles = (n = 4) =>
  `<div class="tile" aria-hidden="true"><span class="skel skel-label"></span><span class="skel skel-value"></span></div>`.repeat(n);
// kind: list (judul + kartu + tabel), table (judul + tabel), detail (judul + rincian + tabel)
export function skeleton(kind = "list") {
  const head = `<div class="page-head"><span class="skel skel-title"></span></div>`;
  const body = kind === "detail"
    ? `<div class="panel"><div class="skel-kv">${`<span class="skel"></span>`.repeat(8)}</div></div><div class="panel">${skelTable(5)}</div>`
    : `${kind === "list" ? `<div class="tiles">${skelTiles()}</div>` : ""}<div class="panel">${skelTable(10)}</div>`;
  return `<div class="skel-page" aria-busy="true" aria-label="Memuat">${head}${body}</div>`;
}

// ---------------------------------------------------------------- tabel per halaman
// Tabel panjang digambar per halaman (bawaan 100 baris) supaya browser tidak menggambar ribuan baris sekaligus.
const PAGE_SIZES = [50, 100, 250, 500];
export const pageSize = () => {
  let n = 0;
  try { n = Number(localStorage.getItem("pageSize")); } catch {}
  return PAGE_SIZES.includes(n) ? n : 100;
};
export function pagerHtml(total, page, size) {
  if (total <= PAGE_SIZES[0]) return "";
  const pages = Math.max(1, Math.ceil(total / size));
  const btn = (p, label, title, off) => `<button type="button" class="small" data-pg="${p}" title="${title}" ${off ? "disabled" : ""}>${label}</button>`;
  return `<div class="pager"><span>Baris <b>${rp(page * size + 1)}&ndash;${rp(Math.min(total, (page + 1) * size))}</b> dari ${rp(total)}</span>
    <span class="spacer"></span>
    <label>Per halaman<select data-pg-size>${PAGE_SIZES.map((n) => `<option ${n === size ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    ${btn(0, "&laquo;", "Halaman pertama", page === 0)}${btn(page - 1, "&lsaquo;", "Sebelumnya", page === 0)}
    <span class="pg-now">${rp(page + 1)} / ${rp(pages)}</span>
    ${btn(page + 1, "&rsaquo;", "Berikutnya", page >= pages - 1)}${btn(pages - 1, "&raquo;", "Halaman terakhir", page >= pages - 1)}</div>`;
}
export function bindPager(box, go) {
  box.querySelectorAll("[data-pg]").forEach((b) => (b.onclick = () => {
    go(Number(b.dataset.pg));
    // pindah halaman dari tombol bawah: bawa pandangan ke awal tabel
    const top = box.getBoundingClientRect().top;
    if (top < 70) window.scrollBy(0, top - 80);
  }));
  box.querySelectorAll("[data-pg-size]").forEach((s) => (s.onchange = () => {
    try { localStorage.setItem("pageSize", s.value); } catch {}
    go(0);
  }));
}
// Tabel biasa (tanpa filter kolom) per halaman. row(r, i) -> "<tr>..."; after(box) dipanggil tiap selesai menggambar (pasang tombol di baris).
export function pagedTable(box, { head, rows, row, empty = "Tidak ada data", foot = "", after = null }) {
  let page = 0;
  bindRows(box);
  const draw = () => {
    const size = pageSize();
    page = Math.max(0, Math.min(page, Math.ceil(rows.length / size) - 1));
    const pager = pagerHtml(rows.length, page, size);
    box.innerHTML = pager + table(head, rows.slice(page * size, (page + 1) * size).map((r, i) => row(r, page * size + i)).join(""), empty, foot) + pager;
    bindPager(box, (p) => { page = p; draw(); });
    after?.(box);
  };
  draw();
}

export const table = (head, rows, empty = "Tidak ada data", foot = "") =>
  `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td colspan="40" class="empty">${esc(empty)}</td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}</table></div>`;

// Ikon garis 24x24 (stroke currentColor)
const ICON = {
  dashboard: `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
  jobs: `<path d="M2 7h11v9H2z"/><path d="M13 10h4l3 3v3h-7"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>`,
  tracker: `<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>`,
  rekap: `<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>`,
  ar: `<path d="M4 7h16v12H4z"/><path d="M4 11h16M12 14.5v3M10.5 16h3"/><path d="M8 7V5h8v2"/>`,
  ap: `<path d="M4 7h16v12H4z"/><path d="M4 11h16M10.5 16h3"/><path d="M8 7V5h8v2"/>`,
  "cek-harga": `<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="m11 14 2 2 4-4"/>`,
  invoices: `<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>`,
  requests: `<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>`,
  kas: `<path d="M3 9l9-5 9 5"/><path d="M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 20h18"/>`,
  units: `<path d="M2 7h11v9H2z"/><path d="M13 10h4l3 3v3h-7"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/><path d="M5 4h6"/>`,
  ledger: `<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3"/><path d="M8 7h8"/>`,
  "utang-piutang": `<path d="M7 7h13l-3-3M17 17H4l3 3"/>`,
  sj: `<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="m9 14 2 2 4-4"/>`,
  unassigned: `<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6M12 17h.01"/>`,
  master: `<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>`,
  users: `<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  chevron: `<path d="m6 9 6 6 6-6"/>`,
};
export const icon = (name, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ""}</svg>`;

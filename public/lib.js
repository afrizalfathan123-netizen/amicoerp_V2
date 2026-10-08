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

export async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/login" && url !== "/me") {
    state.user = null;
    location.hash = "#/login";
  }
  if (!res.ok) throw new Error(data.error || `Gagal (${res.status})`);
  return data;
}
export const get = (url) => api("GET", url);

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
  m.showModal();
  onOpen?.(f);
}
export const closeModal = () => modal().close();

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

export function bindRows(root = view()) {
  root.querySelectorAll("tr[data-href]").forEach((tr) => (tr.onclick = (e) => {
    if (e.target.closest("a,button,input")) return;
    location.hash = tr.dataset.href;
  }));
}

export const table = (head, rows, empty = "Tidak ada data", foot = "") =>
  `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td colspan="40" class="empty">${esc(empty)}</td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}</table></div>`;

// Ikon garis 24x24 (stroke currentColor)
const ICON = {
  dashboard: `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
  jobs: `<path d="M2 7h11v9H2z"/><path d="M13 10h4l3 3v3h-7"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>`,
  tracker: `<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>`,
  rekap: `<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>`,
  invoices: `<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>`,
  requests: `<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>`,
  kas: `<path d="M3 9l9-5 9 5"/><path d="M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 20h18"/>`,
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

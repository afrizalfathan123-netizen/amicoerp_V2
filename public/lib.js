// Helper bersama untuk semua halaman.
export const view = () => document.getElementById("view");
const modal = () => document.getElementById("modal");
const modalForm = () => document.getElementById("modalForm");

export const PHASE_LABEL = { DP_70: "DP 70%", SETTLEMENT_30: "Pelunasan 30%", FULL: "Full 100%", OTHER: "Calo / biaya lain" };
export const STATE_LABEL = {
  draft: "Draft", posted: "Posted", cancelled: "Dibatalkan", confirmed: "Berjalan", done: "Selesai", reversed: "Dibalik",
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

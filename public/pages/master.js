// Master data: tabel + form generik per tab.
import { state, api, view, esc, rp, tgl, options, enumOptions, table, toast, openModal, loadMaster, num, locLabel, can, isAdmin } from "../lib.js";

const TRIP = { ONE_WAY: "One way", ROUND_TRIP: "PP" };
const TABS = {
  partners: {
    label: "Partner", api: "partners", write: ["ADMIN", "FINANCE"],
    note: "Customer, vendor, calo dalam satu daftar. Pajak customer: selling setelah pajak = selling - PPh% + PPN% (customer tanpa pajak: 0 dan 0).",
    columns: [["code", "Kode"], ["name", "Nama"], ["is_customer", "Customer", "bool"], ["is_vendor", "Vendor", "bool"], ["pph_pct", "PPh %", "pct"],
      ["ppn_pct", "PPN %", "pct"], ["payment_terms_days", "Tempo (hari)", "number"], ["phone", "HP"], ["email", "Email"], ["address", "Alamat", "wide"],
      ["npwp", "NPWP"], ["bill_to_name", "Nama di invoice"], ["bill_to_address", "Alamat di invoice", "wide"], ["bill_to_npwp", "NPWP di invoice"], ["active", "Aktif", "bool"]],
    list: ["code", "name", "is_customer", "is_vendor", "pph_pct", "ppn_pct", "phone", "active"],
  },
  "partner-banks": {
    label: "Rekening Penerima", api: "partner-banks", write: ["ADMIN", "FINANCE", "OPERATIONAL"],
    note: "Rekening tujuan transfer vendor / calo / driver.",
    columns: [["partner_id", "Partner", "vendor"], ["bank_name", "Bank"], ["account_number", "No rekening"], ["holder", "Atas nama"], ["is_default", "Utama", "bool"], ["active", "Aktif", "bool"]],
  },
  banks: {
    label: "Rekening AMICO", api: "banks", write: ["ADMIN", "FINANCE"],
    note: "Jenis KAS OPERASIONAL = rekening perantara transfer malam (dana dikirim ke sini dulu, lalu disalurkan ke vendor).",
    columns: [["name", "Nama"], ["bank_name", "Bank"], ["account_number", "No rekening"], ["holder", "Atas nama"], ["kind", "Jenis", "bankkind"],
      ["for_tax_invoice", "Untuk invoice pajak", "bool"], ["is_default", "Default", "bool"], ["active", "Aktif", "bool"]],
  },
  locations: { label: "Lokasi", api: "locations", write: ["ADMIN", "FINANCE", "OPERATIONAL"],
    columns: [["code", "Kode"], ["name", "Nama"], ["province", "Provinsi"], ["active", "Aktif", "bool"]] },
  vehicles: { label: "Kendaraan", api: "vehicles", write: ["ADMIN", "FINANCE", "OPERATIONAL"],
    columns: [["plate_number", "Plat"], ["truck_type", "Jenis truk"], ["owner_partner_id", "Pemilik (vendor)", "vendor"], ["pic", "PIC"], ["active", "Aktif", "bool"]] },
  pricelist: {
    label: "Price Book", api: "pricelist", write: ["ADMIN", "FINANCE"],
    note: "Customer kosong = harga umum. Selling / cost boleh diisi salah satu. Tanggal berlaku kosong = selalu berlaku.",
    columns: [["customer_id", "Customer", "customer"], ["pol_id", "POL", "location"], ["pod_id", "POD", "location"], ["truck_type", "Truk"],
      ["trip_type", "Trip", "trip"], ["selling", "Selling", "money"], ["cost", "Cost", "money"], ["effective_from", "Berlaku dari", "date"],
      ["effective_to", "Sampai", "date"], ["active", "Aktif", "bool"]],
  },
  "route-sla": { label: "SLA Rute", api: "route-sla", write: ["ADMIN", "FINANCE", "OPERATIONAL"], note: "Batas jam perjalanan gate out sampai gate in, dipakai di Tracker.",
    columns: [["pol_id", "POL", "location"], ["pod_id", "POD", "location"], ["trip_type", "Trip", "trip"], ["sla_hours", "SLA (jam)", "number"]] },
};

function cell(type, v) {
  if (type === "bool") return v ? "Ya" : "-";
  if (type === "money") return v == null ? "-" : rp(v);
  if (type === "customer") return esc(state.cache.partners.find((p) => p.id === v)?.name || "Umum");
  if (type === "vendor") return esc(state.cache.partners.find((p) => p.id === v)?.name || "-");
  if (type === "location") return esc(state.cache.locations.find((l) => l.id === v)?.code || "");
  if (type === "trip") return TRIP[v] || "";
  if (type === "bankkind") return v === "OPERATIONAL" ? "Kas operasional" : "Bank";
  if (type === "date") return tgl(v);
  return esc(v ?? "");
}

function input(type, name, v, isNew) {
  const p = state.cache.partners;
  if (type === "bool") return `<input type="checkbox" name="${name}" ${v || (v === undefined && isNew && name === "active") ? "checked" : ""}>`;
  if (type === "customer") return `<select name="${name}">${options(p.filter((x) => x.is_customer), v, undefined, "Umum (semua customer)")}</select>`;
  if (type === "vendor") return `<select name="${name}" ${name === "partner_id" ? "required" : ""}>${options(p.filter((x) => x.is_vendor || name === "partner_id"), v, undefined, "- pilih -")}</select>`;
  if (type === "location") return `<select name="${name}" required>${options(state.cache.locations, v, locLabel, "- pilih -")}</select>`;
  if (type === "trip") return `<select name="${name}">${enumOptions({ ONE_WAY: "One way", ROUND_TRIP: "PP / round trip" }, v)}</select>`;
  if (type === "bankkind") return `<select name="${name}">${enumOptions({ BANK: "Bank", OPERATIONAL: "Kas operasional" }, v || "BANK")}</select>`;
  if (type === "date") return `<input type="date" name="${name}" value="${tgl(v)}">`;
  if (type === "number" || type === "pct") return `<input type="number" step="${type === "pct" ? "0.01" : "1"}" name="${name}" value="${esc(v ?? (type === "pct" ? 0 : ""))}">`;
  return `<input name="${name}" value="${esc(v ?? "")}" ${type === "money" ? 'class="num"' : ""}>`;
}

export async function renderMaster(tab) {
  if (tab === "settings") return renderSettings();
  const cfg = TABS[tab] || TABS.partners;
  await loadMaster();
  const rows = state.cache[{ partners: "partners", "partner-banks": "partnerBanks", banks: "banks", locations: "locations", vehicles: "vehicles", pricelist: "pricelist", "route-sla": "sla" }[cfg.api]];
  const writable = can(...cfg.write);
  const listCols = (cfg.list || cfg.columns.map((c) => c[0])).map((k) => cfg.columns.find((c) => c[0] === k));
  view().innerHTML = `
    <div class="page-head"><h1>Master Data</h1><div class="spacer"></div>
      <div class="actions">${writable ? `<button class="primary" id="addMaster">+ Tambah ${esc(cfg.label)}</button>` : ""}</div></div>
    <div class="tabs">${Object.entries(TABS).map(([k, t]) => `<a href="#/master/${k}" class="${k === tab ? "active" : ""}">${esc(t.label)}</a>`).join("")}
      ${isAdmin() ? `<a href="#/master/settings">Perusahaan</a>` : ""}</div>
    ${cfg.note ? `<div class="note-box">${esc(cfg.note)}</div>` : ""}
    <div class="panel">${table(listCols.map(([, h, t]) => `<th class="${t === "money" ? "num" : ""}">${esc(h)}</th>`).join(""),
      rows.map((r) => `<tr class="${writable ? "click" : ""}" data-id="${r.id}">${listCols.map(([k, , t]) => `<td class="${t === "money" ? "num" : ""}">${cell(t, r[k])}</td>`).join("")}</tr>`).join(""), "Kosong")}</div>`;
  if (!writable) return;
  const edit = (row) => openModal({
    title: `${row ? "Ubah" : "Tambah"} ${cfg.label}`,
    wide: cfg.columns.length > 8,
    body: `<div class="form-grid">${cfg.columns.map(([k, h, t]) => t === "bool"
      ? `<label class="check">${input(t, k, row?.[k], !row)} ${esc(h)}</label>`
      : `<label class="${t === "wide" ? "wide" : ""}">${esc(h)}${input(t, k, row?.[k], !row)}</label>`).join("")}</div>`,
    onSubmit: async (d) => {
      for (const [k, , t] of cfg.columns) if (t === "money") d[k] = d[k] === "" ? null : num(d[k]);
      if (row) await api("PUT", `/${cfg.api}/${row.id}`, d);
      else await api("POST", `/${cfg.api}`, d);
      toast("Tersimpan");
      window.dispatchEvent(new Event("hashchange"));
    },
  });
  document.getElementById("addMaster").onclick = () => edit(null);
  view().querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => edit(rows.find((r) => String(r.id) === tr.dataset.id))));
}

async function renderSettings() {
  const s = state.cache.settings;
  view().innerHTML = `
    <div class="page-head"><h1>Master Data</h1></div>
    <div class="tabs">${Object.entries(TABS).map(([k, t]) => `<a href="#/master/${k}">${esc(t.label)}</a>`).join("")}<a href="#/master/settings" class="active">Perusahaan</a></div>
    <form class="panel" id="setForm"><div class="form-grid">
      <label>Nama perusahaan<input name="company_name" value="${esc(s.company_name || "")}"></label>
      <label>NPWP<input name="company_npwp" value="${esc(s.company_npwp || "")}"></label>
      <label class="wide">Alamat<textarea name="company_address" rows="2">${esc(s.company_address || "")}</textarea></label>
      <label class="check"><input type="checkbox" name="vendor_approval_required" ${s.vendor_approval_required !== false ? "checked" : ""}> Pengajuan vendor perlu persetujuan ADMIN</label>
    </div><div class="modal-foot"><button class="primary" type="submit">Simpan</button></div></form>`;
  document.getElementById("setForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api("PUT", "/settings", { company_name: f.company_name.value, company_npwp: f.company_npwp.value, company_address: f.company_address.value,
        vendor_approval_required: f.vendor_approval_required.checked });
      await loadMaster();
      toast("Pengaturan disimpan");
    } catch (err) { toast(err.message, true); }
  };
}

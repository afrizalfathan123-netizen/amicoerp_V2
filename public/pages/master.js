// Master data: tabel + form generik per tab.
import { state, api, view, esc, rp, tgl, options, enumOptions, table, toast, openModal, loadMaster, num, locLabel, can, isAdmin, SCHEME_SHORT } from "../lib.js";

const TRIP = { ONE_WAY: "One way", ROUND_TRIP: "PP" };
const TABS = {
  partners: {
    label: "Partner", api: "partners", write: ["ADMIN", "FINANCE"],
    note: "Customer, vendor, calo dalam satu daftar. Pajak customer: selling setelah pajak = selling - PPh% + PPN% (customer tanpa pajak: 0 dan 0). " +
      "Skema bayar default dipakai saat job baru dibuat (kosong = dalam kota 100%, antar kota 70/30; vendor hanya 70/30 atau 100%).",
    columns: [["code", "Kode"], ["name", "Nama"], ["is_customer", "Customer", "bool"], ["is_vendor", "Vendor", "bool"], ["pph_pct", "PPh %", "pct"],
      ["ppn_pct", "PPN %", "pct"], ["payment_scheme", "Skema bayar default", "scheme"], ["sj_tracking", "Lacak SJ (SJ fisik dikirim balik lewat kurir)", "bool"], ["payment_terms_days", "Tempo (hari)", "number"], ["phone", "HP"], ["email", "Email"], ["address", "Alamat", "wide"],
      ["npwp", "NPWP"], ["attn", "ATTN (kontak di invoice)"], ["bill_to_name", "Nama di invoice"], ["bill_to_address", "Alamat di invoice", "wide"], ["bill_to_npwp", "NPWP di invoice"], ["active", "Aktif", "bool"]],
    list: ["code", "name", "is_customer", "is_vendor", "pph_pct", "ppn_pct", "payment_scheme", "phone", "active"],
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
  if (type === "scheme") return v ? SCHEME_SHORT[v] : "-";
  if (type === "date") return tgl(v);
  return esc(v ?? "");
}

function input(type, name, v, isNew) {
  const p = state.cache.partners;
  if (type === "bool") return `<input type="checkbox" name="${name}" ${v || (v === undefined && isNew && ["active", "sj_tracking"].includes(name)) ? "checked" : ""}>`;
  if (type === "customer") return `<select name="${name}">${options(p.filter((x) => x.is_customer), v, undefined, "Umum (semua customer)")}</select>`;
  if (type === "vendor") return `<select name="${name}" ${name === "partner_id" ? "required" : ""}>${options(p.filter((x) => x.is_vendor || name === "partner_id"), v, undefined, "- pilih -")}</select>`;
  if (type === "location") return `<select name="${name}" required>${options(state.cache.locations, v, locLabel, "- pilih -")}</select>`;
  if (type === "trip") return `<select name="${name}">${enumOptions({ ONE_WAY: "One way", ROUND_TRIP: "PP / round trip" }, v)}</select>`;
  if (type === "bankkind") return `<select name="${name}">${enumOptions({ BANK: "Bank", OPERATIONAL: "Kas operasional" }, v || "BANK")}</select>`;
  if (type === "date") return `<input type="date" name="${name}" value="${tgl(v)}">`;
  if (type === "scheme") return `<select name="${name}"><option value="">Ikut lingkup job</option>${enumOptions({ "70_30": "DP 70% + pelunasan 30%", "50_50": "DP 50% + pelunasan 50% (customer)", FULL: "Langsung 100%" }, v)}</select>`;
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
      if (cfg.api === "pricelist") {
        // job yang sudah telanjur dibuat tidak berubah sendiri: tunjukkan berapa yang sekarang beda
        const beda = await api("GET", "/price-check").catch(() => []);
        if (beda.length) toast(`Tersimpan. ${beda.length} job selling-nya beda dari price book, buka menu Cek Harga Jual untuk menyamakan.`);
      }
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
      <label class="wide">Alamat (boleh 2 baris, tampil di kop invoice)<textarea name="company_address" rows="2">${esc(s.company_address || "")}</textarea></label>
      <label>Tagline di kop invoice<input name="company_tagline" value="${esc(s.company_tagline ?? "Freight Forwarding & Logistics")}"></label>
      <label>Nama penanda tangan invoice<input name="invoice_signer" value="${esc(s.invoice_signer || "")}" placeholder="mis. ARIF WIROYUDHO"></label>
      <div class="wide sig-box"><span>Tanda tangan di invoice (opsional, gambar PNG / JPG)</span>
        <div id="sigPreview">${s.invoice_signature ? `<img src="${esc(s.invoice_signature)}" alt="tanda tangan">` : `<span class="muted">Belum ada. Tanpa gambar, invoice dicetak dengan ruang kosong untuk tanda tangan basah.</span>`}</div>
        <input type="file" id="sigFile" accept="image/png,image/jpeg"> ${s.invoice_signature ? `<button type="button" class="small danger" id="sigDel">Hapus tanda tangan</button>` : ""}</div>
      <label class="check"><input type="checkbox" name="vendor_approval_required" ${s.vendor_approval_required !== false ? "checked" : ""}> Pengajuan vendor perlu persetujuan FINANCE</label>
      <label class="check wide"><input type="checkbox" name="require_gate_for_billing" ${s.require_gate_for_billing !== false ? "checked" : ""}> Invoice customer dan pelunasan / full vendor wajib kode tugas + jam gate out (job rencana hanya boleh DP / calo vendor)</label>
      <label>Target resi SJ dari driver (hari setelah gate in)<input type="number" min="0" name="sj_target_resi_days" value="${esc(s.sj_target_resi_days ?? 2)}"></label>
      <label>Target SJ di kurir (hari)<input type="number" min="0" name="sj_target_kurir_days" value="${esc(s.sj_target_kurir_days ?? 4)}"></label>
      <label>Target kirim SJ ke customer (hari setelah diterima)<input type="number" min="0" name="sj_target_kirim_days" value="${esc(s.sj_target_kirim_days ?? 3)}"></label>
    </div><div class="modal-foot"><button class="primary" type="submit">Simpan</button></div></form>`;
  // tanda tangan: dibaca jadi data URL, disimpan bersama pengaturan lain saat klik Simpan
  let signature;   // undefined = tidak diubah, "" = dihapus
  document.getElementById("sigFile").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 500000) { e.target.value = ""; return toast("Gambar terlalu besar, maksimal 500 KB", true); }
    const rd = new FileReader();
    rd.onload = () => { signature = rd.result; document.getElementById("sigPreview").innerHTML = `<img src="${signature}" alt="tanda tangan">`; };
    rd.readAsDataURL(file);
  };
  document.getElementById("sigDel")?.addEventListener("click", () => {
    signature = "";
    document.getElementById("sigPreview").innerHTML = `<span class="muted">Akan dihapus saat disimpan.</span>`;
  });
  document.getElementById("setForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api("PUT", "/settings", { company_name: f.company_name.value, company_npwp: f.company_npwp.value, company_address: f.company_address.value,
        company_tagline: f.company_tagline.value, invoice_signer: f.invoice_signer.value, ...(signature !== undefined ? { invoice_signature: signature } : {}),
        vendor_approval_required: f.vendor_approval_required.checked, require_gate_for_billing: f.require_gate_for_billing.checked,
        sj_target_resi_days: Number(f.sj_target_resi_days.value), sj_target_kurir_days: Number(f.sj_target_kurir_days.value),
        sj_target_kirim_days: Number(f.sj_target_kirim_days.value) });
      await loadMaster();
      toast("Pengaturan disimpan");
    } catch (err) { toast(err.message, true); }
  };
}

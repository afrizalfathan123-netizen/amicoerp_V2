// Buat banyak job sekaligus dari absen WhatsApp (judul = tujuan, lalu RIT 1, RIT 2, ... dengan tanggal, nopol, driver, kode tugas).
// Alur: tempel -> tabel pratinjau (bisa dikoreksi) -> server mengecek tiap baris -> "Buat N job" (semua atau tidak sama sekali).
// Rit yang sudah pernah dibuat (customer + tujuan + tanggal + rit sama) ditandai "sudah ada" dan tidak ikut dibuat.
import {
  state, api, esc, rp, options, enumOptions, toast, openModal, customers, vendors, partnerBanksOf, locLabel, num, debounce, SELLING_MODES,
} from "../lib.js";
import { parseWaBatch, normPlate } from "../wa-paste.js";

const SCOPE = { INNERCITY: "Dalam kota", INTERCITY: "Antar kota" };
const TRIP = { ONE_WAY: "One way", ROUND_TRIP: "PP / round trip" };
const KEY = "jobBatchDefaults";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* boleh gagal */ } };

// isian "berlaku untuk semua baris"
const readDefaults = (E) => ({
  customer_id: E.customer_id.value, pol_id: E.pol_id.value, delivery_scope: E.delivery_scope.value, trip_type: E.trip_type.value,
  truck_type: E.truck_type.value.trim().toUpperCase(), selling_mode: E.selling_mode.value, selling: num(E.selling.value), cost: num(E.cost.value),
});
// isi job yang dikirim ke server (sama dengan form Job baru); rekening vendor = rekening utama pemilik kendaraan
const toJob = (r, d) => ({
  job_date: r.job_date, customer_id: d.customer_id, pol_id: d.pol_id, pod_id: r.pod_id, trip_type: d.trip_type,
  delivery_scope: d.delivery_scope, rit_number: r.rit_number || null, truck_type: r.truck_type || d.truck_type,
  plate_number: r.plate_number, vendor_id: r.vendor_id || null,
  vendor_bank_id: r.vendor_id ? partnerBanksOf(r.vendor_id).find((b) => b.is_default)?.id || null : null,
  driver1_name: r.driver1_name, driver1_phone: r.driver1_phone, driver2_name: r.driver2_name, driver2_phone: r.driver2_phone,
  do_number: r.do_number, selling_mode: d.selling_mode, selling: d.selling_mode === "CUSTOM" ? d.selling : "", cost: d.cost || "",
});

export function batchJobForm() {
  const c = state.cache;
  const d0 = load();
  const locs = c.locations.filter((l) => l.active);
  let rows = [];          // baris pratinjau: hasil baca absen + koreksi di tabel + { use, check }
  let seq = 0;            // cek terakhir saja yang dipakai (ketikan cepat)
  openModal({
    title: "Buat banyak job dari absen",
    wide: true,
    submitLabel: "Buat job",
    body: `
      <div class="wa-paste">
        <div class="wa-head"><b>Tempel absen WhatsApp</b>
          <span class="muted">Judul = tujuan (mis. KAMAL), lalu RIT 1, RIT 2, ... masing-masing dengan Tanggal, Nopol, Nama, No Hp, Kode Tugas.
            Beberapa tujuan dalam satu tempelan boleh. Kode tugas boleh kosong, diisi nanti.</span></div>
        <textarea id="bText" rows="6" placeholder="KAMAL&#10;RIT 1 :&#10;・Tanggal : 16/10/2026&#10;・Nopol : B 9130 FXV&#10;・Nama : DENY&#10;・No Hp : 0852xxxxxxxx&#10;・Kode Tugas :"></textarea>
        <div class="wa-foot"><button type="button" class="small" id="bRead">Baca absen</button><span id="bReadInfo"></span></div>
      </div>
      <h4>Berlaku untuk semua baris</h4>
      <div class="form-grid">
        <label>Customer<select name="customer_id">${options(customers(), d0.customer_id, undefined, "- pilih -")}</select></label>
        <label>Asal muat (POL)<select name="pol_id">${options(locs, d0.pol_id, locLabel, "- pilih -")}</select></label>
        <label>Lingkup<select name="delivery_scope">${enumOptions(SCOPE, d0.delivery_scope || "INNERCITY")}</select></label>
        <label>Trip<select name="trip_type">${enumOptions(TRIP, d0.trip_type || "ONE_WAY")}</select></label>
        <label>Jenis truk (nopol tidak dikenal)<input name="truck_type" list="bTrucks" value="${esc(d0.truck_type || "CDDL")}"></label>
        <label>Selling<select name="selling_mode">${enumOptions(SELLING_MODES, d0.selling_mode || "PRICE_BOOK")}</select></label>
        <label>Nominal selling (custom)<input class="num" name="selling"></label>
        <label>Cost truk per job<input class="num" name="cost" placeholder="Kosong = dari price book"></label>
      </div>
      <datalist id="bTrucks">${[...new Set(c.pricelist.map((p) => p.truck_type).concat(c.vehicles.map((v) => v.truck_type)))].map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      <datalist id="bPlates">${c.vehicles.filter((v) => v.active).map((v) => `<option value="${esc(v.plate_number)}">${esc(v.truck_type)}</option>`).join("")}</datalist>
      <div id="bSummary"></div>
      <div id="bTable"></div>`,
    onOpen: (form) => {
      const E = form.elements;
      const submit = form.querySelector("button[type=submit]");
      const $ = (sel) => form.querySelector(sel);
      const vendorName = (id) => vendors().find((v) => v.id === Number(id))?.name || "";
      const defaults = () => readDefaults(E);
      const used = () => rows.filter((r) => r.use);

      const status = (r) => {
        if (!r.check) return `<span class="muted">mengecek...</span>`;
        const x = r.check;
        if (x.existing) return `<span class="warn-text">Sudah ada: <a href="#/jobs/${x.existing.id}" target="_blank">${esc(x.existing.job_number)}</a>${x.existing.plate_number ? ` (${esc(x.existing.plate_number)})` : ""}</span>`;
        if (x.problems.length) return x.problems.map((p) => `<div class="warn-text">${esc(p)}</div>`).join("");
        return `<span class="ok-text">Siap</span>`;
      };
      const price = (r) => (r.check && r.check.selling != null ? `${rp(r.check.selling)}<br><span class="muted">cost ${rp(r.check.cost)}</span>` : "-");
      const unitNote = (r) => `${esc(r.truck_type || defaults().truck_type || "-")}<br><span class="muted">${r.vendor_id ? esc(vendorName(r.vendor_id)) : r.plate_number && !r.known_plate ? "nopol baru, vendor kosong" : "vendor kosong"}</span>`;
      const input = (i, k, v, attrs = "") => `<input data-i="${i}" data-k="${k}" value="${esc(v ?? "")}" ${attrs}>`;

      const summary = () => {
        const n = used().length;
        const ready = used().filter((r) => r.check && !r.check.problems.length).length;
        const exist = rows.filter((r) => r.check?.existing).length;
        const bad = used().filter((r) => r.check?.problems.length).length;
        submit.textContent = n ? `Buat ${n} job` : "Buat job";
        submit.disabled = !n || bad > 0 || ready < n;
        $("#bSummary").innerHTML = rows.length ? `<div class="note-box ${bad ? "warn-box" : ""}">
          ${rows.length} rit terbaca: <b>${ready} siap dibuat</b>${exist ? `, ${exist} sudah pernah dibuat (tidak ikut)` : ""}${bad ? `, <b>${bad} perlu dibetulkan</b> (atau hilangkan centangnya)` : ""}.
          Satu rit (customer + tujuan + tanggal + rit) hanya untuk satu job.</div>` : "";
      };
      const paintRow = (i) => {
        const tr = $(`#bTable tr[data-row="${i}"]`);
        if (!tr) return;
        const r = rows[i];
        tr.querySelector(".b-st").innerHTML = status(r);
        tr.querySelector(".b-price").innerHTML = price(r);
        tr.querySelector(".b-unit").innerHTML = unitNote(r);
        tr.querySelector("[data-k=use]").checked = r.use;
        tr.classList.toggle("muted-row", !r.use);
      };
      const render = () => {
        if (!rows.length) { $("#bTable").innerHTML = ""; summary(); return; }
        $("#bTable").innerHTML = `<div class="table-wrap"><table class="batch-table">
          <thead><tr><th></th><th>Rit</th><th>Tanggal</th><th>Tujuan</th><th>Nopol</th><th>Driver</th><th>No HP</th><th>Kode tugas</th><th>Truk / vendor</th><th class="num">Selling</th><th>Cek</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr data-row="${i}">
            <td><input type="checkbox" data-i="${i}" data-k="use" ${r.use ? "checked" : ""}></td>
            <td>${input(i, "rit_number", r.rit_number, 'type="number" min="1" class="b-rit"')}</td>
            <td>${input(i, "job_date", r.job_date, 'type="date"')}</td>
            <td><select data-i="${i}" data-k="pod_id">${options(locs, r.pod_id, locLabel, r.pod_text ? `- ${r.pod_text}? pilih -` : "- pilih -")}</select></td>
            <td>${input(i, "plate_number", r.plate_number, 'list="bPlates" class="b-plate"')}</td>
            <td>${input(i, "driver1_name", r.driver1_name)}</td>
            <td>${input(i, "driver1_phone", r.driver1_phone)}</td>
            <td>${input(i, "do_number", r.do_number, 'placeholder="boleh kosong"')}</td>
            <td class="b-unit"></td><td class="num b-price"></td><td class="b-st"></td></tr>`).join("")}</tbody></table></div>`;
        rows.forEach((_, i) => paintRow(i));
        summary();
      };

      // server mengecek semua baris yang dicentang (+ yang sudah ada, supaya tandanya tetap tampil)
      const check = async ({ first = false } = {}) => {
        if (!rows.length) return;
        const my = ++seq;
        const d = defaults();
        const list = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.use || r.check?.existing);
        for (const { i } of list) { rows[i].check = null; paintRow(i); }
        summary();
        try {
          const res = await api("POST", "/jobs/batch/check", { jobs: list.map(({ r }) => toJob(r, d)) });
          if (my !== seq) return;
          res.forEach((x, n) => {
            const i = list[n].i;
            rows[i].check = x;
            // pertama dibaca: rit yang sudah pernah dibuat langsung tidak dicentang
            if (first && x.existing) rows[i].use = false;
          });
        } catch (err) {
          if (my !== seq) return;
          $("#bSummary").innerHTML = `<div class="note-box warn-box">${esc(err.message)}</div>`;
          return;
        }
        rows.forEach((_, i) => paintRow(i));
        summary();
      };
      const recheck = debounce(() => check(), 350);

      const read = () => {
        const r = parseWaBatch($("#bText").value, { locations: c.locations, vehicles: c.vehicles, customers: customers() });
        if (r.customer_id && !E.customer_id.value) E.customer_id.value = r.customer_id;
        rows = r.rows.map((x) => ({ ...x, use: true, check: null }));
        const info = $("#bReadInfo");
        info.innerHTML = !$("#bText").value.trim() ? "" : !rows.length
          ? `<span class="warn-text">Belum ada RIT yang terbaca. Formatnya: judul tujuan, lalu "RIT 1 :" dan baris "Label : isi".</span>`
          : `<span class="ok-text">${rows.length} rit terbaca.</span>${r.warn.map((w) => `<div class="warn-text">${esc(w)}</div>`).join("")}`;
        render();
        check({ first: true });
      };
      $("#bRead").onclick = read;
      $("#bText").addEventListener("paste", () => setTimeout(read, 0));

      // koreksi di tabel
      $("#bTable").addEventListener("input", (e) => {
        const el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
        if (!k || Number.isNaN(i)) return;
        const r = rows[i];
        if (k === "use") r.use = el.checked;
        else if (k === "rit_number") r.rit_number = Number(el.value) || null;
        else r[k] = el.value;
        if (k === "plate_number") {
          // nopol dari Master Kendaraan: jenis truk & vendor ikut
          const v = c.vehicles.find((x) => x.plate_number === normPlate(el.value));
          r.known_plate = !!v;
          r.truck_type = v?.truck_type || "";
          r.vendor_id = v?.owner_partner_id || "";
          paintRow(i);
        }
        if (k === "use") { paintRow(i); summary(); }
        recheck();
      });
      $("#bTable").addEventListener("change", (e) => {
        if (e.target.dataset.k === "plate_number") e.target.value = rows[Number(e.target.dataset.i)].plate_number = normPlate(e.target.value);
      });
      for (const n of ["customer_id", "pol_id", "delivery_scope", "trip_type", "truck_type", "selling_mode", "selling", "cost"]) {
        E[n].addEventListener("change", () => check());
      }
      summary();
    },
    onSubmit: async (_, form) => {
      const d = readDefaults(form.elements);
      const pick = rows.filter((r) => r.use);
      if (!pick.length) throw new Error("Belum ada baris yang dicentang");
      const res = await api("POST", "/jobs/batch", { jobs: pick.map((r) => toJob(r, d)) });
      save({ customer_id: d.customer_id, pol_id: d.pol_id, delivery_scope: d.delivery_scope, trip_type: d.trip_type, truck_type: d.truck_type, selling_mode: d.selling_mode });
      toast(`${res.created.length} job dibuat: ${res.created.map((x) => x.job_number).join(", ")}`);
      window.dispatchEvent(new Event("hashchange"));
    },
  });
}

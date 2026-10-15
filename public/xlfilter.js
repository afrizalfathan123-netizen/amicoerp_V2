// Tabel dengan filter & urut per kolom ala Excel: klik ▾ di header -> urutkan, cari, centang nilai yang ditampilkan.
// Dipakai di sisi browser untuk baris yang sudah dimuat. Status filter disimpan per tabel di sessionStorage.
// Filter, urut, centang, dan export berlaku untuk SEMUA baris; yang digambar ke layar hanya satu halaman (paling banyak 50 baris)
// supaya tabel ribuan baris tetap ringan.
//
//   const t = xlTable(box, { id: "jobs", columns, rowHtml, empty, order });
//   t.setRows(rows);      t.visible();   // baris yang sedang tampil (setelah filter & urut)
// columns: [{ key, label, num?: true, value: (r) => nilai untuk filter / urut, text?: (r) => label di daftar filter }]
// order (opsional): fungsi pembanding bawaan kalau belum ada kolom yang diurutkan.
// rowId (opsional): baris bisa dicentang; rowHtml(r, selCell) menaruh selCell (<td> kotak centang) di awal baris.
import { esc, rp, table, pageSize, pagerHtml, bindPager } from "./lib.js";

const BLANK = "(Kosong)";
const MAX_LIST = 1000;

export function xlTable(box, { id, columns, rowHtml, empty = "Tidak ada data", order = null, onChange = null, rowId = null, onSelect = null }) {
  const picked = new Set();
  const storeKey = `xl:${id}`;
  let st = { filters: {}, sort: null };
  try { st = { ...st, ...JSON.parse(sessionStorage.getItem(storeKey) || "{}") }; } catch {}
  let rows = [];
  let page = 0;
  let first = true;
  const col = (k) => columns.find((c) => c.key === k);
  const textOf = (c, r) => {
    const v = c.text ? c.text(r) : c.value(r);
    return v === null || v === undefined || v === "" ? BLANK : c.num && !c.text ? rp(v) : String(v);
  };
  const save = () => { try { sessionStorage.setItem(storeKey, JSON.stringify(st)); } catch {} };
  const pass = (r, skip) => Object.entries(st.filters).every(([k, vals]) => {
    if (k === skip || !col(k)) return true;
    return vals.includes(textOf(col(k), r));
  });
  const visible = () => {
    const out = rows.filter((r) => pass(r));
    const c = st.sort && col(st.sort.key);
    if (c) {
      const dir = st.sort.dir === "desc" ? -1 : 1;
      const v = (r) => c.value(r);
      out.sort((a, b) => {
        const x = v(a), y = v(b);
        if (x === y) return 0;
        if (x === null || x === undefined || x === "") return 1;
        if (y === null || y === undefined || y === "") return -1;
        return (c.num ? Number(x) - Number(y) : String(x).localeCompare(String(y), "id", { numeric: true })) * dir;
      });
    } else if (order) out.sort(order);
    return out;
  };

  function render() {
    const vis = visible();
    const size = pageSize();
    page = Math.max(0, Math.min(page, Math.ceil(vis.length / size) - 1));
    if (st.page !== page) { st.page = page; save(); }
    const part = vis.slice(page * size, (page + 1) * size);
    const pager = pagerHtml(vis.length, page, size);
    const active = Object.keys(st.filters).length || st.sort;
    const head = columns.map((c) => {
      const on = st.filters[c.key] || st.sort?.key === c.key;
      const arrow = st.sort?.key === c.key ? (st.sort.dir === "desc" ? "↓" : "↑") : "▾";
      return `<th class="${c.num ? "num" : ""}"><span class="xl-th">${esc(c.label)}<button type="button" class="xl-btn ${on ? "on" : ""}" data-xl="${c.key}" title="Filter / urutkan">${arrow}</button></span></th>`;
    }).join("");
    const selHead = rowId ? `<th class="xl-sel"><input type="checkbox" data-xl-all title="Centang semua ${rp(vis.length)} baris hasil filter (semua halaman)" ${vis.length && vis.every((r) => picked.has(rowId(r))) ? "checked" : ""}></th>` : "";
    const selCell = (r) => (rowId ? `<td class="xl-sel"><input type="checkbox" data-xl-pick="${esc(rowId(r))}" ${picked.has(rowId(r)) ? "checked" : ""}></td>` : "");
    box.innerHTML = `<div class="xl-info"><span>${vis.length === rows.length ? `${rp(rows.length)} baris` : `<b>${rp(vis.length)}</b> dari ${rp(rows.length)} baris`}</span>
        ${active ? `<button type="button" class="small" data-xl-clear>Hapus filter kolom</button>` : ""}${pager || `<span class="spacer"></span>`}</div>
      ${table(selHead + head, part.map((r) => rowHtml(r, selCell(r))).join(""), empty)}${pager}`;
    bindPager(box, (p) => { page = p; render(); });
    box.querySelectorAll("[data-xl-pick]").forEach((c) => (c.onchange = () => {
      const r = rows.find((x) => String(rowId(x)) === c.dataset.xlPick);
      c.checked ? picked.add(rowId(r)) : picked.delete(rowId(r));
      onSelect?.(selected());
    }));
    box.querySelector("[data-xl-all]")?.addEventListener("change", (e) => {
      for (const r of vis) e.target.checked ? picked.add(rowId(r)) : picked.delete(rowId(r));
      box.querySelectorAll("[data-xl-pick]").forEach((c) => (c.checked = e.target.checked));
      onSelect?.(selected());
    });
    box.querySelectorAll("[data-xl]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openPop(b, col(b.dataset.xl)); }));
    box.querySelector("[data-xl-clear]")?.addEventListener("click", () => { st = { filters: {}, sort: null }; page = 0; save(); render(); });
    onChange?.(vis);
  }

  function openPop(btn, c) {
    closePop();
    // nilai dari baris yang lolos filter kolom LAIN (seperti Excel)
    const counts = new Map();
    for (const r of rows) if (pass(r, c.key)) { const t = textOf(c, r); counts.set(t, (counts.get(t) || 0) + 1); }
    const sortVal = new Map(rows.map((r) => [textOf(c, r), c.value(r)]));
    const values = [...counts.keys()].sort((a, b) => {
      if (a === BLANK) return 1;
      if (b === BLANK) return -1;
      const x = sortVal.get(a), y = sortVal.get(b);
      return c.num ? Number(x) - Number(y) : String(x).localeCompare(String(y), "id", { numeric: true });
    });
    const chosen = new Set(st.filters[c.key] || values);
    const pop = document.createElement("div");
    pop.className = "xl-pop";
    pop.innerHTML = `
      <button type="button" data-sort="asc">${c.num ? "Urutkan terkecil → terbesar" : "Urutkan A → Z"}</button>
      <button type="button" data-sort="desc">${c.num ? "Urutkan terbesar → terkecil" : "Urutkan Z → A"}</button>
      <hr>
      <input type="search" placeholder="Cari" data-q>
      <label class="xl-all"><input type="checkbox" data-allv> (Pilih semua)</label>
      <div class="xl-list"></div>
      <div class="xl-foot"><button type="button" data-clear>Hapus filter</button><span class="spacer"></span>
        <button type="button" data-cancel>Batal</button><button type="button" class="primary" data-ok>OK</button></div>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + window.scrollY + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left + window.scrollX - 10, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8))}px`;
    const list = pop.querySelector(".xl-list"), q = pop.querySelector("[data-q]"), all = pop.querySelector("[data-allv]");
    const shown = () => values.filter((v) => v.toLowerCase().includes(q.value.trim().toLowerCase()));
    const draw = () => {
      const s = shown();
      list.innerHTML = s.slice(0, MAX_LIST).map((v) => `<label><input type="checkbox" value="${esc(v)}" ${chosen.has(v) ? "checked" : ""}> <span>${esc(v)}</span><small>${rp(counts.get(v))}</small></label>`).join("")
        + (s.length > MAX_LIST ? `<div class="muted">${rp(s.length - MAX_LIST)} nilai lain, persempit dengan cari</div>` : "") + (s.length ? "" : `<div class="muted">Tidak ada</div>`);
      all.checked = s.length > 0 && s.every((v) => chosen.has(v));
      list.querySelectorAll("input").forEach((i) => (i.onchange = () => { i.checked ? chosen.add(i.value) : chosen.delete(i.value); all.checked = shown().every((v) => chosen.has(v)); }));
    };
    // mengetik di cari = seperti Excel: yang dicentang hanya hasil cari
    q.oninput = () => { chosen.clear(); if (q.value.trim()) shown().forEach((v) => chosen.add(v)); else values.forEach((v) => chosen.add(v)); draw(); };
    all.onchange = () => { shown().forEach((v) => (all.checked ? chosen.add(v) : chosen.delete(v))); draw(); };
    pop.querySelectorAll("[data-sort]").forEach((b) => (b.onclick = () => { st.sort = { key: c.key, dir: b.dataset.sort }; page = 0; save(); closePop(); render(); }));
    pop.querySelector("[data-clear]").onclick = () => { delete st.filters[c.key]; if (st.sort?.key === c.key) st.sort = null; page = 0; save(); closePop(); render(); };
    pop.querySelector("[data-cancel]").onclick = closePop;
    pop.querySelector("[data-ok]").onclick = () => {
      if (values.every((v) => chosen.has(v))) delete st.filters[c.key];
      else st.filters[c.key] = [...chosen];
      page = 0; save(); closePop(); render();
    };
    q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); pop.querySelector("[data-ok]").click(); } };
    draw();
    q.focus();
    setTimeout(() => document.addEventListener("mousedown", outside), 0);
    document.addEventListener("keydown", escKey);
  }
  const outside = (e) => { if (!e.target.closest(".xl-pop")) closePop(); };
  const escKey = (e) => { if (e.key === "Escape") closePop(); };
  function closePop() {
    document.querySelectorAll(".xl-pop").forEach((p) => p.remove());
    document.removeEventListener("mousedown", outside);
    document.removeEventListener("keydown", escKey);
  }
  window.addEventListener("hashchange", closePop, { once: true });

  // yang dicentang (hanya baris yang masih ada di data)
  const selected = () => rows.filter((r) => picked.has(rowId(r)));
  return {
    // pertama kali: kembali ke halaman terakhir yang dibuka (mis. balik dari detail job); data berganti karena filter -> halaman 1
    setRows(r) { rows = r; page = first ? Number(st.page) || 0 : 0; first = false; render(); onSelect?.(selected()); },
    selected,
    clearSelection() { picked.clear(); render(); onSelect?.([]); },
    visible,
    active: () => Object.keys(st.filters).length > 0,
  };
}

// Invoice customer & pengajuan vendor: daftar, buat, detail (posting, persetujuan, transfer malam, bayar, batal), cetak.
import {
  state, api, get, view, esc, rp, tgl, jam, kv, badge, options, enumOptions, table, toast, openModal, askReason, action,
  customers, vendors, bankLabel, num, today, debounce, bindRows, canFinance, isAdmin, PHASE_LABEL, KIND_LABEL, phaseLabel, latest, skelTable, pagedTable,
} from "../lib.js";
// "DP 70%" kalau semua job di dokumen berskema sama, selain itu "DP"
const movePhase = (m) => phaseLabel(m.phase, m.schemes && !m.schemes.includes(",") ? m.schemes : null);

const banks = (kind) => state.cache.banks.filter((b) => b.active && (!kind || b.kind === kind));
const statusBadge = (m) => m.state === "posted"
  ? `${badge(m.approval_state)} ${m.amount_residual === 0 ? `<span class="badge lunas">Lunas</span>` : `<span class="badge open">Belum lunas</span>`}`
  : badge(m.state);

export const renderInvoices = () => renderMoves("out_invoice");
export const renderRequests = () => renderMoves("in_invoice");

async function renderMoves(type) {
  const isInv = type === "out_invoice";
  const key = `moveFilter-${type}`;
  const f = JSON.parse(sessionStorage.getItem(key) || "{}");
  view().innerHTML = `
    <div class="page-head"><h1>${isInv ? "Invoice Customer" : "Pengajuan Vendor"}</h1>
      <span class="sub">${isInv ? "Tagihan ke customer per fase (DP 70%, pelunasan, full 100%)" : "Permintaan transfer ke vendor / calo, perlu persetujuan ADMIN"}.
        Mau lihat job mana yang belum ${isInv ? "ditagih" : "diajukan"}? Buka <a href="#/${isInv ? "ar" : "ap"}">${isInv ? "AR Customer" : "AP Vendor"}</a>.</span>
      <div class="spacer"></div><div class="actions">${canFinance() ? `<button class="primary" id="newMove">+ ${isInv ? "Invoice baru" : "Pengajuan baru"}</button>` : ""}</div></div>
    <div class="panel">
      <div class="filters">
        <label>Cari<input id="mSearch" placeholder="Nomor, partner, no job" value="${esc(f.search || "")}"></label>
        <label>Status<select id="mState"><option value="">Semua</option>${enumOptions({ draft: "Draft", posted: "Posted", cancelled: "Dibatalkan" }, f.state)}</select></label>
        ${isInv ? "" : `<label>Persetujuan<select id="mApproval"><option value="">Semua</option>${enumOptions({ PENDING: "Menunggu", APPROVED: "Disetujui", REJECTED: "Ditolak" }, f.approval)}</select></label>
          <label>Saluran<select id="mChannel"><option value="">Semua</option>${enumOptions({ NORMAL: "Normal", TRANSFER_MALAM: "Transfer malam" }, f.channel)}</select></label>`}
        <label>Dari<input type="date" id="mFrom" value="${esc(f.from || "")}"></label>
        <label>Sampai<input type="date" id="mTo" value="${esc(f.to || "")}"></label>
      </div>
      <div id="mBox">${skelTable(10, 8)}</div>
    </div>`;
  const el = (id) => document.getElementById(id);
  const only = latest();
  const load = async () => {
    const flt = { move_type: type, search: el("mSearch").value, state: el("mState").value, approval: el("mApproval")?.value || "",
      channel: el("mChannel")?.value || "", from: el("mFrom").value, to: el("mTo").value };
    sessionStorage.setItem(key, JSON.stringify(flt));
    const rows = await only(get(`/moves?${new URLSearchParams(flt)}`));
    pagedTable(el("mBox"), { rows, empty: "Belum ada",
      head: `<th>Nomor</th><th>Tgl</th><th>${isInv ? "Customer" : "Penerima"}</th><th>Fase</th><th class="num">Job</th>
       <th class="num">Total</th><th class="num">Dibayar</th><th class="num">Sisa</th>${isInv ? "" : `<th class="num">Titipan ops</th>`}<th>Status</th>`,
      row: (m) => `<tr class="click" data-href="#/moves/${m.id}">
        <td><b>${esc(m.number || "(draft)")}</b>${m.legacy_number && m.legacy_number !== m.number ? `<br><span class="muted">${esc(m.legacy_number)}</span>` : ""}</td>
        <td>${tgl(m.move_date)}</td><td>${esc(isInv ? m.partner : m.payees || "")}</td>
        <td>${esc(movePhase(m))}${m.payment_channel === "TRANSFER_MALAM" ? `<br><span class="muted">transfer malam</span>` : ""}</td>
        <td class="num">${m.total_jobs}</td><td class="num">${rp(m.amount_total)}</td><td class="num">${rp(m.amount_paid)}</td>
        <td class="num">${rp(m.state === "cancelled" ? 0 : m.amount_residual)}</td>
        ${isInv ? "" : `<td class="num">${m.titipan ? rp(m.titipan) : ""}</td>`}
        <td>${statusBadge(m)}</td></tr>` });
  };
  el("mSearch").oninput = debounce(load);
  for (const k of ["mState", "mApproval", "mChannel", "mFrom", "mTo"]) el(k)?.addEventListener("change", load);
  el("newMove")?.addEventListener("click", () => moveForm(type));
  await load();
}

// preset (dari halaman AR / AP): { partner_id, phase, job_ids } -> job itu saja, langsung dicentang
export function moveForm(type, preset = {}) {
  const isInv = type === "out_invoice";
  const phases = isInv ? { DP: PHASE_LABEL.DP, SETTLEMENT: PHASE_LABEL.SETTLEMENT, FULL: PHASE_LABEL.FULL } : PHASE_LABEL;
  const defBank = banks("BANK").find((b) => b.is_default)?.id;
  openModal({
    title: isInv ? "Invoice customer baru" : "Pengajuan vendor baru",
    wide: true,
    submitLabel: "Simpan draft",
    extraButtons: `<button type="submit" class="primary" data-post="1">Simpan &amp; posting</button>`,
    body: `
      <div class="form-grid">
        ${isInv ? `<label>Customer<select name="partner_id" required>${options(customers(), preset.partner_id || "", undefined, "- pilih -")}</select></label>`
                : `<label>Vendor (filter)<select name="partner_id">${options(vendors(), "", undefined, "Semua vendor")}</select></label>`}
        <label>Fase<select name="phase">${enumOptions(phases, preset.phase || "DP")}</select></label>
        <label>Tanggal<input type="date" name="move_date" value="${today()}"></label>
        ${isInv ? `<label>Jatuh tempo<input type="date" name="due_date"></label>
          <label>Rekening tujuan<select name="bank_account_id">${options(banks("BANK"), defBank, bankLabel, null)}</select></label>`
                : `<label>Saluran<select name="payment_channel">${enumOptions({ NORMAL: "Normal (transfer dari rekening bank)", TRANSFER_MALAM: "Transfer malam (lewat kas operasional)" }, "NORMAL")}</select></label>`}
        <label>Cari job / plat<input name="search" placeholder="atau tempel daftar no job di sini"></label>
        <div style="align-self:end"><button type="button" id="mvPasteBtn" title="Tempel banyak no job / kode tugas sekaligus dari Excel atau WhatsApp">Tempel daftar job</button></div>
        ${isInv ? `<label class="check"><input type="checkbox" name="sj_received" ${preset.job_ids ? "" : "checked"}> Hanya job yang SJ-nya sudah diterima</label>` : ""}
        ${preset.job_ids ? `<label class="check wide"><input type="checkbox" name="only_preset" checked> Hanya ${preset.job_ids.length} job yang dicentang di ${isInv ? "AR Customer" : "AP Vendor"}</label>` : ""}
        <label class="wide">Catatan<input name="note"></label>
      </div>
      <div id="mvPaste" style="margin-top:12px"></div>
      <div class="table-wrap" id="eligible" style="margin-top:12px"><p class="empty">${isInv ? "Pilih customer dulu." : "Memuat..."}</p></div>`,
    onOpen: (form) => {
      const E = form.elements;
      const only = latest();
      // daftar tempel (no job / kode tugas): tampilkan job itu saja, urut sesuai tempelan, langsung dicentang
      let pasted = null;
      const norm = (v) => String(v || "").replace(/\s/g, "").toUpperCase();
      const parseList = (v) => [...new Set(String(v || "").split(/[\s,;]+/).map(norm).filter(Boolean))];
      const pasteBox = form.querySelector("#mvPaste");
      const act = isInv ? "ditagih" : "diajukan";
      const drawPaste = (rows) => {
        E.search.disabled = !!pasted;
        if (!pasted) { pasteBox.innerHTML = ""; return; }
        const hit = new Map();   // nomor -> ada baris yang masih bisa diajukan?
        for (const r of rows || []) for (const k of [norm(r.job_number), norm(r.do_number)]) {
          if (pasted.includes(k)) hit.set(k, hit.get(k) || r.suggested > 0);
        }
        const done = pasted.filter((n) => hit.get(n) === false);
        const missing = pasted.filter((n) => !hit.has(n));
        const short = (list) => `${esc(list.slice(0, 10).join(", "))}${list.length > 10 ? ", ..." : ""}`;
        pasteBox.innerHTML = `<div class="note-box warn-box paste-box" style="margin:0"><span>Daftar tempel: <b>${rp(pasted.length)} nomor</b>${rows ? `,
          ${rp(pasted.length - done.length - missing.length)} bisa ${act}${done.length ? `, <b>${rp(done.length)} sudah ${act} penuh</b> (${short(done)})` : ""}${
          missing.length ? `, <b>${rp(missing.length)} tidak ketemu di fase / filter ini</b> (${short(missing)})` : ""}.` : isInv ? ". Pilih customer dulu." : "."}</span>
          <span class="spacer"></span><button type="button" class="small" data-edit>Ubah daftar</button><button type="button" class="small" data-clear>Hapus daftar</button></div>`;
        pasteBox.querySelector("[data-edit]").onclick = editPaste;
        pasteBox.querySelector("[data-clear]").onclick = () => setPaste(null);
      };
      function editPaste() {
        pasteBox.innerHTML = `<div class="note-box" style="margin:0"><label>Tempel daftar no job / kode tugas (satu per baris, atau dipisah koma / spasi)
          <textarea id="mvPasteText" rows="6" style="width:100%" placeholder="AMC/2610/0278&#10;AMC/2610/0277&#10;...">${esc((pasted || []).join("\n"))}</textarea></label>
          <div class="actions" style="margin-top:8px"><button type="button" class="small primary" data-ok>Tampilkan</button><button type="button" class="small" data-cancel>Batal</button></div></div>`;
        const ta = pasteBox.querySelector("#mvPasteText");
        ta.focus();
        pasteBox.querySelector("[data-ok]").onclick = () => setPaste(parseList(ta.value));
        pasteBox.querySelector("[data-cancel]").onclick = () => drawPaste(form._rows);
      }
      const setPaste = (list) => {
        pasted = list?.length ? list : null;
        if (pasted) E.search.value = "";
        drawPaste(null);
        load();
      };
      form.querySelector("#mvPasteBtn").onclick = editPaste;
      // menempel beberapa nomor langsung di kotak cari = daftar tempel
      E.search.addEventListener("paste", (e) => {
        const text = e.clipboardData?.getData("text") || "";
        const list = parseList(text);
        if (list.length > 1 && (/[\r\n,;]/.test(text.trim()) || list.every((x) => x.includes("/")))) { e.preventDefault(); setPaste(list); }
      });
      const load = async () => {
        const box = form.querySelector("#eligible");
        if (isInv && !E.partner_id.value) return;
        const q = { move_type: type, phase: E.phase.value, partner_id: E.partner_id.value, search: pasted ? "" : E.search.value,
          sj_received: isInv && E.sj_received.checked && E.phase.value !== "DP" ? "1" : "" };
        const ids = preset.job_ids && E.only_preset?.checked ? preset.job_ids : null;
        const rows = await only(pasted
          ? api("POST", "/moves/eligible", { ...q, numbers: pasted, job_ids: ids })
          : get(`/moves/eligible?${new URLSearchParams({ ...q, ...(ids ? { job_ids: ids.join(",") } : {}) })}`));
        form._rows = rows;
        drawPaste(rows);
        // hanya yang masih bisa ditagih / diajukan di fase ini (mis. DP yang sudah diajukan tidak muncul lagi)
        const items = rows.filter((r) => r.suggested > 0);
        if (pasted) {
          const pos = (r) => Math.min(...[norm(r.job_number), norm(r.do_number)].map((k) => pasted.indexOf(k)).filter((i) => i >= 0), 1e9);
          items.sort((a, b) => pos(a) - pos(b));
        }
        box.innerHTML = items.length ? `<table>
          <thead><tr><th><input type="checkbox" id="checkAll"></th><th>Job</th><th>Tgl</th><th>Rute / plat</th>
            ${isInv ? `<th class="num">Selling</th><th class="num">Setelah pajak</th>` : `<th>Jenis</th><th>Penerima / rekening</th><th class="num">Nominal baris</th>`}
            <th class="num">Sudah</th><th class="num">Sisa</th><th class="num">${isInv ? "Tagih sekarang" : "Ajukan sekarang"}</th></tr></thead>
          <tbody>${items.map((r, i) => `<tr>
            <td><input type="checkbox" data-i="${i}"></td>
            <td><b>${esc(r.job_number)}</b>${r.scheme === "50_50" ? ` <span class="badge">50/50</span>` : ""}${r.in_draft > 0 ? `<br><span class="muted">${rp(r.in_draft)} ada di draft lain</span>` : ""}</td>
            <td>${tgl(r.job_date)}</td><td>${esc(r.route)}<br><span class="muted">${esc(r.plate_number || "")}</span></td>
            ${isInv ? `<td class="num">${rp(r.line_amount)}</td><td class="num">${rp(r.selling_net)}</td>`
                    : `<td>${esc(KIND_LABEL[r.kind])}</td><td>${esc(r.partner || "-")}${r.bank_name ? `<br><span class="muted">${esc(r.bank_name)} ${esc(r.account_number)}</span>` : `<br><span class="warn-text">rekening belum diisi</span>`}</td><td class="num">${rp(r.line_amount)}</td>`}
            <td class="num">${rp(r.billed)}</td><td class="num">${rp(r.remaining)}</td>
            <td class="num"><input class="num amount" data-amount="${i}" value="${r.suggested}"></td>
          </tr>`).join("")}</tbody>
          <tfoot><tr><td colspan="${isInv ? 8 : 9}">Total dipilih</td><td class="num" id="selTotal">0</td></tr></tfoot></table>`
          : `<p class="empty">Tidak ada job yang bisa ${isInv ? "ditagih" : "diajukan"} untuk fase ini.</p>`;
        form._items = items;
        const total = () => {
          let s = 0;
          box.querySelectorAll("[data-i]:checked").forEach((c) => (s += Number(num(box.querySelector(`[data-amount="${c.dataset.i}"]`).value) || 0)));
          const out = box.querySelector("#selTotal");   // tidak ada kalau daftarnya kosong
          if (out) out.textContent = rp(s);
        };
        box.querySelectorAll("[data-i], [data-amount]").forEach((x) => (x.oninput = total));
        const all = box.querySelector("#checkAll");
        if (all) all.onchange = () => { box.querySelectorAll("[data-i]").forEach((c) => (c.checked = all.checked)); total(); };
        if (pasted || (preset.job_ids && E.only_preset?.checked)) { box.querySelectorAll("[data-i]").forEach((c) => (c.checked = true)); if (all) all.checked = true; total(); }
      };
      E.partner_id.onchange = load;
      E.phase.onchange = load;
      E.search.oninput = debounce(load);
      if (E.only_preset) E.only_preset.onchange = load;
      if (E.sj_received) E.sj_received.onchange = load;
      if (!isInv || E.partner_id.value) load();
    },
    onSubmit: async (d, form, submitter) => {
      const lines = [...form.querySelectorAll("[data-i]:checked")].map((c) => {
        const r = form._items[Number(c.dataset.i)];
        return { job_id: r.job_id, job_line_id: r.job_line_id || undefined, amount: num(form.querySelector(`[data-amount="${c.dataset.i}"]`).value) };
      });
      if (!lines.length) throw new Error("Centang minimal 1 job");
      const body = { move_type: type, phase: d.phase, move_date: d.move_date, note: d.note, lines, post: submitter?.dataset.post === "1" };
      if (isInv) Object.assign(body, { partner_id: d.partner_id, due_date: d.due_date, bank_account_id: d.bank_account_id });
      else body.payment_channel = d.payment_channel;
      const m = await api("POST", "/moves", body);
      toast(m.state === "posted" ? `${m.number} diposting` : "Draft disimpan");
      location.hash = `#/moves/${m.id}`;
    },
  });
}

export async function renderMoveDetail(id) {
  const m = await get(`/moves/${id}`);
  const isInv = m.move_type === "out_invoice";
  const night = m.payment_channel === "TRANSFER_MALAM";
  const payable = m.state === "posted" && ["NOT_REQUIRED", "APPROVED"].includes(m.approval_state) && m.amount_residual > 0;
  view().innerHTML = `
    <div class="page-head">
      <a href="#/${isInv ? "invoices" : "requests"}" class="btn">&larr;</a>
      <h1>${esc(m.number || "Draft")}</h1>${statusBadge(m)}
      <span class="sub">${isInv ? "Invoice customer" : "Pengajuan vendor"} &middot; ${esc(PHASE_LABEL[m.phase])}${night ? " &middot; transfer malam" : ""}</span>
      <div class="spacer"></div>
      <div class="actions">
        ${canFinance() && m.state === "draft" ? `<button class="primary" id="postMove">Posting</button><button class="danger" id="delMove">Hapus draft</button>` : ""}
        ${isAdmin() && m.state === "posted" && m.approval_state === "PENDING" ? `<button class="primary" id="approve">Setujui</button><button class="danger" id="reject">Tolak</button>` : ""}
        ${canFinance() && night && payable && m.amount_residual > m.titipan ? `<button id="fund">Kirim dana ke kas operasional</button>` : ""}
        ${canFinance() && night && m.titipan > 0 ? `<button id="returnFund">Dana kembali dari operasional</button>` : ""}
        ${canFinance() && payable && (!night || m.titipan > 0) ? `<button class="primary" id="pay">${isInv ? "Catat pembayaran masuk" : night ? "Catat penyaluran ke vendor" : "Catat transfer"}</button>` : ""}
        ${canFinance() && m.state === "posted" ? `<button class="danger" id="cancelMove">Batalkan</button>` : ""}
        ${m.state !== "draft" ? `<a class="btn" href="#/moves/${m.id}/cetak">Cetak</a>` : ""}
        ${!isInv ? `<button id="waText" title="Format pengajuan untuk grup WhatsApp">Salin teks WhatsApp</button>` : ""}
      </div>
    </div>
    ${m.state === "posted" && m.approval_state === "PENDING" ? `<div class="note-box warn-box">Menunggu persetujuan ADMIN sebelum bisa dibayar.</div>` : ""}
    ${m.approval_state === "REJECTED" ? `<div class="note-box warn-box">Ditolak: ${esc(m.rejection_reason || "")}</div>` : ""}
    <div class="panel"><div class="kv">
      ${isInv ? kv("Customer", m.partner) + kv("Tagih ke", [m.bill_to_name, m.bill_to_npwp && `NPWP ${m.bill_to_npwp}`].filter(Boolean).join(" / "))
              : kv("Penerima", [...new Set(m.lines.filter((l) => !l.cancelled_at).map((l) => l.payee_name || l.payee_holder))].join(", "))}
      ${kv("Tanggal", tgl(m.move_date))}${m.due_date ? kv("Jatuh tempo", tgl(m.due_date)) : ""}${kv("Fase", PHASE_LABEL[m.phase])}
      ${isInv ? kv("Rekening tujuan", m.bank_account ? `${m.company_bank} ${m.company_account_number} a.n. ${m.company_holder}` : "-") : ""}
      ${night ? kv("Dana di kas operasional", rp(m.titipan)) : ""}
      ${kv("Total", rp(m.amount_total))}${kv("Dibayar", rp(m.amount_paid))}${kv("Sisa", rp(m.amount_residual))}
      ${isInv && (m.ppn_amount || m.pph23_amount) ? kv("Pajak", `dasar ${rp(m.tax_basis)}, PPN ${rp(m.ppn_amount)}, PPh 23 ${rp(m.pph23_amount)}`) : ""}
      ${kv("Dibuat oleh", m.created_by_name)}${m.approved_by_name ? kv(m.approval_state === "REJECTED" ? "Ditolak oleh" : "Disetujui oleh", `${m.approved_by_name} ${jam(m.approved_at)}`) : ""}
      ${kv("Catatan", m.note)}${m.cancel_reason ? kv("Alasan batal", m.cancel_reason) : ""}
      ${m.legacy_number ? kv("Nomor lama (AMICO)", m.legacy_number) : ""}
    </div></div>
    <div class="panel"><h2>Isi dokumen</h2>
      ${table(`<th>#</th><th>Job</th><th>Tgl job</th><th>Rute</th><th>Plat</th><th>DO</th><th>Jenis</th>${isInv ? "" : "<th>Penerima / rekening</th>"}
        <th class="num">Nominal</th><th class="num">Dibayar</th><th></th>`,
        m.lines.map((l, i) => `<tr class="${l.cancelled_at ? "rev" : ""}">
          <td>${i + 1}</td><td><a href="#/jobs/${l.job_id}">${esc(l.job_number)}</a></td><td>${tgl(l.job_date)}</td><td>${esc(l.route)}</td>
          <td>${esc(l.plate_number || "")}</td><td>${esc(l.do_number || "")}</td><td>${l.job_line_id ? esc(KIND_LABEL[l.kind]) : `<a href="#/unassigned" class="badge warn">Tanpa tujuan</a>`}${m.phase === "DP" && l.dp_prev > 0 ? `<br><span class="badge draft" title="DP sebelumnya ${rp(l.dp_prev)}${l.reroute ? `, reroute ${esc(l.reroute.dari)} → ${esc(l.reroute.ke)}` : ""}">DP tambahan</span>` : ""}</td>
          ${isInv ? "" : `<td>${esc(l.payee_name || l.payee_holder || "-")}${l.payee_bank_name ? `<br><span class="muted">${esc(l.payee_bank_name)} ${esc(l.payee_account_number)} a.n. ${esc(l.payee_holder)}</span>` : ""}</td>`}
          <td class="num">${l.cancelled_at ? `<s>${rp(l.amount)}</s><br><span class="muted">batal: ${esc(l.cancel_reason || "")}</span>` : rp(l.amount)}</td>
          <td class="num">${rp(l.paid)}</td>
          <td>${canFinance() && m.state === "posted" && !l.cancelled_at && l.paid === 0 && m.lines.filter((x) => !x.cancelled_at).length > 1 ? `<button class="small danger" data-cancel-line="${l.id}">Batalkan baris</button>` : ""}</td>
        </tr>`).join(""), "Kosong",
        `<tr><td colspan="${isInv ? 7 : 8}">Total</td><td class="num">${rp(m.amount_total)}</td><td class="num">${rp(m.amount_paid)}</td><td></td></tr>`)}
    </div>
    ${m.transfers.length ? `<div class="panel"><h2>Dana kas operasional <span class="hint">transfer malam</span></h2>
      ${table("<th>Nomor</th><th>Tgl</th><th>Dari</th><th>Ke</th><th class='num'>Nominal</th><th>Catatan</th>",
        m.transfers.map((t) => `<tr><td>${esc(t.number)}</td><td>${tgl(t.transfer_date)}</td><td>${esc(t.from_name)}</td><td>${esc(t.to_name)}</td>
          <td class="num">${rp(t.to_kind === "OPERATIONAL" ? t.amount : -t.amount)}</td><td>${esc(t.note || "")}</td></tr>`).join(""))}</div>` : ""}
    <div class="panel"><h2>Pembayaran <span class="hint">batal bayar = baris pembalik, data asli tetap ada</span></h2>
      ${table("<th>Nomor</th><th>Tgl</th><th>Rekening</th><th class='num'>Nominal</th><th>Catatan</th><th>Oleh</th><th>Status</th><th></th>",
        m.payments.map((p) => `<tr class="${p.amount < 0 ? "rev" : ""}">
          <td>${esc(p.number)}</td><td>${tgl(p.pay_date)}</td><td>${esc(p.bank_account || "")}</td><td class="num">${rp(p.amount)}</td>
          <td>${esc(p.note || "")}</td><td>${esc(p.created_by_name || "")}</td><td>${p.amount < 0 ? "Pembalik" : badge(p.state)}</td>
          <td>${canFinance() && p.state === "posted" && p.amount > 0 && !p.reversed_payment_id ? `<button class="small danger" data-reverse="${p.id}">Batal bayar</button>` : ""}</td>
        </tr>`).join(""), "Belum ada pembayaran")}
    </div>`;
  const on = (sel, fn) => document.getElementById(sel)?.addEventListener("click", fn);
  on("waText", async () => {
    const text = waText(m);
    try { await navigator.clipboard.writeText(text); toast("Teks WhatsApp disalin"); }
    catch { openModal({ title: "Teks WhatsApp", body: `<textarea rows="18" style="width:100%">${esc(text)}</textarea>` }); }
  });
  on("postMove", action(() => api("POST", `/moves/${id}/post`), "Diposting"));
  on("delMove", async () => {
    try { await api("POST", `/moves/${id}/cancel`, {}); toast("Draft dihapus"); location.hash = isInv ? "#/invoices" : "#/requests"; } catch (e) { toast(e.message, true); }
  });
  on("approve", action(() => api("POST", `/moves/${id}/approve`, { approve: true }), "Disetujui"));
  on("reject", () => askReason("Tolak pengajuan", "Pengajuan batal, job bisa diajukan lagi.", (reason) => api("POST", `/moves/${id}/approve`, { approve: false, reason }), "Tolak"));
  on("cancelMove", () => askReason(`Batalkan ${m.number}`, "Hanya bisa kalau belum ada pembayaran (atau sudah dibalik) dan tidak ada dana di kas operasional.",
    (reason) => api("POST", `/moves/${id}/cancel`, { reason }), "Batalkan dokumen"));
  view().querySelectorAll("[data-cancel-line]").forEach((b) => (b.onclick = () => askReason("Batalkan baris ini",
    "Baris tidak dihitung lagi dan job bisa diajukan / ditagih ulang.", (reason) => api("POST", `/move-lines/${b.dataset.cancelLine}/cancel`, { reason }), "Batalkan baris")));
  view().querySelectorAll("[data-reverse]").forEach((b) => (b.onclick = () => openModal({
    title: "Batal bayar",
    body: `<div class="form-grid"><label>Tanggal<input type="date" name="pay_date" value="${today()}"></label><label>Alasan<input name="reason" required></label></div>
      <div class="note-box">Dibuat baris pembalik (minus). Pembayaran asli tidak dihapus.</div>`,
    submitLabel: "Buat pembalik",
    onSubmit: async (d) => { await api("POST", `/payments/${b.dataset.reverse}/reverse`, d); toast("Pembayaran dibalik"); window.dispatchEvent(new Event("hashchange")); },
  })));
  on("fund", () => openModal({
    title: "Kirim dana ke kas operasional",
    body: `<div class="form-grid">
      <label>Dari rekening<select name="from_account_id">${options(banks("BANK"), banks("BANK").find((b) => b.is_default)?.id, bankLabel, null)}</select></label>
      <label>Ke kas operasional<select name="to_account_id">${options(banks("OPERATIONAL"), "", bankLabel, null)}</select></label>
      <label>Tanggal<input type="date" name="transfer_date" value="${today()}"></label>
      <label>Nominal<input class="num" name="amount" value="${m.amount_residual - m.titipan}"></label>
      <label class="wide">Catatan<input name="note"></label></div>
      <div class="note-box">Uang pindah ke kas operasional dulu. Vendor dianggap dibayar saat operasional menyalurkan (tombol "Catat penyaluran ke vendor").</div>`,
    onSubmit: async (d) => { d.amount = num(d.amount); await api("POST", `/moves/${id}/fund`, d); toast("Dana dikirim"); window.dispatchEvent(new Event("hashchange")); },
  }));
  on("returnFund", () => openModal({
    title: "Dana kembali dari kas operasional",
    body: `<div class="form-grid">
      <label>Ke rekening<select name="to_account_id">${options(banks("BANK"), banks("BANK").find((b) => b.is_default)?.id, bankLabel, null)}</select></label>
      <label>Tanggal<input type="date" name="transfer_date" value="${today()}"></label>
      <label>Nominal<input class="num" name="amount" value="${m.titipan}"></label>
      <label class="wide">Alasan<input name="note" required></label></div>`,
    onSubmit: async (d) => { d.amount = num(d.amount); await api("POST", `/moves/${id}/return-fund`, d); toast("Dana dikembalikan"); window.dispatchEvent(new Event("hashchange")); },
  }));
  on("pay", () => {
    const open = m.lines.filter((l) => !l.cancelled_at && l.amount - l.paid > 0);
    const accounts = night ? banks("OPERATIONAL") : banks("BANK");
    openModal({
      title: isInv ? "Catat pembayaran dari customer" : night ? "Catat penyaluran dari kas operasional" : "Catat transfer ke vendor",
      wide: !isInv,
      body: `<div class="form-grid">
        <label>Tanggal uang ${isInv ? "masuk" : "keluar"}<input type="date" name="pay_date" value="${today()}" required></label>
        <label>Rekening AMICO<select name="bank_account_id">${options(accounts, m.bank_account_id || accounts.find((b) => b.is_default)?.id, bankLabel, null)}</select></label>
        <label>Nominal<input class="num" name="amount" value="${night ? Math.min(m.amount_residual, m.titipan) : m.amount_residual}" required></label>
        <label>Bukti (link)<input name="proof_url"></label>
        <label class="wide">Catatan<input name="note"></label></div>
        ${!isInv && open.length > 1 ? `<h4>Baris yang dibayar <span class="muted">(kosong = berurutan)</span></h4>
          ${table("<th></th><th>Job</th><th>Penerima</th><th class='num'>Sisa</th>",
            open.map((l) => `<tr><td><input type="checkbox" data-line="${l.id}" data-open="${l.amount - l.paid}"></td><td>${esc(l.job_number)}</td>
              <td>${esc(l.payee_name || l.payee_holder || "")}</td><td class="num">${rp(l.amount - l.paid)}</td></tr>`).join(""))}` : ""}
        ${!isInv ? `<details><summary>Penerima sebenarnya beda dari rekening di pengajuan?</summary><div class="form-grid">
          <label>Nama<input name="actual_payee_name"></label><label>Bank<input name="actual_bank_name"></label>
          <label>No rekening<input name="actual_account_number"></label><label>Atas nama<input name="actual_holder"></label></div></details>` : ""}
        <div class="note-box">Sisa ${rp(m.amount_residual)}${night ? `, dana di kas operasional ${rp(m.titipan)}` : ""}. Kalau dibayar sebagian, sisanya tetap terbuka.</div>`,
      onOpen: (form) => {
        const boxes = form.querySelectorAll("[data-line]");
        boxes.forEach((c) => (c.onchange = () => {
          const sel = [...boxes].filter((x) => x.checked);
          if (sel.length) form.elements.amount.value = sel.reduce((s, x) => s + Number(x.dataset.open), 0);
        }));
      },
      onSubmit: async (d, form) => {
        d.amount = num(d.amount);
        d.line_ids = [...form.querySelectorAll("[data-line]:checked")].map((c) => Number(c.dataset.line));
        await api("POST", `/moves/${id}/pay`, d);
        toast("Pembayaran dicatat");
        window.dispatchEvent(new Event("hashchange"));
      },
    });
  });
}

// ---------------------------------------------------------------- cetak
export async function renderMovePrint(id) {
  const m = await get(`/moves/${id}`);
  if (m.move_type === "out_invoice") return renderInvoicePrint(m, await get("/settings"));
  const s = state.cache.settings;
  const isInv = m.move_type === "out_invoice";
  const lines = m.lines.filter((l) => !l.cancelled_at);
  const selling = lines.reduce((a, l) => a + (l.job_selling || 0), 0);
  view().innerHTML = `
    <div class="page-head no-print"><a href="#/moves/${id}" class="btn">&larr; Kembali</a><div class="spacer"></div><button class="primary" onclick="window.print()">Cetak / simpan PDF</button></div>
    <div class="print-doc">
      <div class="print-head">
        <div><div class="print-company">${esc(s.company_name || "")}</div><div class="muted">${esc(s.company_address || "")}</div>
          ${s.company_npwp ? `<div class="muted">NPWP ${esc(s.company_npwp)}</div>` : ""}</div>
        <div class="print-title">${isInv ? "INVOICE" : "PENGAJUAN PEMBAYARAN"}<div class="print-number">${esc(m.number || "")}</div></div>
      </div>
      <div class="print-meta">
        ${isInv ? `<div><span>Kepada</span><b>${esc(m.bill_to_name || m.partner)}</b><div>${esc(m.bill_to_address || "")}</div>${m.bill_to_npwp ? `<div>NPWP ${esc(m.bill_to_npwp)}</div>` : ""}</div>` : ""}
        <div><span>Tanggal</span><b>${tgl(m.move_date)}</b>${m.due_date ? `<span>Jatuh tempo</span><b>${tgl(m.due_date)}</b>` : ""}</div>
        <div><span>Keterangan</span><b>${esc(PHASE_LABEL[m.phase])}</b></div>
      </div>
      <table class="print-table">
        <thead><tr><th>#</th><th>No job</th><th>DO</th><th>Rute</th><th>Truk / plat</th>${isInv ? `<th class="num">Selling</th>` : "<th>Penerima / rekening</th>"}<th class="num">${isInv ? "Ditagih" : "Nominal"}</th></tr></thead>
        <tbody>${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.job_number)}</td><td>${esc(l.do_number || "")}</td><td>${esc(l.route)}</td>
          <td>${esc(l.truck_type || "")} ${esc(l.plate_number || "")}</td>
          ${isInv ? `<td class="num">${rp(l.job_selling)}</td>` : `<td>${esc(l.payee_name || l.payee_holder || "")}<br>${esc(l.payee_bank_name || "")} ${esc(l.payee_account_number || "")}</td>`}
          <td class="num">${rp(l.amount)}</td></tr>`).join("")}</tbody>
      </table>
      ${isInv ? `<table class="print-sum">
        ${m.phase !== "DP" ? `<tr><td>Total selling</td><td class="num">${rp(selling)}</td></tr>
          ${m.ppn_amount ? `<tr><td>PPN</td><td class="num">${rp(m.ppn_amount)}</td></tr>` : ""}
          ${m.pph23_amount ? `<tr><td>PPh 23 (dipotong customer)</td><td class="num">-${rp(m.pph23_amount)}</td></tr>` : ""}
          ${m.phase === "SETTLEMENT" ? `<tr><td>Dikurangi DP yang sudah ditagih</td><td class="num">-${rp(selling + m.ppn_amount - m.pph23_amount - m.amount_total)}</td></tr>` : ""}` : ""}
        <tr class="total"><td>Jumlah yang harus dibayar</td><td class="num">${rp(m.amount_total)}</td></tr></table>
        ${m.bank_account ? `<div class="print-bank">Pembayaran ke: <b>${esc(m.company_bank)} ${esc(m.company_account_number)}</b> a.n. ${esc(m.company_holder)}</div>` : ""}`
      : `<table class="print-sum"><tr class="total"><td>Total</td><td class="num">${rp(m.amount_total)}</td></tr></table>`}
    </div>`;
}

// Invoice customer dengan format AMICO (sama dengan file Excel "INVOICE AMICO TO CUSTOMER"):
// kop + logo, Bill to, blok keterangan, tabel per job, Sub Total - PPN - PPh 23 - TOTAL - DP - GRAND TOTAL, rekening, tanda tangan.
// s = pengaturan terbaru dari server (kop, penanda tangan), bukan salinan saat login
function renderInvoicePrint(m, s) {
  state.cache.settings = s;
  const lines = m.lines.filter((l) => !l.cancelled_at);
  const dmy = (v) => (v ? new Date(`${tgl(v)}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : "");
  // satu job bisa punya lebih dari satu baris (selling tambahan): di tabel cukup satu baris per job
  const jobs = [...new Map(lines.map((l) => [l.job_id, l])).values()];
  const nowSum = jobs.reduce((a, l) => a + Number(l.job_selling || 0), 0);
  // dasar yang tersimpan saat invoice dibuat (invoice lama tanpa dasar: pakai selling job sekarang)
  const sub = Number(m.tax_basis) > 0 ? Number(m.tax_basis) : nowSum;
  const ppn = Number(m.ppn_amount || 0), pph = Number(m.pph23_amount || 0);
  const total = sub + ppn - pph;
  const scheme = [...new Set(jobs.map((l) => l.customer_scheme))].length === 1 ? jobs[0]?.customer_scheme : null;
  const dpPct = scheme === "50_50" ? 50 : 70;
  const dpPrev = [...new Map(lines.map((l) => [l.job_line_id, Number(l.dp_prev || 0)])).values()].reduce((a, v) => a + v, 0);
  const rows = [["Sub Total", sub]];
  if (m.phase !== "DP") {
    if (ppn) rows.push(["PPN", ppn]);
    if (pph) rows.push(["PPH 23", -pph]);
    if (ppn || pph) rows.push(["TOTAL", total]);
  }
  let expected = m.phase === "DP" ? Number(m.amount_total) : total;
  if (m.phase === "DP") rows.push([`DP ${dpPct}%`, Number(m.amount_total)]);
  if (m.phase === "SETTLEMENT") { rows.push([`DP ${dpPct}%`, -dpPrev]); expected = total - dpPrev; }
  // selisih kecil karena pembulatan / selling setelah pajak diisi manual / ditagih sebagian: ditampilkan, tidak disembunyikan
  if (Math.abs(expected - Number(m.amount_total)) >= 1) rows.push(["Adjustment", Number(m.amount_total) - expected]);
  rows.push(["GRAND TOTAL", Number(m.amount_total)]);
  const money = (v) => `${v < 0 ? "(" : ""}${rp(Math.abs(v))}${v < 0 ? ")" : ""}`;
  // tanggal jalan = tanggal gate out (waktu Jakarta); belum gate out = tanggal job
  const jamDate = (v) => (v ? new Date(v).toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }) : "");
  const billName = m.bill_to_name || m.partner;
  const billAddr = m.bill_to_address || m.partner_address || "";
  const billNpwp = m.bill_to_npwp || m.partner_npwp || "";
  const trucks = [...new Set(jobs.map((l) => l.truck_type).filter(Boolean))].join(", ");
  const info = [
    ["Client Name", `<b>${esc(billName)}</b>`, "Our Ref No", ""], ["Commodity/ Pkts", "", "Shipper / Consignee", ""],
    ["Bill of Landing", "", "House/B Landing", ""], ["Vessel/Voyage", "", "AJU/PO", ""], ["POL/POD/ETD", "", "KGM/ M3", ""],
    ["Shipment Type", esc(trucks ? `Trucking ${trucks}` : "Trucking"), "Our Job No", esc(jobs.length === 1 ? jobs[0].job_number : "")],
  ];
  view().innerHTML = `
    <div class="page-head no-print"><a href="#/moves/${m.id}" class="btn">&larr; Kembali</a><div class="spacer"></div>
      <span class="muted">Kertas A4 tegak. Di jendela cetak pilih "Save as PDF" untuk PDF.</span><button class="primary" onclick="window.print()">Cetak / simpan PDF</button></div>
    ${Math.abs(sub - nowSum) >= 1 ? `<div class="note-box warn-box no-print">Selling job berubah sesudah invoice ini dibuat (sekarang ${rp(nowSum)}, saat invoice ${rp(sub)}).
      Sub Total memakai nilai saat invoice dibuat; harga per baris di tabel memakai selling sekarang.</div>` : ""}
    <div class="inv-doc">
      <div class="inv-header"><div class="inv-top">
        <img class="inv-logo" src="img/logo-amico.png" alt="AMICO">
        <div class="inv-company"><div class="inv-co-name">${esc(s.company_name || "")}</div>
          ${s.company_tagline !== "" ? `<div class="inv-co-tag">${esc(s.company_tagline ?? "Freight Forwarding & Logistics")}</div>` : ""}
          <div class="inv-co-addr">${esc(s.company_address || "")}</div></div>
      </div><div class="inv-title">INVOICE</div></div>
      <div class="inv-head">
        <div class="inv-bill"><div>Bill to :</div><div class="inv-bill-name">${esc(billName)}</div><div class="inv-pre">${esc(billAddr)}</div>
          <table class="inv-kv"><tr><td>NPWP</td><td>: ${esc(billNpwp)}</td></tr><tr><td>Telp.</td><td>: ${esc(m.partner_phone || "")}</td></tr>
            <tr><td>ATTN</td><td>: ${esc(m.partner_attn || "")}</td></tr></table></div>
        <table class="inv-kv inv-no"><tr><td>Invoice No</td><td>: <b>${esc(m.number || "(draft)")}</b></td></tr><tr><td>Date</td><td>: ${dmy(m.move_date)}</td></tr>
          ${m.due_date ? `<tr><td>Due Date</td><td>: ${dmy(m.due_date)}</td></tr>` : ""}</table>
      </div>
      <table class="inv-info">${info.map((r, i) => `<tr class="${i === 0 ? "shade" : ""}"><td>${r[0]}</td><td>: ${r[1]}</td><td>${r[2]}</td><td>: ${r[3]}</td></tr>`).join("")}</table>
      <table class="inv-lines">
        <thead><tr><th>No</th><th>Job Number</th><th>Tanggal Jalan</th><th>Kode Tugas</th><th>Origin</th><th>Route</th><th>Plate Number</th><th>Truck Type</th><th>Total Price</th></tr></thead>
        <tbody>${jobs.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.job_number)}</td><td>${dmy(jamDate(l.gate_out_at) || l.job_date)}</td><td>${esc(l.do_number || "")}</td>
          <td>${esc(l.pol)}</td><td>${esc(l.pod)}</td><td>${esc(l.plate_number || "")}</td><td>${esc(l.truck_type || "")}</td>
          <td class="num">${rp(l.job_selling)}</td></tr>`).join("")}</tbody>
      </table>
      <!-- rincian, rekening, tanda tangan selalu di bagian bawah kertas; job sedikit = tengah kosong -->
      <div class="inv-bottom">
      <table class="inv-sum">${rows.map(([k, v]) => `<tr class="${k === "GRAND TOTAL" ? "grand" : ""}"><td class="sp"></td><td>${esc(k)}</td><td class="num">${money(v)}</td></tr>`).join("")}</table>
      <div class="inv-foot">
        <div class="inv-bank"><div>Please make your payment to the following bank account:</div>
          <table class="inv-kv"><tr><td><b>BANK NAME</b></td><td>: ${esc(m.company_bank || "")}</td></tr>
            <tr><td><b>BANK ACCOUNT NO</b></td><td>: ${esc(m.company_account_number || "")}</td></tr>
            <tr><td><b>ACCOUNT NAME</b></td><td>: ${esc(m.company_holder || "")}</td></tr></table></div>
        <div class="inv-sign"><div>Approved By,</div>
          <div class="inv-sig-img">${s.invoice_signature ? `<img src="${esc(s.invoice_signature)}" alt="">` : ""}</div>
          <div class="inv-signer">${esc(s.invoice_signer || "")}</div><b>${esc(s.company_name || "")}</b></div>
      </div>
      </div>
    </div>`;
}

// Teks pengajuan untuk grup WhatsApp (format yang dipakai tim selama ini), dikelompokkan per customer & job
function waText(m) {
  const n = (v) => Number(v || 0).toLocaleString("id-ID");
  const night = m.payment_channel === "TRANSFER_MALAM";
  const lines = m.lines.filter((l) => !l.cancelled_at);
  const pct = (l) => (m.phase === "DP" ? (l.vendor_scheme === "FULL" ? 100 : 70) : m.phase === "SETTLEMENT" ? 30 : 100);
  const extra = m.phase === "DP" && lines.some((l) => l.dp_prev > 0);
  const title = { DP: `${extra ? "DP TAMBAHAN" : "DP"} ${pct(lines[0] || {})}%`, SETTLEMENT: "PELUNASAN 30%", FULL: "FULL 100%", OTHER: "CALO / BIAYA LAIN" }[m.phase];
  const dt = new Date(m.posted_at || m.created_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" });
  const out = [`BATCH PENGAJUAN ${title}`, `Batch : ${m.number || "(draft)"}`, `Jalur : ${night ? "Transfer malam" : "Normal"}`,
    `Total Job : ${new Set(lines.map((l) => l.job_id)).size}`, `Total ${title} : Rp ${n(m.amount_total)}`, `Dibuat : ${dt}`, "=".repeat(47), ""];
  const byCust = new Map();
  for (const l of lines) {
    if (!byCust.has(l.customer)) byCust.set(l.customer, new Map());
    const jobs = byCust.get(l.customer);
    if (!jobs.has(l.job_id)) jobs.set(l.job_id, []);
    jobs.get(l.job_id).push(l);
  }
  let no = 0;
  for (const [cust, jobs] of byCust) {
    for (const [, ls] of jobs) {
      const j = ls[0];
      out.push(`${++no}. PENGAJUAN ${title}`, "", cust, "", j.job_number,
        `Rute     : ${j.pol} ${j.pod}`, `Unit     : ${j.truck_type || "-"}`, `Nopol    : ${j.plate_number || "-"}`);
      if (j.driver1_name) out.push(`Nama     : ${j.driver1_name}`, `Hp       : ${j.driver1_phone || "-"}`);
      if (j.driver2_name) out.push(`Nama     : ${j.driver2_name}`, `Hp       : ${j.driver2_phone || "-"}`);
      out.push(`Kode Tugas : ${j.do_number || "-"}`, "");
      if (j.reroute && j.dp_prev > 0) out.push(`Reroute  : ${j.reroute.dari} -> ${j.reroute.ke}`, `Alasan   : ${j.reroute.alasan || "-"}`, "");
      for (const l of ls) {
        const what = l.job_line_id ? (l.kind === "TRUCKING" ? "trucking" : (l.kind || "").toLowerCase()) : "selisih";
        if (l.kind === "TRUCKING") out.push(`Harga trucking : ${n(l.line_amount)}`);
        if (m.phase === "DP" && l.dp_prev > 0) out.push(`DP sebelumnya : ${n(l.dp_prev)}`);
        out.push(`${title.toLowerCase().replace(/^dp/, "DP").replace(/^./, (c) => c.toUpperCase())} ${what} : ${n(l.amount)}`, "",
          `Rekening ${what}:`, l.payee_holder || l.payee_name || "-", l.payee_bank_name || "-", l.payee_account_number || "-", "");
      }
    }
  }
  return out.join("\n").trim();
}

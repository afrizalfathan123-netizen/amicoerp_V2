// ERP AMICO v2: router, menu sesuai role, login.
import { state, api, get, esc, view, toast, loadMaster, openModal, closeModal, ROLE_LABEL, can, icon, newNavigation, skeleton, table, jam, deviceLabel } from "./lib.js";
import { startFox } from "./fox.js";
import { parseDateTime } from "./wa-paste.js";

const NAV = [
  { group: "Operasional" },
  { href: "#/dashboard", key: "dashboard", label: "Dashboard" },
  { href: "#/jobs", key: "jobs", label: "Job" },
  { href: "#/sisihkan", key: "sisihkan", label: "Sisihkan" },
  { href: "#/tracker", key: "tracker", label: "Tracker" },
  { href: "#/sj", key: "sj", label: "Surat Jalan" },
  { group: "Keuangan" },
  { href: "#/rekap", key: "rekap", label: "Rekap Posisi" },
  { href: "#/ar", key: "ar", label: "AR Customer" },
  { href: "#/ap", key: "ap", label: "AP Vendor" },
  { href: "#/cek-harga", key: "cek-harga", label: "Cek Harga Jual" },
  { href: "#/invoices", key: "invoices", label: "Invoice Customer" },
  { href: "#/requests", key: "requests", label: "Pengajuan Vendor" },
  { href: "#/units", key: "units", label: "Unit Sewa" },
  { href: "#/kas", key: "kas", label: "Kas & Rekening" },
  { href: "#/ledger", key: "ledger", label: "Jurnal Kas" },
  { href: "#/utang-piutang", key: "utang-piutang", label: "Utang Piutang" },
  { href: "#/unassigned", key: "unassigned", label: "Selisih" },
  { group: "Pengaturan" },
  { href: "#/master/partners", key: "master", label: "Master Data" },
  { href: "#/users", key: "users", label: "User & Audit", roles: ["ADMIN"] },
];

// Grup menu dari key halaman (untuk label kecil di atas judul dan breadcrumb)
function navInfo(key) {
  let group = "";
  for (const n of NAV) {
    if (n.group) group = n.group;
    else if (n.key === key) return { group, label: n.label };
  }
  return { group: "", label: "" };
}
const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

// [pola hash, modul halaman, fungsi, key menu]
const ROUTES = [
  [/^#\/dashboard$/, "dashboard", "renderDashboard", "dashboard"],
  [/^#\/jobs$/, "jobs", "renderJobs", "jobs"],
  [/^#\/jobs\/(\d+)$/, "jobs", "renderJobDetail", "jobs"],
  [/^#\/sisihkan$/, "sisihkan", "renderSisihkan", "sisihkan"],
  [/^#\/tracker$/, "tracker", "renderTracker", "tracker"],
  [/^#\/sj$/, "sj", "renderSj", "sj"],
  [/^#\/sj\/deliveries\/(\d+)\/cetak$/, "sj", "renderDeliveryPrint", "sj"],
  [/^#\/rekap$/, "reports", "renderRekap", "rekap"],
  [/^#\/ar$/, "billing", "renderAr", "ar"],
  [/^#\/ap$/, "billing", "renderAp", "ap"],
  [/^#\/cek-harga$/, "pricecheck", "renderPriceCheck", "cek-harga"],
  [/^#\/invoices$/, "moves", "renderInvoices", "invoices"],
  [/^#\/requests$/, "moves", "renderRequests", "requests"],
  [/^#\/moves\/(\d+)$/, "moves", "renderMoveDetail", null],
  [/^#\/moves\/(\d+)\/cetak$/, "moves", "renderMovePrint", null],
  [/^#\/units$/, "units", "renderUnits", "units"],
  [/^#\/kas$/, "reports", "renderKas", "kas"],
  [/^#\/ledger$/, "reports", "renderLedger", "ledger"],
  [/^#\/utang-piutang$/, "reports", "renderUtangPiutang", "utang-piutang"],
  [/^#\/unassigned$/, "unassigned", "renderUnassigned", "unassigned"],
  [/^#\/master\/([\w-]+)$/, "master", "renderMaster", "master"],
  [/^#\/users$/, "users", "renderUsers", "users"],
];

function renderNav(activeKey) {
  const nav = document.getElementById("nav");
  nav.innerHTML = NAV.filter((n) => !n.roles || can(...n.roles)).map((n) => n.group
    ? `<div class="nav-group">${esc(n.group)}</div>`
    : `<a href="${n.href}" class="${n.key === activeKey ? "active" : ""}">${icon(n.key)}<span>${esc(n.label)}</span></a>`).join("");
  document.getElementById("userBox").innerHTML = `
    <details class="user-menu">
      <summary>
        <span class="avatar">${esc(initials(state.user.display_name))}</span>
        <span class="who"><b>${esc(state.user.display_name)}</b><small>${esc(ROLE_LABEL[state.user.role])} · @${esc(state.user.username)}</small></span>
        ${icon("chevron", 16)}
      </summary>
      <div class="user-actions"><a href="#" id="changePw">Ganti password</a><a href="#" id="mySessions">Sesi &amp; perangkat</a>
        <a href="#" id="foxToggle">${startFox().enabled() ? "Matikan" : "Nyalakan"} rubah</a><a href="#" id="logout">Keluar</a></div>
    </details>`;
  const { group, label } = navInfo(activeKey);
  const company = state.cache.settings?.company_name || "PT AMICO";
  const topbar = document.getElementById("topbar");
  topbar.hidden = false;
  topbar.innerHTML = `
    <div class="crumb"><span>${esc(company)}</span><span class="sep">/</span>${group ? `<span>${esc(group)}</span><span class="sep">/</span>` : ""}<b>${esc(label || "Detail")}</b></div>
    <div class="spacer"></div>
    <span class="avatar small" title="${esc(state.user.display_name)}">${esc(initials(state.user.display_name))}</span>
    ${can("ADMIN", "FINANCE", "OPERATIONAL") ? `<button class="primary" id="topNewJob">${icon("plus", 16)} Job baru</button>` : ""}`;
  document.getElementById("topNewJob")?.addEventListener("click", async () => {
    (await import("./pages/jobs.js")).jobForm();
  });
  document.getElementById("foxToggle").onclick = (e) => {
    e.preventDefault();
    const fox = startFox();
    fox.set(!fox.enabled());
    e.target.textContent = `${fox.enabled() ? "Matikan" : "Nyalakan"} rubah`;
    toast(fox.enabled() ? "Rubah dinyalakan" : "Rubah dimatikan");
  };
  document.getElementById("logout").onclick = async (e) => {
    e.preventDefault();
    await api("POST", "/logout");
    state.user = null;
    location.hash = "#/login";
  };
  document.getElementById("changePw").onclick = (e) => {
    e.preventDefault();
    openModal({
      title: "Ganti password",
      body: `<div class="form-grid"><label>Password lama<input type="password" name="old_password" required></label>
        <label>Password baru (min. 8)<input type="password" name="new_password" minlength="8" required></label></div>`,
      onSubmit: async (d) => {
        await api("POST", "/me/password", d);
        toast("Password diganti. Perangkat lain dikeluarkan, perangkat ini tetap masuk.");
      },
    });
  };
  document.getElementById("mySessions").onclick = (e) => { e.preventDefault(); sessionsModal(); };
}

// Sesi login saya: perangkat / browser yang sedang masuk, keluarkan satu atau semua perangkat lain
async function sessionsModal() {
  const rows = await get("/me/sessions");
  openModal({
    title: "Sesi & perangkat",
    wide: true,
    body: `${table("<th>Perangkat</th><th>IP</th><th>Masuk</th><th>Terakhir dipakai</th><th></th>",
      rows.map((s) => `<tr><td><b>${esc(deviceLabel(s.user_agent))}</b>${s.current ? ` <span class="badge posted">perangkat ini</span>` : ""}</td>
        <td>${esc(s.ip || "-")}</td><td>${jam(s.created_at)}</td><td>${jam(s.last_seen_at)}</td>
        <td>${s.current ? "" : `<button type="button" class="small danger" data-kill="${s.id}">Keluarkan</button>`}</td></tr>`).join(""), "Tidak ada sesi")}
      <div class="note-box">Sesi habis sendiri kalau tidak dipakai beberapa jam. Ada perangkat yang tidak Anda kenal? Keluarkan, lalu ganti password.</div>`,
    extraButtons: rows.length > 1 ? `<button type="button" class="danger" id="killOthers">Keluar dari semua perangkat lain</button>` : "",
    onOpen: (form) => {
      form.querySelectorAll("[data-kill]").forEach((b) => (b.onclick = async () => {
        try { await api("DELETE", `/me/sessions/${b.dataset.kill}`); toast("Perangkat dikeluarkan"); sessionsModal(); } catch (err) { toast(err.message, true); }
      }));
      form.querySelector("#killOthers")?.addEventListener("click", async () => {
        try { const r = await api("POST", "/me/sessions/logout-others"); toast(`${r.removed} perangkat lain dikeluarkan`); sessionsModal(); } catch (err) { toast(err.message, true); }
      });
    },
  });
}

// Akun baru / password direset ADMIN: wajib ganti password dulu sebelum memakai aplikasi
function renderForcePassword() {
  document.getElementById("sidebar").hidden = true;
  document.getElementById("topbar").hidden = true;
  view().innerHTML = `
    <div class="login-box">
      <div class="brand-login"><span class="brand-mark">A</span><b>amico</b><small>ERP v2 · Logistik</small></div>
      <form id="forcePwForm" class="panel">
        <div class="eyebrow">Keamanan akun</div>
        <h2 class="login-title">Ganti password dulu</h2>
        <p class="muted">Halo ${esc(state.user.display_name)}, password Anda dibuat oleh ADMIN. Buat password baru milik Anda sendiri (minimal 8 karakter).</p>
        <label>Password dari ADMIN<input type="password" name="old_password" autocomplete="current-password" required></label>
        <label>Password baru<input type="password" name="new_password" minlength="8" autocomplete="new-password" required></label>
        <label>Ulangi password baru<input type="password" name="again" minlength="8" autocomplete="new-password" required></label>
        <div class="modal-error" id="forcePwError"></div>
        <button class="primary" type="submit">Simpan password</button>
        <a href="#" id="forcePwLogout" class="muted">Keluar</a>
      </form>
    </div>`;
  document.getElementById("forcePwForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = document.getElementById("forcePwError");
    if (f.new_password.value !== f.again.value) { err.textContent = "Password baru tidak sama"; return; }
    try {
      await api("POST", "/me/password", { old_password: f.old_password.value, new_password: f.new_password.value });
      state.user.must_change_password = false;
      await loadMaster();
      toast("Password baru disimpan");
      location.hash = "#/dashboard";
      router();
    } catch (x) { err.textContent = x.message; }
  };
  document.getElementById("forcePwLogout").onclick = async (e) => {
    e.preventDefault();
    await api("POST", "/logout").catch(() => {});
    state.user = null;
    location.hash = "#/login";
    router();
  };
}

function renderLogin() {
  document.getElementById("sidebar").hidden = true;
  document.getElementById("topbar").hidden = true;
  view().innerHTML = `
    <div class="login-box">
      <div class="brand-login"><span class="brand-mark">A</span><b>amico</b><small>ERP v2 · Logistik</small></div>
      <form id="loginForm" class="panel">
        <div class="eyebrow">Masuk</div>
        <h2 class="login-title">Selamat datang kembali</h2>
        <label>Username<input name="username" autocomplete="username" required autofocus></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <div class="modal-error" id="loginError"></div>
        <button class="primary" type="submit">Masuk</button>
      </form>
    </div>`;
  document.getElementById("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      state.user = await api("POST", "/login", { username: f.username.value, password: f.password.value });
      if (state.user.must_change_password) { renderForcePassword(); return; }
      await loadMaster();
      location.hash = "#/dashboard";
    } catch (err) {
      document.getElementById("loginError").textContent = err.message;
    }
  };
}

// Tiap navigasi punya nomor urut. Halaman yang selesai dimuat belakangan padahal pengguna sudah pindah (nomornya sudah lama)
// tidak boleh menggambar atau menampilkan pesan gagal di atas halaman yang baru.
let navSeq = 0;
let lastHash = null;
const SKELETON = { renderJobDetail: "detail", renderMoveDetail: "detail", renderMovePrint: "detail", renderDeliveryPrint: "detail",
  renderJobs: "list", renderSj: "list", renderAr: "list", renderAp: "list", renderDashboard: "list", renderKas: "list", renderPriceCheck: "list" };

async function router() {
  const my = ++navSeq;
  newNavigation();
  const hash = location.hash || "#/dashboard";
  if (!state.user) {
    try {
      state.user = await get("/me");
      if (state.user.must_change_password) return renderForcePassword();
      await loadMaster();
    } catch {
      if (hash !== "#/login") location.hash = "#/login";
      return renderLogin();
    }
  }
  if (hash === "#/login") { location.hash = "#/dashboard"; return; }
  for (const [re, mod, fn, nav] of ROUTES) {
    const m = hash.match(re);
    if (!m) continue;
    document.getElementById("sidebar").hidden = false;
    renderNav(nav);
    // muat ulang halaman yang sama (setelah simpan / aksi): isi lama tetap tampil sampai yang baru siap, posisi gulir dijaga.
    // pindah halaman: tampilkan kerangka (skeleton) dulu.
    const same = hash === lastHash;
    lastHash = hash;
    const scrollY = window.scrollY;
    if (!same) {
      closeModal();
      view().innerHTML = skeleton(SKELETON[fn] || "table");
      window.scrollTo(0, 0);
    }
    // label kecil grup menu di atas judul halaman
    const eyebrow = () => {
      const head = view().querySelector(".page-head");
      const { group } = navInfo(nav);
      if (head && group && !head.querySelector(".eyebrow")) head.insertAdjacentHTML("afterbegin", `<div class="eyebrow">${esc(group)}</div>`);
    };
    try {
      const page = await import(`./pages/${mod}.js`);
      if (my !== navSeq) return;
      const done = page[fn](...m.slice(1));
      eyebrow();          // halaman biasanya langsung menggambar judul, baru memuat data
      await done;
      if (my !== navSeq) return;
      eyebrow();
      if (same) window.scrollTo(0, scrollY);
    } catch (err) {
      if (my !== navSeq) return;
      console.error(err);
      view().innerHTML = `<div class="panel"><b>Gagal memuat</b><p class="muted">${esc(err.message)}</p>
        <button type="button" id="retryPage">Coba lagi</button></div>`;
      document.getElementById("retryPage").onclick = () => { lastHash = null; router(); };
    }
    return;
  }
  location.hash = "#/dashboard";
}

// Tempel tanggal / tanggal-jam gaya Excel ("14/10/2026 03:32") ke kotak tanggal mana pun (gate out / gate in, tanggal job, dst.).
// Kotak tanggal bawaan browser tidak menerima tempelan teks, jadi dibaca di sini lalu diisikan.
const dateBox = (el) => (el instanceof HTMLInputElement && ["datetime-local", "date"].includes(el.type) && !el.disabled && !el.readOnly ? el : null);
function pasteIntoDateBox(el, text) {
  if (!String(text || "").trim()) return;
  const r = parseDateTime(text);
  if (!r) return toast(`Tempelan "${String(text).trim().slice(0, 30)}" tidak terbaca. Formatnya hari/bulan/tahun jam:menit, mis. 14/10/2026 03:32`, true);
  if (el.type === "datetime-local" && !r.time) return toast("Tempelan tidak berisi jam. Contoh: 14/10/2026 03:32", true);
  el.value = el.type === "date" ? r.date : `${r.date}T${r.time}`;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new CustomEvent("amico:pasted", { bubbles: true }));
}
let pasteSeenAt = 0;
document.addEventListener("paste", (e) => {
  const el = dateBox(e.target) || dateBox(document.activeElement);
  if (!el) return;
  pasteSeenAt = Date.now();
  e.preventDefault();
  pasteIntoDateBox(el, e.clipboardData?.getData("text") || "");
});
// cadangan: kalau browser tidak mengirim event "paste" ke kotak tanggal, Ctrl+V dibaca langsung dari clipboard
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "v") return;
  const el = dateBox(document.activeElement);
  if (!el) return;
  const at = Date.now();
  setTimeout(async () => {
    if (pasteSeenAt >= at) return;
    try { pasteIntoDateBox(el, await navigator.clipboard.readText()); } catch {}
  }, 150);
});

window.addEventListener("hashchange", router);
// kesalahan saat memuat ulang dari filter / tombol (di luar router) tetap terlihat, tidak hilang diam-diam
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.message) toast(e.reason.message, true);
});
router();

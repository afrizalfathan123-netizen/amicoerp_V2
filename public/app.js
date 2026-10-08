// ERP AMICO v2: router, menu sesuai role, login.
import { state, api, get, esc, view, toast, loadMaster, openModal, ROLE_LABEL, can, icon } from "./lib.js";

const NAV = [
  { group: "Operasional" },
  { href: "#/dashboard", key: "dashboard", label: "Dashboard" },
  { href: "#/jobs", key: "jobs", label: "Job" },
  { href: "#/tracker", key: "tracker", label: "Tracker" },
  { href: "#/sj", key: "sj", label: "Surat Jalan" },
  { group: "Keuangan" },
  { href: "#/rekap", key: "rekap", label: "Rekap Posisi" },
  { href: "#/invoices", key: "invoices", label: "Invoice Customer" },
  { href: "#/requests", key: "requests", label: "Pengajuan Vendor" },
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
  [/^#\/tracker$/, "tracker", "renderTracker", "tracker"],
  [/^#\/sj$/, "sj", "renderSj", "sj"],
  [/^#\/sj\/deliveries\/(\d+)\/cetak$/, "sj", "renderDeliveryPrint", "sj"],
  [/^#\/rekap$/, "reports", "renderRekap", "rekap"],
  [/^#\/invoices$/, "moves", "renderInvoices", "invoices"],
  [/^#\/requests$/, "moves", "renderRequests", "requests"],
  [/^#\/moves\/(\d+)$/, "moves", "renderMoveDetail", null],
  [/^#\/moves\/(\d+)\/cetak$/, "moves", "renderMovePrint", null],
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
      <div class="user-actions"><a href="#" id="changePw">Ganti password</a><a href="#" id="logout">Keluar</a></div>
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
        toast("Password diganti, silakan login lagi");
        state.user = null;
        location.hash = "#/login";
      },
    });
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
      await loadMaster();
      location.hash = "#/dashboard";
    } catch (err) {
      document.getElementById("loginError").textContent = err.message;
    }
  };
}

async function router() {
  const hash = location.hash || "#/dashboard";
  if (!state.user) {
    try {
      state.user = await get("/me");
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
    view().innerHTML = `<p class="muted">Memuat...</p>`;
    try {
      const page = await import(`./pages/${mod}.js`);
      await page[fn](...m.slice(1));
      // label kecil grup menu di atas judul halaman
      const head = view().querySelector(".page-head");
      const { group } = navInfo(nav);
      if (head && group && !head.querySelector(".eyebrow")) head.insertAdjacentHTML("afterbegin", `<div class="eyebrow">${esc(group)}</div>`);
    } catch (err) {
      view().innerHTML = `<div class="panel"><b>Gagal memuat</b><p class="muted">${esc(err.message)}</p></div>`;
    }
    return;
  }
  location.hash = "#/dashboard";
}

window.addEventListener("hashchange", router);
router();

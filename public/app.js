// ERP AMICO v2: router, menu sesuai role, login.
import { state, api, get, esc, view, toast, loadMaster, openModal, ROLE_LABEL, can } from "./lib.js";

const NAV = [
  { href: "#/dashboard", key: "dashboard", label: "Dashboard" },
  { href: "#/jobs", key: "jobs", label: "Job" },
  { href: "#/tracker", key: "tracker", label: "Tracker" },
  { group: "Keuangan" },
  { href: "#/rekap", key: "rekap", label: "Rekap Posisi" },
  { href: "#/invoices", key: "invoices", label: "Invoice Customer" },
  { href: "#/requests", key: "requests", label: "Pengajuan Vendor" },
  { href: "#/kas", key: "kas", label: "Kas & Rekening" },
  { href: "#/ledger", key: "ledger", label: "Jurnal Kas" },
  { href: "#/utang-piutang", key: "utang-piutang", label: "Utang Piutang" },
  { group: "Pengaturan" },
  { href: "#/master/partners", key: "master", label: "Master Data" },
  { href: "#/users", key: "users", label: "User & Audit", roles: ["ADMIN"] },
];

// [pola hash, modul halaman, fungsi, key menu]
const ROUTES = [
  [/^#\/dashboard$/, "dashboard", "renderDashboard", "dashboard"],
  [/^#\/jobs$/, "jobs", "renderJobs", "jobs"],
  [/^#\/jobs\/(\d+)$/, "jobs", "renderJobDetail", "jobs"],
  [/^#\/tracker$/, "tracker", "renderTracker", "tracker"],
  [/^#\/rekap$/, "reports", "renderRekap", "rekap"],
  [/^#\/invoices$/, "moves", "renderInvoices", "invoices"],
  [/^#\/requests$/, "moves", "renderRequests", "requests"],
  [/^#\/moves\/(\d+)$/, "moves", "renderMoveDetail", null],
  [/^#\/moves\/(\d+)\/cetak$/, "moves", "renderMovePrint", null],
  [/^#\/kas$/, "reports", "renderKas", "kas"],
  [/^#\/ledger$/, "reports", "renderLedger", "ledger"],
  [/^#\/utang-piutang$/, "reports", "renderUtangPiutang", "utang-piutang"],
  [/^#\/master\/([\w-]+)$/, "master", "renderMaster", "master"],
  [/^#\/users$/, "users", "renderUsers", "users"],
];

function renderNav(activeKey) {
  const nav = document.getElementById("nav");
  nav.innerHTML = NAV.filter((n) => !n.roles || can(...n.roles)).map((n) => n.group
    ? `<div class="nav-group">${esc(n.group)}</div>`
    : `<a href="${n.href}" class="${n.key === activeKey ? "active" : ""}">${esc(n.label)}</a>`).join("");
  document.getElementById("userBox").innerHTML = `
    <div><b>${esc(state.user.display_name)}</b><br>${esc(ROLE_LABEL[state.user.role])}</div>
    <div class="user-actions"><a href="#" id="changePw">Ganti password</a> &middot; <a href="#" id="logout">Keluar</a></div>`;
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
  view().innerHTML = `
    <div class="login-box">
      <div class="brand-login">AMICO <span>ERP v2</span></div>
      <form id="loginForm" class="panel">
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
    } catch (err) {
      view().innerHTML = `<div class="panel"><b>Gagal memuat</b><p class="muted">${esc(err.message)}</p></div>`;
    }
    return;
  }
  location.hash = "#/dashboard";
}

window.addEventListener("hashchange", router);
router();

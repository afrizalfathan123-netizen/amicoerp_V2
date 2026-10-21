// User, catatan login & audit (ADMIN)
import { api, get, view, esc, jam, enumOptions, table, toast, openModal, ROLE_LABEL, deviceLabel } from "../lib.js";

const EVENT_LABEL = { LOGIN: "Login", LOGIN_GAGAL: "Login gagal", LOGOUT: "Keluar", KELUAR_SEMUA: "Keluar semua perangkat",
  SESI_DIHAPUS: "Perangkat dikeluarkan", GANTI_PASSWORD: "Ganti password" };

export async function renderUsers() {
  const [users, audit, logins] = await Promise.all([get("/users"), get("/audit"), get("/login-events")]);
  view().innerHTML = `
    <div class="page-head"><h1>User & Audit</h1><div class="spacer"></div><div class="actions"><a class="btn" href="/api/export/semua.xlsx" title="Daftar tabel, kolom, dan isi semua tabel dalam satu file Excel">Export semua data (Excel)</a>
      <button class="primary" id="addUser">+ User baru</button></div></div>
    <div class="note-box"><b>ADMIN</b>: semua + user & pengaturan. <b>FINANCE</b>: invoice customer, menyetujui & membayar pengajuan vendor, batal bayar,
      uang kembali, transfer, master harga. <b>OPERATIONAL</b>: job (cost; selling boleh), tracker / gate / SJ, membuat pengajuan vendor (DP, pelunasan, calo)
      dan pengajuan uang kembali; keuangan hanya lihat. <b>VIEWER</b>: hanya lihat.<br>
      Password dari ADMIN (user baru / reset) adalah password sementara: user wajib menggantinya saat login pertama.</div>
    <div class="panel"><h2>User <span class="hint">klik baris untuk ubah / reset password / keluarkan sesi</span></h2>
      ${table("<th>Username</th><th>Nama</th><th>Role</th><th>Email</th><th>Aktif</th><th>Login terakhir</th><th class=\"num\">Sesi aktif</th><th>Password</th>",
        users.map((u) => `<tr class="click" data-id="${u.id}"><td><b>${esc(u.username)}</b></td><td>${esc(u.display_name)}</td><td>${esc(ROLE_LABEL[u.role])}</td>
          <td>${esc(u.email || "")}</td><td>${u.active ? "Ya" : "-"}</td><td>${jam(u.last_login_at)}</td><td class="num">${u.sesi}</td>
          <td>${u.must_change_password ? `<span class="badge warn">wajib ganti</span>` : ""}</td></tr>`).join(""))}
    </div>
    <div class="panel"><h2>Catatan login <span class="hint">500 terakhir: login, login gagal, keluar, ganti password</span></h2>
      ${table("<th>Waktu</th><th>User</th><th>Kejadian</th><th>Keterangan</th><th>IP</th><th>Perangkat</th>",
        logins.map((e) => `<tr class="${e.event === "LOGIN_GAGAL" ? "rev" : ""}"><td class="nowrap">${jam(e.at)}</td><td>${esc(e.username || "")}</td>
          <td>${esc(EVENT_LABEL[e.event] || e.event)}</td><td class="small-text">${esc(e.note || "")}</td><td>${esc(e.ip || "")}</td>
          <td class="small-text">${esc(deviceLabel(e.user_agent))}</td></tr>`).join(""), "Belum ada")}
    </div>
    <div class="panel"><h2>Audit <span class="hint">300 aktivitas terakhir</span></h2>
      ${table("<th>Waktu</th><th>User</th><th>Data</th><th>Aksi</th><th>Detail</th>",
        audit.map((a) => `<tr><td>${jam(a.at)}</td><td>${esc(a.username || "")}</td><td>${esc(a.entity)} #${a.entity_id ?? ""}</td><td>${esc(a.action)}</td>
          <td class="muted small-text">${esc(JSON.stringify(a.detail || {})).slice(0, 220)}</td></tr>`).join(""))}
    </div>`;
  const form = (u) => openModal({
    title: u ? `Ubah ${u.username}` : "User baru",
    body: `<div class="form-grid">
      ${u ? "" : `<label>Username<input name="username" pattern="[a-z0-9._-]{3,40}" placeholder="huruf kecil, angka, titik" required></label>`}
      <label>Nama<input name="display_name" value="${esc(u?.display_name || "")}" required></label>
      <label>Email<input type="email" name="email" value="${esc(u?.email || "")}"></label>
      <label>Role<select name="role">${enumOptions(ROLE_LABEL, u?.role || "VIEWER")}</select></label>
      <label>${u ? "Reset password (kosongkan kalau tidak diganti)" : "Password sementara (min. 8)"}<input type="password" name="password" ${u ? "" : "required"} minlength="8"></label>
      ${u ? `<label class="check"><input type="checkbox" name="active" ${u.active ? "checked" : ""}> Aktif</label>` : ""}</div>
      <div class="note-box">${u ? "Reset password: user dikeluarkan dari semua perangkat dan wajib mengganti password saat login berikutnya."
        : "User wajib mengganti password ini saat login pertama."}</div>`,
    extraButtons: u && u.sesi ? `<button type="button" class="danger" id="kickUser">Keluarkan dari semua perangkat (${u.sesi})</button>` : "",
    onOpen: (f) => f.querySelector("#kickUser")?.addEventListener("click", async () => {
      try { const r = await api("POST", `/users/${u.id}/logout-all`); toast(`${r.removed} sesi ${u.username} dikeluarkan`); window.dispatchEvent(new Event("hashchange")); }
      catch (err) { toast(err.message, true); }
    }),
    onSubmit: async (d) => {
      if (u) { if (!d.password) delete d.password; await api("PUT", `/users/${u.id}`, d); }
      else await api("POST", "/users", d);
      toast("Tersimpan");
      window.dispatchEvent(new Event("hashchange"));
    },
  });
  document.getElementById("addUser").onclick = () => form(null);
  view().querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => form(users.find((u) => String(u.id) === tr.dataset.id))));
}

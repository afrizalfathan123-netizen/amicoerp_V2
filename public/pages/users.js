// User & audit (ADMIN)
import { api, get, view, esc, jam, enumOptions, table, toast, openModal, ROLE_LABEL } from "../lib.js";

export async function renderUsers() {
  const [users, audit] = await Promise.all([get("/users"), get("/audit")]);
  view().innerHTML = `
    <div class="page-head"><h1>User & Audit</h1><div class="spacer"></div><div class="actions"><button class="primary" id="addUser">+ User baru</button></div></div>
    <div class="note-box">ADMIN: semua + persetujuan pengajuan + user. FINANCE: keuangan & master harga. OPERATIONAL: job, perjalanan, kendaraan (keuangan hanya lihat). VIEWER: hanya lihat.</div>
    <div class="panel"><h2>User</h2>
      ${table("<th>Username</th><th>Nama</th><th>Role</th><th>Email</th><th>Aktif</th><th>Login terakhir</th>",
        users.map((u) => `<tr class="click" data-id="${u.id}"><td><b>${esc(u.username)}</b></td><td>${esc(u.display_name)}</td><td>${esc(ROLE_LABEL[u.role])}</td>
          <td>${esc(u.email || "")}</td><td>${u.active ? "Ya" : "-"}</td><td>${jam(u.last_login_at)}</td></tr>`).join(""))}
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
      <label>${u ? "Password baru (kosongkan kalau tidak diganti)" : "Password (min. 8)"}<input type="password" name="password" ${u ? "" : "required"} minlength="8"></label>
      ${u ? `<label class="check"><input type="checkbox" name="active" ${u.active ? "checked" : ""}> Aktif</label>` : ""}</div>`,
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

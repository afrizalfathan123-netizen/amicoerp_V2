// Export seluruh isi database ke satu file Excel: daftar tabel, daftar kolom (tipe, boleh kosong, default),
// lalu satu sheet per tabel / view laporan. Password & token sesi tidak ikut.
// Dipakai oleh GET /api/export/semua.xlsx (ADMIN) dan scripts/export-all.js.
import ExcelJS from "exceljs";

// [nama, keterangan]. Urutan = urutan sheet.
export const TABLES = [
  ["res_partner", "Partner: customer, vendor, calo dalam satu daftar (pajak, skema bayar default, bill-to)"],
  ["res_partner_bank", "Rekening penerima transfer milik partner (vendor / calo / driver)"],
  ["res_bank_account", "Rekening milik AMICO: BANK dan KAS OPERASIONAL (perantara transfer malam)"],
  ["location", "Lokasi POL / POD"],
  ["vehicle", "Kendaraan (plat, jenis truk, pemilik)"],
  ["product", "Jenis baris order: TRUCKING, CALO, TOL, PARKIR, BONGKAR, LAINNYA, SELISIH"],
  ["pricelist_item", "Price book: selling / cost per rute + truk + trip (customer khusus atau umum, tanggal berlaku)"],
  ["route_sla", "Batas waktu perjalanan per rute (tracker)"],
  ["job", "Job / order: customer, rute, truk, driver, skema bayar per sisi, perjalanan, SJ"],
  ["job_line", "Baris order job = rencana uang: selling, cost truk, calo, tol, dll (side SALE / PURCHASE)"],
  ["trip_update", "Update posisi perjalanan"],
  ["account_move", "Dokumen: invoice customer (out_invoice) / pengajuan vendor (in_invoice), fase DP / SETTLEMENT / FULL / OTHER"],
  ["account_move_line", "Isi dokumen; job_line_id kosong = selisih tanpa tujuan"],
  ["account_payment", "Pembayaran: uang benar-benar masuk / keluar rekening (minus = pembalik)"],
  ["account_payment_line", "Pembagian pembayaran ke baris dokumen"],
  ["internal_transfer", "Pindah uang antar rekening AMICO (dana transfer malam ke kas operasional)"],
  ["jobreg_snapshot", "Salinan angka Excel JOB REGISTRATION per job (untuk perbandingan di halaman Selisih)"],
  ["ir_sequence", "Penomoran dokumen berikutnya per periode"],
  ["app_setting", "Pengaturan aplikasi"],
  ["app_user", "User (password tidak ikut diexport)"],
  ["audit_log", "Riwayat perubahan penting"],
  ["schema_migrations", "Migrasi skema yang sudah dijalankan"],
];
export const VIEWS = [
  ["v_job_balance", "Rekap uang per job: selling, cost, ditagih, diterima, diajukan, dibayar"],
  ["v_job_phase_position", "Posisi per job x sisi x fase: rencana, belum ditagih, belum dibayar"],
  ["v_utang_piutang", "Format sheet UTANG PIUTANG finance"],
  ["v_kurang_transfer", "Kurang transfer / kurang bayar (selisih_kas: + surplus, - minus)"],
  ["v_unassigned", "Selisih tanpa tujuan"],
  ["v_cash_ledger", "Jurnal kas: 1 baris = 1 uang masuk / keluar untuk 1 job"],
  ["v_move_status", "Total, terbayar, sisa per dokumen"],
  ["v_titipan_operasional", "Dana transfer malam di kas operasional yang belum disalurkan"],
  ["v_bank_balance", "Mutasi per rekening AMICO"],
];
const HIDDEN = { app_user: ["password_hash"] };

const style = (ws) => {
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2A1A0E" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (ws.columnCount) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
};
const cell = (v) => (v == null ? null : typeof v === "object" ? JSON.stringify(v) : v);

export async function buildAllExport(db) {
  const wb = new ExcelJS.Workbook();
  const all = [...TABLES.map(([n, d]) => [n, d, "tabel"]), ...VIEWS.map(([n, d]) => [n, d, "view (dihitung)"])];
  const cols = await db.query(
    `select table_name, column_name, data_type, is_nullable, column_default, ordinal_position
     from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`);
  const colsOf = (t) => cols.filter((c) => c.table_name === t && !(HIDDEN[t] || []).includes(c.column_name));

  const list = wb.addWorksheet("DAFTAR TABEL");
  list.columns = [{ header: "SHEET / TABEL", key: "t", width: 24 }, { header: "JENIS", key: "k", width: 16 },
    { header: "KETERANGAN", key: "d", width: 90 }, { header: "JUMLAH BARIS", key: "n", width: 14 }, { header: "JUMLAH KOLOM", key: "c", width: 14 }];
  const kolom = wb.addWorksheet("KOLOM");
  kolom.columns = [{ header: "TABEL", key: "t", width: 24 }, { header: "NO", key: "o", width: 6 }, { header: "KOLOM", key: "c", width: 28 },
    { header: "TIPE", key: "y", width: 26 }, { header: "BOLEH KOSONG", key: "n", width: 14 }, { header: "DEFAULT", key: "d", width: 40 }];

  for (const [name, desc, kind] of all) {
    const c = colsOf(name);
    if (!c.length) continue;   // tabel / view belum ada di database ini
    const rows = await db.query(`select ${c.map((x) => `"${x.column_name}"`).join(", ")} from ${name} order by 1`);
    list.addRow({ t: name, k: kind, d: desc, n: rows.length, c: c.length });
    for (const x of c) kolom.addRow({ t: name, o: x.ordinal_position, c: x.column_name, y: x.data_type, n: x.is_nullable === "YES" ? "ya" : "tidak", d: x.column_default });
    const ws = wb.addWorksheet(name.slice(0, 31));
    ws.columns = c.map((x) => ({ header: x.column_name, key: x.column_name,
      width: Math.max(10, Math.min(x.column_name.length + 2, 40)) }));
    for (const r of rows) ws.addRow(Object.fromEntries(c.map((x) => [x.column_name, cell(r[x.column_name])])));
    // angka bulat (rupiah) pakai pemisah ribuan; persen / desimal dibiarkan apa adanya
    c.forEach((x, i) => {
      if (!["numeric", "bigint"].includes(x.data_type) || x.column_name === "id" || x.column_name.endsWith("_id")) return;
      if (rows.every((r) => r[x.column_name] == null || Number.isInteger(r[x.column_name]))) ws.getColumn(i + 1).numFmt = "#,##0;-#,##0";
    });
    style(ws);
  }
  style(list);
  style(kolom);
  return wb;
}

// Tes pembaca teks WhatsApp untuk form Job baru (public/wa-paste.js). Fungsi murni, tanpa database.
//   node test/wa-paste.test.js
import assert from "node:assert/strict";
import { parseWaJob, parseWaBatch, findPlace, parseDate, parseDateTime, normPlate, normPhone, parseRoute } from "../public/wa-paste.js";

const master = {
  locations: [{ id: 1, code: "JST", name: "Jakarta Selatan" }, { id: 2, code: "SOC", name: "Solo" }, { id: 3, code: "JAT", name: "Jatake" },
    { id: 4, code: "OLD", name: "Lokasi lama", active: false }],
  vehicles: [{ id: 7, plate_number: "B 9263 FXV", truck_type: "CDDL", owner_partner_id: 5 }],
  customers: [{ id: 11, code: "SERYU", name: "SERYU" }, { id: 12, code: "LINTAS", name: "PT Lintas Nusa" }],
  yearNow: 2026,
};
let passed = 0;
const step = (name, fn) => { fn(); passed++; console.log("  ok -", name); };

step("format harian operasional: tanggal, rute, nama, nopol, no hp, kode tugas", () => {
  const r = parseWaJob(`Tanggal : 12/10/2026
Rute.  : JST-SOC (muat-tujuan)
Nama : Ananda
Nopol : H 1234 OC
No hp : 0812131231232
Kode Tugas : jt 000123`, master);
  assert.deepEqual(r.fields, { job_date: "2026-10-12", pol_id: 1, pod_id: 2, driver1_name: "Ananda", plate_number: "H 1234 OC",
    driver1_phone: "0812131231232", do_number: "JT000123" });
  assert.equal(r.warn.length + r.unknown.length, 0);
  assert.ok(r.hasData);
});

step("format customer v1: nama customer di baris pertama, Driver / No tlp, plat dikenali dari master, baris jam", () => {
  const r = parseWaJob(`SERYU

*Rute*   : soc - jat PP
Nopol : b9263fxv
Driver : Budi Santoso
No tlp : +62 812-1111 2222
Driver 2 : Agus
No. HP : 62813 3333 4444
Kode tugas :
20/08/2026 02:26 Selesai loading, otw SOC`, master);
  assert.deepEqual(r.fields, { customer_id: 11, pol_id: 2, pod_id: 3, trip_type: "ROUND_TRIP", plate_number: "B 9263 FXV",
    driver1_name: "Budi Santoso", driver1_phone: "081211112222", driver2_name: "Agus", driver2_phone: "081333334444", job_date: "2026-08-20" });
  assert.equal(r.vehicle.id, 7);          // form mengisi jenis truk & vendor dari kendaraan ini
});

step("yang tidak cocok dengan master diberi catatan, bukan diisi asal", () => {
  const r = parseWaJob(`Rute : JST - MDN
Customer : Tidak Dikenal
Tanggal : 32/13/2026
Catatan : barang pecah belah
Kode Tugas : xxxxxxxxxxxxx`, master);
  assert.deepEqual(r.fields, { pol_id: 1 });
  assert.equal(r.warn.length, 3);          // tujuan MDN, customer, tanggal
  assert.deepEqual(r.unknown, ["Catatan : barang pecah belah"]);
  assert.deepEqual(r.clear, ["pod_id"]);   // POD lama di form dikosongkan, tidak dibiarkan salah
  // lokasi nonaktif tidak dipakai
  assert.equal(parseWaJob("Rute : OLD - SOC", master).fields.pol_id, undefined);
});

step("muat & tujuan di baris terpisah, nama lokasi, jenis truk, 'Unit' berisi plat", () => {
  const r = parseWaJob(`Muat = Jakarta Selatan
Tujuan : solo
Jenis : cddl  long
Unit : D 8123 AB
HP : 81299990000
Supir : Rahmat`, master);
  assert.deepEqual(r.fields, { pol_id: 1, pod_id: 2, truck_type: "CDDL LONG", plate_number: "D 8123 AB", driver1_phone: "081299990000", driver1_name: "Rahmat" });
});

step("bagian kecil: tanggal, plat, HP, rute", () => {
  assert.equal(parseDate("12-10-26"), "2026-10-12");
  assert.equal(parseDate("2026/10/12"), "2026-10-12");
  assert.equal(parseDate("12 Oktober 2026"), "2026-10-12");
  assert.equal(parseDate("5 Okt", 2026), "2026-10-05");
  assert.equal(parseDate("31/02/2026"), "");
  assert.equal(normPlate(" h1234oc "), "H 1234 OC");
  assert.equal(normPlate("B 9420  FXT"), "B 9420 FXT");
  assert.equal(normPhone("+62 812-3456-7890"), "081234567890");
  assert.equal(normPhone("0812 3456 7890"), "081234567890");
  assert.deepEqual(parseRoute("Jakarta ke Solo"), { pol: "JAKARTA", pod: "SOLO", trip: "" });
  assert.deepEqual(parseRoute("JST > SOC ow"), { pol: "JST", pod: "SOC", trip: "ONE_WAY" });
  assert.equal(parseWaJob("halo, unit ready ya", master).hasData, false);
});

step("tempel tanggal-jam gaya Excel / WhatsApp ke kotak gate", () => {
  assert.deepEqual(parseDateTime("14/10/2026 03:32"), { date: "2026-10-14", time: "03:32" });
  assert.deepEqual(parseDateTime("14/10/2026 03:32 Bekasi"), { date: "2026-10-14", time: "03:32" });
  assert.deepEqual(parseDateTime("  5-1-26  7.05 "), { date: "2026-01-05", time: "07:05" });
  assert.deepEqual(parseDateTime("14/10/2026 03:32:59"), { date: "2026-10-14", time: "03:32" });
  assert.deepEqual(parseDateTime("2026-10-14T03:32"), { date: "2026-10-14", time: "03:32" });
  assert.deepEqual(parseDateTime("13/10/2026, pukul 19.53"), { date: "2026-10-13", time: "19:53" });
  assert.deepEqual(parseDateTime("14/10/2026"), { date: "2026-10-14", time: "" });     // tanpa jam: kotak gate menolak, kotak tanggal menerima
  // hari/bulan, bukan bulan/hari: 03/04 = 3 April
  assert.deepEqual(parseDateTime("03/04/2026 10:00"), { date: "2026-04-03", time: "10:00" });
  for (const bad of ["Bekasi", "31/02/2026 10:00", "14/10/2026 25:00", "14/10/2026 10:75", ""]) assert.equal(parseDateTime(bad), null, bad);
  // tahun 3 angka = salah ketik: ditolak, bukan ditebak jadi tanggal lain
  assert.equal(parseDateTime("14/10/202 03:32"), null);
  assert.equal(parseDate("14/10/202"), "");
});

step("absen banyak rit: judul = tujuan, satu baris per RIT, bullet WhatsApp, kode tugas kosong", () => {
  const m = { ...master, locations: [...master.locations, { id: 21, code: "DC KAMAL", name: "DC KAMAL" }, { id: 22, code: "DC MAKASAR", name: "DC MAKASAR" }],
    vehicles: [...master.vehicles, { id: 8, plate_number: "B 9130 FXV", truck_type: "CDDL", owner_partner_id: 6 }] };
  const rit = (n, tgl) => `RIT ${n} :\n  ・Tanggal : ${tgl}\n  ・Nopol : B 9130 FXV\n  ・Nama : DENY\n  ・No Hp : 085289958282\n  ・Kode Tugas:`;
  const r = parseWaBatch(`KAMAL\n\n${rit(3, "15/10/2026")}\n\n${rit(5, "15/10/2026")}\n${rit(1, "16/10/2026")}`, m);
  assert.deepEqual(r.rows.map((x) => [x.rit_number, x.pod_id, x.job_date]), [[3, 21, "2026-10-15"], [5, 21, "2026-10-15"], [1, 21, "2026-10-16"]]);
  assert.deepEqual(r.rows[0], { rit_number: 3, pod_id: 21, pod_text: "KAMAL", job_date: "2026-10-15", plate_number: "B 9130 FXV", do_number: "",
    driver1_name: "DENY", driver1_phone: "085289958282", driver2_name: "", driver2_phone: "", truck_type: "CDDL", vendor_id: 6, known_plate: true, warn: [] });
  assert.equal(r.warn.length, 0);
  // salinan beberapa pesan WhatsApp ("[08.00, 15/10/2026] Admin: ..."), dua tujuan, tanggal bersama di bawah judul, customer di judul
  const r2 = parseWaBatch(`[08.00, 15/10/2026] Admin: SERYU\n[08.00, 15/10/2026] Admin: MAKASAR\nTanggal : 17/10/2026\nRIT 1:\nNopol : B 1 AB\nKode tugas : zx 01\nRIT 2 :\nNopol : B 2 AB\nANTAH\nRIT 1 :\nNopol : B 3 AB`, m);
  assert.equal(r2.customer_id, 11);
  assert.deepEqual(r2.rows.map((x) => [x.rit_number, x.pod_id, x.job_date, x.plate_number, x.do_number, x.known_plate]),
    [[1, 22, "2026-10-17", "B 1 AB", "ZX01", false], [2, 22, "2026-10-17", "B 2 AB", "", false], [1, "", "", "B 3 AB", "", false]]);
  assert.match(r2.warn[0], /ANTAH/);
  assert.equal(findPlace(m.locations, "dc kamal").id, 21);
  assert.equal(findPlace(m.locations, "XY"), null);
});

console.log(`Tempel WhatsApp: ${passed} langkah lulus`);

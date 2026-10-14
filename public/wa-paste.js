// Baca teks WhatsApp ("Label : nilai" per baris) menjadi isian form Job baru.
//
//   Tanggal : 12/10/2026
//   Rute    : JST-SOC
//   Nama    : Ananda            (atau "Driver : ...")
//   Nopol   : H 1234 OC
//   No hp   : 0812131231232
//   Kode Tugas : JT000123
//
// Fungsi murni (tanpa DOM) supaya bisa dites: parseWaJob(teks, { locations, vehicles, customers }).
// Label dibaca longgar: huruf besar / kecil, titik, dan spasi diabaikan ("Rute.", "No. HP", "NOPOL").

const BULAN = { jan: 1, januari: 1, feb: 2, februari: 2, mar: 3, maret: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, jul: 7, juli: 7,
  agu: 8, agt: 8, agustus: 8, aug: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, nov: 11, november: 11, des: 12, desember: 12, dec: 12 };
const key = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const label = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const starts = (l, list) => list.some((x) => l.startsWith(x));
const pad = (n) => String(n).padStart(2, "0");

// "12/10/2026", "12-10-26", "2026-10-12", "12 Oktober 2026", "12 Okt" (tahun kosong = tahun ini) -> "2026-10-12"
export function parseDate(value, yearNow = new Date().getFullYear()) {
  const raw = String(value || "").trim();
  let d, m, y;
  let x = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (x) [, y, m, d] = x;
  else if ((x = raw.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/))) [, d, m, y] = x;
  else if ((x = raw.match(/(\d{1,2})\s+([A-Za-z]+)\.?(?:\s+(\d{2,4}))?/)) && BULAN[x[2].toLowerCase()]) { d = x[1]; m = BULAN[x[2].toLowerCase()]; y = x[3]; }
  else return "";
  if (y && String(y).length === 3) return "";
  y = !y ? yearNow : String(y).length === 2 ? `20${y}` : y;
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(m) - 1 || dt.getDate() !== Number(d)) return "";
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Tanggal + jam dari tempelan Excel / WhatsApp, format hari/bulan/tahun: "14/10/2026 03:32", "14-10-26 3.32", "14/10/2026 03:32:10",
// juga "2026-10-14 03:32" dan teks yang mengandungnya ("14/10/2026 03:32 Bekasi").
// Hasil { date: "2026-10-14", time: "03:32" } (time "" kalau tempelan tanpa jam), atau null kalau tidak terbaca.
export function parseDateTime(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  let y, m, d, hh, mm;
  let x = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T,]+(\d{1,2})[:.](\d{2}))?/);
  if (x) [, y, m, d, hh, mm] = x;
  else if ((x = raw.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T,]+(?:jam |pukul )?(\d{1,2})[:.](\d{2}))?/i))) [, d, m, y, hh, mm] = x;
  else return null;
  if (y.length === 3) return null;
  const date = parseDate(`${y.length === 2 ? `20${y}` : y}-${m}-${d}`);
  if (!date) return null;
  if (hh === undefined) return { date, time: "" };
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  return { date, time: `${pad(hh)}:${mm}` };
}

// "h1234oc" / "H 1234  OC" -> "H 1234 OC"
export function normPlate(value) {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const m = raw.replace(/ /g, "").match(/^([A-Z]{1,2})(\d{1,4})([A-Z]{0,3})$/);
  return m ? [m[1], m[2], m[3]].filter(Boolean).join(" ") : raw;
}

// "+62 812-1312 3123" / "62812..." / "812..." -> "0812..."
export function normPhone(value) {
  let s = String(value || "").replace(/[^\d+]/g, "");
  if (s.startsWith("+62")) s = `0${s.slice(3)}`;
  else if (s.startsWith("62") && s.length >= 10) s = `0${s.slice(2)}`;
  else if (s.startsWith("8") && s.length >= 9) s = `0${s}`;
  return s.replace(/\+/g, "");
}

// "JST-SOC (muat-tujuan)", "JST - SOC PP", "Jakarta ke Solo", "JST > SOC" -> { pol, pod, trip }
export function parseRoute(value) {
  const raw = String(value || "").replace(/\([^)]*\)/g, " ").toUpperCase();
  const trip = /\b(PP|ROUND\s*TRIP|PULANG\s*PERGI)\b/.test(raw) ? "ROUND_TRIP" : /\b(ONE\s*WAY|OW)\b/.test(raw) ? "ONE_WAY" : "";
  const clean = raw.replace(/\b(PP|ROUND\s*TRIP|PULANG\s*PERGI|ONE\s*WAY|OW)\b/g, " ").replace(/\s+/g, " ").trim();
  let parts = clean.split(/\s*(?:-+>?|–|—|→|>|\/|\bKE\b|\bTO\b)\s*/).filter(Boolean);
  if (parts.length < 2) parts = clean.split(" ").filter(Boolean);
  return { pol: parts[0] || "", pod: parts[1] || "", trip };
}

const empty = (v) => !v || /^[x\-_.\s]*$/i.test(v) || /^tidak\s*ada/i.test(v);

export function parseWaJob(text, { locations = [], vehicles = [], customers = [], yearNow } = {}) {
  const fields = {};
  const read = [];      // yang berhasil dibaca (untuk ditampilkan)
  const warn = [];      // terbaca tapi perlu dicek (lokasi tidak ada di master, dst.)
  const unknown = [];   // baris "label : nilai" yang tidak dikenali
  const clear = [];     // disebut di teks tapi tidak cocok dengan master -> kolomnya dikosongkan, jangan menyisakan isi lama
  const drivers = [];
  let pending = -1;
  const findLoc = (v) => locations.find((l) => l.active !== false && (key(l.code) === key(v) || key(l.name) === key(v)));
  const findCust = (v) => customers.find((c) => key(c.name) === key(v) || key(c.code) === key(v));

  for (const line of String(text || "").replace(/\r/g, "").split("\n").map((x) => x.replace(/^[\s*_•\-]+/, "").trim()).filter(Boolean)) {
    // baris jam "20/08/2026 02:26 Selesai loading": tanggalnya dipakai kalau tidak ada baris Tanggal
    const ms = line.match(/^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+\d{1,2}[.:]\d{2}/);
    if (ms) { if (!fields._msDate) fields._msDate = parseDate(ms[1], yearNow); continue; }
    const i = line.search(/[:=]/);
    if (i < 0) {
      // baris tanpa titik dua (mis. "SERYU" di baris pertama) = nama customer kalau cocok dengan master
      const c = findCust(line);
      if (c && !fields.customer_id) { fields.customer_id = c.id; read.push(`customer ${c.name}`); }
      continue;
    }
    const l = label(line.slice(0, i));
    const value = line.slice(i + 1).trim().replace(/^[*_]+|[*_]+$/g, "").trim();
    if (!l) continue;

    const isPol = l === "pol" || starts(l, ["muat", "asal", "origin", "lokasimuat"]);
    const isPod = l === "pod" || starts(l, ["tujuan", "bongkar", "destinasi", "lokasibongkar"]);
    if (isPol || isPod) {
      // muat dan tujuan ditulis di baris terpisah
      if (empty(value)) continue;
      const loc = findLoc(value.replace(/\([^)]*\)/g, " ").trim());
      if (loc) { fields[isPol ? "pol_id" : "pod_id"] = loc.id; read.push(`${isPol ? "muat" : "tujuan"} ${loc.code}`); }
      else { clear.push(isPol ? "pol_id" : "pod_id"); warn.push(`Lokasi ${isPol ? "muat" : "tujuan"} "${value}" belum ada di Master Data > Lokasi, pilih ${isPol ? "POL" : "POD"} sendiri`); }
    } else if (starts(l, ["rute", "route", "trip"])) {
      if (empty(value)) continue;
      const r = parseRoute(value);
      const pol = findLoc(r.pol), pod = findLoc(r.pod);
      if (pol) fields.pol_id = pol.id; else if (r.pol) { clear.push("pol_id"); warn.push(`Lokasi muat "${r.pol}" belum ada di Master Data > Lokasi, pilih POL sendiri`); }
      if (pod) fields.pod_id = pod.id; else if (r.pod) { clear.push("pod_id"); warn.push(`Lokasi tujuan "${r.pod}" belum ada di Master Data > Lokasi, pilih POD sendiri`); }
      if (r.trip) fields.trip_type = r.trip;
      if (pol || pod) read.push(`rute ${pol?.code || "?"} - ${pod?.code || "?"}${r.trip === "ROUND_TRIP" ? " PP" : ""}`);
    } else if (starts(l, ["tanggal", "tgl", "date"])) {
      const d = parseDate(value, yearNow);
      if (d) { fields.job_date = d; read.push(`tanggal ${d}`); } else if (!empty(value)) warn.push(`Tanggal "${value}" tidak terbaca`);
    } else if (starts(l, ["nopol", "plat", "plate", "nomorpolisi", "nopolisi"])) {
      if (empty(value)) continue;
      fields.plate_number = normPlate(value);
      const v = vehicles.find((x) => key(x.plate_number) === key(fields.plate_number));
      if (v) { fields.plate_number = v.plate_number; fields._vehicle = v; }
      read.push(`plat ${fields.plate_number}`);
    } else if (starts(l, ["type", "tipe", "jenis", "unit", "truck", "truk", "armada"])) {
      if (empty(value)) continue;
      // "Unit : B 1234 XX" = plat, bukan jenis truk
      if (/^[A-Z]{1,2}\d{1,4}[A-Z]{0,3}$/.test(key(value)) && /\d/.test(value)) {
        fields.plate_number = normPlate(value);
        const v = vehicles.find((x) => key(x.plate_number) === key(fields.plate_number));
        if (v) { fields.plate_number = v.plate_number; fields._vehicle = v; }
        read.push(`plat ${fields.plate_number}`);
        continue;
      }
      fields.truck_type = value.toUpperCase().replace(/\s+/g, " ");
      read.push(`truk ${fields.truck_type}`);
    } else if (["kode", "do", "nodo", "nomordo"].includes(l) || starts(l, ["kodetugas", "taskcode", "kodedo"])) {
      if (empty(value)) continue;
      fields.do_number = value.replace(/\s+/g, "").toUpperCase();
      read.push(`kode tugas ${fields.do_number}`);
    } else if (l === "wa" || starts(l, ["nohp", "hp", "notlp", "notelp", "tlp", "telp", "telepon", "phone", "nowa", "whatsapp", "kontak", "nomorhp", "nomortelepon"])) {
      if (empty(value)) continue;
      const phone = normPhone(value) || value;
      if (pending >= 0 && !drivers[pending].phone) drivers[pending].phone = phone;
      else { drivers.push({ name: "", phone }); pending = drivers.length - 1; }
    } else if (starts(l, ["customer", "cust", "pelanggan", "namacust", "namapelanggan"])) {
      const c = findCust(value);
      if (c) { fields.customer_id = c.id; read.push(`customer ${c.name}`); } else if (!empty(value)) warn.push(`Customer "${value}" belum ada di master, pilih sendiri`);
    } else if (starts(l, ["driver", "namadriver", "nama", "supir", "sopir", "pengemudi"])) {
      if (empty(value)) continue;
      // nama datang setelah no HP tanpa nama -> pasangkan
      if (pending >= 0 && !drivers[pending].name && drivers[pending].phone) drivers[pending].name = value;
      else { drivers.push({ name: value, phone: "" }); pending = drivers.length - 1; }
    } else unknown.push(line);
  }

  if (!fields.job_date && fields._msDate) { fields.job_date = fields._msDate; read.push(`tanggal ${fields.job_date}`); }
  delete fields._msDate;
  drivers.slice(0, 2).forEach((d, n) => {
    if (d.name) fields[`driver${n + 1}_name`] = d.name;
    if (d.phone) fields[`driver${n + 1}_phone`] = d.phone;
    if (d.name || d.phone) read.push(`driver ${n + 1} ${[d.name, d.phone].filter(Boolean).join(" ")}`);
  });
  if (drivers.length > 2) warn.push(`Ada ${drivers.length} driver di teks, hanya 2 pertama yang dipakai`);
  const vehicle = fields._vehicle || null;
  delete fields._vehicle;
  return { fields, vehicle, read, warn, unknown, clear, hasData: Object.keys(fields).length > 0 };
}

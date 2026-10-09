// Maskot rubah 8-bit yang sesekali lewat di bagian bawah layar (area halaman, bukan sidebar).
// Sprite di fox-sprites.js (menghadap kiri; dibalik saat jalan ke kanan). Tingkahnya acak: jalan, lari, berhenti lalu
// duduk sambil bernapas, menoleh ke pengguna, memandang ke belakang, rebahan / tidur, lompat, mengejar kupu-kupu,
// kadang tersandung. Mata berkedip. Klik rubah saat diam -> senang; saat tidur -> kaget lalu kabur.
// Ikut bereaksi ke notifikasi (toast). Bisa dimatikan dari menu user (per browser). Mengikuti "kurangi animasi" OS.
import { FOX, FOX_PALETTE } from "./fox-sprites.js";

const S = 2;                    // 1 piksel sprite = 2 px layar
const CW = 100, CH = 56;        // kanvas dalam piksel sprite
const CX = 50;                  // kolom jangkar (tengah kepala) di kanvas
const GY = CH - 2;              // baris tanah (baris terbawah sprite)
const E = 3;                    // ukuran piksel balon ekspresi

// ikon di balon (5x5)
const EMO = {
  "!": { c: "#2A1A0E", g: ["..x..", "..x..", "..x..", ".....", "..x.."] },
  "?": { c: "#2A1A0E", g: [".xxx.", "...x.", "..x..", ".....", "..x.."] },
  heart: { c: "#E8798A", g: [".x.x.", "xxxxx", "xxxxx", ".xxx.", "..x.."] },
  z: { c: "#5AA9E6", g: ["xxxx.", "..x..", ".x...", "xxxx.", "....."] },
  note: { c: "#2A1A0E", g: ["..xx.", "..x.x", "..x..", "xxx..", "xx..."] },
  dots: { c: "#2A1A0E", g: [".....", ".....", "x.x.x", ".....", "....."] },
  ok: { c: "#6B8E3D", g: ["....x", "...x.", "x.x..", ".x...", "....."] },
  sweat: { c: "#5AA9E6", g: ["..x..", ".xxx.", "xxxxx", "xxxxx", ".xxx."] },
  coin: { c: "#E0A21B", g: [".xxx.", "xx.xx", "x.x.x", "xx.xx", ".xxx."] },
};
// kupu-kupu 5x4, dua frame (sayap buka / tutup)
const BUTTERFLY = [
  ["g.a.g", "gg.gg", ".gag.", "g...g"],
  ["..a..", ".gag.", ".gag.", "..a.."],
];
const BF_PAL = { g: "#F4AE52", a: "#2A1A0E" };

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (...xs) => xs[Math.floor(Math.random() * xs.length)];

export function startFox() {
  if (window.__fox) return window.__fox;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const KEY = "amico-fox";
  const enabled = () => { try { const v = localStorage.getItem(KEY); return v ? v === "on" : !reduce; } catch { return !reduce; } };

  const layer = document.createElement("div");
  layer.className = "fox-layer";
  layer.setAttribute("aria-hidden", "true");
  const cv = document.createElement("canvas");
  cv.width = CW * S; cv.height = CH * S;
  cv.className = "fox";
  layer.appendChild(cv);
  document.body.appendChild(layer);
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  let fox = null;        // { x, dir, tasks, t, ... } saat sedang tampil
  let timer = null;
  let last = 0;

  // panggung: lebar area halaman (tanpa sidebar), rubah berjalan di tepi bawah layar
  const stage = () => {
    const tb = document.getElementById("topbar");
    const shell = document.querySelector(".shell");
    if (!tb || tb.hidden || !shell) return null;
    const r = shell.getBoundingClientRect();
    return { left: r.left, width: r.width };
  };

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(spawn, ms ?? rnd(25000, 90000));   // jarak muncul tidak pernah sama
  }

  // ------------------------------------------------------------ rencana satu kemunculan
  function plan(g) {
    const dir = Math.random() < 0.5 ? 1 : -1;            // 1 = ke kanan
    const off = 60 * S;
    const startX = dir > 0 ? -off : g.width + off;
    const endX = dir > 0 ? g.width + off : -off;
    const at = (f) => (dir > 0 ? g.width * f : g.width * (1 - f));
    const tasks = [];
    const r = Math.random();
    if (r < 0.14) {
      tasks.push({ type: "move", to: endX, speed: rnd(120, 150), gait: "run", chase: true });
    } else if (r < 0.26) {
      if (Math.random() < 0.5) {     // lari lalu tersandung
        tasks.push({ type: "move", to: at(rnd(0.3, 0.6)), speed: rnd(170, 210), gait: "run" });
        tasks.push({ type: "jump", h: 3, dur: 0.3, speed: 130, frame: "run1" });
        tasks.push({ type: "idle", pose: "lie", dur: 1.3, emote: "sweat" });
        tasks.push({ type: "idle", pose: "front", face: "shock", dur: 0.9, emote: "!" });
        tasks.push({ type: "move", to: endX, speed: rnd(200, 240), gait: "run" });
      } else tasks.push({ type: "move", to: endX, speed: rnd(160, 220), gait: "run" });
    } else {
      const stops = Math.floor(rnd(1, 4));
      const marks = Array.from({ length: stops }, () => rnd(0.15, 0.85)).sort((a, b) => a - b);
      for (const m of marks) {
        tasks.push({ type: "move", to: at(m), speed: rnd(40, 65), gait: Math.random() < 0.2 ? "run" : "walk" });
        tasks.push(...act());
      }
      tasks.push({ type: "move", to: endX, speed: rnd(45, 170), gait: Math.random() < 0.4 ? "run" : "walk" });
    }
    return { x: startX, dir, tasks, t: 0, dist: 0, emote: null, emoteT: 0, blinkT: rnd(1.5, 4), g };
  }

  // satu tingkah saat berhenti
  function act() {
    return pick(
      // duduk santai sambil bernapas, kadang bersenandung
      () => [{ type: "idle", pose: "sit", dur: rnd(3, 5), emote: pick(null, null, "note", "dots", "heart", "coin") }],
      // menoleh ke pengguna
      () => [{ type: "idle", pose: "stand", dur: 0.6 }, { type: "idle", pose: "front", dur: rnd(1.8, 3), emote: pick(null, "?", "heart") }],
      // memandang ke belakang (ke dalam halaman), lalu menoleh
      () => [{ type: "idle", pose: "back", dur: rnd(1.5, 2.5), emote: pick("dots", "?") }, { type: "idle", pose: "front", dur: 1, face: "happy" }],
      // menguap, rebahan, tertidur, kaget bangun
      () => [{ type: "idle", pose: "sit", dur: 1.2 }, { type: "idle", pose: "lie", dur: 1.5 }, { type: "idle", pose: "sleep", dur: rnd(4, 7), emote: "z", zzz: true },
        { type: "idle", pose: "front", face: "shock", dur: 0.8, emote: "!" }],
      // lompat-lompat
      () => Array.from({ length: Math.floor(rnd(1, 4)) }, () => ({ type: "jump", h: rnd(6, 10), dur: 0.42, speed: 0 })),
      // berdiri diam, melihat sekeliling (balik badan sebentar)
      () => [{ type: "idle", pose: "stand", dur: 1 }, { type: "turn" }, { type: "idle", pose: "stand", dur: rnd(0.8, 1.4), emote: "?" }, { type: "turn" }],
      // rebahan sebentar
      () => [{ type: "idle", pose: "lie", dur: rnd(2.5, 4), emote: pick(null, "note") }],
    )();
  }

  function spawn() {
    if (!enabled() || fox) return schedule();
    if (document.hidden) return schedule(rnd(5000, 15000));
    const g = stage();
    if (!g || g.width < 420) return schedule(rnd(10000, 20000));
    fox = plan(g);
    layer.style.left = `${g.left}px`;
    layer.style.width = `${g.width}px`;
    layer.hidden = false;
    last = performance.now();
    requestAnimationFrame(tick);
  }

  function say(emote, dur = 1.6) { if (fox) { fox.emote = emote; fox.emoteT = dur; } }

  // ------------------------------------------------------------ pilih frame sprite
  function frameFor(f, task) {
    const breath = Math.floor(f.t / 0.9) % 2 === 1;          // tarik napas tiap ~0,9 detik
    const blink = f.blinking;
    const v = (base, canBlink = true) => {
      let n = base + (blink && canBlink && FOX[`${base}_blink`] ? "_blink" : "");
      if (breath && FOX[`${n}_in`]) n += "_in";
      return n;
    };
    if (task.type === "move") {
      const cycle = task.gait === "walk" ? 8 : 11;
      return `${task.gait === "walk" ? "walk" : "run"}${(Math.floor(f.dist / cycle) % 4) + 1}`;
    }
    if (task.type === "jump") return task.frame || (f.t / task.dur < 0.15 || f.t / task.dur > 0.85 ? "stand" : "run3");
    if (task.type === "idle") {
      switch (task.pose) {
        case "sit": return v("sit");
        case "lie": return v("lie", false);
        case "sleep": return v("lie_sleep", false);
        case "back": return "back";
        case "front":
          if (task.face === "shock") return "front_shock";
          if (task.face === "happy") return v("front_happy", false);
          return v("front");
        default: return v("stand");
      }
    }
    return "stand";
  }

  // ------------------------------------------------------------ loop animasi
  function tick(now) {
    if (!fox) return;
    // timestamp rAF bisa sedikit lebih awal dari performance.now() -> jangan negatif
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    const f = fox;
    const task = f.tasks[0];
    if (!task) { fox = null; layer.hidden = true; return schedule(); }
    f.t += dt;
    if (f.emoteT > 0 && (f.emoteT -= dt) <= 0) f.emote = null;
    let lift = 0;

    if (task.type === "move") {
      const d = Math.sign(task.to - f.x) || f.dir;
      f.dir = d;
      f.x += d * task.speed * dt;
      f.dist += task.speed * dt / S;
      if (task.chase && Math.random() < 0.01) task.hop = 0.45;       // lompat menangkap kupu-kupu
      if (task.hop > 0) { task.hop -= dt; lift = Math.round(Math.sin((1 - task.hop / 0.45) * Math.PI) * 8); }
      if ((d > 0 && f.x >= task.to) || (d < 0 && f.x <= task.to)) { f.x = task.to; next(); }
    } else if (task.type === "idle") {
      if (task.emote && f.t < 0.05) say(task.emote, task.zzz ? task.dur : Math.min(task.dur, 2.2));
      if (task.zzz) f.emoteT = 1;
      if (f.t >= task.dur) next();
    } else if (task.type === "jump") {
      const p = Math.min(1, f.t / task.dur);
      lift = Math.round(Math.sin(p * Math.PI) * task.h);
      f.x += f.dir * (task.speed || 0) * dt;
      if (p >= 1) next();
    } else if (task.type === "turn") {
      f.dir = -f.dir;
      next();
    }
    // kedip sesekali
    f.blinkT -= dt;
    f.blinking = f.blinkT < 0;
    if (f.blinkT < -0.14) f.blinkT = rnd(2, 5);

    draw(frameFor(f, task), lift, task);
    cv.style.transform = `translate3d(${Math.round(f.x - CX * S)}px, 0, 0)`;
    cv.style.pointerEvents = task.type === "idle" ? "auto" : "none";     // hanya bisa diklik saat diam
    requestAnimationFrame(tick);
  }

  function next() { fox.tasks.shift(); fox.t = 0; }

  function px(x, y, color, size = S) { ctx.fillStyle = color; ctx.fillRect(x * size, y * size, size, size); }

  function draw(name, lift, task) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    const f = fox;
    const spr = FOX[name] || FOX.stand;
    const rows = spr.rows;
    const h = rows.length, w = rows[0].length;
    const top = GY - h + 1 - lift;
    const flip = f.dir > 0;                       // sprite menghadap kiri; ke kanan = dicerminkan
    const left = flip ? CX - (w - 1 - spr.ax) : CX - spr.ax;
    // bayangan saat melompat
    if (lift > 1) for (let x = -8; x <= 8; x++) px(CX + x, GY + 1, "rgba(42,26,14,.16)");
    for (let y = 0; y < h; y++) {
      const r = rows[y];
      for (let x = 0; x < w; x++) {
        const ch = r[x];
        if (ch === ".") continue;
        px(flip ? left + (w - 1 - x) : left + x, top + y, FOX_PALETTE[ch]);
      }
    }
    // kupu-kupu di depan kepala, naik turun
    if (task?.chase) {
      const bf = BUTTERFLY[Math.floor(f.t * 9) % 2];
      const bx = CX + f.dir * (16 + Math.round(Math.sin(f.t * 2.3) * 3)) - 2;
      const by = top + 2 + Math.round(Math.sin(f.t * 6) * 4);
      bf.forEach((r, y) => [...r].forEach((ch, x) => ch !== "." && px(bx + x, by + y, BF_PAL[ch])));
    }
    // balon ekspresi di atas kepala, sedikit ke depan
    if (f.emote && EMO[f.emote] && lift < 4) {
      const e = EMO[f.emote];
      const headX = CX * S + (f.dir > 0 ? 6 : -6) * S;
      const bx0 = Math.round(headX / E) + (f.dir > 0 ? 1 : -8);
      const by0 = Math.max(0, Math.round((top * S) / E) - 8 - (f.emote === "z" ? Math.floor(f.t * 2) % 2 : 0));
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        if ((x === 0 || x === 6) && (y === 0 || y === 6)) continue;
        px(bx0 + x, by0 + y, edge ? "#2A1A0E" : "#FFFFFF", E);
      }
      px(bx0 + (f.dir > 0 ? 1 : 5), by0 + 7, "#2A1A0E", E);
      e.g.forEach((r, y) => [...r].forEach((ch, x) => ch === "x" && px(bx0 + 1 + x, by0 + 1 + y, e.c, E)));
    }
  }

  // ------------------------------------------------------------ interaksi
  cv.addEventListener("click", () => {
    if (!fox) return;
    const task = fox.tasks[0];
    if (task?.type === "idle" && task.pose === "sleep") {
      // dibangunkan: kaget lalu kabur
      fox.emote = null;
      fox.tasks = [{ type: "idle", pose: "front", face: "shock", dur: 0.7, emote: "!" }, { type: "jump", h: 6, dur: 0.32, speed: 0 },
        { type: "move", to: fox.dir > 0 ? fox.g.width + 120 : -120, speed: 230, gait: "run" }];
    } else {
      fox.tasks.unshift({ type: "jump", h: 7, dur: 0.4, speed: 0 }, { type: "idle", pose: "front", face: "happy", dur: 1.6, emote: "heart" });
    }
    fox.t = 0;
  });
  // notifikasi berhasil / gagal -> rubah ikut bereaksi kalau sedang tampil
  window.addEventListener("amico:toast", (e) => {
    if (!fox) return;
    const bad = e.detail?.error;
    say(bad ? "sweat" : "ok", 1.8);
    if (fox.tasks[0]?.type === "idle") {
      fox.tasks.unshift(bad ? { type: "idle", pose: "front", face: "shock", dur: 1.2 }
        : { type: "jump", h: 6, dur: 0.35, speed: 0 }, ...(bad ? [] : [{ type: "idle", pose: "front", face: "happy", dur: 1.2 }]));
      fox.t = 0;
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && fox) last = performance.now(); });

  layer.hidden = true;
  schedule(rnd(6000, 15000));
  const api = {
    enabled,
    set(on) {
      try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {}
      if (!on && fox) { fox = null; layer.hidden = true; }
      if (on) schedule(800);
    },
    now: () => { if (!fox) spawn(); },
  };
  window.__fox = api;
  return api;
}

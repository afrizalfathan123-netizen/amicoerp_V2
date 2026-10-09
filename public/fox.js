// Maskot rubah 8-bit di tepi bawah layar (area halaman, bukan sidebar). Bisa beberapa rubah sekaligus (maks. 3).
// Sprite di fox-sprites.js (menghadap kiri; dibalik saat jalan ke kanan), tiga warna: oranye, putih salju, cokelat.
//
// Kemunculan (jeda acak): sendirian (jalan / lari / berhenti duduk, menoleh, tidur, kejar kupu-kupu, tersandung),
// berdua yang sengaja bertemu di tengah, atau rombongan bertiga. Dua rubah yang berpapasan juga punya peluang berhenti
// dan berinteraksi: menyapa, ngobrol, berbagi koin, tabrakan, tidur bareng, kejar-kejaran.
// Klik rubah saat diam -> senang; saat tidur -> kaget lalu kabur. Ikut bereaksi ke notifikasi (toast).
// Bisa dimatikan dari menu user (per browser). Mengikuti "kurangi animasi" OS.
import { FOX, FOX_PALETTE } from "./fox-sprites.js";

const S = 2;                    // 1 piksel sprite = 2 px layar
const CW = 100, CH = 56;        // kanvas per rubah dalam piksel sprite
const CX = 50;                  // kolom jangkar (tengah kepala) di kanvas
const GY = CH - 2;              // baris tanah
const E = 3;                    // ukuran piksel balon ekspresi
const MAX = 3;                  // rubah tampil bersamaan

// warna: oranye (asli gambar), putih salju, cokelat
const VARIANTS = [
  FOX_PALETTE,
  { a: "#1e2430", b: "#6f7d92", c: "#b9c6d6", d: "#d3dce8", e: "#e9eff6", f: "#c6d0dd", g: "#f6c3cc", h: "#ffffff", i: "#ffffff" },
  { a: "#1a0f0a", b: "#4a2a1c", c: "#8a4a2b", d: "#a85d36", e: "#b86a3e", f: "#d29b78", g: "#f2b8ae", h: "#f6dcc0", i: "#f8e7d2" },
];

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
  laugh: { c: "#2A1A0E", g: ["x.x.x", ".....", "xxxxx", "x...x", ".xxx."] },
};
const BUTTERFLY = [["g.a.g", "gg.gg", ".gag.", "g...g"], ["..a..", ".gag.", ".gag.", "..a.."]];
const BF_PAL = { g: "#F4AE52", a: "#2A1A0E" };

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (...xs) => xs[Math.floor(Math.random() * xs.length)];

// ---------------------------------------------------------------- adegan dua rubah (durasi kedua sisi sama)
const idle = (pose, dur, emote = null, face = null, extra = {}) => ({ type: "idle", pose, dur, emote, face, ...extra });
const SCENES = {
  sapa: () => ({
    a: [idle("stand", 0.4), { type: "jump", h: 6, dur: 0.4, speed: 0 }, idle("sit", 2.4, "heart"), idle("front", 1.2, null, "happy")],
    b: [idle("stand", 0.8, "!"), idle("sit", 2.4, "note"), idle("front", 1.2, null, "happy")],
  }),
  ngobrol: () => ({
    a: [idle("sit", 1.2, "note"), idle("sit", 1.2), idle("sit", 1.2, "?"), idle("sit", 1.2), idle("front", 1.0, "laugh", "happy")],
    b: [idle("sit", 1.2), idle("sit", 1.2, "dots"), idle("sit", 1.2), idle("sit", 1.2, "heart"), idle("front", 1.0, null, "happy")],
  }),
  koin: () => ({
    a: [idle("stand", 0.5), idle("sit", 1.8, "coin"), idle("front", 1.4, "heart", "happy")],
    b: [idle("stand", 0.5), idle("sit", 1.8, "!"), { type: "jump", h: 6, dur: 0.4, speed: 0 }, idle("front", 1.0, "heart", "happy")],
  }),
  tidur: () => ({
    a: [idle("sit", 1.0, "dots"), idle("lie", 1.2), idle("sleep", 4.5, "z", null, { zzz: true }), idle("front", 0.7, "!", "shock"), idle("stand", 0.6)],
    b: [idle("sit", 1.0), idle("lie", 1.2), idle("sleep", 4.5, "z", null, { zzz: true }), idle("sleep", 0.7), idle("front", 0.6, "!", "shock")],
  }),
  tabrakan: () => ({
    a: [idle("front", 0.8, "!", "shock"), { type: "jump", h: 5, dur: 0.35, speed: -70 }, idle("stand", 0.8, "?"), idle("front", 1.2, "laugh", "happy")],
    b: [idle("front", 0.8, "!", "shock"), { type: "jump", h: 5, dur: 0.35, speed: -70 }, idle("stand", 0.8, "dots"), idle("front", 1.2, "laugh", "happy")],
  }),
  // b kabur, a mengejar; keluar ke sisi yang sama
  kejar: () => ({
    a: [idle("stand", 0.7, "!")],
    b: [idle("front", 0.5, "note", "happy"), { type: "turn" }],
    chase: true,
  }),
};

export function startFox() {
  if (window.__fox) return window.__fox;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const KEY = "amico-fox";
  const enabled = () => { try { const v = localStorage.getItem(KEY); return v ? v === "on" : !reduce; } catch { return !reduce; } };

  const layer = document.createElement("div");
  layer.className = "fox-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.hidden = true;
  document.body.appendChild(layer);

  const actors = [];
  let timer = null;
  let running = false;
  let last = 0;
  let stageW = 0;
  let nextId = 1;

  // panggung: lebar area halaman (tanpa sidebar)
  const stage = () => {
    const tb = document.getElementById("topbar");
    const shell = document.querySelector(".shell");
    if (!tb || tb.hidden || !shell) return null;
    const r = shell.getBoundingClientRect();
    return { left: r.left, width: r.width };
  };

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(spawnEvent, ms ?? rnd(15000, 55000));      // jeda acak, tidak pernah sama
  }

  // ------------------------------------------------------------ membuat rubah
  function makeActor(dir, x, pal) {
    const cv = document.createElement("canvas");
    cv.width = CW * S; cv.height = CH * S;
    cv.className = "fox";
    layer.appendChild(cv);
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const a = { id: nextId++, cv, ctx, x, dir, tasks: [], t: 0, dist: 0, emote: null, emoteT: 0, blinkT: rnd(1.5, 4), blinking: false,
      pal: pal || pick(...VARIANTS), met: false, exitX: 0, exitSpeed: 60, exitGait: "walk" };
    cv.addEventListener("click", () => onClick(a));
    actors.push(a);
    return a;
  }
  const offL = () => -60 * S, offR = () => stageW + 60 * S;
  const exitOf = (dir) => (dir > 0 ? offR() : offL());
  const exitTask = (a) => ({ type: "move", to: a.exitX, speed: a.exitSpeed, gait: a.exitGait });

  // satu tingkah saat rubah sendirian berhenti
  function soloAct() {
    return pick(
      () => [idle("sit", rnd(3, 5), pick(null, null, "note", "dots", "heart", "coin"))],
      () => [idle("stand", 0.6), idle("front", rnd(1.8, 3), pick(null, "?", "heart"))],
      () => [idle("back", rnd(1.5, 2.5), pick("dots", "?")), idle("front", 1, null, "happy")],
      () => [idle("sit", 1.2), idle("lie", 1.5), idle("sleep", rnd(4, 7), "z", null, { zzz: true }), idle("front", 0.8, "!", "shock")],
      () => Array.from({ length: Math.floor(rnd(1, 4)) }, () => ({ type: "jump", h: rnd(6, 10), dur: 0.42, speed: 0 })),
      () => [idle("stand", 1), { type: "turn" }, idle("stand", rnd(0.8, 1.4), "?"), { type: "turn" }],
      () => [idle("lie", rnd(2.5, 4), pick(null, "note"))],
    )();
  }

  function spawnSolo() {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const a = makeActor(dir, dir > 0 ? offL() : offR());
    a.exitX = exitOf(dir);
    const at = (f) => (dir > 0 ? stageW * f : stageW * (1 - f));
    const r = Math.random();
    if (r < 0.14) {
      a.tasks.push({ type: "move", to: a.exitX, speed: rnd(120, 150), gait: "run", chase: true });
    } else if (r < 0.26) {
      a.exitSpeed = rnd(170, 230); a.exitGait = "run";
      if (Math.random() < 0.5) {     // lari lalu tersandung
        a.tasks.push({ type: "move", to: at(rnd(0.3, 0.6)), speed: rnd(170, 210), gait: "run" },
          { type: "jump", h: 3, dur: 0.3, speed: 130, frame: "run1" }, idle("lie", 1.3, "sweat"), idle("front", 0.9, "!", "shock"));
      }
      a.tasks.push(exitTask(a));
    } else {
      const marks = Array.from({ length: Math.floor(rnd(1, 4)) }, () => rnd(0.15, 0.85)).sort((x, y) => x - y);
      a.exitSpeed = rnd(45, 170); a.exitGait = a.exitSpeed > 100 ? "run" : "walk";
      for (const m of marks) a.tasks.push({ type: "move", to: at(m), speed: rnd(40, 65), gait: "walk" }, ...soloAct());
      a.tasks.push(exitTask(a));
    }
  }

  // berdua: masuk dari kiri & kanan, tiba bersamaan di tengah, lalu satu adegan
  function spawnDuo(scene) {
    const m = stageW * rnd(0.3, 0.7);
    const A = makeActor(1, offL());
    let pal = pick(...VARIANTS);
    while (pal === A.pal && Math.random() < 0.7) pal = pick(...VARIANTS);
    const B = makeActor(-1, offR(), pal);
    const T = rnd(7, 11);
    const sa = (m - 22 - A.x) / T, sb = (B.x - (m + 22)) / T;
    A.tasks.push({ type: "move", to: m - 22, speed: sa, gait: sa > 90 ? "run" : "walk" });
    B.tasks.push({ type: "move", to: m + 22, speed: sb, gait: sb > 90 ? "run" : "walk" });
    const back = Math.random() < 0.4;                          // setelah adegan: berpapasan terus, atau balik arah
    A.exitX = back ? offL() : offR(); B.exitX = back ? offR() : offL();
    for (const x of [A, B]) { x.exitSpeed = rnd(45, 90); x.exitGait = "walk"; x.met = true; }
    playScene(A, B, scene || pick("sapa", "ngobrol", "koin", "tidur", "tabrakan", "kejar"), true);
    return m;
  }

  // rombongan bertiga berbaris, berhenti duduk bersama, lalu lanjut
  function spawnParade() {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const speed = rnd(45, 65);
    const stop = dir > 0 ? stageW * rnd(0.4, 0.75) : stageW * rnd(0.25, 0.6);
    const em = ["note", "?", "heart"];
    for (let k = 0; k < 3; k++) {
      const gap = k * 75;
      const a = makeActor(dir, dir > 0 ? offL() - gap : offR() + gap, k === 0 ? VARIANTS[0] : pick(...VARIANTS));
      a.exitX = exitOf(dir);                  // semua keluar ke sisi yang sama
      a.exitSpeed = speed; a.met = true;
      a.tasks.push({ type: "move", to: stop - dir * gap, speed, gait: "walk" },
        idle("sit", 1 + k * 0.4), idle("sit", 2.6 - k * 0.4, em[k]), idle("front", 1.2, null, "happy"), exitTask(a));
    }
  }

  // jalankan adegan dua rubah. pre = rubah masih berjalan menuju titik temu (tugas sebelumnya tetap)
  function playScene(A, B, name, pre = false) {
    const sc = SCENES[name]();
    const faceEach = () => {
      const d = Math.sign(B.x - A.x) || 1;
      return [{ type: "face", dir: d }, { type: "face", dir: -d }];
    };
    const [fa, fb] = pre ? [{ type: "faceTo", other: B }, { type: "faceTo", other: A }] : faceEach();
    const keepA = pre ? A.tasks.slice(0, 1) : [];
    const keepB = pre ? B.tasks.slice(0, 1) : [];
    A.met = B.met = true;
    if (sc.chase) {
      // b kabur ke arah membelakangi a; a mengejar; keluar ke sisi yang sama
      const away = () => (Math.sign(B.x - A.x) || 1) > 0 ? offR() : offL();
      A.tasks = [...keepA, fa, ...sc.a, { type: "moveDyn", target: away, speed: 175, gait: "run" }];
      B.tasks = [...keepB, fb, ...sc.b, { type: "moveDyn", target: away, speed: 195, gait: "run" }];
    } else {
      A.tasks = [...keepA, fa, ...sc.a, exitTask(A)];
      B.tasks = [...keepB, fb, ...sc.b, exitTask(B)];
    }
    if (!pre) { A.t = 0; B.t = 0; }
  }

  function spawnEvent() {
    if (!enabled()) return schedule();
    if (document.hidden) return schedule(rnd(5000, 15000));
    const g = stage();
    if (!g || g.width < 420) return schedule(rnd(10000, 20000));
    stageW = g.width;
    layer.style.left = `${g.left}px`;
    layer.style.width = `${g.width}px`;
    const free = MAX - actors.length;
    if (free <= 0) return schedule(rnd(6000, 12000));
    const r = Math.random();
    if (r < 0.12 && free >= 3) spawnParade();
    else if (r < 0.42 && free >= 2) spawnDuo();
    else spawnSolo();
    start();
    schedule();
  }

  function start() {
    layer.hidden = false;
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(tick);
  }

  function say(a, emote, dur = 1.6) { a.emote = emote; a.emoteT = dur; }

  // ------------------------------------------------------------ pilih frame sprite
  function frameFor(a, task) {
    if (!task) return "stand";
    const breath = Math.floor(a.t / 0.9) % 2 === 1;
    const v = (base, canBlink = true) => {
      let n = base + (a.blinking && canBlink && FOX[`${base}_blink`] ? "_blink" : "");
      if (breath && FOX[`${n}_in`]) n += "_in";
      return n;
    };
    if (task.type === "move" || task.type === "moveDyn") {
      const cycle = task.gait === "walk" ? 8 : 11;
      return `${task.gait === "walk" ? "walk" : "run"}${(Math.floor(a.dist / cycle) % 4) + 1}`;
    }
    if (task.type === "jump") return task.frame || (a.t / task.dur < 0.15 || a.t / task.dur > 0.85 ? "stand" : "run3");
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

  // ------------------------------------------------------------ satu langkah satu rubah
  function step(a, dt) {
    const task = a.tasks[0];
    if (!task) return false;
    a.t += dt;
    if (a.emoteT > 0 && (a.emoteT -= dt) <= 0) a.emote = null;
    a.lift = 0;
    if (task.type === "move" || task.type === "moveDyn") {
      if (task.type === "moveDyn" && task.to == null) task.to = task.target();
      const d = Math.sign(task.to - a.x) || a.dir;
      a.dir = d;
      a.x += d * task.speed * dt;
      a.dist += (task.speed * dt) / S;
      if (task.chase && Math.random() < 0.01) task.hop = 0.45;
      if (task.hop > 0) { task.hop -= dt; a.lift = Math.round(Math.sin((1 - task.hop / 0.45) * Math.PI) * 8); }
      if ((d > 0 && a.x >= task.to) || (d < 0 && a.x <= task.to)) { a.x = task.to; next(a); }
    } else if (task.type === "idle") {
      if (task.emote && a.t < 0.05) say(a, task.emote, task.zzz ? task.dur : Math.min(task.dur, 2.2));
      if (task.zzz) a.emoteT = 1;
      if (a.t >= task.dur) next(a);
    } else if (task.type === "jump") {
      const p = Math.min(1, a.t / task.dur);
      a.lift = Math.round(Math.sin(p * Math.PI) * task.h);
      a.x += a.dir * (task.speed || 0) * dt;
      if (p >= 1) next(a);
    } else if (task.type === "turn") {
      a.dir = -a.dir; next(a);
    } else if (task.type === "face") {
      a.dir = task.dir; next(a);
    } else if (task.type === "faceTo") {
      a.dir = Math.sign(task.other.x - a.x) || a.dir; next(a);
    }
    a.blinkT -= dt;
    a.blinking = a.blinkT < 0;
    if (a.blinkT < -0.14) a.blinkT = rnd(2, 5);
    return true;
  }
  function next(a) { a.tasks.shift(); a.t = 0; }

  // dua rubah berpapasan -> peluang berhenti dan berinteraksi
  function encounters() {
    for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
      const A = actors[i], B = actors[j];
      if (A.met || B.met) continue;
      const ta = A.tasks[0], tb = B.tasks[0];
      if (!ta || !tb || ta.chase || tb.chase) continue;
      const dx = B.x - A.x;
      if (Math.abs(dx) > 60) continue;
      const aToward = ta.type === "move" && Math.sign(dx) === A.dir;
      const bToward = tb.type === "move" && Math.sign(-dx) === B.dir;
      if (!aToward && !bToward) continue;
      A.met = B.met = true;                                    // satu kali kesempatan per pasangan
      if (Math.random() < 0.7) {
        const both = aToward && bToward;
        playScene(A, B, both ? pick("tabrakan", "sapa", "ngobrol", "koin", "kejar") : pick("sapa", "ngobrol", "koin", "tidur"));
      }
    }
  }

  // ------------------------------------------------------------ loop animasi
  function tick(now) {
    // timestamp rAF bisa sedikit lebih awal dari performance.now() -> jangan negatif
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    try {
      for (const a of [...actors]) {
        // tugas habis -> rubah sudah keluar layar, hapus
        if (!step(a, dt) || !a.tasks.length) { a.cv.remove(); actors.splice(actors.indexOf(a), 1); }
      }
      encounters();
    } catch (err) {
      console.error("rubah:", err);
    }
    for (const a of actors) {
      draw(a, frameFor(a, a.tasks[0]), a.lift || 0, a.tasks[0]);
      a.cv.style.transform = `translate3d(${Math.round(a.x - CX * S)}px, 0, 0)`;
      a.cv.style.zIndex = String(10 + Math.round(a.id % 7));
      a.cv.style.pointerEvents = a.tasks[0]?.type === "idle" ? "auto" : "none";     // hanya bisa diklik saat diam
    }
    if (!actors.length) { running = false; layer.hidden = true; return; }
    requestAnimationFrame(tick);
  }

  function draw(a, name, lift, task) {
    const { ctx, pal } = a;
    const px = (x, y, color, size = S) => { ctx.fillStyle = color; ctx.fillRect(x * size, y * size, size, size); };
    ctx.clearRect(0, 0, a.cv.width, a.cv.height);
    const spr = FOX[name] || FOX.stand;
    const rows = spr.rows;
    const h = rows.length, w = rows[0].length;
    const top = GY - h + 1 - lift;
    const flip = a.dir > 0;                       // sprite menghadap kiri; ke kanan = dicerminkan
    const left = flip ? CX - (w - 1 - spr.ax) : CX - spr.ax;
    if (lift > 1) for (let x = -8; x <= 8; x++) px(CX + x, GY + 1, "rgba(42,26,14,.16)");
    for (let y = 0; y < h; y++) {
      const r = rows[y];
      for (let x = 0; x < w; x++) {
        const ch = r[x];
        if (ch === ".") continue;
        px(flip ? left + (w - 1 - x) : left + x, top + y, pal[ch]);
      }
    }
    if (task?.chase) {
      const bf = BUTTERFLY[Math.floor(a.t * 9) % 2];
      const bx = CX + a.dir * (16 + Math.round(Math.sin(a.t * 2.3) * 3)) - 2;
      const by = top + 2 + Math.round(Math.sin(a.t * 6) * 4);
      bf.forEach((r, y) => [...r].forEach((ch, x) => ch !== "." && px(bx + x, by + y, BF_PAL[ch])));
    }
    if (a.emote && EMO[a.emote] && lift < 4) {
      const e = EMO[a.emote];
      const headX = CX * S + (a.dir > 0 ? 6 : -6) * S;
      const bx0 = Math.round(headX / E) + (a.dir > 0 ? 1 : -8);
      const by0 = Math.max(0, Math.round((top * S) / E) - 8 - (a.emote === "z" ? Math.floor(a.t * 2) % 2 : 0));
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        if ((x === 0 || x === 6) && (y === 0 || y === 6)) continue;
        px(bx0 + x, by0 + y, edge ? "#2A1A0E" : "#FFFFFF", E);
      }
      px(bx0 + (a.dir > 0 ? 1 : 5), by0 + 7, "#2A1A0E", E);
      e.g.forEach((r, y) => [...r].forEach((ch, x) => ch === "x" && px(bx0 + 1 + x, by0 + 1 + y, e.c, E)));
    }
  }

  // ------------------------------------------------------------ interaksi pengguna
  function onClick(a) {
    const task = a.tasks[0];
    if (!task) return;
    const rest = a.tasks.filter((t) => t.type === "move" || t.type === "moveDyn").slice(-1);
    if (task.type === "idle" && task.pose === "sleep") {
      a.emote = null;
      a.tasks = [idle("front", 0.7, "!", "shock"), { type: "jump", h: 6, dur: 0.32, speed: 0 },
        { type: "move", to: a.dir > 0 ? offR() : offL(), speed: 230, gait: "run" }];
    } else {
      a.tasks.unshift({ type: "jump", h: 7, dur: 0.4, speed: 0 }, idle("front", 1.6, "heart", "happy"));
      if (!rest.length) a.tasks.push(exitTask(a));
    }
    a.t = 0;
  }
  window.addEventListener("amico:toast", (e) => {
    const bad = e.detail?.error;
    for (const a of actors) {
      say(a, bad ? "sweat" : "ok", 1.8);
      if (a.tasks[0]?.type === "idle") {
        a.tasks.unshift(...(bad ? [idle("front", 1.2, null, "shock")] : [{ type: "jump", h: 6, dur: 0.35, speed: 0 }, idle("front", 1.2, null, "happy")]));
        a.t = 0;
      }
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && running) last = performance.now(); });

  schedule(rnd(5000, 12000));
  const api = {
    enabled,
    set(on) {
      try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {}
      if (!on) { for (const a of actors) a.cv.remove(); actors.length = 0; layer.hidden = true; }
      if (on) schedule(800);
    },
    now: () => spawnEvent(),
    // untuk uji: paksa satu jenis kemunculan ("solo" | "duo" | "parade"), adegan duo opsional (mis. "sapa")
    demo: (kind = "duo", scene) => {
      const g = stage(); if (!g) return;
      stageW = g.width; layer.style.left = `${g.left}px`; layer.style.width = `${g.width}px`;
      const out = ({ solo: spawnSolo, duo: spawnDuo, parade: spawnParade })[kind]?.(scene);
      start();
      return out;
    },
  };
  window.__fox = api;
  return api;
}

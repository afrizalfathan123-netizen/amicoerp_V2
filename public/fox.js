// Maskot rubah 8-bit yang sesekali lewat di atas garis topbar.
// Digambar pixel per pixel di <canvas> (tanpa gambar luar), tingkahnya acak: jalan, lari, duduk, kedip, menguap, tidur,
// lompat, menengok, mengejar kupu-kupu, kadang tersandung. Klik rubah -> bereaksi. Ikut bereaksi ke notifikasi (toast).
// Bisa dimatikan dari menu user (disimpan per browser). Mengikuti "kurangi animasi" di pengaturan OS.

const S = 3;                    // 1 pixel sprite = 3 px layar
const W = 30, H = 30;           // kanvas dalam pixel sprite; rubah 24x16 ditaruh di (OX, OY)
const OX = 3, OY = 14, FEET = 12;
const PAL = {
  o: "#2A1A0E", k: "#2A1A0E", n: "#2A1A0E", r: "#D4621A", d: "#A8470F", c: "#FEF3E2", a: "#F4AE52",
  p: "#E8798A", w: "#FFFFFF", g: "#6B8E3D", b: "#5AA9E6", y: "#F4C542",
};

// ---------------------------------------------------------------- sprite (menghadap kanan)
const STAND = [
  "........................",
  ".................o...o..",
  ".occo...........oro.oro.",
  ".occo...........orrrrrro",
  "orrrro.........orrrrkrro",
  "orrrrro........orrrccccn",
  ".orrrrrooooooooorccccco.",
  "..orrrorrrrrrrrrccccco..",
  "...oo.orrrrrrrrcccco....",
  "......orrrrrcccccco.....",
  "......oddooooooddo......",
  "......oddo....oddo......",
  "......oooo....oooo......",
  "........................",
  "........................",
  "........................",
];
// duduk tegak: badan vertikal di bawah kepala, ekor melingkar di tanah
const SIT = [
  "........................",
  ".................o...o..",
  "................oro.oro.",
  "................orrrrrro",
  "...............orrrrkrro",
  "...............orrrccccn",
  "..............orrccccco.",
  ".............orrrrcccco.",
  "............orrrrrcccco.",
  "..oo.......orrrrrrcccco.",
  ".occo.....orrrrrrrrcdco.",
  "orrrrrrrrrrrrrrrrrrodo..",
  ".oooooooooooooooooooooo.",
  "........................",
  "........................",
  "........................",
];
const SLEEP = [
  "........................", "........................", "........................", "........................",
  "........................", "........................",
  ".........o...o..........",
  "........oro.oro.........",
  ".......orrrrrrrooooo....",
  "......orrrrrrrrrrrrro...",
  ".....orrdrrrrrrrrrrrro..",
  ".....orrrrccccccccccco..",
  "......ooooooooooooooo...",
  "........................", "........................", "........................",
];
// variasi: ganti beberapa baris / titik
const rows = (base, over) => base.map((r, i) => (over[i] !== undefined ? over[i] : r));
const dot = (base, list) => base.map((r, y) => {
  const a = r.split("");
  for (const [x, yy, ch] of list) if (yy === y) a[x] = ch;
  return a.join("");
});
const LEGS_B = { 11: ".....oddo......oddo.....", 12: ".....oooo......oooo....." };   // kaki terbuka
const LEGS_C = { 11: ".......oddooddo.........", 12: ".......oooooooo........." };   // kaki rapat
const TAIL_UP = { 2: "..occo..........oro.oro.", 3: "..occo..........orrrrrro", 4: ".orrrro........orrrrkrro" };
const BLINK = [[20, 4, "d"]];
const YAWN = [[20, 4, "d"], [20, 6, "o"], [21, 6, "p"]];
const FR = {
  stand: STAND, walkB: rows(STAND, LEGS_B), walkC: rows(STAND, LEGS_C),
  sit: SIT, sleep: SLEEP,
};
const frame = (name, { blink, yawn, tail } = {}) => {
  let f = FR[name];
  if (tail && name !== "sleep" && name !== "sit") f = rows(f, TAIL_UP);
  if (yawn) f = dot(f, YAWN);
  else if (blink && name !== "sleep") f = dot(f, BLINK);
  return f;
};

// ikon di balon (5x5)
const EMO = {
  "!": { c: "o", g: ["..x..", "..x..", "..x..", ".....", "..x.."] },
  "?": { c: "o", g: [".xxx.", "...x.", "..x..", ".....", "..x.."] },
  heart: { c: "p", g: [".x.x.", "xxxxx", "xxxxx", ".xxx.", "..x.."] },
  z: { c: "b", g: ["xxxx.", "..x..", ".x...", "xxxx.", "....."] },
  note: { c: "o", g: ["..xx.", "..x.x", "..x..", "xxx..", "xx..."] },
  dots: { c: "o", g: [".....", ".....", "x.x.x", ".....", "....."] },
  ok: { c: "g", g: ["....x", "...x.", "x.x..", ".x...", "....."] },
  sweat: { c: "b", g: ["..x..", ".xxx.", "xxxxx", "xxxxx", ".xxx."] },
  coin: { c: "y", g: [".xxx.", "xx.xx", "x.x.x", "xx.xx", ".xxx."] },
};
const BUTTERFLY = [["a.a", ".o.", "a.a"], [".a.", ".o.", ".a."]];

// ---------------------------------------------------------------- mesin tingkah
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
  cv.width = W * S; cv.height = H * S;
  cv.className = "fox";
  cv.title = "Hai!";
  layer.appendChild(cv);
  document.body.appendChild(layer);
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  let fox = null;        // { x, dir, tasks, t, ... } saat sedang tampil
  let timer = null;
  let last = 0;

  const ground = () => {
    const tb = document.getElementById("topbar");
    if (!tb || tb.hidden) return null;
    const r = tb.getBoundingClientRect();
    return { left: r.left, width: r.width, y: r.bottom };
  };

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(spawn, ms ?? rnd(25000, 90000));   // jarak muncul tidak pernah sama
  }

  // rencana satu kemunculan
  function plan(g) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const startX = dir > 0 ? -W * S : g.width + 4;
    const endX = dir > 0 ? g.width + 4 : -W * S;
    const at = (f) => (dir > 0 ? g.width * f : g.width * (1 - f));
    const tasks = [];
    const r = Math.random();
    if (r < 0.12) {
      // kejar kupu-kupu
      tasks.push({ type: "chase", to: endX, speed: rnd(110, 150) });
    } else if (r < 0.24) {
      // lari kencang, kadang tersandung
      if (Math.random() < 0.45) {
        tasks.push({ type: "move", to: at(rnd(0.3, 0.6)), speed: rnd(170, 220), gait: "run" });
        tasks.push({ type: "jump", h: 4, dur: 0.35, speed: 120 });
        tasks.push({ type: "idle", pose: "sleep", dur: 1.4, emote: "sweat" });
        tasks.push({ type: "idle", pose: "stand", dur: 0.7, emote: "!" });
        tasks.push({ type: "move", to: endX, speed: rnd(200, 240), gait: "run" });
      } else tasks.push({ type: "move", to: endX, speed: rnd(160, 230), gait: "run" });
    } else {
      // jalan santai dengan 1-3 kali berhenti
      const stops = Math.floor(rnd(1, 4));
      const marks = Array.from({ length: stops }, () => rnd(0.15, 0.85)).sort((a, b) => a - b);
      for (const m of marks) {
        tasks.push({ type: "move", to: at(m), speed: rnd(38, 70), gait: Math.random() < 0.25 ? "run" : "walk" });
        tasks.push(...act());
      }
      tasks.push({ type: "move", to: endX, speed: rnd(45, 160), gait: Math.random() < 0.4 ? "run" : "walk" });
    }
    return { x: startX, y: 0, dir, tasks, t: 0, frameT: 0, step: 0, emote: null, emoteT: 0, blinkT: rnd(1, 3), g };
  }

  // satu tingkah saat berhenti
  function act() {
    return pick(
      () => [{ type: "idle", pose: "sit", dur: rnd(2.5, 4.5), tail: true }],
      () => [{ type: "idle", pose: "sit", dur: rnd(2.5, 4), emote: pick("note", "dots", "?", "heart", "coin") }],
      () => [{ type: "idle", pose: "stand", dur: 0.8 }, { type: "turn" }, { type: "idle", pose: "stand", dur: rnd(0.6, 1.2), emote: "?" }, { type: "turn" }],
      () => [{ type: "idle", pose: "sit", dur: 1.2 }, { type: "idle", pose: "sit", dur: 1.4, yawn: true }, { type: "idle", pose: "sleep", dur: rnd(4, 7), emote: "z", zzz: true }, { type: "idle", pose: "stand", dur: 0.6, emote: "!" }],
      () => Array.from({ length: Math.floor(rnd(1, 4)) }, () => ({ type: "jump", h: rnd(5, 9), dur: 0.42, speed: 0 })),
      () => [{ type: "idle", pose: "stand", dur: rnd(1.5, 3), tail: true, emote: Math.random() < 0.5 ? "note" : null }],
      () => [{ type: "idle", pose: "sit", dur: 1.5, yawn: true }, { type: "idle", pose: "sit", dur: 1.5 }],
    )();
  }

  function spawn() {
    if (!enabled() || fox) return schedule();
    if (document.hidden) return schedule(rnd(5000, 15000));
    const g = ground();
    if (!g || g.width < 360) return schedule(rnd(10000, 20000));
    fox = plan(g);
    layer.style.left = `${g.left}px`;
    layer.style.width = `${g.width}px`;
    layer.style.top = `${g.y - (OY + FEET + 1) * S}px`;
    layer.hidden = false;
    last = performance.now();
    requestAnimationFrame(tick);
  }

  function say(emote, dur = 1.6) { if (fox) { fox.emote = emote; fox.emoteT = dur; } }

  function tick(now) {
    if (!fox) return;
    // timestamp rAF bisa sedikit lebih awal dari performance.now() saat muncul -> jangan sampai negatif
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    const f = fox;
    const task = f.tasks[0];
    if (!task) { fox = null; layer.hidden = true; return schedule(); }
    f.t += dt;
    let pose = "stand", opts = {}, lift = 0;
    if (f.emoteT > 0 && (f.emoteT -= dt) <= 0) f.emote = null;

    if (task.type === "move" || task.type === "chase") {
      const d = Math.sign(task.to - f.x) || f.dir;
      f.dir = d;
      f.x += d * task.speed * dt;
      f.frameT += task.speed * dt;
      const stride = task.gait === "walk" ? 7 : 11;
      const cycle = task.gait === "walk" ? ["stand", "walkB", "stand", "walkC"] : ["walkB", "stand", "walkC", "stand"];
      pose = cycle[Math.floor(f.frameT / stride) % 4];
      if (task.gait !== "walk" && pose === "walkB") lift = 1;           // lari: badan sedikit naik
      opts.tail = Math.floor(f.frameT / 18) % 2 === 0;
      if (task.type === "chase") {
        if (Math.random() < 0.012) task.hop = 0.4;                        // lompat menangkap
        if (task.hop > 0) { task.hop -= dt; lift = Math.round(Math.sin((1 - task.hop / 0.4) * Math.PI) * 7); pose = "walkB"; }
      }
      if ((d > 0 && f.x >= task.to) || (d < 0 && f.x <= task.to)) { f.x = task.to; next(); }
    } else if (task.type === "idle") {
      pose = task.pose;
      if (task.emote && f.t < 0.05) say(task.emote, task.zzz ? task.dur : Math.min(task.dur, 2.2));
      if (task.zzz) { f.emoteT = 1; if (Math.floor(f.t * 1.2) % 2) opts.breath = true; }
      opts.tail = task.tail && Math.floor(f.t * 3) % 2 === 0;
      opts.yawn = task.yawn && f.t > 0.3 && f.t < task.dur - 0.2;
      if (f.t >= task.dur) next();
    } else if (task.type === "jump") {
      const p = Math.min(1, f.t / task.dur);
      lift = Math.round(Math.sin(p * Math.PI) * task.h);
      pose = p < 0.15 || p > 0.85 ? "stand" : "walkB";
      f.x += f.dir * (task.speed || 0) * dt;
      if (p >= 1) next();
    } else if (task.type === "turn") {
      f.dir = -f.dir;
      next();
    }
    // kedip sesekali
    f.blinkT -= dt;
    if (f.blinkT < 0) { opts.blink = true; if (f.blinkT < -0.12) f.blinkT = rnd(1.5, 4); }

    draw(pose, opts, lift, task);
    cv.style.transform = `translate3d(${Math.round(f.x)}px, 0, 0)`;
    cv.style.pointerEvents = task.type === "idle" ? "auto" : "none";     // hanya bisa diklik saat diam
    requestAnimationFrame(tick);
  }

  function next() { fox.tasks.shift(); fox.t = 0; }

  function px(x, y, color) { ctx.fillStyle = color; ctx.fillRect(x * S, y * S, S, S); }

  function draw(pose, opts, lift, task) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    const f = fox;
    const spr = frame(pose, opts);
    const oy = OY - lift;
    for (let y = 0; y < spr.length; y++) {
      const row = spr[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === ".") continue;
        const sx = f.dir > 0 ? OX + x : OX + (23 - x);
        px(sx, oy + y + (pose === "sleep" && opts.breath && y < 9 ? 1 : 0), PAL[ch]);
      }
    }
    // bayangan kecil di tanah saat melompat
    if (lift > 1) for (let x = 9; x < 18; x++) px(f.dir > 0 ? OX + x : OX + 23 - x, OY + FEET + 1, "rgba(42,26,14,.18)");
    // kupu-kupu
    // kupu-kupu: selalu sedikit di depan kepala, naik turun
    if (task?.type === "chase") {
      const bf = BUTTERFLY[Math.floor(f.t * 8) % 2];
      const bx = Math.round((f.dir > 0 ? OX + 23 : OX - 3) + Math.sin(f.t * 3) * 2);
      const by = Math.round(OY - 2 + Math.sin(f.t * 7) * 3);
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
        const ch = bf[y][x];
        if (ch !== ".") px(bx + x, by + y, ch === "a" ? PAL.a : PAL.o);
      }
    }
    // balon ekspresi di atas kepala
    if (f.emote && EMO[f.emote] && lift < 3) {
      const e = EMO[f.emote];
      const bx = f.dir > 0 ? OX + 19 : OX - 2, by = OY - 8 - (f.emote === "z" ? Math.floor(f.t * 2) % 2 : 0);
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        const corner = (x === 0 || x === 6) && (y === 0 || y === 6);
        if (corner) continue;
        px(bx + x, by + y, edge ? PAL.o : PAL.w);
      }
      px(bx + (f.dir > 0 ? 1 : 5), by + 7, PAL.o);   // ekor balon
      e.g.forEach((r, y) => [...r].forEach((ch, x) => ch === "x" && px(bx + 1 + x, by + 1 + y, PAL[e.c])));
    }
  }

  // klik rubah: senang / kaget kalau sedang tidur
  cv.addEventListener("click", () => {
    if (!fox) return;
    const task = fox.tasks[0];
    if (task?.type === "idle" && task.pose === "sleep") {
      // dibangunkan: kaget lalu kabur
      fox.emote = null;
      fox.tasks = [{ type: "jump", h: 7, dur: 0.35, speed: 0 }, { type: "idle", pose: "stand", dur: 0.6, emote: "!" },
        { type: "move", to: fox.dir > 0 ? fox.g.width + 4 : -W * S, speed: 230, gait: "run" }];
    } else {
      fox.tasks.unshift({ type: "jump", h: 6, dur: 0.4, speed: 0 }, { type: "idle", pose: "sit", dur: 1.6, emote: "heart" });
    }
    fox.t = 0;
  });
  // notifikasi berhasil / gagal -> rubah ikut bereaksi kalau sedang tampil
  window.addEventListener("amico:toast", (e) => {
    if (!fox) return;
    say(e.detail?.error ? "sweat" : "ok", 1.8);
    if (!e.detail?.error && fox.tasks[0]?.type === "idle") { fox.tasks.unshift({ type: "jump", h: 5, dur: 0.35, speed: 0 }); fox.t = 0; }
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

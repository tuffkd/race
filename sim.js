// sim.js — pure, deterministic, fixed-step (1/60). No Math.random/Date. Shared by client+server.
// Input per tick: {steer:-1..1, jump:bool}. jump = FRESH PRESS EDGE only (client latches keydown, ignores key-repeat).
(function (g) {
  const C = { speed: 23, flightMul: 1.3, steer: 2.9, grip: 7, air: 2, gravity: 42, jumpV: 21, rampJump: 0.2,
    flightLift: 24, flightDamp: 2, flightSink: 3, rollTime: 0.6, fallDelay: 0.7, regen: 0, coyote: 4, buffer: 5,
    bump: 1.4, rest: 0.6, carR: 1.3 };
  const DEFAULTS = Object.assign({}, C);
  const S = 0.75, SQ = Math.sqrt(3), CH = 1.2; // hex corner radius; car height for ceiling checks
  const hexXZ = (q, r) => [S * SQ * (q + r / 2), S * 1.5 * r];
  function xzHex(x, z) {
    const q = (SQ / 3 * x - z / 3) / S, r = 2 / 3 * z / S, s = -q - r;
    let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
    const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
    return [rq, rr];
  }
  const key = (q, r) => (q + 128) * 256 + (r + 128);

  // Floating hex platform {x,z,r(circumradius),top,th,o}. o=0 vertex along z, o=1 vertex along x. Open underneath.
  // Modular: Phase 3 outer platforms are just entries with top=0.
  function hexN(p, x, z) { // -> [penetration depth (>0 inside), outward normal x, z]
    let ux = x - p.x, uz = z - p.z;
    if (p.o) { const t = ux; ux = uz; uz = t; }
    const dx = Math.abs(ux), dz = Math.abs(uz), d1 = dx, d2 = 0.5 * dx + 0.866025 * dz, sx = ux < 0 ? -1 : 1, sz = uz < 0 ? -1 : 1;
    let nx, nz;
    if (d1 >= d2) { nx = sx; nz = 0; } else { nx = sx * 0.5; nz = sz * 0.866025; }
    if (p.o) { const t = nx; nx = nz; nz = t; }
    return [p.r * 0.866025 - Math.max(d1, d2), nx, nz];
  }
  const hexIn = (p, x, z) => hexN(p, x, z)[0];

  // st: G=grounded A=airborne(flight available) F=flight D=dropped(no flight until landing)
  // gt=frames since grounded, buf=frames left on buffered jump press
  const car = (id, x, z, yaw, mass, drive = true) => ({ id, x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw, mass, drive,
    st: 'G', gt: 0, buf: 0, roll: 0, rollT: -1, rollDir: 0, rise: 0 });

  function create(o = {}) {
    const w = { t: 0, cfg: C, tiles: new Map(), list: [], active: [], queue: [], qh: 0, redLog: [], fallLog: [], regenLog: [],
      ramps: o.ramps || [], plats: (o.plats || []).map(p => Object.assign({ th: 0.7, o: 0 }, p)), cars: [] };
    const N = o.radius || 36;
    for (let q = -N; q <= N; q++)
      for (let r = Math.max(-N, -q - N); r <= Math.min(N, -q + N); r++) {
        const [x, z] = hexXZ(q, r), t = { i: w.list.length, q, r, x, z, s: 0, t: 0, ft: 0 }; // s:0 idle 1 red 2 fallen
        w.tiles.set(key(q, r), t); w.list.push(t);
      }
    return w;
  }

  function groundY(w, c) {
    let h = -Infinity;
    if (c.y >= -0.5) { // floor + ramps only support cars from above (no snapping up from the abyss)
      const t = w.tiles.get(key(...xzHex(c.x, c.z)));
      if (t && t.s < 2) h = 0;
      for (const p of w.ramps) {
        const d = Math.max(Math.abs(c.x - p.x), Math.abs(c.z - p.z));
        if (d < p.hw) h = Math.max(h, p.h * (1 - d / p.hw));
      }
    }
    for (const p of w.plats) // standable only from above; passable from below (open underneath)
      if (c.y >= p.top - 0.5 && hexIn(p, c.x, c.z) > 0) h = Math.max(h, p.top);
    return h;
  }

  // Single touchdown path: ANY surface contact fully resets the jump FSM to GROUNDED.
  const land = (c, y) => { c.y = y; c.vy = 0; c.st = 'G'; c.rise = 0; c.rollT = -1; c.roll = 0; c.gt = 0; };

  function stepCar(w, c, inp, dt) {
    const K = w.cfg, st = inp.steer || 0, y0 = c.y;
    if (c.buf > 0) c.buf--;
    const hop = () => { c.vy = K.jumpV + K.rampJump * Math.max(c.rise, 0); c.st = 'A'; c.rise = 0; c.gt = 99; c.buf = 0;
      c.rollDir = st; c.rollT = st ? 0 : -1; };
    if (inp.jump) {
      if (c.st === 'G' || (c.st === 'A' && c.gt <= K.coyote)) hop(); // grounded, or just left ground (coyote window)
      else {
        const g0 = groundY(w, c);
        if (K.buffer > 0 && c.vy <= 0 && g0 > -Infinity && c.y - g0 <= Math.max(0.6, -c.vy * K.buffer * dt)) c.buf = K.buffer + 1; // landing imminent: queue ground jump
        else if (c.st === 'A') { c.st = 'F'; c.vy = Math.max(c.vy, K.flightLift); }
        else if (c.st === 'F') c.st = 'D';
      }
    }
    c.yaw -= st * K.steer * dt;
    const sp = c.drive ? K.speed * (c.st === 'F' ? K.flightMul : 1) : 0;
    const k = Math.min(1, (c.st === 'G' ? K.grip : K.air) * dt);
    c.vx += (Math.sin(c.yaw) * sp - c.vx) * k;
    c.vz += (Math.cos(c.yaw) * sp - c.vz) * k;
    if (c.st === 'F') c.vy += (-K.flightSink - c.vy) * Math.min(1, K.flightDamp * dt);
    else if (c.st !== 'G') c.vy -= K.gravity * dt;
    c.x += c.vx * dt; c.z += c.vz * dt;
    const gy = groundY(w, c);
    if (c.st === 'G') {
      if (gy === -Infinity || (gy < c.y - 0.05 && (c.rise > 1 || c.y - gy > 0.8))) {
        c.st = 'A'; c.vy = Math.max(c.rise, 0); // ramp/edge launch keeps flight available
        c.y += c.vy * dt;
      } else { c.rise = (gy - c.y) / dt; c.y = gy; }
    } else {
      c.y += c.vy * dt;
      if (gy > -Infinity && c.y <= gy) { land(c, gy); if (c.buf > 0) hop(); } // buffered press fires as ground jump
    }
    // platform slab (underside..top): head-bump from below, side push when entering horizontally
    for (const p of w.plats) {
      const under = p.top - p.th;
      if (c.y >= p.top - 0.5 || c.y + CH <= under) continue;
      const [dep, nx, nz] = hexN(p, c.x, c.z);
      if (dep <= 0) continue;
      if (y0 + CH <= under + 1e-6) { c.y = under - CH; if (c.vy > 0) c.vy = 0; }
      else {
        c.x += nx * dep; c.z += nz * dep;
        const vn = c.vx * nx + c.vz * nz; if (vn < 0) { c.vx -= vn * nx; c.vz -= vn * nz; }
      }
    }
    if (c.rollT >= 0) {
      c.rollT += dt; c.roll = 6.2832 * Math.min(c.rollT / K.rollTime, 1) * c.rollDir;
      if (c.rollT >= K.rollTime) { c.rollT = -1; c.roll = 0; }
    }
    if (c.st === 'G' && c.y < 0.1) { // 4 wheel contact points
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      for (const [a, b] of [[.6, 1], [-.6, 1], [.6, -1], [-.6, -1]]) {
        const t = w.tiles.get(key(...xzHex(c.x + fz * a + fx * b, c.z - fx * a + fz * b)));
        if (t && t.s === 0) { t.s = 1; t.t = K.fallDelay; w.active.push(t); w.redLog.push(t); }
      }
    }
    c.gt = c.st === 'G' ? 0 : Math.min(99, c.gt + 1);
  }

  function step(w, inputs, dt) {
    const K = w.cfg, cs = w.cars;
    w.t += dt;
    for (const c of cs) stepCar(w, c, inputs[c.id] || {}, dt);
    let n = 0;
    for (const t of w.active) {
      if ((t.t -= dt) <= 0) { t.s = 2; t.ft = w.t; w.fallLog.push(t); w.queue.push(t); } else w.active[n++] = t;
    }
    w.active.length = n;
    if (K.regen > 0) { // respawn fallen tiles oldest-first; regen=0 keeps them gone (shrinking arena)
      while (w.qh < w.queue.length && w.t - w.queue[w.qh].ft >= K.regen) { const t = w.queue[w.qh++]; t.s = 0; w.regenLog.push(t); }
      if (w.qh > 2048) { w.queue.splice(0, w.qh); w.qh = 0; }
    }
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j];
      if (Math.abs(a.y - b.y) > 1.5) continue;
      let dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz), m = 2 * K.carR;
      if (d >= m || d === 0) continue;
      dx /= d; dz /= d;
      const o = m - d, ia = 1 / a.mass, ib = 1 / b.mass, sm = ia + ib;
      a.x -= dx * o * ia / sm; a.z -= dz * o * ia / sm; b.x += dx * o * ib / sm; b.z += dz * o * ib / sm;
      const vn = (b.vx - a.vx) * dx + (b.vz - a.vz) * dz;
      if (vn < 0) { // Phase 4 hooks: Smash = mass/bump up, Shield = zero a-side displacement
        const J = -(1 + K.rest) * vn / sm * K.bump;
        a.vx -= J * ia * dx; a.vz -= J * ia * dz; b.vx += J * ib * dx; b.vz += J * ib * dz;
      }
    }
  }

  const hash = w => JSON.stringify([w.t, w.cars, w.list.map(t => t.s)]);
  const api = { C, DEFAULTS, S, car, create, step, hash, hexXZ, xzHex, groundY, hexIn };
  if (typeof module !== 'undefined') module.exports = api; else g.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);

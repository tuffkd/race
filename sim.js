// sim.js — pure, deterministic, fixed-step (1/60). No Math.random/Date. Shared by client+server.
(function (g) {
  const C = { speed: 23, flightMul: 1.3, steer: 2.9, grip: 7, air: 2, gravity: 42, jumpV: 21, rampJump: 0.35,
    flightLift: 24, flightDamp: 2, flightSink: 3, rollTime: 0.6, fallDelay: 0.7, bump: 1.4, rest: 0.6, carR: 1.3 };
  const DEFAULTS = Object.assign({}, C);
  const S = 0.75, SQ = Math.sqrt(3); // hex corner radius; width 1.3 / tip-to-tip 1.5 vs car length 3.2
  const hexXZ = (q, r) => [S * SQ * (q + r / 2), S * 1.5 * r];
  function xzHex(x, z) {
    const q = (SQ / 3 * x - z / 3) / S, r = 2 / 3 * z / S, s = -q - r;
    let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
    const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
    return [rq, rr];
  }
  const key = (q, r) => (q + 128) * 256 + (r + 128);

  // st: G=grounded A=airborne(flight available) F=flight D=dropped(no flight until landing)
  const car = (id, x, z, yaw, mass, drive = true) => ({ id, x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw, mass, drive,
    st: 'G', jp: false, roll: 0, rollT: -1, rollDir: 0, rise: 0 });

  function create(o = {}) {
    const w = { t: 0, cfg: C, tiles: new Map(), list: [], active: [], redLog: [], fallLog: [],
      ramps: o.ramps || [], plats: o.plats || [], cars: [] };
    const N = o.radius || 72;
    for (let q = -N; q <= N; q++)
      for (let r = Math.max(-N, -q - N); r <= Math.min(N, -q + N); r++) {
        const [x, z] = hexXZ(q, r), t = { i: w.list.length, q, r, x, z, s: 0, t: 0, ft: 0 }; // s:0 idle 1 red 2 fallen
        w.tiles.set(key(q, r), t); w.list.push(t);
      }
    return w;
  }

  function groundY(w, c) {
    let h = -Infinity;
    const t = w.tiles.get(key(...xzHex(c.x, c.z)));
    if (t && t.s < 2) h = 0;
    for (const p of w.ramps) { // axis-aligned 4-sided pyramid
      const d = Math.max(Math.abs(c.x - p.x), Math.abs(c.z - p.z));
      if (d < p.hw) h = Math.max(h, p.h * (1 - d / p.hw));
    }
    for (const p of w.plats)
      if (Math.abs(c.x - p.x) < p.hw && Math.abs(c.z - p.z) < p.hw && c.y >= p.top - 0.5) h = Math.max(h, p.top);
    return h;
  }

  function stepCar(w, c, inp, dt) {
    const K = w.cfg, st = inp.steer || 0, edge = !!inp.jump && !c.jp;
    c.jp = !!inp.jump;
    c.yaw -= st * K.steer * dt;
    if (edge) {
      if (c.st === 'G') { c.vy = K.jumpV + K.rampJump * Math.max(c.rise, 0); c.st = 'A'; c.rise = 0; c.rollDir = st; if (st) c.rollT = 0; }
      else if (c.st === 'A') { c.st = 'F'; c.vy = Math.max(c.vy, K.flightLift); }
      else if (c.st === 'F') c.st = 'D';
    }
    const sp = c.drive ? K.speed * (c.st === 'F' ? K.flightMul : 1) : 0;
    const k = Math.min(1, (c.st === 'G' ? K.grip : K.air) * dt);
    c.vx += (Math.sin(c.yaw) * sp - c.vx) * k;
    c.vz += (Math.cos(c.yaw) * sp - c.vz) * k;
    if (c.st === 'F') c.vy += (-K.flightSink - c.vy) * Math.min(1, K.flightDamp * dt);
    else if (c.st !== 'G') c.vy -= K.gravity * dt;
    c.x += c.vx * dt; c.z += c.vz * dt;
    for (const p of w.plats) { // platform side walls (below top surface)
      const dx = c.x - p.x, dz = c.z - p.z;
      if (Math.abs(dx) < p.hw && Math.abs(dz) < p.hw && c.y < p.top - 0.5) {
        const ox = p.hw - Math.abs(dx), oz = p.hw - Math.abs(dz);
        if (ox < oz) { c.x += (dx < 0 ? -ox : ox); c.vx = 0; } else { c.z += (dz < 0 ? -oz : oz); c.vz = 0; }
      }
    }
    const gy = groundY(w, c);
    if (c.st === 'G') {
      if (gy === -Infinity || (gy < c.y - 0.05 && (c.rise > 1 || c.y - gy > 0.8))) {
        c.st = 'A'; c.vy = Math.max(c.rise, 0); // ramp launch keeps flight available
        c.y += c.vy * dt;
      } else { c.rise = (gy - c.y) / dt; c.y = gy; }
    } else {
      c.y += c.vy * dt;
      if (gy > -Infinity && c.y <= gy && c.vy <= 0) { c.y = gy; c.vy = 0; c.st = 'G'; c.rise = 0; c.rollT = -1; c.roll = 0; }
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
  }

  function step(w, inputs, dt) {
    const K = w.cfg, cs = w.cars;
    w.t += dt;
    for (const c of cs) stepCar(w, c, inputs[c.id] || {}, dt);
    let n = 0;
    for (const t of w.active) { if ((t.t -= dt) <= 0) { t.s = 2; t.ft = w.t; w.fallLog.push(t); } else w.active[n++] = t; }
    w.active.length = n;
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
  const api = { C, DEFAULTS, S, car, create, step, hash, hexXZ, xzHex, groundY };
  if (typeof module !== 'undefined') module.exports = api; else g.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);

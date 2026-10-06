// sim.js — pure, deterministic, fixed-step (1/60). No Math.random/Date. Shared by client+server.
// Input per tick: {steer:-1..1, jump:bool}. jump = FRESH PRESS EDGE only (client latches keydown, ignores key-repeat).
(function (g) {
  const C = {
    // ---- RAMMING / BUMP TUNING (vehicle-to-vehicle) ----
    baseBumpForce: 30,         // minimum shove of a head-on hit (scaled down for glancing hits)
    speedToForceRatio: 0.5,    // extra force per unit of the ATTACKER's speed toward the target
    defenderKnockbackMult: 2.2, // multiplier on that force, applied to the DEFENDER's velocity
    attackerRecoil: 0.20,      // share of the attacker's forward speed lost on impact (0.20 = keeps 80%)
    // ---- movement ----
    speed: 23, flightMul: 1.6, steer: 2.9, grip: 7, air: 2, gravity: 42, jumpV: 21, rampJump: 0.2,
    flightLift: 24, flightDamp: 2, flightSink: 9, rollTime: 0.6, fallDelay: 0.7, regen: 5, regenOff: false, coyote: 7, buffer: 10, flightLock: 8,
    carR: 1.3 };
  const DEFAULTS = Object.assign({}, C);
  const ELIM_Y = -12; // below this a car is ELIMINATED (fell into the void)
  const S = 0.75, SQ = Math.sqrt(3), CH = 1.2, LEDGE = 1.0; // LEDGE: cars whose bottom is within 1u of a platform top mount it (no pixel-perfect jumps); // hex corner radius; car height for ceiling checks
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

  // st: G=grounded  J=jumping (ground jump pressed; the ONLY airborne state that can fly)  F=flight  D=dropped from flight
  //     C=coyote (just left a surface without jumping; a jump press within K.coyote frames = full ground/ramp jump)
  //     X=falling (coyote expired: jump/fly do nothing)
  // gs=frames since last grounded, hopped=ground jump used this flight, buf=frames left on buffered press, ev=last jump decision
  // decay=false (dummy bots) -> this car never triggers tile decay
  const car = (id, x, z, yaw, mass, drive = true, decay = true) => ({ id, x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw, mass, drive, decay,
    st: 'G', gs: 0, ev: '', evT: 0, buf: 0, bcd: 0, alive: true, sp: { x, z, yaw }, roll: 0, rollT: -1, rollDir: 0, rise: 0 });

  function create(o = {}) {
    const w = { t: 0, cfg: C, tiles: new Map(), list: [], active: [], queue: [], qh: 0, redLog: [], fallLog: [], regenLog: [],
      ramps: o.ramps || [], plats: (o.plats || []).map(p => Object.assign({ th: 0.7, o: 0 }, p)), cars: [], scores: {}, round: { phase: 'play', winner: null, t: 0 } };
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
      if (c.y >= p.top - LEDGE && hexIn(p, c.x, c.z) > 0) h = Math.max(h, p.top);
    return h;
  }

  // Single touchdown path: ANY surface contact fully resets the jump FSM to GROUNDED.
  const land = (c, y) => { c.y = y; c.vy = 0; c.st = 'G'; c.rise = 0; c.rollT = -1; c.roll = 0; c.gs = 0; };

  // Look ahead n ticks along the current trajectory: will the car touch ANY surface (floor, ramp slope, platform top)?
  // Needed because ramps/platforms rise toward a car that is still gliding above them.
  function willLand(w, c, n, dt) {
    const K = w.cfg, p = { x: c.x, y: c.y, z: c.z }; let vy = c.vy;
    const g0 = groundY(w, p); if (c.vy <= 0 && g0 > -Infinity && p.y - g0 <= 0.6) return true;
    for (let i = 0; i < n; i++) {
      p.x += c.vx * dt; p.z += c.vz * dt;
      const gy = groundY(w, p);
      vy = c.st === 'F' ? vy + (-K.flightSink - vy) * Math.min(1, K.flightDamp * dt) : vy - K.gravity * dt;
      p.y += vy * dt;
      if (gy > -Infinity && p.y <= gy) return true;
    }
    return false;
  }

  function stepCar(w, c, inp, dt) {
    const K = w.cfg, st = inp.steer || 0, y0 = c.y;
    if (c.buf > 0) c.buf--;
    if (c.bcd > 0) c.bcd--;
    if (c.evT > 0 && --c.evT === 0) c.ev = '';
    const hop = ev => { c.vy = K.jumpV + K.rampJump * Math.max(c.rise, 0); c.st = 'J'; c.rise = 0; c.gs = 0; c.buf = 0;
      c.rollDir = st; c.rollT = st ? 0 : -1; c.ev = ev; c.evT = 40; };
    if (inp.jump) { // fresh press, consumed exactly once. Decision order:
      if (c.st === 'G') hop('HOP');
      else if (c.st === 'C') hop('COYOTE'); // grace window after leaving a ramp crest / ledge: full normal jump (incl. ramp bonus)
      else {
        if (K.buffer > 0 && willLand(w, c, K.buffer, dt)) { c.buf = K.buffer + 1; c.ev = 'BUFFERED'; c.evT = 40; } // landing imminent -> ground jump on touchdown
        else if (c.st === 'J') { // flight ONLY from JUMPING
          if (c.gs <= K.flightLock) { c.ev = 'BLOCKED'; c.evT = 40; } // too soon after the hop: swallowed, never pops wings
          else { c.st = 'F'; c.vy = Math.max(c.vy, K.flightLift); c.ev = 'FLIGHT'; c.evT = 40; }
        }
        else if (c.st === 'F') { c.st = 'D'; c.ev = 'DROP'; c.evT = 40; }
        else { c.ev = 'NO-FLY'; c.evT = 40; } // FALLING / DROPPED: jump does nothing
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
      // Momentum detach: if the car's upward ground speed (c.rise) would carry it above the surface this tick
      // (ramp crest, ramp lip, plateau), it leaves the ground with that velocity instead of snapping down.
      const yb = c.y + c.rise * dt - 0.5 * K.gravity * dt * dt;
      if (gy === -Infinity || c.y - gy > 0.8 || (c.rise > 2 && yb > gy + 0.02)) {
        c.st = K.coyote > 0 ? 'C' : 'X'; c.vy = Math.max(c.rise, 0); // left the surface without a jump: coyote window, then FALLING
        c.y += c.vy * dt;
      } else { c.rise = (gy - c.y) / dt; c.y = gy; }
    } else {
      c.y += c.vy * dt;
      if (gy > -Infinity && c.y <= gy) { land(c, gy); if (c.buf > 0) hop('LAND-HOP'); } // buffered press fires as ground jump
    }
    // platform slab (underside..top): head-bump from below, side push when entering horizontally
    for (const p of w.plats) {
      const under = p.top - p.th;
      if (c.y >= p.top - LEDGE || c.y + CH <= under) continue;
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
    if (c.decay && c.st === 'G' && c.y < 0.1) { // 4 wheel contact points (only decaying cars)
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      for (const [a, b] of [[.6, 1], [-.6, 1], [.6, -1], [-.6, -1]]) {
        const t = w.tiles.get(key(...xzHex(c.x + fz * a + fx * b, c.z - fx * a + fz * b)));
        if (t && t.s === 0) { t.s = 1; t.t = K.fallDelay; w.active.push(t); w.redLog.push(t); }
      }
    }
    c.gs = c.st === 'G' ? 0 : Math.min(999, c.gs + 1);
    if (c.st === 'C' && c.gs > K.coyote) c.st = 'X'; // coyote expired -> true FALLING (jump input locked out)
  }

  function step(w, inputs, dt) {
    const K = w.cfg, cs = w.cars;
    w.t += dt;
    for (const c of cs) if (c.alive) stepCar(w, c, inputs[c.id] || {}, dt);
    for (const c of cs) if (c.alive && c.y < ELIM_Y) { c.alive = false; c.vx = c.vy = c.vz = 0; } // eliminated: frozen, no collisions/decay
    judgeRound(w);
    let n = 0;
    for (const t of w.active) {
      if ((t.t -= dt) <= 0) { t.s = 2; t.ft = w.t; w.fallLog.push(t); w.queue.push(t); } else w.active[n++] = t;
    }
    w.active.length = n;
    if (!K.regenOff && K.regen > 0) { // respawn fallen tiles oldest-first after K.regen seconds; regenOff = permanent destruction
      while (w.qh < w.queue.length && w.t - w.queue[w.qh].ft >= K.regen) { const t = w.queue[w.qh++]; t.s = 0; w.regenLog.push(t); }
      if (w.qh > 2048) { w.queue.splice(0, w.qh); w.qh = 0; }
    }
    // ---- asymmetric, velocity-weighted ramming ----
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j];
      if (!a.alive || !b.alive || Math.abs(a.y - b.y) > 1.5) continue;
      let nx = b.x - a.x, nz = b.z - a.z; const d = Math.hypot(nx, nz), m2 = 2 * K.carR;
      if (d >= m2 || d === 0) continue;
      nx /= d; nz /= d; // a -> b
      const o = m2 - d; // separation: the car that gets hit is moved out of the way more than the rammer
      const sa = a.vx * nx + a.vz * nz, sb = -(b.vx * nx + b.vz * nz); // each car's speed toward the other
      const A = sa >= sb ? a : b, D = A === a ? b : a, mx = A === a ? nx : -nx, mz = A === a ? nz : -nz; // A = attacker, m = A->D
      A.x -= mx * o * 0.2; A.z -= mz * o * 0.2; D.x += mx * o * 0.8; D.z += mz * o * 0.8;
      const rvx = A.vx - D.vx, rvz = A.vz - D.vz, closing = rvx * mx + rvz * mz; // relative velocity along impact normal
      if (closing <= 0 || D.bcd > 0) continue; // separating, or defender was just hit (no repeat impulses)
      const rl = Math.hypot(rvx, rvz), align = rl > 1e-6 ? closing / rl : 0; // cos(impact angle): 1 head-on, ->0 glancing
      const sA = Math.max(0, A.vx * mx + A.vz * mz);                         // attacker speed toward defender
      const mr = 2 * A.mass / (A.mass + D.mass);                              // heavier attacker hits harder
      const F = (K.baseBumpForce * align + K.speedToForceRatio * sA) * mr;
      const kn = F * K.defenderKnockbackMult;
      const dn = D.vx * mx + D.vz * mz, add = Math.max(kn, dn) - dn;          // override defender's velocity along impact
      D.vx += mx * add; D.vz += mz * add; D.bcd = 8;
      const rec = Math.min(1, K.attackerRecoil * D.mass / A.mass);            // attacker keeps ~(1-recoil) of forward speed
      const an = A.vx * mx + A.vz * mz;
      if (an > 0) { A.vx -= mx * an * rec; A.vz -= mz * an * rec; }
    }
  }

  // Survival loop: last car alive wins the round (needs 2+ cars); winner's score +1.
  function judgeRound(w) {
    const R = w.round;
    if (R.phase !== 'play' || w.cars.length < 2) return;
    const al = w.cars.filter(c => c.alive);
    if (al.length <= 1) { R.phase = 'over'; R.t = w.t; R.winner = al.length ? al[0].id : null; if (R.winner) w.scores[R.winner] = (w.scores[R.winner] || 0) + 1; }
  }
  // Host round reset: all tiles restored, cars back on their starting pads, round state cleared; scores persist.
  function resetRound(w) {
    for (const t of w.list) { t.s = 0; t.t = 0; t.ft = 0; }
    w.active.length = 0; w.queue.length = 0; w.qh = 0; w.redLog.length = w.fallLog.length = w.regenLog.length = 0;
    for (const c of w.cars) Object.assign(c, car(c.id, c.sp.x, c.sp.z, c.sp.yaw, c.mass, c.drive, c.decay));
    w.round = { phase: 'play', winner: null, t: 0 };
  }

  const hash = w => JSON.stringify([w.t, w.cars, w.list.map(t => t.s)]);
  const api = { C, DEFAULTS, S, ELIM_Y, car, create, step, resetRound, hash, hexXZ, xzHex, groundY, hexIn };
  if (typeof module !== 'undefined') module.exports = api; else g.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);

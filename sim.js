// sim.js — pure, deterministic, fixed-step (1/60). No Math.random/Date. Shared by client+server.
// Input per tick: {steer:-1..1, jump:bool}. jump = FRESH PRESS EDGE only (client latches keydown, ignores key-repeat).
(function (g) {
  const C = {
    // ---- RAMMING / BUMP TUNING (vehicle-to-vehicle) ----
    baseBumpForce: 30,         // minimum shove of a head-on hit (scaled down for glancing hits)
    speedToForceRatio: 0.5,    // extra force per unit of the ATTACKER's speed toward the target
    defenderKnockbackMult: 2.2, // multiplier on that force, applied to the DEFENDER's velocity
    attackerRecoil: 0.20,      // share of the attacker's forward speed lost on impact (0.20 = keeps 80%)
    // ---- MAP SHRINKING (battle-royale zone) ----
    mapShrinkEnabled: true,            // outer tile rings collapse inward during a round
    mapShrinkInitialDelay: 30,         // seconds into the round before the first wave
    mapShrinkInterval: 5,              // seconds between waves
    mapShrinkRingsPerStep: 1,          // outer rings that fall per wave
    mapShrinkMinRemainingRings: 1,     // stop here: 1 = center tile + 1 ring, 0 = center tile only
    // ---- LOBBY / BOTS ----
    maxPlayers: 4, fillBots: false, botAI: true, // host lobby capacity (2-8), fill empty slots with bots at match start, bots drive (false = static test dummies)
    // ---- POWER-UPS ----
    puOn: true, puMax: 3, pickupSpawnMinDelay: 4.5, pickupSpawnMaxDelay: 8.0, invMax: 3, invDup: true, allowDuplicatePassives: false, // board cap, spawn delay range (s), inventory size
    smashMass: 1.5, smashBump: 2.2, powerSmashDuration: 10,      // Power Smash: mass x, bump force x, duration (s)
    shieldHits: 3, shieldBounce: 14, shatterReflect: 1.3, // Energy Shield: hits absorbed, attacker bounce speed, shatter blast vs Smash
    boostMul: 1.7, boostTime: 1.5, boostKick: 10,       // Speed Boost: speed x, duration, instant kick
    shockwaveForce: 150, shockwaveRadius: 50,                     // Kinetic Shockwave
    hexCollapseRadius: 5, hexCollapseWarningTime: 0.05, hexCollapseFallSpeed: 6, // Hex Collapse: rings around target (0 = target only, 1 = +6), warning-red seconds, fall-speed multiplier (visual)
    oilTime: 3, oilLife: 20, oilGrip: 0.5, oilSteer: 0.25, oilClearAll: false, // Oil Slick (dispense time, tile lifetime, victim grip + steering while slipping)
    oilSlickSlipDuration: 1.2, oilSlipStack: true,   // OilSlick_SlipDuration: seconds victims lose control per slick; stacks additively across different slicks
    ghostPhaseDuration: 4.0, ghostPhaseStack: true, ghostPhaseCooldown: 0, // Ghost Phase: duration, a 2nd activation ADDS time (4+4=8), optional cooldown after it ends
    rampsFallWithFloor: false,         // false (default): ramps stay solid as floating islands when the floor under them is gone; true: they fall with their floor tile
    // ---- QUANTUM SHIFT (Space: 50/50 BIG or SMALL) ----
    quantumDuration: 8,
    bigScale: 2, bigMassMul: 3, bigOutForce: 1.5, bigInForce: 0.25, bigSpeedMul: 0.8, bigTurnMul: 0.65, bigTileFall: 1.5, // Juggernaut
    smallScale: 0.5, smallMassMul: 0.35, smallOutForce: 0.1, smallInForce: 2, smallSpeedMul: 2, smallAccelMul: 2, smallTurnMul: 1, // Speedster
    // ---- movement ----
    speed: 23, flightMul: 1.6, steer: 2.9, grip: 7, air: 2, gravity: 42, jumpV: 21, rampJump: 0.2,
    flightLift: 24, flightDamp: 2, flightSink: 9, rollTime: 0.6, fallDelay: 0.7, regen: 5, regenOff: false, coyote: 7, buffer: 10, flightLock: 8,
    carR: 1.3 };
  const DEFAULTS = Object.assign({}, C); // hard-coded fallbacks; saved tweaks are layered on top

  // ---------------- CONFIG PERSISTENCE (localStorage) ----------------
  // Only values that differ from DEFAULTS are saved, so untouched settings keep following the defaults in this file.
  // Server/Node has no localStorage: call Sim.setStorage({getItem,setItem,removeItem}) to plug in a file/db adapter.
  const STORE_KEY = 'rsr.config.v1';
  let store = null;
  try { if (typeof localStorage !== 'undefined' && localStorage) store = localStorage; } catch (e) { store = null; } // may throw (privacy mode / sandboxed)
  const setStorage = s => { store = s; };
  function loadConfig() { // -> number of saved values applied
    if (!store) return 0;
    let n = 0;
    try {
      const o = JSON.parse(store.getItem(STORE_KEY) || '{}');
      for (const k in o) { // accept only known keys with the right type (numbers must be finite)
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k) || typeof o[k] !== typeof DEFAULTS[k]) continue;
        if (typeof o[k] === 'number' && !isFinite(o[k])) continue;
        C[k] = o[k]; n++;
      }
    } catch (e) { /* corrupt/blocked storage: fall back to defaults */ }
    return n;
  }
  function saveConfig() { // -> true if written
    if (!store) return false;
    try {
      const diff = {};
      for (const k in C) if (C[k] !== DEFAULTS[k]) diff[k] = C[k];
      store.setItem(STORE_KEY, JSON.stringify(diff));
      return true;
    } catch (e) { return false; } // quota / blocked
  }
  function resetConfig() { // restore defaults and forget saved tweaks
    Object.assign(C, DEFAULTS);
    try { if (store) store.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  }
  loadConfig();
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
    st: 'G', gs: 0, ev: '', evT: 0, buf: 0, bcd: 0, bot: false, ai: null, alive: true, sp: { x, z, yaw }, inv: [], smashT: 0, shield: 0, boostT: 0, ghostT: 0, oilT: 0, slick: 0, slickDeps: [], oilDep: 0, ghostCd: 0, qk: null, qT: 0, sz: 1, roll: 0, rollT: -1, rollDir: 0, rise: 0 });

  function create(o = {}) {
    const w = { t: 0, cfg: C, tiles: new Map(), list: [], active: [], queue: [], qh: 0, redLog: [], fallLog: [], regenLog: [],
      ramps: (o.ramps || []).map(p => Object.assign({}, p, { gone: false, ft: 0 })), depId: 0, plats: (o.plats || []).map(p => Object.assign({ th: 0.7, o: 0, tier: 'mid' }, p)), cars: [], scores: {}, round: { phase: 'play', winner: null, t: 0 },
      N: o.radius || 36, rs0: 0, shrinkRing: o.radius || 36, shrinkN: 0, items: [], iid: 1, nextSpawn: -1, rs: o.seed || 12345, oilList: [], oilLog: [], oilClr: [], oilHit: [], events: [] };
    const N = o.radius || 36;
    for (let q = -N; q <= N; q++)
      for (let r = Math.max(-N, -q - N); r <= Math.min(N, -q + N); r++) {
        const [x, z] = hexXZ(q, r), t = { i: w.list.length, q, r, x, z, s: 0, t: 0, ft: 0, fs: 1, o: null, oh: [], ot: 0, ring: Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)), perm: false }; // s:0 idle 1 red 2 fallen; o=oil owner, oh=cars that already hit it
        w.tiles.set(key(q, r), t); w.list.push(t);
      }
    return w;
  }

  function groundY(w, c) {
    let h = -Infinity;
    if (c.y >= -0.5) { // floor + ramps only support cars from above (no snapping up from the abyss)
      const t = w.tiles.get(key(...xzHex(c.x, c.z)));
      if (t && (t.s < 2 || c.ghostT > 0)) h = 0; // Ghost Phase hovers over tiles that already fell
      for (const p of w.ramps) { // ramps are floating islands (stay solid without floor) unless rampsFallWithFloor dropped them
        if (p.gone) continue;
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

  // ---------------- POWER-UPS ----------------
  // Passives (apply on pickup, no slot): smash, shield.  Actives (inventory, Space): boost, shock, collapse, oil, ghost.
  const TYPES = ['smash', 'shield', 'boost', 'shock', 'collapse', 'oil', 'ghost', 'quantum'];
  const TM = ['boostT', 'ghostT', 'oilT', 'smashT', 'slick', 'ghostCd', 'qT'];
  // all tiles within k hex rings of axial (q,r): k=0 -> just that tile, k=1 -> 7 tiles, k=2 -> 19 ...
  function ringTiles(w, q, r, k) {
    const out = [];
    for (let dq = -k; dq <= k; dq++) for (let dr = Math.max(-k, -dq - k); dr <= Math.min(k, -dq + k); dr++) { const t = w.tiles.get(key(q + dq, r + dr)); if (t) out.push(t); }
    return out;
  }
  const effMass = (K, c) => c.mass * (c.smashT > 0 ? K.smashMass : 1) * (c.qk === 'big' ? K.bigMassMul : c.qk === 'small' ? K.smallMassMul : 1);
  const qOut = (K, c) => c.qk === 'big' ? K.bigOutForce : c.qk === 'small' ? K.smallOutForce : 1; // outgoing knockback multiplier (Quantum Shift)
  const qIn = (K, c) => c.qk === 'big' ? K.bigInForce : c.qk === 'small' ? K.smallInForce : 1;   // incoming knockback multiplier
  function rnd(w) { w.rs = (w.rs + 0x6D2B79F5) >>> 0; let t = w.rs; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  function clearTile(w, t) { t.o = null; t.oh = []; w.oilClr.push(t); w.oilList = w.oilList.filter(x => x !== t); }
  function clearOil(w, id) { for (const t of w.oilList.slice()) if (t.o === id) clearTile(w, t); } // max 1 deployment per player
  function coatAround(w, c) {
    const sz = c.sz;
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    for (const [a, b] of [[0, 0], [.6, 1], [-.6, 1], [.6, -1], [-.6, -1]]) {
      const t = w.tiles.get(key(...xzHex(c.x + fz * a * sz + fx * b * sz, c.z - fx * a * sz + fz * b * sz)));
      if (t && t.s === 0 && t.o !== c.id) { const had = !!t.o; t.o = c.id; t.dep = c.oilDep; t.oh = []; t.ot = w.t + w.cfg.oilLife; if (!had) w.oilList.push(t); w.oilLog.push(t); }
    }
  }
  // Items float above EXISTING geometry only: floor tiles, ramps, mid platforms, high platform. Never dead center.
  function spawnPoint(w) {
    for (let tries = 0; tries < 40; tries++) {
      const r = rnd(w); let x, z, y, ti = -1; // category first (ground 30% / ramp 20% / mid 30% / high 20%), then a valid point inside it
      if (r < 0.3) { const t = w.list[Math.floor(rnd(w) * w.list.length)]; if (t.s !== 0) continue; x = t.x; z = t.z; y = 0; ti = t.i; }
      else if (r < 0.5 && w.ramps.length) {
        const p = w.ramps[Math.floor(rnd(w) * w.ramps.length)]; if (p.gone) continue;
        x = p.x + (rnd(w) * 2 - 1) * p.hw * 0.8; z = p.z + (rnd(w) * 2 - 1) * p.hw * 0.8;
        y = p.h * (1 - Math.max(Math.abs(x - p.x), Math.abs(z - p.z)) / p.hw);
      } else {
        const hi = r >= 0.8, cand = w.plats.filter(p => (p.tier === 'high') === hi); if (!cand.length) continue;
        const p = cand[Math.floor(rnd(w) * cand.length)]; let ok = false;
        for (let k = 0; k < 16 && !ok; k++) { x = p.x + (rnd(w) * 2 - 1) * p.r; z = p.z + (rnd(w) * 2 - 1) * p.r; ok = hexIn(p, x, z) >= 0.8 && Math.hypot(x, z) >= 3; }
        if (!ok) continue; y = p.top;
      }
      if (Math.hypot(x, z) < 3) continue; // no dead-center spawns
      if (w.items.some(i => Math.hypot(i.x - x, i.z - z) < 6)) continue;
      return { x, y: y + 1.3, z, ti };
    }
    return null;
  }
  function collect(w, c, type) {
    const K = w.cfg;
    // Passives already active: refused unless allowDuplicatePassives (then Smash adds time, Shield adds hits)
    if (type === 'smash') { if (c.smashT > 0) { if (!K.allowDuplicatePassives) return false; c.smashT += K.powerSmashDuration; } else c.smashT = K.powerSmashDuration; return true; }
    if (type === 'shield') { if (c.shield > 0) { if (!K.allowDuplicatePassives) return false; c.shield += K.shieldHits; } else c.shield = K.shieldHits; return true; }
    if (c.inv.length >= K.invMax || (!K.invDup && c.inv.includes(type))) return false;
    c.inv.push(type); return true;
  }
  const canCollect = (K, c, type) => type === 'smash' ? (c.smashT <= 0 || K.allowDuplicatePassives)
    : type === 'shield' ? (c.shield <= 0 || K.allowDuplicatePassives)
    : c.inv.length < K.invMax && (K.invDup || !c.inv.includes(type));

  // ---------------- BOT AI (practice mode / lobby fill) ----------------
  // Runs inside the sim (deterministic, no Math.random): goals = nearby foe to ram / nearest ground coin / orbit the center,
  // steering = safest heading near the goal (avoids red, fallen and void tiles), items used contextually.
  const EMPTY_IN = {};
  const wrapPi = a => { a %= 2 * Math.PI; return a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function hazardAt(w, x, z, me) { // 0 safe, 0.8 enemy oil, 1.5 warning-red, 2 void / gone
    const t = w.tiles.get(key(...xzHex(x, z)));
    if (!t || t.s === 2) return 2;
    if (t.s === 1) return 1.5;
    if (t.o && t.o !== me.id && !t.oh.includes(me.id)) return 0.8;
    if (t.ring >= w.shrinkRing - 3) return 0.7; // rim of the (shrinking) arena: keep a safety margin
    return 0;
  }
  const onRamp = (w, x, z) => w.ramps.some(p => !p.gone && Math.max(Math.abs(x - p.x), Math.abs(z - p.z)) < p.hw + 1);
  function pickGoal(w, c, opps) {
    let foe = null, fs = 1e9;
    for (const o of opps) {
      if (o.ghostT > 0 || (o.shield > 0 && c.smashT <= 0)) continue; // can't hurt ghosts; shields just bounce us
      const d = Math.hypot(o.x - c.x, o.z - c.z), q = d - 0.5 * Math.max(0, Math.hypot(o.x, o.z) - 14); // prefer foes near the edge
      if (d < 36 && q < fs) { fs = q; foe = o; }
    }
    let coin = null, cd = 1e9;
    for (const it of w.items) { // ground coins only (bots don't climb ramps / platforms)
      if (it.y - 1.3 > 0.5 || !canCollect(w.cfg, c, it.type) || hazardAt(w, it.x, it.z, c) >= 0.7 || onRamp(w, it.x, it.z)) continue;
      const d = Math.hypot(it.x - c.x, it.z - c.z); if (d < cd) { cd = d; coin = it; }
    }
    if (foe && Math.hypot(foe.x - c.x, foe.z - c.z) < 12) return { k: 'ram', id: foe.id };
    if (coin) return { k: 'coin', id: coin.id, x: coin.x, z: coin.z };
    if (foe) return { k: 'ram', id: foe.id };
    return null;
  }
  // Wander goal: the open patch of solid floor (no red / fallen / ramp tiles around it) that is close and roughly ahead.
  function safeSpot(w, c) {
    let best = null, bq = -1e9;
    for (const r of [8, 16, 24, 31]) for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8, x = Math.sin(a) * r, z = Math.cos(a) * r;
      let ok = 0; for (let i = 0; i < 9; i++) { const px = x + (i % 3 - 1) * 4.5, pz = z + (Math.floor(i / 3) - 1) * 4.5; ok += hazardAt(w, px, pz, c) === 0 && !onRamp(w, px, pz) ? 1 : 0; }
      const d = Math.hypot(x - c.x, z - c.z), brg = Math.abs(wrapPi(Math.atan2(x - c.x, z - c.z) - c.yaw));
      const q = ok * 3 - Math.abs(d - 24) * 0.12 - brg * 1.1 - Math.max(0, r - 28) * 0.4;
      if (d > 6 && q > bq) { bq = q; best = { x, z }; }
    }
    return best;
  }
  function shouldUse(w, c, type, opps, err, ai, foe) {
    const K = w.cfg; if (!opps.length) return false;
    const live = opps.filter(o => o.ghostT <= 0), near = r => live.filter(o => Math.hypot(o.x - c.x, o.z - c.z) < r), stale = ai.hold > 5; // unused too long -> just use it
    if (type === 'shock') return near(K.shockwaveRadius * 0.4).length > 0 || near(K.shockwaveRadius * 0.7).length > 1 || (stale && near(K.shockwaveRadius).length > 0);
    if (type === 'boost') { const d = foe ? Math.hypot(foe.x - c.x, foe.z - c.z) : 0; return (d > 6 && d < 22 && Math.abs(err) < 0.25) || stale; }
    if (type === 'collapse') return near(48).length > 0 || stale;
    if (type === 'quantum') return c.qT <= 0 && (near(34).length > 0 || stale);
    if (type === 'oil') { const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw); // someone chasing us
      return (c.st === 'G' && live.some(o => { const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz); return d < 22 && d > 3 && (dx * fx + dz * fz) / d < -0.3; })) || stale; }
    if (type === 'ghost') return c.ghostT <= 0 && (live.some(o => { const dx = c.x - o.x, dz = c.z - o.z, d = Math.hypot(dx, dz); if (d > 12 || d < 0.1) return false; return (o.vx * dx + o.vz * dz) / d > 10 || (o.smashT > 0 && d < 10); }) || stale);
    return false;
  }
  function botInput(w, c, dt) {
    const K = w.cfg;
    if (!K.botAI) { c.drive = false; c.decay = false; return EMPTY_IN; } // static test dummy
    c.drive = true; c.decay = true;
    const ai = c.ai || (c.ai = { t: 0, goal: null, cd: 0, hold: 0, jt: 0, ls: 0, wp: null, wt: 0, seed: [...c.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 97 });
    const out = { steer: 0 };
    ai.cd = Math.max(0, ai.cd - dt); ai.jt = Math.max(0, ai.jt - dt); ai.t -= dt;
    const opps = w.cars.filter(o => o !== c && o.alive), spd = Math.max(Math.hypot(c.vx, c.vz), K.speed * 0.8);
    if (ai.t <= 0) { ai.t = 0.12; ai.goal = pickGoal(w, c, opps); } // replan ~8x/s
    const g = ai.goal, foe = g && g.k === 'ram' ? w.cars.find(o => o.id === g.id && o.alive) : null; let ax, az;
    if (foe) { ax = foe.x + foe.vx * 0.3; az = foe.z + foe.vz * 0.3; } // lead the target
    else if (g && g.k === 'coin' && w.items.some(i => i.id === g.id)) { ax = g.x; az = g.z; }
    else { // wander toward the safest open ground (away from its own fallen / red trail)
      if (!ai.wp || ai.wt <= 0 || Math.hypot(ai.wp.x - c.x, ai.wp.z - c.z) < 5) { ai.wp = safeSpot(w, c) || { x: 0, z: 0 }; ai.wt = 0.6; }
      ai.wt -= dt; ax = ai.wp.x; az = ai.wp.z;
    }
    // Arc planner: roll the car forward ~1.5 s for each steering value (respects the real turning circle),
    // penalize red / fallen / void tiles (and ramps, unless the goal is on one), reward ending up pointed at the goal.
    const rampPen = !onRamp(w, ax, az); let bs = 0, bq = 1e9, bhz = 0;
    for (const st of [-1, -0.7, -0.4, -0.15, 0, 0.15, 0.4, 0.7, 1]) {
      let x = c.x, z = c.z, h = c.yaw, vx = c.vx, vz = c.vz, hz = 0, dm = 1e9;
      for (let k = 1; k <= 30; k++) { // 1.5 s in 0.05 s steps, same steering + grip model as the real car (so drift is accounted for)
        h -= st * K.steer * 0.05; const gk = Math.min(1, (c.st === 'G' ? K.grip : K.air) * 0.05);
        vx += (Math.sin(h) * spd - vx) * gk; vz += (Math.cos(h) * spd - vz) * gk; x += vx * 0.05; z += vz * 0.05;
        if (k % 3 === 0) { hz += (hazardAt(w, x, z, c) + (rampPen && onRamp(w, x, z) ? 1 : 0)) * (1.4 - k / 3 * 0.08); dm = Math.min(dm, Math.hypot(ax - x, az - z)); }
      }
      const dev = Math.abs(wrapPi(Math.atan2(vx, vz) - Math.atan2(ax - x, az - z))), q = hz * 10 + dm * 0.35 + Math.hypot(ax - x, az - z) * 0.1 + dev * 0.5 + Math.abs(st - ai.ls) * 0.15; // closest approach + final distance stop 'circle forever' plans
      if (q < bq) { bq = q; bs = st; bhz = hz; }
    }
    out.steer = bs; ai.ls = bs;
    const err = wrapPi(Math.atan2(ax - c.x, az - c.z) - c.yaw);
    if (c.st === 'G' && bhz >= 7 && ai.jt <= 0) { out.jump = true; ai.jt = 0.3; }                             // boxed in by holes: hop...
    else if (c.st === 'J' && c.gs > K.flightLock + 1 && bhz >= 5 && ai.jt <= 0) { out.jump = true; ai.jt = 1; } // ...then glide across
    if (c.inv.length && ai.cd <= 0) { ai.hold += dt; if (shouldUse(w, c, c.inv[0], opps, err, ai, foe)) { out.power = true; ai.cd = 0.9; ai.hold = 0; } }
    else if (!c.inv.length) ai.hold = 0;
    return out;
  }

  function itemsStep(w) {
    const K = w.cfg;
    for (const t of w.oilList.slice()) if (w.t > t.ot) clearTile(w, t);
    w.items = w.items.filter(i => !(i.ti >= 0 && w.list[i.ti].s === 2)); // ground item whose tile fell
    for (const c of w.cars) {
      if (!c.alive || !c.decay) continue; // bots don't collect
      for (let k = w.items.length - 1; k >= 0; k--) {
        const it = w.items[k];
        if (Math.hypot(c.x - it.x, c.z - it.z) > 2.4 || Math.abs(c.y + 0.6 - it.y) > 2.4) continue;
        if (collect(w, c, it.type)) { w.items.splice(k, 1); w.events.push({ k: 'pick', id: c.id, type: it.type }); }
      }
    }
    if (K.puOn && w.items.length < K.puMax) {
      if (w.nextSpawn < 0) w.nextSpawn = w.t + K.pickupSpawnMinDelay + rnd(w) * Math.max(0, K.pickupSpawnMaxDelay - K.pickupSpawnMinDelay);
      else if (w.t >= w.nextSpawn) {
        const p = spawnPoint(w);
        if (p) w.items.push({ id: w.iid++, type: TYPES[Math.floor(rnd(w) * TYPES.length)], x: p.x, y: p.y, z: p.z, ti: p.ti });
        w.nextSpawn = -1;
      }
    }
    if (w.events.length > 200) w.events.splice(0, 100);
    if (w.oilHit.length > 200) w.oilHit.splice(0, 100);
  }
  function activate(w, c) {
    const K = w.cfg, type = c.inv[0]; let ok = true;
    if (type === 'boost') { c.boostT = K.boostTime; c.vx += Math.sin(c.yaw) * K.boostKick; c.vz += Math.cos(c.yaw) * K.boostKick; w.events.push({ k: 'boost', id: c.id }); }
    else if (type === 'ghost') { if (c.ghostCd > 0) ok = false; else c.ghostT = K.ghostPhaseStack ? c.ghostT + K.ghostPhaseDuration : K.ghostPhaseDuration; } // 2nd Ghost Phase while active ADDS time
    else if (type === 'quantum') { // 50/50: BIG juggernaut or SMALL speedster
      if (c.qT > 0) ok = false;
      else { c.qk = rnd(w) < 0.5 ? 'big' : 'small'; c.qT = K.quantumDuration; w.events.push({ k: 'quantum', id: c.id, kind: c.qk }); }
    }
    else if (type === 'oil') { if (c.oilT > 0) ok = false; else { clearOil(w, c.id); c.oilT = K.oilTime; c.oilDep = ++w.depId; } }
    else if (type === 'shock') { // radial blast, force decays with distance from the epicenter
      w.events.push({ k: 'shock', x: c.x, y: c.y, z: c.z, r: K.shockwaveRadius });
      for (const o of w.cars) {
        if (o === c || !o.alive || o.ghostT > 0) continue;
        const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz); if (d >= K.shockwaveRadius) continue;
        const f = K.shockwaveForce * Math.pow(1 - d / K.shockwaveRadius, 1.5) / effMass(K, o) * qIn(K, o);
        const nx = d > 1e-6 ? dx / d : 0, nz = d > 1e-6 ? dz / d : 1, dn = o.vx * nx + o.vz * nz, add = Math.max(f, dn) - dn;
        o.vx += nx * add; o.vz += nz * add;
      }
    } else if (type === 'collapse') { // random opponent: tiles under/around them go red (warning), then drop
      const opp = w.cars.filter(o => o !== c && o.alive);
      if (!opp.length) ok = false;
      else {
        const o = opp[Math.floor(rnd(w) * opp.length)], [q, r] = xzHex(o.x, o.z), k = Math.max(0, Math.round(K.hexCollapseRadius));
        for (const t of ringTiles(w, q, r, k)) {
          if (t.s === 0) { t.s = 1; t.t = K.hexCollapseWarningTime; w.active.push(t); w.redLog.push(t); }
          else if (t.s === 1 && t.t > K.hexCollapseWarningTime) t.t = K.hexCollapseWarningTime;
          if (t.s === 1) t.fs = K.hexCollapseFallSpeed; // collapsed tiles fall at this speed multiplier
        }
        w.events.push({ k: 'collapse', x: o.x, z: o.z, id: o.id, rad: (k + 0.6) * 2.6 });
      }
    }
    if (ok) c.inv.shift();
  }

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
    const g0 = c.ghostT;
    for (const k2 of TM) if (c[k2] > 0) c[k2] = Math.max(0, c[k2] - dt);
    if (g0 > 0 && c.ghostT === 0) c.ghostCd = K.ghostPhaseCooldown;           // optional cooldown starts when Ghost Phase ends
    if (c.slick === 0 && c.slickDeps.length) c.slickDeps = [];                 // slip over: forget which slicks already hit us
    if (c.qk && c.qT <= 0) c.qk = null;                                         // Quantum Shift expired
    const tg = c.qk === 'big' ? K.bigScale : c.qk === 'small' ? K.smallScale : 1; // size eases toward its target (visual + physics)
    c.sz += (tg - c.sz) * Math.min(1, 10 * dt); if (Math.abs(tg - c.sz) < 0.002) c.sz = tg;
    const qs = c.qk === 'big' ? K.bigSpeedMul : c.qk === 'small' ? K.smallSpeedMul : 1, qt = c.qk === 'big' ? K.bigTurnMul : c.qk === 'small' ? K.smallTurnMul : 1, qa = c.qk === 'small' ? K.smallAccelMul : 1;
    if (inp.power && c.inv.length) activate(w, c); // Space: use first item in inventory
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
    c.yaw -= st * K.steer * (c.slick > 0 ? K.oilSteer : 1) * qt * dt; // oil: no tight turns; BIG turns wider
    const sp = c.drive ? K.speed * (c.st === 'F' ? K.flightMul : 1) * (c.boostT > 0 ? K.boostMul : 1) * qs : 0;
    const k = Math.min(1, (c.st === 'G' ? (c.slick > 0 ? K.oilGrip : K.grip * qa) : K.air * qa) * dt); // oil: no traction; SMALL accelerates 2x
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
    if (c.st === 'G' && c.y < 0.1) { // oil: hitting a slick (not your own) kills traction; dispensing coats tiles under you
      const ct = w.tiles.get(key(...xzHex(c.x, c.z)));
      if (ct && ct.o && ct.o !== c.id && !ct.oh.includes(c.id)) {
        const dep = ct.dep || 0, D = K.oilSlickSlipDuration;
        if (!c.slickDeps.includes(dep)) { c.slickDeps.push(dep); c.slick = K.oilSlipStack ? c.slick + D : Math.max(c.slick, D); } // each different slick ADDS its slip time
        else c.slick = Math.max(c.slick, Math.min(D, 0.35));                                                                          // same trail: stay slippery while on it
        if (K.oilClearAll) clearTile(w, ct); else { ct.oh.push(c.id); w.oilHit.push(ct); } }
      if (c.oilT > 0) coatAround(w, c);
    }
    if (c.decay && c.oilT <= 0 && c.st === 'G' && c.y < 0.1) { // 4 wheel contact points (decaying cars only; tiles are immune while you dispense oil)
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      for (const [a, b] of [[.6, 1], [-.6, 1], [.6, -1], [-.6, -1]]) {
        const t = w.tiles.get(key(...xzHex(c.x + (fz * a + fx * b) * c.sz, c.z + (-fx * a + fz * b) * c.sz)));
        if (t && t.s === 0) { t.s = 1; t.t = c.qk === 'big' ? K.fallDelay / K.bigTileFall : K.fallDelay; w.active.push(t); w.redLog.push(t); } // BIG: tiles drop 50% faster
      }
    }
    c.gs = c.st === 'G' ? 0 : Math.min(999, c.gs + 1);
    if (c.st === 'C' && c.gs > K.coyote) c.st = 'X'; // coyote expired -> true FALLING (jump input locked out)
  }

  function step(w, inputs, dt) {
    const K = w.cfg, cs = w.cars;
    w.t += dt;
    for (const c of cs) if (c.alive) stepCar(w, c, inputs[c.id] || (c.bot ? botInput(w, c, dt) : EMPTY_IN), dt);
    for (const c of cs) if (c.alive && c.y < ELIM_Y) { c.alive = false; c.vx = c.vy = c.vz = 0; } // eliminated: frozen, no collisions/decay
    judgeRound(w);
    shrinkStep(w);
    rampStep(w);
    itemsStep(w);
    let n = 0;
    for (const t of w.active) {
      if ((t.t -= dt) <= 0) { t.s = 2; t.ft = w.t; w.fallLog.push(t); w.queue.push(t); if (t.o) clearTile(w, t); } else w.active[n++] = t;
    }
    w.active.length = n;
    if (!K.regenOff && K.regen > 0) { // respawn fallen tiles oldest-first after K.regen seconds; regenOff = permanent destruction
      while (w.qh < w.queue.length && w.t - w.queue[w.qh].ft >= K.regen) { const t = w.queue[w.qh++]; if (t.perm || t.ring > w.shrinkRing) continue; t.s = 0; t.fs = 1; w.regenLog.push(t); } // zone-collapsed tiles never return
      if (w.qh > 2048) { w.queue.splice(0, w.qh); w.qh = 0; }
    }
    // ---- asymmetric, velocity-weighted ramming (+ Power Smash / Energy Shield / Ghost) ----
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j];
      if (!a.alive || !b.alive || a.ghostT > 0 || b.ghostT > 0 || Math.abs(a.y - b.y) > 1.5) continue; // ghosts: intangible both ways
      let nx = b.x - a.x, nz = b.z - a.z; const d = Math.hypot(nx, nz), m2 = (a.sz + b.sz) * K.carR; // hit radius follows size
      if (d >= m2 || d === 0) continue;
      nx /= d; nz /= d; // a -> b
      const o = m2 - d;
      const sa = a.vx * nx + a.vz * nz, sb = -(b.vx * nx + b.vz * nz); // each car's speed toward the other
      const A = sa >= sb ? a : b, D = A === a ? b : a, mx = A === a ? nx : -nx, mz = A === a ? nz : -nz; // A = attacker, m = A->D
      const sh = D.shield > 0, as = sh ? 1 : 0.2; // a shielded defender is never displaced
      A.x -= mx * o * as; A.z -= mz * o * as; D.x += mx * o * (1 - as); D.z += mz * o * (1 - as);
      const rvx = A.vx - D.vx, rvz = A.vz - D.vz, closing = rvx * mx + rvz * mz; // relative velocity along impact normal
      if (closing <= 0 || D.bcd > 0) continue; // separating, or defender was just hit (no repeat impulses)
      const rl = Math.hypot(rvx, rvz), align = rl > 1e-6 ? closing / rl : 0; // cos(impact angle): 1 head-on, ->0 glancing
      const sA = Math.max(0, A.vx * mx + A.vz * mz);                         // attacker speed toward defender
      const mA = effMass(K, A), mD = effMass(K, D), mr = 2 * mA / (mA + mD);  // Power Smash: +mass
      const F = (K.baseBumpForce * align + K.speedToForceRatio * sA) * mr * (A.smashT > 0 ? K.smashBump : 1) * qOut(K, A);
      const kn = F * K.defenderKnockbackMult * qIn(K, D);                         // BIG hits hard / takes little, SMALL the opposite
      D.bcd = 8;
      if (sh) { // Energy Shield: defender takes nothing; attacker is thrown back
        const smash = A.smashT > 0, back = smash ? kn * K.shatterReflect : K.shieldBounce;
        if (smash) { D.shield = 0; w.events.push({ k: 'shatter', id: D.id }); } else { D.shield--; w.events.push({ k: 'shield', id: D.id }); }
        const delta = -back - (A.vx * mx + A.vz * mz); A.vx += mx * delta; A.vz += mz * delta;
        continue;
      }
      const dn = D.vx * mx + D.vz * mz, add = Math.max(kn, dn) - dn;          // override defender's velocity along impact
      D.vx += mx * add; D.vz += mz * add;
      const rec = Math.min(1, K.attackerRecoil * mD / mA);                    // attacker keeps ~(1-recoil) of forward speed
      const an = A.vx * mx + A.vz * mz;
      if (an > 0) { A.vx -= mx * an * rec; A.vz -= mz * an * rec; }
    }
  }

  // Ramps optionally fall with their floor: a ramp is 'gone' while the tile under its center is fallen (mirrors it, incl. respawn).
  function rampStep(w) {
    const on = w.cfg.rampsFallWithFloor;
    for (const p of w.ramps) {
      const t = w.tiles.get(key(...xzHex(p.x, p.z))), gone = !!on && (!t || t.s === 2);
      if (gone && !p.gone) p.ft = w.t;
      p.gone = gone;
    }
  }

  // ---------------- MAP SHRINKING ----------------
  // Waves start mapShrinkInitialDelay s into the round, then every mapShrinkInterval s. Each wave drops the outermost
  // mapShrinkRingsPerStep rings (hex distance from the center tile) using the normal Hex Collapse warning-red -> fall,
  // and those tiles are permanent (no respawn). Stops at mapShrinkMinRemainingRings.
  function shrinkInfo(w) {
    const K = w.cfg, lim = Math.max(0, Math.round(K.mapShrinkMinRemainingRings));
    const on = K.mapShrinkEnabled && w.round.phase === 'play' && w.shrinkRing > lim;
    return { ring: w.shrinkRing, min: lim, next: on ? w.rs0 + K.mapShrinkInitialDelay + w.shrinkN * K.mapShrinkInterval : -1 };
  }
  function shrinkStep(w) {
    const K = w.cfg, zi = shrinkInfo(w);
    if (zi.next < 0 || w.t < zi.next) return;
    const outer = w.shrinkRing, inner = Math.max(zi.min, outer - Math.max(1, Math.round(K.mapShrinkRingsPerStep)));
    for (const t of w.list) {
      if (t.ring <= inner || t.ring > outer) continue;
      t.perm = true;
      if (t.s === 0) { t.s = 1; t.t = K.hexCollapseWarningTime; w.active.push(t); w.redLog.push(t); }
      else if (t.s === 1 && t.t > K.hexCollapseWarningTime) t.t = K.hexCollapseWarningTime;
      if (t.s === 1) t.fs = K.hexCollapseFallSpeed;
    }
    w.shrinkRing = inner; w.shrinkN++; w.events.push({ k: 'zone', ring: inner });
  }

  // Survival loop: last car alive wins the round (needs 2+ cars); winner's score +1.
  function judgeRound(w) {
    const rnd = w.round;
    if (rnd.phase !== 'play' || w.cars.length < 2) return;
    const al = w.cars.filter(c => c.alive);
    if (al.length <= 1) { rnd.phase = 'over'; rnd.t = w.t; rnd.winner = al.length ? al[0].id : null; if (rnd.winner) w.scores[rnd.winner] = (w.scores[rnd.winner] || 0) + 1; }
  }
  // Host round reset: all tiles restored, cars back on their starting pads, round state cleared; scores persist.
  function resetRound(w) {
    for (const t of w.list) { t.s = 0; t.t = 0; t.ft = 0; t.fs = 1; t.o = null; t.oh = []; t.perm = false; }
    w.active.length = 0; w.queue.length = 0; w.qh = 0; w.redLog.length = w.fallLog.length = w.regenLog.length = 0;
    for (const p of w.ramps) { p.gone = false; p.ft = 0; }
    w.items = []; w.nextSpawn = -1; w.oilList = []; w.oilLog.length = w.oilClr.length = w.oilHit.length = w.events.length = 0;
    for (const c of w.cars) Object.assign(c, car(c.id, c.sp.x, c.sp.z, c.sp.yaw, c.mass, c.drive, c.decay), { bot: c.bot });
    w.round = { phase: 'play', winner: null, t: 0 }; w.rs0 = w.t; w.shrinkRing = w.N; w.shrinkN = 0; // zone timer restarts with the round
  }

  const hash = w => JSON.stringify([w.t, w.cars, w.list.map(t => t.s), w.items, w.shrinkRing, w.shrinkN]);
  const api = { C, DEFAULTS, botInput, shrinkInfo, STORE_KEY, loadConfig, saveConfig, resetConfig, setStorage, S, ELIM_Y, car, create, step, resetRound, hash, hexXZ, xzHex, groundY, hexIn };
  if (typeof module !== 'undefined') module.exports = api; else g.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);

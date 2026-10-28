/* Cornfield Carver - cozy fieldwork.
 * Part 1: pure game core (no DOM, exported for Node tests).
 * Part 2: Canvas renderer + controller (browser only).
 * All art is drawn from code; the map format is versioned JSON data only.
 */
(function (root) {
  'use strict';

  /* ===================================================================
   * PART 1 - CORE
   * =================================================================== */
  var FORMAT = 'cornfield-carver';
  var VERSION = 2;
  var PURPOSES = ['art', 'maze'];
  var MAX_UNDO = 150;
  var MAX_JSON = 40000;
  var MAX_NAME = 40;
  var DEFAULT_NAME = 'My cornfield';

  var SIZES = {
    small: { w: 15, h: 11, label: 'Cozy plot' },
    medium: { w: 25, h: 17, label: 'Family farm' },
    large: { w: 35, h: 23, label: 'Great field' },
    expansive: { w: 69, h: 35, label: 'Wide acres' },
    grand: { w: 105, h: 69, label: 'Grand estate' },
    vast: { w: 207, h: 105, label: 'Harvest country' }
  };
  var SEASONS = ['spring', 'summer', 'autumn', 'winter'];
  var ANIMALS = ['dog', 'cat', 'cow', 'horse', 'pig', 'chicken'];
  var BRAID = { spring: 0.04, summer: 0, autumn: 0.08, winter: 0.12 };
  var DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // right, down, left, up

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function cleanName(n) {
    if (typeof n !== 'string') return DEFAULT_NAME;
    n = n.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    return n || DEFAULT_NAME;
  }

  function dirIndex(dx, dy) {
    for (var i = 0; i < 4; i++) if (DIRS[i][0] === dx && DIRS[i][1] === dy) return i;
    return 0;
  }

  function tractorSpot(size) {
    var d = SIZES[size];
    return { x: 0, y: 2 * Math.floor((d.h - 1) / 4) + 1 };
  }

  /** Build a game state object. grid: Uint8Array, 1 = corn, 0 = cleared.
   *  purpose: 'art' (default) or 'maze'. start/exit may be null (not yet placed).
   *  The tractor is independent of the gates: o.tractor, else the start gate, else the default spot. */
  function createState(o) {
    var d = SIZES[o.size], tp = o.tractor || o.start || tractorSpot(o.size);
    var s = {
      size: o.size, season: o.season, animal: o.animal,
      seed: o.seed >>> 0, name: cleanName(o.name),
      purpose: o.purpose === 'maze' ? 'maze' : 'art',
      w: d.w, h: d.h, grid: o.grid,
      start: o.start ? { x: o.start.x, y: o.start.y } : null,
      exit: o.exit ? { x: o.exit.x, y: o.exit.y } : null,
      tractor: { x: tp.x, y: tp.y, dir: 0 },
      run: null, history: [], stroke: null, strokeOpen: false, dirty: false
    };
    resetRun(s);
    return s;
  }

  /** A maze run needs maze purpose and both gates placed. */
  function isConfigured(s) { return s.purpose === 'maze' && !!s.start && !!s.exit; }

  function resetRun(s) {
    s.run = { x: s.start ? s.start.x : 0, y: s.start ? s.start.y : 0, moves: 0, won: false, dir: 1 }; // dir: ephemeral facing (0 right, 1 down, 2 left, 3 up), never saved
  }

  function inBounds(s, x, y) { return x >= 0 && y >= 0 && x < s.w && y < s.h; }
  function idx(s, x, y) { return y * s.w + x; }

  /** Generate a perfect (plus optional braided) maze grid for a size/season/seed. */
  function generateMaze(size, season, seed) {
    var d = SIZES[size], w = d.w, h = d.h, rnd = mulberry32(seed);
    var g = new Uint8Array(w * h);
    g.fill(1);
    var cellRows = (h - 1) / 2;
    var sy = 2 * Math.floor(rnd() * cellRows) + 1;
    var ey = 2 * Math.floor(rnd() * cellRows) + 1;
    var stack = [[1, sy]];
    g[sy * w + 1] = 0;
    while (stack.length) {
      var cur = stack[stack.length - 1], opts = [];
      for (var i = 0; i < 4; i++) {
        var nx = cur[0] + DIRS[i][0] * 2, ny = cur[1] + DIRS[i][1] * 2;
        if (nx >= 1 && ny >= 1 && nx <= w - 2 && ny <= h - 2 && g[ny * w + nx] === 1) opts.push(i);
      }
      if (!opts.length) { stack.pop(); continue; }
      var k = opts[Math.floor(rnd() * opts.length)];
      g[(cur[1] + DIRS[k][1]) * w + cur[0] + DIRS[k][0]] = 0;
      g[(cur[1] + DIRS[k][1] * 2) * w + cur[0] + DIRS[k][0] * 2] = 0;
      stack.push([cur[0] + DIRS[k][0] * 2, cur[1] + DIRS[k][1] * 2]);
    }
    var braid = BRAID[season] || 0;
    if (braid > 0) {
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          if (g[y * w + x] !== 1 || (x % 2) === (y % 2)) continue;
          var open = (x % 2 === 0) ? (g[y * w + x - 1] === 0 && g[y * w + x + 1] === 0)
                                   : (g[(y - 1) * w + x] === 0 && g[(y + 1) * w + x] === 0);
          if (open && rnd() < braid) g[y * w + x] = 0;
        }
      }
    }
    g[sy * w] = 0;
    g[ey * w + w - 1] = 0;
    return { grid: g, start: { x: 0, y: sy }, exit: { x: w - 1, y: ey } };
  }

  function newMaze(o) {
    var seed = (o.seed === undefined ? 1 : o.seed) >>> 0;
    var m = generateMaze(o.size, o.season, seed);
    return createState({ size: o.size, season: o.season, animal: o.animal, seed: seed, name: o.name, purpose: 'maze',
      grid: m.grid, start: m.start, exit: m.exit });
  }

  /** Fully planted field. Art (default): only the tractor footprint is cleared and there are no gates.
   *  purpose 'maze': start and exit gates are pre-placed and cleared, as in the original blank field. */
  function newBlank(o) {
    var d = SIZES[o.size], g = new Uint8Array(d.w * d.h), maze = o.purpose === 'maze', tp = tractorSpot(o.size);
    g.fill(1);
    g[tp.y * d.w + tp.x] = 0;
    var st = null, ex = null;
    if (maze) {
      st = { x: 0, y: tp.y }; ex = { x: d.w - 1, y: tp.y };
      g[ex.y * d.w + ex.x] = 0;
    }
    return createState({ size: o.size, season: o.season, animal: o.animal, seed: o.seed || 0, name: o.name,
      purpose: maze ? 'maze' : 'art', grid: g, start: st, exit: ex, tractor: tp });
  }

  /** Switch art <-> maze. A view preference: never touches the grid and is not undoable. */
  function setPurpose(s, purpose) {
    if (PURPOSES.indexOf(purpose) < 0 || s.purpose === purpose) return false;
    s.purpose = purpose;
    resetRun(s);
    return true;
  }

  /** Place the start or exit gate on any in-bounds cell different from the other gate. One undo step. */
  function placeGate(s, which, x, y) {
    if (s.purpose !== 'maze') return { ok: false, error: 'Switch to Maze to place a start and exit.' };
    if (which !== 'start' && which !== 'exit') return { ok: false, error: 'Unknown gate.' };
    if (!isInt(x) || !isInt(y) || !inBounds(s, x, y)) return { ok: false, error: 'Pick a spot inside the field.' };
    var other = s[which === 'start' ? 'exit' : 'start'];
    if (other && other.x === x && other.y === y) return { ok: false, error: 'The start and exit need different spots.' };
    var cur = s[which];
    if (cur && cur.x === x && cur.y === y) return { ok: false, error: 'That gate is already there.' };
    s.stroke = null;
    var e = pushEntry(s, snapshotMeta(s)), i = idx(s, x, y);
    if (s.grid[i] === 1) { e.c.push([i, 1]); s.grid[i] = 0; }
    s[which] = { x: x, y: y };
    resetRun(s);
    s.dirty = true;
    return { ok: true };
  }

  /* ---- history ---- */
  function pushEntry(s, e) {
    s.history.push(e);
    if (s.history.length > MAX_UNDO) s.history.shift();
    return e;
  }
  function snapshotMeta(s) {
    return { c: [], tx: s.tractor.x, ty: s.tractor.y, td: s.tractor.dir,
      start: s.start ? { x: s.start.x, y: s.start.y } : null, exit: s.exit ? { x: s.exit.x, y: s.exit.y } : null, seed: s.seed };
  }
  function beginStroke(s) { s.strokeOpen = true; s.stroke = null; }
  function endStroke(s) { s.strokeOpen = false; s.stroke = null; }

  function recordCarve(s, i) {
    if (!s.stroke) s.stroke = pushEntry(s, snapshotMeta(s));
    s.stroke.c.push([i, 1]);
  }

  function samePt(a, b) { return a === b || (!!a && !!b && a.x === b.x && a.y === b.y); }

  function undo(s) {
    var e = s.history.pop();
    s.stroke = null;
    if (!e) return false;
    for (var i = e.c.length - 1; i >= 0; i--) s.grid[e.c[i][0]] = e.c[i][1];
    var layoutChanged = !samePt(s.start, e.start) || !samePt(s.exit, e.exit);
    s.start = e.start ? { x: e.start.x, y: e.start.y } : null;
    s.exit = e.exit ? { x: e.exit.x, y: e.exit.y } : null;
    s.seed = e.seed;
    s.tractor = { x: e.tx, y: e.ty, dir: e.td };
    if (s.run.won || layoutChanged || s.grid[idx(s, s.run.x, s.run.y)] === 1) resetRun(s);
    s.dirty = true;
    return true;
  }

  /** Replace the whole grid as one undoable step. The tractor moves to `tractor` (default: the start gate). */
  function applyGrid(s, grid, start, exit, seed, tractor) {
    var e = snapshotMeta(s);
    for (var i = 0; i < grid.length; i++) if (s.grid[i] !== grid[i]) e.c.push([i, s.grid[i]]);
    pushEntry(s, e);
    s.stroke = null;
    s.grid = grid;
    s.start = start ? { x: start.x, y: start.y } : null;
    s.exit = exit ? { x: exit.x, y: exit.y } : null;
    s.seed = seed >>> 0;
    var tp = tractor || start || s.tractor;
    s.tractor = { x: tp.x, y: tp.y, dir: 0 };
    resetRun(s);
    s.dirty = false;
  }

  /** Generate a fresh maze (maze purpose only). */
  function regenerate(s, seed) {
    if (s.purpose !== 'maze') return false;
    var m = generateMaze(s.size, s.season, seed);
    applyGrid(s, m.grid, m.start, m.exit, seed);
    return true;
  }

  /** Fill the whole field with corn, keeping the gates and the tractor's footprint clear. */
  function replant(s) {
    var g = new Uint8Array(s.w * s.h);
    g.fill(1);
    g[idx(s, s.tractor.x, s.tractor.y)] = 0;
    if (s.start) g[idx(s, s.start.x, s.start.y)] = 0;
    if (s.exit) g[idx(s, s.exit.x, s.exit.y)] = 0;
    applyGrid(s, g, s.start, s.exit, s.seed, { x: s.tractor.x, y: s.tractor.y });
  }

  /* ---- tractor ---- */
  function moveTractor(s, dx, dy) {
    var t = s.tractor, nx = t.x + dx, ny = t.y + dy;
    t.dir = dirIndex(dx, dy);
    if (!inBounds(s, nx, ny)) return { moved: false, carved: false, x: t.x, y: t.y };
    var i = idx(s, nx, ny), carved = false;
    if (s.grid[i] === 1) {
      recordCarve(s, i);
      s.grid[i] = 0;
      s.dirty = true;
      carved = true;
    }
    t.x = nx; t.y = ny;
    if (!s.strokeOpen) s.stroke = null;
    return { moved: true, carved: carved, x: nx, y: ny };
  }

  function stepToward(x, y, tx, ty) {
    var ddx = tx - x, ddy = ty - y;
    if (!ddx && !ddy) return null;
    if (Math.abs(ddx) >= Math.abs(ddy)) return [ddx > 0 ? 1 : -1, 0];
    return [0, ddy > 0 ? 1 : -1];
  }

  /** Drive the tractor toward a tile, carving along the way. */
  function carveTo(s, tx, ty, maxSteps) {
    var steps = 0, carved = 0, lim = maxSteps || 60;
    if (!inBounds(s, tx, ty)) return { steps: 0, carved: 0 };
    while (steps < lim) {
      var st = stepToward(s.tractor.x, s.tractor.y, tx, ty);
      if (!st) break;
      var r = moveTractor(s, st[0], st[1]);
      if (!r.moved) break;
      steps++;
      if (r.carved) carved++;
    }
    return { steps: steps, carved: carved };
  }

  /* ---- runner ---- */
  function moveRunner(s, dx, dy) {
    var r = s.run;
    if (!isConfigured(s)) return { moved: false, blocked: false, won: false, idle: true };
    if (r.won) return { moved: false, blocked: false, won: true };
    var nx = r.x + dx, ny = r.y + dy;
    if (!inBounds(s, nx, ny) || s.grid[idx(s, nx, ny)] === 1) return { moved: false, blocked: true, won: false };
    r.x = nx; r.y = ny; r.moves++; r.dir = dirIndex(dx, dy);
    if (nx === s.exit.x && ny === s.exit.y) r.won = true;
    return { moved: true, blocked: false, won: r.won };
  }

  /** Move the runner toward a tile, sliding along corn when blocked. */
  function runTo(s, tx, ty, maxSteps) {
    var steps = 0, lim = maxSteps || 8;
    if (!isConfigured(s)) return 0;
    while (steps < lim && !s.run.won) {
      var x = s.run.x, y = s.run.y, st = stepToward(x, y, tx, ty);
      if (!st) break;
      var r = moveRunner(s, st[0], st[1]);
      if (!r.moved) {
        var alt = st[0] ? [0, Math.sign(ty - y)] : [Math.sign(tx - x), 0];
        if (!alt[0] && !alt[1]) break;
        r = moveRunner(s, alt[0], alt[1]);
        if (!r.moved) break;
      }
      steps++;
    }
    return steps;
  }

  /** Shortest cleared route from (fx,fy) to the exit, excluding the origin; null if blocked. */
  function findPath(s, fx, fy) {
    if (!isConfigured(s) || !inBounds(s, fx, fy) || s.grid[idx(s, fx, fy)] === 1) return null;
    var n = s.w * s.h, prev = new Int32Array(n).fill(-2), q = [idx(s, fx, fy)], head = 0;
    prev[q[0]] = -1;
    var goal = idx(s, s.exit.x, s.exit.y);
    while (head < q.length) {
      var c = q[head++];
      if (c === goal) break;
      var cx = c % s.w, cy = (c - cx) / s.w;
      for (var i = 0; i < 4; i++) {
        var nx = cx + DIRS[i][0], ny = cy + DIRS[i][1];
        if (!inBounds(s, nx, ny)) continue;
        var ni = ny * s.w + nx;
        if (prev[ni] !== -2 || s.grid[ni] === 1) continue;
        prev[ni] = c; q.push(ni);
      }
    }
    if (prev[goal] === -2) return null;
    var path = [], c2 = goal;
    while (prev[c2] !== -1) { path.push([c2 % s.w, Math.floor(c2 / s.w)]); c2 = prev[c2]; }
    return path.reverse();
  }

  function isSolvable(s) { return isConfigured(s) && findPath(s, s.start.x, s.start.y) !== null; }

  function counts(s) {
    var corn = 0;
    for (var i = 0; i < s.grid.length; i++) corn += s.grid[i];
    return { corn: corn, cleared: s.grid.length - corn };
  }

  /* ---- JSON ---- */
  function serialize(s, opts) {
    var rows = [];
    for (var y = 0; y < s.h; y++) {
      var r = '';
      for (var x = 0; x < s.w; x++) r += s.grid[y * s.w + x] ? '#' : '.';
      rows.push(r);
    }
    var o = {
      format: FORMAT, version: VERSION, name: s.name, purpose: s.purpose, size: s.size, season: s.season, animal: s.animal,
      seed: s.seed, width: s.w, height: s.h, rows: rows
    };
    if (s.start) o.start = [s.start.x, s.start.y];
    if (s.exit) o.exit = [s.exit.x, s.exit.y];
    if (opts && opts.tractor) o.tractor = [s.tractor.x, s.tractor.y];
    return o;
  }
  function stringify(s, opts) { return JSON.stringify(serialize(s, opts)); }

  function fail(msg) { return { ok: false, error: msg }; }

  /** Validate untrusted JSON text. Never evaluates anything; only copies known, checked fields. */
  function parse(text) {
    if (typeof text !== 'string') return fail('Nothing to import.');
    if (text.length > MAX_JSON) return fail('That is too large to be a cornfield (limit ' + MAX_JSON + ' characters).');
    var o;
    try { o = JSON.parse(text); } catch (e) { return fail('That is not valid JSON.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return fail('Expected a cornfield object.');
    if (o.format !== FORMAT) return fail('This is not a Cornfield Carver creation.');
    if (!isInt(o.version) || o.version < 1) return fail('Missing or invalid version.');
    if (o.version > VERSION) return fail('This creation was made with a newer version of the game.');
    if (typeof o.size !== 'string' || !hasOwn(SIZES, o.size)) return fail('Unknown field size.');
    if (typeof o.season !== 'string' || SEASONS.indexOf(o.season) < 0) return fail('Unknown season.');
    if (typeof o.animal !== 'string' || ANIMALS.indexOf(o.animal) < 0) return fail('Unknown runner animal.');
    var d = SIZES[o.size];
    if (o.width !== d.w || o.height !== d.h) return fail('Field dimensions do not match its size.');
    if (!Array.isArray(o.rows) || o.rows.length !== d.h) return fail('Field rows are missing or the wrong count.');
    var g = new Uint8Array(d.w * d.h);
    for (var y = 0; y < d.h; y++) {
      var row = o.rows[y];
      if (typeof row !== 'string' || row.length !== d.w || !/^[#.]+$/.test(row)) return fail('Row ' + (y + 1) + ' is invalid.');
      for (var x = 0; x < d.w; x++) g[y * d.w + x] = row.charAt(x) === '#' ? 1 : 0;
    }
    var seed = 0;
    if (o.seed !== undefined) {
      if (!isInt(o.seed) || o.seed < 0 || o.seed > 4294967295) return fail('Invalid seed.');
      seed = o.seed;
    }
    function pt(p, label) {
      if (!Array.isArray(p) || p.length !== 2 || !isInt(p[0]) || !isInt(p[1]) ||
          p[0] < 0 || p[1] < 0 || p[0] >= d.w || p[1] >= d.h) return null;
      return { x: p[0], y: p[1] };
    }
    // Version 1 files are mazes with both gates required; version 2 declares a purpose and gates may be absent.
    var purpose = 'maze', st = null, ex = null, v2 = o.version >= 2;
    if (v2) {
      if (typeof o.purpose !== 'string' || PURPOSES.indexOf(o.purpose) < 0) return fail('Unknown purpose.');
      purpose = o.purpose;
    }
    if (!v2 || o.start !== undefined) { st = pt(o.start); if (!st) return fail('Invalid start position.'); }
    if (!v2 || o.exit !== undefined) { ex = pt(o.exit); if (!ex) return fail('Invalid exit position.'); }
    if ((st && g[st.y * d.w + st.x]) || (ex && g[ex.y * d.w + ex.x])) return fail('Start and exit tiles must be cleared.');
    if (st && ex && st.x === ex.x && st.y === ex.y) return fail('Start and exit must differ.');
    var tr = null;
    if (o.tractor !== undefined) {
      tr = pt(o.tractor);
      if (!tr) return fail('Invalid tractor position.');
    } else if (!st) {
      // No gate and no saved tractor: park it on the first cleared cell so it never sits in corn.
      for (var k = 0; k < g.length; k++) if (!g[k]) { tr = { x: k % d.w, y: Math.floor(k / d.w) }; break; }
      if (!tr) { tr = tractorSpot(o.size); g[tr.y * d.w + tr.x] = 0; }
    }
    return { ok: true, state: createState({ size: o.size, season: o.season, animal: o.animal, seed: seed, name: o.name,
      purpose: purpose, grid: g, start: st, exit: ex, tractor: tr }) };
  }

  /** Pure corn pose for one plant (0..2) of cell (x,y): rests most of the time, then a short smooth lean burst.
   *  Returns { angle (radians, root-anchored lean), active }. Deterministic in (x, y, plant, seed, time).
   *  Each plant: own period 8-15 s, burst 1.5-2.5 s (sin^2 envelope), peak lean 5-8 degrees. */
  var BURST_MAX = 0.16;
  function hash3(x, y, s) {
    var h = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul((s | 0) + 7, 83492791)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return h;
  }
  function cornPose(x, y, plant, seed, time, out) {
    out = out || {};
    var h = hash3(x * 3 + plant, y, (seed ^ 0x2f6b) | 0), h2 = hash3(h & 0xffff, (h >>> 16) + plant, 977);
    var period = 8 + 7 * ((h & 1023) / 1023), dur = 1.5 + ((h >>> 10) & 1023) / 1023;
    var off = ((h2 & 4095) / 4095) * period, peak = (5 + 3 * (((h2 >>> 12) & 255) / 255)) * Math.PI / 180;
    var tt = time + off, k = Math.floor(tt / period), local = tt - k * period;
    if (!(local < dur)) { out.angle = 0; out.active = false; return out; }
    var u = local / dur, env = Math.sin(Math.PI * u); env *= env;
    var hk = hash3(k, plant + 11, h), sign = hk & 1 ? 1 : -1;
    // sin²(πu) * sin(2πu) peaks at 3√3/8 ≈ 0.6495; normalize so the requested lean is reached.
    var a = sign * peak * env * Math.sin(2 * Math.PI * u) / 0.65;
    out.angle = Math.max(-BURST_MAX, Math.min(BURST_MAX, a)); out.active = true; return out;
  }

  var core = {
    FORMAT: FORMAT, VERSION: VERSION, MAX_UNDO: MAX_UNDO, MAX_JSON: MAX_JSON, MAX_NAME: MAX_NAME,
    PURPOSES: PURPOSES, SIZES: SIZES, SEASONS: SEASONS, ANIMALS: ANIMALS, DIRS: DIRS,
    mulberry32: mulberry32, cleanName: cleanName, generateMaze: generateMaze, newMaze: newMaze, newBlank: newBlank,
    createState: createState, resetRun: resetRun, beginStroke: beginStroke, endStroke: endStroke,
    moveTractor: moveTractor, carveTo: carveTo, moveRunner: moveRunner, runTo: runTo, undo: undo,
    regenerate: regenerate, replant: replant, setPurpose: setPurpose, placeGate: placeGate, isConfigured: isConfigured, findPath: findPath, isSolvable: isSolvable, counts: counts,
    serialize: serialize, stringify: stringify, parse: parse, inBounds: inBounds, cornPose: cornPose
  };
  root.CornfieldCore = core;
  if (typeof module !== 'undefined' && module.exports) module.exports = core;

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  /* ===================================================================
   * PART 2 - RENDERING + CONTROLLER (browser)
   * =================================================================== */
  var TAU = Math.PI * 2;

  var PAL = {
    spring: { sky: ['#dcefe4', '#f8f0da'], hill: ['#bddaa9', '#a6cb94'], soil: '#7b5b45', path: '#ead6ab',
      tray: '#e6d5ae', trayDark: '#b9a37a', corn: ['#f4f0a0', '#e6d35a', '#b9a23a'], leaf: '#6fae4c', stalk: '#86b85a', husk: '#9cc46a', tassel: '#d8d48a', kernel: '#fff7b8', flower: '#f4a8bd' },
    summer: { sky: ['#fde6b4', '#fbf3e4'], hill: ['#e8d390', '#d8bf6e'], soil: '#704f3a', path: '#ebd2a1',
      tray: '#ead6a8', trayDark: '#bca06f', corn: ['#fff2a0', '#f4cc3c', '#c8921c'], leaf: '#5f9c3e', stalk: '#74ab44', husk: '#8fba55', tassel: '#e2bd5a', kernel: '#fff3b0' },
    autumn: { sky: ['#f6d4ac', '#f8eadb'], hill: ['#e1aa6c', '#cd8c4e'], soil: '#6b4533', path: '#deba8a',
      tray: '#e4cba1', trayDark: '#b08e62', corn: ['#fbd37a', '#eba836', '#b9701c'], leaf: '#c4a23e', stalk: '#d2b252', husk: '#c9a85a', tassel: '#c98a3a', kernel: '#ffe3a0' },
    winter: { sky: ['#d8e6f1', '#f5f8fb'], hill: ['#ebf0f6', '#d3dfea'], soil: '#7c6a66', path: '#f2f6fa',
      tray: '#e9e2d6', trayDark: '#b3a894', corn: ['#f6f4d8', '#dcd596', '#aaa060'], leaf: '#8fae94', stalk: '#a9c0a2', husk: '#b7ccb0', tassel: '#d9d2a6', kernel: '#fffbe6' }
  };
  var ORG = 0.8;   // tile origin inside the layer (x), in tiles
  var ORGY = 1.25; // tile origin inside the layer (y): extra headroom for tall plants

  // Corn sprite geometry, in tiles: padding either side, height above the cell top and below its bottom.
  var SPR = { pad: 0.2, over: 0.46, under: 0.12 };

  function mix(hex, amt) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255, t = amt < 0 ? 0 : 255, p = Math.abs(amt);
    r = Math.round(r + (t - r) * p); g = Math.round(g + (t - g) * p); b = Math.round(b + (t - b) * p);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function hash(x, y, s) {
    var h = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul((s | 0) + 7, 83492791)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return h;
  }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function flat(g, x, y, rx, ry, c, rot) {
    g.save(); g.translate(x, y); if (rot) g.rotate(rot); g.scale(rx, ry);
    g.fillStyle = c; g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill(); g.restore();
  }
  function ball(g, x, y, rx, ry, c, rot) {
    g.save(); g.translate(x, y); if (rot) g.rotate(rot); g.scale(rx, ry);
    var gr = g.createRadialGradient(-0.3, -0.35, 0.05, 0, 0, 1.05);
    gr.addColorStop(0, mix(c, 0.28)); gr.addColorStop(0.6, c); gr.addColorStop(1, mix(c, -0.2));
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill(); g.restore();
  }
  function poly(g, pts, c) {
    g.fillStyle = c; g.beginPath(); g.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath(); g.fill();
  }

  /* ---- corn: tall stalks, arching tapered leaves, husked ears with kernel rows, tassels ---- */
  /** A tapered leaf from (x,y) that heads off at `ang` and droops by `curl` (positive = down). */
  function leaf(g, x, y, ang, len, wid, c, rib, curl) {
    var dx = Math.cos(ang), dy = Math.sin(ang), nx = -dy, ny = dx;
    var mx = x + dx * len * 0.55, my = y + dy * len * 0.55 - curl * len * 0.1;
    var ex = x + dx * len, ey = y + dy * len + curl * len * 0.55;
    g.beginPath(); g.moveTo(x, y);
    g.quadraticCurveTo(mx + nx * wid, my + ny * wid, ex, ey);
    g.quadraticCurveTo(mx - nx * wid, my - ny * wid, x, y);
    g.fillStyle = c; g.fill();
    var sheen = g.createLinearGradient(mx - nx * wid, my - ny * wid, mx + nx * wid, my + ny * wid);
    sheen.addColorStop(0, 'rgba(20,40,10,0.26)'); sheen.addColorStop(0.4, 'rgba(255,255,215,0.22)'); sheen.addColorStop(1, 'rgba(20,40,10,0.32)');
    g.fillStyle = sheen; g.fill();
    g.strokeStyle = rib; g.lineWidth = Math.max(0.6, wid * 0.22); g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(mx, my, ex, ey); g.stroke();
  }

  /** One corn plant rooted at (rx, ry), h tall. Light comes from the upper left. */
  function drawPlant(g, pal, season, t, rx, ry, h, sc, rnd) {
    var lean = (rnd() - 0.35) * 0.1 * t, i, side, f, px, py;
    function at(fr) { return { x: rx + lean * fr * fr, y: ry - h * fr }; }
    // stalk
    var top = at(1);
    g.lineCap = 'round';
    g.strokeStyle = mix(pal.stalk, -0.22); g.lineWidth = 0.095 * t * sc;
    g.beginPath(); g.moveTo(rx, ry); g.quadraticCurveTo(rx, ry - h * 0.55, top.x, top.y); g.stroke();
    g.strokeStyle = pal.stalk; g.lineWidth = 0.065 * t * sc;
    g.beginPath(); g.moveTo(rx - 0.008 * t, ry); g.quadraticCurveTo(rx - 0.008 * t, ry - h * 0.55, top.x - 0.008 * t, top.y); g.stroke();
    // lower leaves, then the ear, then upper leaves in front
    var rib = mix(pal.leaf, 0.28), snow = season === 'winter';
    function leaves(from, to) {
      for (i = from; i < to; i++) {
        f = 0.16 + i * 0.15; side = i % 2 ? 1 : -1;
        var p = at(f), len = (0.62 - f * 0.28) * t * sc, ang = side > 0 ? -0.55 - rnd() * 0.2 : -Math.PI + 0.55 + rnd() * 0.2;
        leaf(g, p.x, p.y, ang, len, 0.09 * t * sc, i % 3 === 0 ? mix(pal.leaf, -0.14) : pal.leaf, rib, 1.1 + rnd() * 0.5);
        if (snow) { g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.ellipse(p.x + Math.cos(ang) * len * 0.7, p.y + Math.sin(ang) * len * 0.7 - 0.01 * t, 0.07 * t * sc, 0.025 * t * sc, 0, 0, TAU); g.fill(); }
      }
    }
    leaves(0, 3);
    // ear
    var es = rnd() < 0.5 ? -1 : 1, ep = at(0.5), er = (season === 'spring' ? 0.62 : 1) * sc;
    var ex = ep.x + es * 0.085 * t * sc, ey = ep.y - 0.03 * t, ew = 0.095 * t * er, eh = 0.27 * t * er, tilt = es * 0.28;
    g.save(); g.translate(ex, ey); g.rotate(tilt);
    // husk leaves wrapping the base
    for (i = -1; i <= 1; i += 2) leaf(g, i * 0.015 * t, eh * 0.55, -Math.PI / 2 + i * 0.22, eh * 1.15, ew * 0.95, pal.husk, mix(pal.husk, -0.2), i * 0.1);
    // ear body with kernel rows
    var eg = g.createLinearGradient(-ew, 0, ew, 0);
    eg.addColorStop(0, pal.corn[0]); eg.addColorStop(0.45, pal.corn[1]); eg.addColorStop(1, pal.corn[2]);
    g.beginPath(); g.ellipse(0, -eh * 0.18, ew, eh * 0.78, 0, 0, TAU); g.fillStyle = eg; g.fill();
    g.save(); g.beginPath(); g.ellipse(0, -eh * 0.18, ew, eh * 0.78, 0, 0, TAU); g.clip();
    g.fillStyle = pal.kernel; g.globalAlpha = 0.5;
    for (var row = 0; row < 8; row++) for (var col = -1; col <= 1; col++) {
      g.beginPath(); g.ellipse(col * ew * 0.5 + (row % 2) * ew * 0.12, -eh * 0.88 + row * eh * 0.19, ew * 0.2, eh * 0.06, 0, 0, TAU); g.fill();
    }
    g.globalAlpha = 0.28; g.strokeStyle = pal.corn[2]; g.lineWidth = Math.max(0.5, 0.012 * t);
    for (col = -1; col <= 1; col += 2) { g.beginPath(); g.moveTo(col * ew * 0.28, -eh); g.lineTo(col * ew * 0.28, eh * 0.6); g.stroke(); }
    g.restore(); g.globalAlpha = 1;
    // husk front flap + silk
    leaf(g, 0, eh * 0.62, -Math.PI / 2 - es * 0.12, eh * 0.95, ew * 0.9, mix(pal.husk, 0.08), mix(pal.husk, -0.2), -es * 0.2);
    g.strokeStyle = '#c99a5a'; g.lineWidth = Math.max(0.6, 0.012 * t);
    g.beginPath(); g.moveTo(0, -eh * 0.92); g.lineTo(-0.03 * t, -eh * 1.1); g.moveTo(0, -eh * 0.92); g.lineTo(0.025 * t, -eh * 1.12); g.stroke();
    g.restore();
    leaves(3, 6);
    // tassel
    var tc = pal.tassel;
    g.strokeStyle = tc; g.lineWidth = Math.max(0.8, 0.018 * t * sc); g.lineCap = 'round';
    for (i = -2; i <= 2; i++) {
      g.beginPath(); g.moveTo(top.x, top.y);
      g.quadraticCurveTo(top.x + i * 0.05 * t * sc, top.y - 0.14 * t * sc, top.x + i * 0.11 * t * sc, top.y - (0.12 - Math.abs(i) * 0.025) * t * sc + 0.03 * t);
      g.stroke();
    }
    g.fillStyle = tc;
    for (i = -2; i <= 2; i++) { g.beginPath(); g.arc(top.x + i * 0.11 * t * sc, top.y - (0.12 - Math.abs(i) * 0.025) * t * sc + 0.03 * t, 0.014 * t * sc, 0, TAU); g.fill(); }
    if (snow) { g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.ellipse(top.x, top.y - 0.02 * t, 0.09 * t * sc, 0.035 * t * sc, 0, 0, TAU); g.fill(); }
    else if (season === 'spring' && rnd() < 0.5) flat(g, top.x + 0.06 * t, top.y + 0.12 * t, 0.03 * t, 0.03 * t, pal.flower);
  }

  /** A cell's worth of corn: a main plant with two smaller ones behind it, all drawn from a seeded generator. */
  function drawCornSprite(gs, pal, t, rnd, season) {
    var cx = (SPR.pad + 0.5) * t, ry = (SPR.over + 0.9) * t, g = gs[0];
    var sh = g.createRadialGradient(cx + 0.06 * t, ry + 0.05 * t, 0, cx + 0.06 * t, ry + 0.05 * t, 0.46 * t);
    sh.addColorStop(0, 'rgba(40,25,10,0.38)'); sh.addColorStop(1, 'rgba(40,25,10,0)');
    g.save(); g.translate(cx, ry + 0.05 * t); g.scale(1, 0.34); g.translate(-cx, -(ry + 0.05 * t));
    g.fillStyle = sh; g.beginPath(); g.arc(cx + 0.06 * t, ry + 0.05 * t, 0.46 * t, 0, TAU); g.fill(); g.restore();
    var roots = [{ x: cx - 0.2 * t, y: ry - 0.1 * t }, { x: cx + 0.22 * t, y: ry - 0.08 * t }, null];
    drawPlant(gs[1], pal, season, t, roots[0].x, roots[0].y, 0.9 * t, 0.78, rnd);
    drawPlant(gs[2], pal, season, t, roots[1].x, roots[1].y, 0.85 * t, 0.74, rnd);
    roots[2] = { x: cx + (rnd() - 0.5) * 0.06 * t, y: ry };
    drawPlant(gs[3], pal, season, t, roots[2].x, roots[2].y, 1.1 * t, 1, rnd);
    return roots;
  }

  /* Per variant: `layers` = [shadow, backLeft, backRight, front] canvases, `roots` = each plant's root in sprite css px,
     and `comp` = the cell composited from those same layers, so a resting cell (one drawImage) and a cell whose stalks
     are moving look identical. */
  var spriteCache = {};
  function getSprites(season, t, dpr) {
    var key = season + '|' + t + '|' + dpr;
    if (spriteCache[key]) return spriteCache[key];
    var out = { comp: [], layers: [], roots: [] }, w = Math.ceil((1 + 2 * SPR.pad) * t * dpr), h = Math.ceil((SPR.over + 1 + SPR.under) * t * dpr);
    function mk() { var c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').scale(dpr, dpr); return c; }
    for (var v = 0; v < 6; v++) {
      var cvs = [mk(), mk(), mk(), mk()], comp = mk(), cg = comp.getContext('2d');
      out.roots.push(drawCornSprite(cvs.map(function (c) { return c.getContext('2d'); }), PAL[season], t, mulberry32(v * 977 + 13), season));
      cg.setTransform(1, 0, 0, 1, 0, 0);
      for (var li = 0; li < 4; li++) cg.drawImage(cvs[li], 0, 0);
      out.layers.push(cvs); out.comp.push(comp);
    }
    spriteCache = {}; // keep a single entry
    spriteCache[key] = out;
    return out;
  }

  var LAYER_MAX_PIXELS = 16000000; // ~64 MB of pixel data per field layer
  /** Static diorama layer: tray, soil, paths and, when `withCorn`, the baked corn. Returns {canvas, w, h, withCorn} in css px.
   *  Without corn the stalks are drawn live from the sprite atlas (see drawCorn) so they can sway at their roots. */
  function buildLayer(s, season, t, dpr, withCorn) {
    var pal = PAL[season], LW = (s.w + 2 * ORG) * t, LH = (s.h + ORGY + ORG + 0.4) * t;
    // Bound the backing store: lower the layer's DPR (never its css size) so it stays within LAYER_MAX_PIXELS.
    dpr = Math.min(dpr, Math.sqrt(LAYER_MAX_PIXELS / (LW * LH)));
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.floor(LW * dpr)); cv.height = Math.max(1, Math.floor(LH * dpr));
    var g = cv.getContext('2d'); g.scale(cv.width / LW, cv.height / LH);
    var x0 = 0.3 * t, y0 = (ORGY - ORG + 0.3) * t, pw = LW - 0.6 * t, ph = (s.h + 2 * ORG - 0.6) * t, depth = 0.4 * t, rad = 0.5 * t;
    // tray: side + drop shadow, then top
    g.save(); g.shadowColor = 'rgba(70,45,20,0.35)'; g.shadowBlur = 0.45 * t; g.shadowOffsetY = 0.22 * t;
    rr(g, x0, y0 + depth, pw, ph, rad); g.fillStyle = pal.trayDark; g.fill(); g.restore();
    rr(g, x0, y0 + depth * 0.5, pw, ph, rad); g.fillStyle = mix(pal.trayDark, -0.08); g.fill();
    var tg = g.createLinearGradient(0, y0, 0, y0 + ph);
    tg.addColorStop(0, mix(pal.tray, 0.25)); tg.addColorStop(1, pal.tray);
    rr(g, x0, y0, pw, ph, rad); g.fillStyle = tg; g.fill();
    // soil bed
    var fx = ORG * t, fy = ORGY * t, fw = s.w * t, fh = s.h * t;
    g.save(); rr(g, fx - 0.06 * t, fy - 0.06 * t, fw + 0.12 * t, fh + 0.12 * t + 0.14 * t, 0.22 * t);
    g.fillStyle = mix(pal.soil, -0.4); g.fill(); g.restore(); // raised front lip of the bed
    rr(g, fx, fy, fw, fh, 0.16 * t); g.fillStyle = pal.soil; g.fill();
    g.save(); rr(g, fx, fy, fw, fh, 0.16 * t); g.clip();
    var x, y, i;
    // paths
    for (y = 0; y < s.h; y++) {
      for (x = 0; x < s.w; x++) {
        if (s.grid[y * s.w + x]) continue;
        var px = fx + x * t, py = fy + y * t;
        g.fillStyle = pal.path; g.fillRect(px - 0.5, py - 0.5, t + 1, t + 1);
        var hh = hash(x, y, 5);
        g.fillStyle = 'rgba(120,85,50,0.12)';
        g.beginPath(); g.arc(px + ((hh & 255) / 255) * t, py + (((hh >> 8) & 255) / 255) * t, 0.04 * t, 0, TAU); g.fill();
        g.beginPath(); g.arc(px + (((hh >> 16) & 255) / 255) * t, py + (((hh >> 24) & 255) / 255) * t, 0.03 * t, 0, TAU); g.fill();
      }
    }
    // soft edge shadows where paths meet corn
    var ew = 0.22 * t;
    for (y = 0; y < s.h; y++) {
      for (x = 0; x < s.w; x++) {
        if (s.grid[y * s.w + x]) continue;
        var qx = fx + x * t, qy = fy + y * t, side;
        for (i = 0; i < 4; i++) {
          var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
          if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h || !s.grid[ny * s.w + nx]) continue;
          var ax = qx + (DIRS[i][0] > 0 ? t : DIRS[i][0] < 0 ? 0 : t / 2), ay = qy + (DIRS[i][1] > 0 ? t : DIRS[i][1] < 0 ? 0 : t / 2);
          var lg = g.createLinearGradient(ax, ay, ax - DIRS[i][0] * ew, ay - DIRS[i][1] * ew);
          lg.addColorStop(0, 'rgba(70,40,20,0.28)'); lg.addColorStop(1, 'rgba(70,40,20,0)');
          g.fillStyle = lg;
          if (i === 0) g.fillRect(qx + t - ew, qy, ew, t);
          else if (i === 2) g.fillRect(qx, qy, ew, t);
          else if (i === 1) g.fillRect(qx, qy + t - ew, t, ew);
          else g.fillRect(qx, qy, t, ew);
        }
      }
    }
    g.restore();
    // corn
    if (withCorn) {
      var sprites = getSprites(season, t, dpr), sw = (1 + 2 * SPR.pad) * t, sh = (SPR.over + 1 + SPR.under) * t;
      for (y = 0; y < s.h; y++) { // top to bottom so nearer rows overlap farther ones
        for (x = 0; x < s.w; x++) {
          if (!s.grid[y * s.w + x]) continue;
          g.drawImage(sprites.comp[hash(x, y, s.seed) % 6], fx + x * t - SPR.pad * t, fy + (y + 1 + SPR.under) * t - sh, sw, sh);
        }
      }
    }
    return { canvas: cv, w: LW, h: LH, withCorn: !!withCorn };
  }

  /** Corn motion: each stalk rests most of the time and takes its own short lean burst (core.cornPose). Cells whose
   *  three plants all rest draw the cached composite in one call; a cell with a moving stalk draws its cached shadow
   *  and plant layers, each rotated about its own root so roots never move. Below MOTION_MIN_T px per tile motion is
   *  invisible, so everything stays on the composite. Only cells whose sprite can touch the viewport are visited.
   *  Returns { drawn, activeCells, activePlants, visiblePlants }. */
  var MOTION_MIN_T = 10;
  function drawCorn(g, s, sprites, t, dpr, ox, oy, cw, ch, time) {
    var sw = (1 + 2 * SPR.pad) * t, sh = (SPR.over + 1 + SPR.under) * t, bx = ox + ORG * t, by = oy + ORGY * t;
    var x0 = Math.max(0, Math.floor((-bx - sw) / t)), x1 = Math.min(s.w - 1, Math.ceil((cw - bx + sw) / t));
    var y0 = Math.max(0, Math.floor((-by - sh) / t)), y1 = Math.min(s.h - 1, Math.ceil((ch - by + (SPR.over + 1) * t) / t));
    var moves = t >= MOTION_MIN_T, st = { drawn: 0, activeCells: 0, activePlants: 0, visiblePlants: 0 }, poses = [{}, {}, {}];
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (!s.grid[y * s.w + x]) continue;
        var v = hash(x, y, s.seed) % 6, px = bx + x * t - SPR.pad * t, py = by + y * t - SPR.over * t, anyActive = false, p;
        st.drawn++; st.visiblePlants += 3;
        if (moves) {
          for (p = 0; p < 3; p++) {
            poses[p] = core.cornPose(x, y, p, s.seed, time, poses[p]);
            if (poses[p].active) { anyActive = true; st.activePlants++; }
          }
        }
        if (!anyActive) { g.drawImage(sprites.comp[v], px, py, sw, sh); continue; }
        st.activeCells++;
        var layers = sprites.layers[v], roots = sprites.roots[v];
        g.drawImage(layers[0], px, py, sw, sh);
        for (p = 0; p < 3; p++) {
          var a = poses[p].angle;
          if (!a) { g.drawImage(layers[p + 1], px, py, sw, sh); continue; }
          // rotate about this stalk's root; positive angle leans the top to the right
          g.setTransform(dpr * Math.cos(a), dpr * Math.sin(a), -dpr * Math.sin(a), dpr * Math.cos(a), dpr * (px + roots[p].x), dpr * (py + roots[p].y));
          g.drawImage(layers[p + 1], -roots[p].x, -roots[p].y, sw, sh);
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      }
    }
    return st;
  }

  /* ---- toy tractor: raised side/front/back views with cab, fenders and big round tires ---- */
  function vgrad(g, x, y, w, h, r, c1, c2) {
    var gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, c1); gr.addColorStop(1, c2);
    g.fillStyle = gr; rr(g, x, y, w, h, r); g.fill();
  }
  function tire(g, x, y, r, phase) {
    var gr = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r * 1.05);
    gr.addColorStop(0, '#6a5b52'); gr.addColorStop(0.7, '#3f342f'); gr.addColorStop(1, '#2b221e');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.strokeStyle = '#2b221e'; g.lineWidth = r * 0.16; g.lineCap = 'round';
    for (var k = 0; k < 10; k++) {
      var a = (k + phase * 10) / 10 * TAU;
      g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.78); g.lineTo(x + Math.cos(a) * r * 0.98, y + Math.sin(a) * r * 0.98); g.stroke();
    }
    ball(g, x, y, r * 0.46, r * 0.46, '#efc86a');
    flat(g, x, y, r * 0.14, r * 0.14, '#8d6a2c');
  }
  function sideTractor(g, ph) {
    flat(g, 0.02, 0.45, 0.52, 0.09, 'rgba(40,25,10,0.28)');
    vgrad(g, -0.34, 0.02, 0.8, 0.2, 0.06, '#c4513a', '#9c3b2a');            // chassis
    vgrad(g, 0.04, -0.12, 0.42, 0.3, 0.09, '#f48f76', '#d4573f');           // hood
    g.fillStyle = '#f4e2b8'; rr(g, 0.43, -0.07, 0.06, 0.22, 0.03); g.fill(); // grill
    g.strokeStyle = '#b79a6a'; g.lineWidth = 0.015;
    for (var k = 0; k < 3; k++) { g.beginPath(); g.moveTo(0.435, -0.03 + k * 0.06); g.lineTo(0.485, -0.03 + k * 0.06); g.stroke(); }
    flat(g, 0.47, -0.1, 0.035, 0.035, '#fbe58a');
    g.fillStyle = '#5a4a44'; rr(g, 0.29, -0.34, 0.05, 0.24, 0.02); g.fill(); rr(g, 0.275, -0.37, 0.08, 0.04, 0.02); g.fill(); // exhaust
    vgrad(g, -0.42, -0.4, 0.46, 0.46, 0.07, '#e8745b', '#cc4f38');          // cab
    vgrad(g, -0.45, -0.52, 0.52, 0.12, 0.05, '#fbb09c', '#e8745b');         // roof, top face catching light
    vgrad(g, -0.37, -0.39, 0.34, 0.31, 0.05, '#dff0f4', '#9cc5d3');         // side window
    g.fillStyle = '#e8745b'; g.fillRect(-0.21, -0.39, 0.035, 0.31);          // pillar
    ball(g, -0.3, -0.2, 0.05, 0.055, '#f6d5b0');                             // driver head
    tire(g, -0.2, 0.2, 0.25, ph);
    g.fillStyle = '#d9533c'; g.beginPath(); g.arc(-0.2, 0.2, 0.29, Math.PI * 1.02, Math.PI * 1.98); g.arc(-0.2, 0.2, 0.25, Math.PI * 1.98, Math.PI * 1.02, true); g.closePath(); g.fill(); // fender
    tire(g, 0.3, 0.3, 0.14, ph);
    g.strokeStyle = '#d9533c'; g.lineWidth = 0.03; g.beginPath(); g.arc(0.3, 0.3, 0.17, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
  }
  function frontTractor(g, ph, back) {
    flat(g, 0, 0.45, 0.54, 0.1, 'rgba(40,25,10,0.28)');
    function bigTires() {
      for (var i = -1; i <= 1; i += 2) {
        var x = i * 0.38 - 0.085, gr = g.createLinearGradient(x, 0, x + 0.17, 0);
        gr.addColorStop(0, '#6a5b52'); gr.addColorStop(1, '#2b221e');
        g.fillStyle = gr; rr(g, x, back ? -0.02 : -0.14, 0.17, 0.52, 0.07); g.fill();
        g.strokeStyle = '#2b221e'; g.lineWidth = 0.025;
        for (var k = 0; k < 6; k++) { var yy = (back ? 0.0 : -0.12) + ((k + ph * 6) % 6) * 0.085; g.beginPath(); g.moveTo(x + 0.01, yy); g.lineTo(x + 0.16, yy); g.stroke(); }
      }
    }
    if (back) {
      for (var j = -1; j <= 1; j += 2) { g.fillStyle = '#3f342f'; rr(g, j * 0.26 - 0.045, -0.42, 0.09, 0.26, 0.04); g.fill(); }
      vgrad(g, -0.2, -0.4, 0.4, 0.26, 0.09, '#f48f76', '#d4573f');
    }
    if (!back) bigTires();
    if (!back) {
      for (var m = -1; m <= 1; m += 2) { g.fillStyle = '#3f342f'; rr(g, m * 0.26 - 0.045, 0.2, 0.09, 0.26, 0.04); g.fill(); }
      vgrad(g, -0.21, 0.0, 0.42, 0.3, 0.09, '#f6a58f', '#d4573f');                 // hood
      g.fillStyle = '#f4e2b8'; rr(g, -0.14, 0.07, 0.28, 0.17, 0.04); g.fill();   // grill
      g.strokeStyle = '#b79a6a'; g.lineWidth = 0.014;
      for (var q = 0; q < 3; q++) { g.beginPath(); g.moveTo(-0.13, 0.11 + q * 0.05); g.lineTo(0.13, 0.11 + q * 0.05); g.stroke(); }
      flat(g, -0.16, 0.0, 0.035, 0.035, '#fbe58a'); flat(g, 0.16, 0.0, 0.035, 0.035, '#fbe58a');
    }
    // cab
    var cy = back ? -0.2 : -0.5;
    vgrad(g, -0.29, cy, 0.58, 0.46, 0.07, '#e8745b', '#cc4f38');
    vgrad(g, -0.32, cy - 0.12, 0.64, 0.14, 0.05, '#fbb09c', '#e8745b');           // roof top
    vgrad(g, -0.22, cy + 0.04, 0.44, 0.3, 0.05, '#dff0f4', '#9cc5d3');           // glass
    g.fillStyle = '#e8745b'; g.fillRect(-0.012, cy + 0.04, 0.024, 0.3);
    if (!back) { g.fillStyle = '#5a4a44'; rr(g, 0.14, -0.2, 0.045, 0.18, 0.02); g.fill(); }
    else {
      bigTires();
      flat(g, -0.3, 0.38, 0.03, 0.03, '#e2453c'); flat(g, 0.3, 0.38, 0.03, 0.03, '#e2453c');
    }
    // fenders over the big tires
    g.fillStyle = '#d9533c';
    rr(g, -0.5, back ? -0.06 : -0.17, 0.2, 0.09, 0.04); g.fill(); rr(g, 0.3, back ? -0.06 : -0.17, 0.2, 0.09, 0.04); g.fill();
  }
  function drawTractor(g, cx, cy, t, dir, phase) {
    g.save(); g.translate(cx, cy); g.scale(t, t);
    var ph = ((phase % 1) + 1) % 1;
    if (dir === 0) sideTractor(g, ph);
    else if (dir === 2) { g.scale(-1, 1); sideTractor(g, ph); }
    else frontTractor(g, ph, dir === 3);
    g.restore();
  }

  /* ---- six toy animals (front-facing, upright) ---- */
  var ANI_BODY = { dog: '#d9a86c', cat: '#e8a259', cow: '#fbf7ee', horse: '#a8683c', pig: '#f6aebb', chicken: '#fffaf0' };
  var ANI_FOOT = { dog: '#8a5a35', cat: '#c47a36', cow: '#f3b3b3', horse: '#4b2f20', pig: '#ee93a6', chicken: '#f0a030' };

  var ANI_LEG = { dog: '#b98550', cat: '#d98d3e', cow: '#f1ece0', horse: '#6b4129', pig: '#f08ea5', chicken: '#f0a030' };

  /* Four legs hang below the body, outside its outline. Diagonal pairs alternate (front-left with hind-right,
     then the other two). A leg's cycle is sin(phase + offset): positive = swinging (paw lifted, reaching out),
     negative = planted and pushing back. Phase 0 and every multiple of PI is the neutral pose for both pairs. */
  function drawLeg(g, kind, r, sx, front, off, pose, noToes) {
    var amt = pose ? pose.amount : 0, sw = pose ? Math.sin(pose.phase + off) * amt : 0, up = Math.max(0, sw), down = Math.max(0, -sw);
    var hipX = sx * (front ? 0.26 : 0.5) * r, hipY = (front ? 0.78 : 0.68) * r;
    var fx = hipX + sx * (front ? 0.1 : 0.08) * r * sw;
    var fy = (front ? 1.2 : 1.1) * r - up * (kind === 'chicken' ? 0.36 : 0.32) * r * (front ? 1 : 0.85) + down * 0.07 * r;
    var near = 1 + 0.22 * sw * (front ? 1 : 0.6); // a reaching paw comes toward the viewer
    g.save(); g.lineCap = 'round'; g.strokeStyle = ANI_LEG[kind]; g.lineWidth = Math.max(0.16 * r, 2);
    g.beginPath(); g.moveTo(hipX, hipY); g.lineTo(fx, fy - 0.03 * r); g.stroke();
    ball(g, fx, fy, (front ? 0.19 : 0.16) * r * near, 0.11 * r * near, front ? ANI_FOOT[kind] : mix(ANI_FOOT[kind], -0.15));
    if (front && !noToes) {
      g.strokeStyle = mix(ANI_FOOT[kind], -0.3); g.lineWidth = Math.max(0.5, 0.025 * r);
      g.beginPath(); g.moveTo(fx - 0.04 * r, fy + 0.04 * r); g.lineTo(fx - 0.04 * r, fy - 0.02 * r);
      g.moveTo(fx + 0.04 * r, fy + 0.04 * r); g.lineTo(fx + 0.04 * r, fy - 0.02 * r); g.stroke();
    }
    g.restore();
  }

  function groundShadow(g, r, rx) {
    var sg = g.createRadialGradient(0, 1.22 * r, 0, 0, 1.22 * r, rx * r);
    sg.addColorStop(0, 'rgba(40,25,10,0.38)'); sg.addColorStop(1, 'rgba(40,25,10,0)');
    g.save(); g.translate(0, 1.22 * r); g.scale(1, 0.2); g.translate(0, -1.22 * r);
    g.fillStyle = sg; g.beginPath(); g.arc(0, 1.22 * r, rx * r, 0, TAU); g.fill(); g.restore();
  }

  /* Side profile, facing right (the left view is this drawn mirrored). Diagonal legs move together as in the front view:
     the near front leg pairs with the far hind leg. A leg's sin(phase + off) > 0 is the swing (paw lifted and reaching forward). */
  function sideLeg(g, kind, r, hipX, off, far, pose) {
    var amt = pose ? pose.amount : 0, sw = pose ? Math.sin(pose.phase + off) * amt : 0, up = Math.max(0, sw), down = Math.max(0, -sw);
    var fx = hipX + 0.26 * r * sw, fy = 1.17 * r - up * 0.3 * r + down * 0.03 * r;
    var lc = far ? mix(ANI_LEG[kind], -0.22) : ANI_LEG[kind], fc = far ? mix(ANI_FOOT[kind], -0.22) : ANI_FOOT[kind];
    g.save(); g.lineCap = 'round'; g.strokeStyle = lc; g.lineWidth = Math.max((kind === 'chicken' ? 0.1 : 0.16) * r, 2);
    g.beginPath(); g.moveTo(hipX, 0.7 * r); g.lineTo(fx, fy - 0.03 * r); g.stroke();
    ball(g, fx + 0.05 * r, fy, 0.16 * r, 0.09 * r, fc);
    g.restore();
  }
  function sideAnimal(g, kind, r, pose) {
    var amt = pose ? pose.amount : 0, sn = pose ? Math.sin(pose.phase) * amt : 0, cs = pose ? Math.cos(pose.phase) * amt : 0;
    var sq = pose ? Math.cos(2 * pose.phase) * amt : 0, body = ANI_BODY[kind], u = 0.5 * r, bx = -0.08 * r, i;
    var rx = { dog: 0.72, cat: 0.66, cow: 0.8, horse: 0.82, pig: 0.76, chicken: 0.56 }[kind] * r;
    groundShadow(g, r, 1.0);
    // tail first, so the body overlaps its root
    g.save(); g.lineCap = 'round';
    var tx = bx - rx * 0.92, tw = 0.5 * sn;
    if (kind === 'dog') { g.translate(tx, 0.4 * r); g.rotate(tw * 0.5); g.strokeStyle = '#b98550'; g.lineWidth = 0.14 * r; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(-0.3 * r, -0.05 * r, -0.32 * r, -0.4 * r); g.stroke(); }
    else if (kind === 'cat') { g.translate(tx, 0.5 * r); g.rotate(tw * 0.3); g.strokeStyle = body; g.lineWidth = 0.13 * r; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(-0.5 * r, 0.05 * r, -0.42 * r, -0.45 * r); g.quadraticCurveTo(-0.4 * r, -0.65 * r, -0.28 * r, -0.62 * r); g.stroke(); }
    else if (kind === 'cow') { g.translate(tx, 0.32 * r); g.rotate(tw * 0.3); g.strokeStyle = '#3a3532'; g.lineWidth = 0.08 * r; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(-0.15 * r, 0.3 * r, -0.1 * r, 0.62 * r); g.stroke(); ball(g, -0.1 * r, 0.7 * r, 0.1 * r, 0.16 * r, '#3a3532'); }
    else if (kind === 'horse') { g.translate(tx, 0.3 * r); g.rotate(tw * 0.35); poly(g, [0, -0.05 * r, -0.2 * r, 0.05 * r, -0.45 * r, 0.55 * r, -0.18 * r, 0.85 * r, -0.05 * r, 0.5 * r, 0.05 * r, 0.1 * r], '#4b2f20'); }
    else if (kind === 'pig') { g.translate(tx, 0.35 * r); g.strokeStyle = '#ee93a6'; g.lineWidth = 0.07 * r; g.beginPath(); g.arc(-0.08 * r, -0.04 * r, 0.12 * r, 0.6, TAU * 0.9); g.stroke(); }
    else { g.translate(tx + 0.1 * r, 0.3 * r); g.rotate(tw * 0.15); poly(g, [0, 0.1 * r, -0.5 * r, -0.5 * r, -0.28 * r, 0.1 * r], '#e2453c'); poly(g, [0, 0.12 * r, -0.62 * r, -0.12 * r, -0.28 * r, 0.22 * r], '#efe7d6'); poly(g, [0, 0.12 * r, -0.5 * r, 0.12 * r, -0.2 * r, 0.3 * r], '#c9b890'); }
    g.restore();
    sideLeg(g, kind, r, bx - rx * 0.55, 0, true, pose); sideLeg(g, kind, r, bx + rx * 0.55, Math.PI, true, pose);   // far legs
    g.save(); g.translate(bx, 0.75 * r); g.rotate(0.04 * sn); g.translate(-bx, -0.75 * r);
    ball(g, bx, 0.5 * r, rx * (1 + 0.04 * sq), (kind === 'chicken' ? 0.48 : 0.44) * r * (1 - 0.05 * sq), body, kind === 'chicken' ? -0.25 : 0);
    if (kind === 'cow') { flat(g, bx - 0.12 * r, 0.4 * r, 0.3 * r, 0.22 * r, '#3a3532', 0.3); flat(g, bx + 0.35 * r, 0.65 * r, 0.16 * r, 0.12 * r, '#3a3532', 0.2); }
    else if (kind === 'chicken') ball(g, bx - 0.02 * r, 0.52 * r, 0.36 * r, 0.24 * r, '#efe7d6', 0.25 + 0.5 * amt * (0.5 + 0.5 * sq));
    g.restore();
    sideLeg(g, kind, r, bx - rx * 0.55, Math.PI, false, pose); sideLeg(g, kind, r, bx + rx * 0.55, 0, false, pose);   // near legs
    if (kind === 'horse') { // arched neck, mane and a long face
      poly(g, [bx + 0.35 * r, 0.3 * r, bx + 0.78 * r, 0.4 * r, bx + 0.98 * r, -0.4 * r, bx + 0.62 * r, -0.8 * r], '#a8683c');
      poly(g, [bx + 0.3 * r, 0.25 * r, bx + 0.56 * r, -0.82 * r, bx + 0.7 * r, -0.76 * r, bx + 0.42 * r, 0.3 * r], '#4b2f20');
    }
    // the head nods with the stride (a chicken pecks forward)
    var hx = { dog: 0.64, cat: 0.6, cow: 0.64, horse: 1.12, pig: 0.68, chicken: 0.5 }[kind] * r + bx, hy = { horse: -0.42, chicken: -0.14 }[kind] * r;
    if (hy === undefined || isNaN(hy)) hy = -0.14 * r;
    g.save(); g.translate(hx + (kind === 'chicken' ? 0.07 * r * cs : 0), hy + (kind === 'chicken' ? 0 : 0.05 * r * sq)); g.rotate(0.1 * sn);
    function eye(ex, ey, s) {
      flat(g, ex, ey, 0.1 * u * s, 0.12 * u * s, '#2b211c'); flat(g, ex - 0.03 * u, ey - 0.04 * u, 0.035 * u, 0.04 * u, '#ffffff');
    }
    if (kind === 'dog') {
      ball(g, 0, 0, u * 1.05, u, body);
      flat(g, 0.25 * u, -0.45 * u, 0.5 * u, 0.3 * u, '#9a6a3e');
      ball(g, 0.78 * u, 0.32 * u, 0.58 * u, 0.4 * u, '#f6e6c8');
      ball(g, 1.3 * u, 0.2 * u, 0.17 * u, 0.14 * u, '#3b2a22');
      flat(g, 0.9 * u, 0.62 * u, 0.2 * u, 0.1 * u, '#e8708a');
      eye(0.42 * u, -0.12 * u, 1);
      ball(g, -0.35 * u, 0.1 * u, 0.34 * u, 0.62 * u, '#8a5a35', 0.2 + 0.3 * cs);
    } else if (kind === 'cat') {
      poly(g, [-0.55 * u, -0.5 * u, -0.5 * u, -1.45 * u, 0.15 * u, -0.85 * u], body);
      poly(g, [-0.4 * u, -0.6 * u, -0.38 * u, -1.15 * u, 0.0 * u, -0.8 * u], '#f3b3b3');
      poly(g, [0.0 * u, -0.85 * u, 0.5 * u, -1.45 * u, 0.78 * u, -0.45 * u], mix(body, -0.08));
      ball(g, 0, 0, u * 1.05, u * 0.92, body);
      g.strokeStyle = '#b86d2a'; g.lineWidth = 0.06 * u;
      for (i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(i * 0.22 * u, -0.9 * u); g.lineTo(i * 0.22 * u + 0.1 * u, -0.6 * u); g.stroke(); }
      ball(g, 0.74 * u, 0.34 * u, 0.4 * u, 0.28 * u, '#fbe6cc');
      poly(g, [0.98 * u, 0.2 * u, 1.18 * u, 0.26 * u, 1.04 * u, 0.4 * u], '#e57f93');
      g.strokeStyle = 'rgba(60,40,30,0.55)'; g.lineWidth = 0.025 * u;
      g.beginPath(); g.moveTo(0.9 * u, 0.4 * u); g.lineTo(1.65 * u, 0.28 * u); g.moveTo(0.9 * u, 0.46 * u); g.lineTo(1.6 * u, 0.58 * u); g.stroke();
      eye(0.42 * u, -0.12 * u, 1);
    } else if (kind === 'cow') {
      ball(g, 0.05 * u, -1.0 * u, 0.14 * u, 0.22 * u, '#efe0b8', 0.2);
      ball(g, -0.62 * u, -0.45 * u, 0.42 * u, 0.18 * u, '#fbf7ee', 0.45 + 0.3 * cs);
      ball(g, 0, 0, u * 1.05, u * 0.98, '#fbf7ee');
      flat(g, -0.3 * u, -0.38 * u, 0.4 * u, 0.34 * u, '#3a3532', 0.3);
      ball(g, 0.82 * u, 0.4 * u, 0.62 * u, 0.46 * u, '#f3b3b3');
      flat(g, 1.28 * u, 0.36 * u, 0.07 * u, 0.1 * u, '#b5686c');
      eye(0.45 * u, -0.14 * u, 1);
    } else if (kind === 'horse') {
      ball(g, 0.1 * r, -0.12 * r, 0.27 * r, 0.52 * r, '#a8683c', -0.85);
      ball(g, 0.4 * r, 0.12 * r, 0.2 * r, 0.26 * r, '#c99468', -0.85);
      flat(g, 0.5 * r, 0.2 * r, 0.04 * r, 0.06 * r, '#5a3a28', -0.85);
      poly(g, [-0.18 * r, -0.4 * r, -0.2 * r, -0.82 * r, 0.0 * r, -0.5 * r], '#a8683c');
      ball(g, -0.04 * r, -0.4 * r, 0.12 * r, 0.2 * r, '#4b2f20', 0.3);
      eye(0.12 * r, -0.2 * r, 0.9);
    } else if (kind === 'pig') {
      ball(g, 0, 0, u * 1.05, u * 0.94, body);
      poly(g, [-0.55 * u, -0.6 * u, 0.1 * u, -1.0 * u, 0.15 * u, -0.25 * u], '#ee93a6');
      flat(g, 0.45 * u, 0.25 * u, 0.17 * u, 0.1 * u, 'rgba(240,120,140,0.5)');
      ball(g, 1.0 * u, 0.24 * u, 0.34 * u, 0.36 * u, '#f08ea5');
      flat(g, 1.18 * u, 0.2 * u, 0.06 * u, 0.1 * u, '#a8465f'); flat(g, 1.02 * u, 0.42 * u, 0.06 * u, 0.08 * u, '#a8465f');
      eye(0.45 * u, -0.14 * u, 0.9);
    } else { // chicken
      for (i = -1; i <= 1; i++) ball(g, i * 0.2 * r - 0.04 * r, -0.33 * r - (i === 0 ? 0.07 * r : 0), 0.11 * r, 0.12 * r, '#e2453c');
      ball(g, 0, 0, 0.3 * r, 0.3 * r, body);
      poly(g, [0.24 * r, -0.12 * r, 0.56 * r, 0.0 * r, 0.24 * r, 0.08 * r], '#f0a030');
      ball(g, 0.2 * r, 0.16 * r, 0.07 * r, 0.12 * r, '#e2453c');
      eye(0.1 * r, -0.07 * r, 0.9);
    }
    g.restore();
  }

  /* Seen from behind: no face, ears, tail and rump readable, hind legs nearest. */
  function backAnimal(g, kind, r, pose) {
    var amt = pose ? pose.amount : 0, sn = pose ? Math.sin(pose.phase) * amt : 0, cs = pose ? Math.cos(pose.phase) * amt : 0;
    var sq = pose ? Math.cos(2 * pose.phase) * amt : 0, body = ANI_BODY[kind], H = 0.62 * r, hy = -0.14 * r, i;
    function X(v) { return v * H; }
    function Y(v) { return hy + v * H; }
    groundShadow(g, r, 0.8);
    drawLeg(g, kind, r, -1, true, Math.PI, pose, true); drawLeg(g, kind, r, 1, true, 0, pose, true);   // far (front) legs
    g.save(); g.translate(0, 0.75 * r); g.rotate(0.07 * sn); g.translate(0, -0.75 * r);
    ball(g, 0, 0.5 * r, (kind === 'chicken' ? 0.64 : 0.6) * r * (1 + 0.05 * sq), 0.46 * r * (1 - 0.06 * sq), body);
    g.restore();
    // tail on the rump
    g.save(); g.lineCap = 'round'; g.translate(0, 0.4 * r); g.rotate(0.35 * sn);
    if (kind === 'dog') { g.strokeStyle = '#b98550'; g.lineWidth = 0.14 * r; g.beginPath(); g.moveTo(0, 0.1 * r); g.quadraticCurveTo(0.08 * r, -0.15 * r, 0.02 * r, -0.3 * r); g.stroke(); }
    else if (kind === 'cat') { g.strokeStyle = body; g.lineWidth = 0.13 * r; g.beginPath(); g.moveTo(0, 0.1 * r); g.quadraticCurveTo(0.22 * r, -0.2 * r, -0.04 * r, -0.5 * r); g.stroke(); }
    else if (kind === 'cow') { g.strokeStyle = '#3a3532'; g.lineWidth = 0.08 * r; g.beginPath(); g.moveTo(0, -0.05 * r); g.lineTo(0, 0.4 * r); g.stroke(); ball(g, 0, 0.5 * r, 0.1 * r, 0.16 * r, '#3a3532'); }
    else if (kind === 'horse') poly(g, [-0.08 * r, -0.05 * r, 0.08 * r, -0.05 * r, 0.16 * r, 0.5 * r, 0, 0.62 * r, -0.16 * r, 0.5 * r], '#4b2f20');
    else if (kind === 'pig') { g.strokeStyle = '#ee93a6'; g.lineWidth = 0.07 * r; g.beginPath(); g.arc(0, 0, 0.1 * r, 0.3, TAU * 0.95); g.stroke(); }
    else { for (i = -2; i <= 2; i++) ball(g, i * 0.17 * r, -0.2 * r - (2 - Math.abs(i)) * 0.06 * r, 0.1 * r, 0.34 * r, i % 2 ? '#e2453c' : '#efe7d6', i * 0.28); }
    g.restore();
    if (kind === 'cow') flat(g, 0.2 * r, 0.45 * r, 0.2 * r, 0.14 * r, '#3a3532', 0.4);
    if (kind === 'chicken') for (i = -1; i <= 1; i += 2) ball(g, i * 0.45 * r, 0.5 * r, 0.18 * r, 0.3 * r, '#efe7d6', -i * (0.3 + 0.55 * amt * (0.5 + 0.5 * sq)));
    drawLeg(g, kind, r, -1, false, 0, pose, true); drawLeg(g, kind, r, 1, false, Math.PI, pose, true);   // near (hind) legs
    g.save(); g.translate(0, hy + (kind === 'chicken' ? 0.09 * r * cs : 0.06 * r * sq)); g.rotate(0.13 * sn); g.translate(0, -hy);
    if (kind === 'dog') {
      for (i = -1; i <= 1; i += 2) ball(g, X(i * 0.85), Y(-0.05), 0.3 * H, 0.55 * H, '#8a5a35', -i * 0.25 + i * 0.35 * cs);
      ball(g, 0, hy, H, H * 0.96, body);
      flat(g, X(0.4), Y(-0.2), 0.3 * H, 0.3 * H, '#9a6a3e');
    } else if (kind === 'cat') {
      for (i = -1; i <= 1; i += 2) poly(g, [X(i * 0.97), Y(-0.2), X(i * 0.72) + i * 0.08 * H * cs, Y(-1.15), X(i * 0.22), Y(-0.82)], mix(body, -0.06));
      ball(g, 0, hy, H, H * 0.92, body);
      g.strokeStyle = '#b86d2a'; g.lineWidth = 0.06 * H; g.lineCap = 'round';
      for (i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(X(i * 0.22), Y(-0.9)); g.lineTo(X(i * 0.22), Y(-0.45)); g.stroke(); }
    } else if (kind === 'cow') {
      for (i = -1; i <= 1; i += 2) {
        ball(g, X(i * 0.55), Y(-0.98), 0.14 * H, 0.2 * H, '#efe0b8', i * 0.4);
        ball(g, X(i * 1.0), Y(-0.45), 0.34 * H, 0.18 * H, '#fbf7ee', i * (0.3 + 0.4 * cs));
      }
      ball(g, 0, hy, H, H * 0.98, '#fbf7ee');
      flat(g, X(-0.4), Y(-0.3), 0.4 * H, 0.36 * H, '#3a3532', 0.4);
    } else if (kind === 'horse') {
      for (i = -1; i <= 1; i += 2) poly(g, [X(i * 0.82), Y(-0.45), X(i * 0.62) + i * 0.1 * H * cs, Y(-1.28), X(i * 0.28), Y(-0.75)], '#a8683c');
      ball(g, 0, hy + 0.02 * r, 0.86 * H, 1.04 * H, '#a8683c');
      ball(g, 0, Y(0.1), 0.2 * H, 0.95 * H, '#4b2f20');   // mane down the back of the neck
    } else if (kind === 'pig') {
      for (i = -1; i <= 1; i += 2) poly(g, [X(i * 0.95), Y(-0.1), X(i * 0.4), Y(-0.9), X(i * 1.12), Y(-0.78) + 0.14 * H * cs * i], '#ee93a6');
      ball(g, 0, hy, H, H * 0.94, body);
    } else {
      for (i = -1; i <= 1; i++) ball(g, X(i * 0.3), Y(-1.0 - (i === 0 ? 0.12 : 0) - 0.07 * Math.abs(cs)), 0.22 * H, 0.24 * H, '#e2453c');
      ball(g, 0, hy, H, H * 0.96, body);
      ball(g, 0, Y(0.45), 0.55 * H, 0.35 * H, mix(body, -0.06));   // nape feathers
    }
    g.restore();
  }

  // pose (optional): { phase, amount } from the distance-driven gait; omitted = the neutral, static pose.
  // dir (optional): 0 right, 2 left, 3 away from the viewer (back); 1 or omitted = the front-facing view.
  function drawAnimal(g, kind, cx, cy, r, pose, dir) {
    if (dir === 0 || dir === 2 || dir === 3) {
      g.save(); g.translate(cx, cy);
      if (dir === 3) backAnimal(g, kind, r, pose);
      else { if (dir === 2) g.scale(-1, 1); sideAnimal(g, kind, r, pose); }
      g.restore();
      return;
    }
    var amt = pose ? pose.amount : 0, sn = pose ? Math.sin(pose.phase) * amt : 0, cs = pose ? Math.cos(pose.phase) * amt : 0;
    var sq = pose ? Math.cos(2 * pose.phase) * amt : 0;
    g.save(); g.translate(cx, cy);
    var H = 0.62 * r, hy = -0.14 * r, body = ANI_BODY[kind];
    // grounded soft shadow, tail, hind legs, rounded body, front legs with toes
    var sg = g.createRadialGradient(0, 1.22 * r, 0, 0, 1.22 * r, 0.8 * r);
    sg.addColorStop(0, 'rgba(40,25,10,0.38)'); sg.addColorStop(1, 'rgba(40,25,10,0)');
    g.save(); g.translate(0, 1.22 * r); g.scale(1, 0.2); g.translate(0, -1.22 * r);
    g.fillStyle = sg; g.beginPath(); g.arc(0, 1.22 * r, 0.8 * r, 0, TAU); g.fill(); g.restore();
    g.save(); g.translate(0.45 * r, 0.6 * r); g.rotate(0.45 * Math.sin(pose ? 2 * pose.phase + 1 : 0) * amt); g.translate(-0.45 * r, -0.6 * r);
    if (kind === 'cat') { g.strokeStyle = body; g.lineWidth = 0.14 * r; g.lineCap = 'round'; g.beginPath(); g.moveTo(0.4 * r, 0.7 * r); g.quadraticCurveTo(0.85 * r, 0.7 * r, 0.8 * r, 0.25 * r); g.stroke(); }
    else if (kind === 'cow' || kind === 'horse') { g.strokeStyle = kind === 'cow' ? '#3a3532' : '#4b2f20'; g.lineWidth = 0.1 * r; g.lineCap = 'round'; g.beginPath(); g.moveTo(0.45 * r, 0.6 * r); g.quadraticCurveTo(0.8 * r, 0.7 * r, 0.7 * r, 0.95 * r); g.stroke(); }
    else if (kind === 'dog') ball(g, 0.58 * r, 0.42 * r, 0.12 * r, 0.22 * r, '#b98550', 0.6);
    else if (kind === 'pig') { g.strokeStyle = '#ee93a6'; g.lineWidth = 0.07 * r; g.lineCap = 'round'; g.beginPath(); g.arc(0.58 * r, 0.5 * r, 0.1 * r, 0, TAU * 0.8); g.stroke(); }
    else poly(g, [0.4 * r, 0.45 * r, 0.82 * r, 0.1 * r, 0.7 * r, 0.5 * r, 0.9 * r, 0.42 * r, 0.45 * r, 0.75 * r], '#efe7d6');
    g.restore();
    drawLeg(g, kind, r, -1, false, 0, pose); drawLeg(g, kind, r, 1, false, Math.PI, pose);   // hind-left with front-right
    g.save(); g.translate(0, 0.75 * r); g.rotate(0.07 * sn); g.translate(0, -0.75 * r);    // the body rolls with each stride
    ball(g, 0, 0.5 * r, (kind === 'chicken' ? 0.64 : 0.6) * r * (1 + 0.05 * sq), 0.46 * r * (1 - 0.06 * sq), body);
    g.restore();
    drawLeg(g, kind, r, -1, true, Math.PI, pose); drawLeg(g, kind, r, 1, true, 0, pose);
    // the head nods and tilts with the stride (a chicken pecks forward)
    g.save(); g.translate(0, hy + (kind === 'chicken' ? 0.09 * r * cs : 0.06 * r * sq)); g.rotate(0.13 * sn); g.translate(0, -hy);
    function X(v) { return v * H; }
    function Y(v) { return hy + v * H; }
    function eyes(ex, ey, s) {
      for (var i = -1; i <= 1; i += 2) {
        flat(g, X(i * ex), Y(ey), 0.1 * H * s, 0.12 * H * s, '#2b211c');
        flat(g, X(i * ex) - 0.03 * H, Y(ey) - 0.04 * H, 0.035 * H, 0.04 * H, '#ffffff');
      }
    }
    var i;
    if (kind === 'dog') {
      for (i = -1; i <= 1; i += 2) ball(g, X(i * 0.85), Y(-0.05), 0.3 * H, 0.55 * H, '#8a5a35', -i * 0.25 + i * 0.35 * cs);
      ball(g, 0, hy, H, H * 0.96, body);
      flat(g, X(0.4), Y(-0.2), 0.3 * H, 0.3 * H, '#9a6a3e');
      ball(g, 0, Y(0.34), 0.5 * H, 0.36 * H, '#f6e6c8');
      flat(g, 0, Y(0.62), 0.12 * H, 0.14 * H, '#e8708a');
      ball(g, 0, Y(0.2), 0.17 * H, 0.12 * H, '#3b2a22');
      eyes(0.36, -0.12, 1);
    } else if (kind === 'cat') {
      for (i = -1; i <= 1; i += 2) {
        poly(g, [X(i * 0.97), Y(-0.2), X(i * 0.72) + i * 0.08 * H * cs, Y(-1.15), X(i * 0.22), Y(-0.82)], body);
        poly(g, [X(i * 0.82), Y(-0.38), X(i * 0.7) + i * 0.06 * H * cs, Y(-0.94), X(i * 0.42), Y(-0.78)], '#f3b3b3');
      }
      ball(g, 0, hy, H, H * 0.92, body);
      g.strokeStyle = '#b86d2a'; g.lineWidth = 0.06 * H; g.lineCap = 'round';
      for (i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(X(i * 0.22), Y(-0.9)); g.lineTo(X(i * 0.22), Y(-0.58)); g.stroke(); }
      ball(g, 0, Y(0.32), 0.34 * H, 0.25 * H, '#fbe6cc');
      poly(g, [X(-0.1), Y(0.18), X(0.1), Y(0.18), 0, Y(0.3)], '#e57f93');
      g.strokeStyle = 'rgba(60,40,30,0.55)'; g.lineWidth = 0.025 * H;
      for (i = -1; i <= 1; i += 2) {
        g.beginPath(); g.moveTo(X(i * 0.3), Y(0.34)); g.lineTo(X(i * 1.0), Y(0.2));
        g.moveTo(X(i * 0.3), Y(0.4)); g.lineTo(X(i * 1.0), Y(0.46)); g.stroke();
      }
      eyes(0.4, -0.12, 1);
    } else if (kind === 'cow') {
      for (i = -1; i <= 1; i += 2) {
        ball(g, X(i * 0.55), Y(-0.98), 0.14 * H, 0.2 * H, '#efe0b8', i * 0.4);
        ball(g, X(i * 1.0), Y(-0.45), 0.34 * H, 0.18 * H, '#fbf7ee', i * (0.3 + 0.4 * cs));
        flat(g, X(i * 1.03), Y(-0.45), 0.2 * H, 0.09 * H, '#f3b3b3', i * (0.3 + 0.4 * cs));
      }
      flat(g, -0.22 * r, 0.45 * r, 0.2 * r, 0.14 * r, '#3a3532', 0.4);
      ball(g, 0, hy, H, H * 0.98, '#fbf7ee');
      flat(g, X(-0.52), Y(-0.38), 0.36 * H, 0.32 * H, '#3a3532', 0.4);
      ball(g, 0, Y(0.42), 0.62 * H, 0.4 * H, '#f3b3b3');
      for (i = -1; i <= 1; i += 2) flat(g, X(i * 0.22), Y(0.44), 0.06 * H, 0.09 * H, '#b5686c');
      eyes(0.42, -0.14, 1);
    } else if (kind === 'horse') {
      ball(g, 0, Y(-0.7), 0.36 * H, 0.5 * H, '#4b2f20');
      for (i = -1; i <= 1; i += 2) {
        poly(g, [X(i * 0.82), Y(-0.45), X(i * 0.62) + i * 0.1 * H * cs, Y(-1.28), X(i * 0.28), Y(-0.75)], '#a8683c');
        poly(g, [X(i * 0.66), Y(-0.6), X(i * 0.6) + i * 0.08 * H * cs, Y(-1.0), X(i * 0.4), Y(-0.75)], '#d9a07a');
      }
      ball(g, 0, hy + 0.02 * r, 0.86 * H, 1.04 * H, '#a8683c');
      flat(g, 0, Y(0.0), 0.13 * H, 0.58 * H, '#f7ead6');
      ball(g, 0, Y(0.64), 0.5 * H, 0.34 * H, '#c99468');
      for (i = -1; i <= 1; i += 2) flat(g, X(i * 0.2), Y(0.68), 0.06 * H, 0.09 * H, '#5a3a28');
      ball(g, 0, Y(-0.66), 0.3 * H, 0.2 * H, '#4b2f20');
      eyes(0.42, -0.12, 0.95);
    } else if (kind === 'pig') {
      for (i = -1; i <= 1; i += 2) poly(g, [X(i * 0.95), Y(-0.1), X(i * 0.4), Y(-0.9), X(i * 1.12), Y(-0.78) + 0.14 * H * cs * i], '#ee93a6');
      ball(g, 0, hy, H, H * 0.94, body);
      for (i = -1; i <= 1; i += 2) flat(g, X(i * 0.66), Y(0.22), 0.17 * H, 0.1 * H, 'rgba(240,120,140,0.5)');
      ball(g, 0, Y(0.32), 0.48 * H, 0.34 * H, '#f08ea5');
      for (i = -1; i <= 1; i += 2) flat(g, X(i * 0.17), Y(0.33), 0.07 * H, 0.1 * H, '#a8465f');
      eyes(0.45, -0.12, 0.9);
    } else { // chicken
      for (i = -1; i <= 1; i++) ball(g, X(i * 0.3), Y(-1.0 - (i === 0 ? 0.12 : 0) - 0.07 * Math.abs(cs)),0.22 * H, 0.24 * H, '#e2453c');
      ball(g, 0, hy, H, H * 0.96, body);
      for (i = -1; i <= 1; i += 2) ball(g, i * 0.45 * r, 0.5 * r, 0.18 * r, 0.3 * r, '#efe7d6', -i * (0.3 + 0.55 * amt * (0.5 + 0.5 * sq)));
      ball(g, 0, Y(0.58), 0.12 * H, 0.17 * H, '#e2453c');
      poly(g, [X(-0.22), Y(0.1), X(0.22), Y(0.1), 0, Y(0.5)], '#f0a030');
      eyes(0.44, -0.18, 1);
    }
    g.restore();
    g.restore();
  }

  function drawFlag(g, cx, cy, t, time) {
    g.save(); g.translate(cx, cy);
    flat(g, 0, 0.36 * t, 0.2 * t, 0.07 * t, 'rgba(40,25,10,0.25)');
    g.strokeStyle = '#7b5b45'; g.lineWidth = 0.06 * t; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-0.12 * t, 0.36 * t); g.lineTo(-0.12 * t, -0.42 * t); g.stroke();
    var w = Math.sin(time * 5) * 0.05 * t;
    g.fillStyle = '#e8735a'; g.beginPath();
    g.moveTo(-0.1 * t, -0.42 * t); g.quadraticCurveTo(0.15 * t, -0.42 * t + w, 0.4 * t, -0.3 * t + w * 1.4);
    g.quadraticCurveTo(0.15 * t, -0.2 * t + w, -0.1 * t, -0.14 * t); g.closePath(); g.fill();
    g.restore();
  }

  /* ---- backgrounds ---- */
  function drawBackdrop(g, W, H, pal, time) {
    var bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, pal.sky[0]); bg.addColorStop(1, pal.sky[1]);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    for (var k = 0; k < 2; k++) {
      g.fillStyle = pal.hill[k]; g.beginPath(); g.moveTo(0, H);
      for (var x = 0; x <= W; x += 20) g.lineTo(x, H * (0.82 + k * 0.08) - Math.sin(x / (110 + k * 60) + k * 2) * H * 0.04);
      g.lineTo(W, H); g.closePath(); g.fill();
    }
  }

  /* ---------------------------------------------------------------
   * Controller
   * --------------------------------------------------------------- */
  var KEY = 'cornfield-carver:v1', BEST_KEY = 'cornfield-carver:best:v1', BACKUP_KEY = 'cornfield-carver:backup';
  var PREV_KEY = 'cornfield-carver:previous', PREFS_KEY = 'cornfield-carver:prefs:v1';
  var MOTION_MODES = ['device', 'full', 'reduced'];
  function $(id) { return document.getElementById(id); }

  function boot() {
    var canvas = $('field'), ctx = canvas.getContext('2d');
    var S = null;
    var ui = {
      mode: 'carve', view: 'fit', place: null, dpr: 0, cw: 0, ch: 0, t: 24, close: false, layer: null, layerDirty: true,
      ox: 0, oy: 0, vt: { x: 0, y: 0 }, vr: { x: 0, y: 0 }, particles: [], hint: null,
      reduce: false, motionMode: 'device', deviceReduce: false, cornT: 0, sprites: null, cornDrawn: 0, cornStats: { drawn: 0, activeCells: 0, activePlants: 0, visiblePlants: 0 },
      pendingTrack: null, trackAt: 0,
      ownsSave: false, resumeRaw: null, saveBlocked: false,
      startedAt: null, elapsed: 0, running: false, held: null, nextStep: 0, pointer: null, strokeTimer: 0,
      lastHud: '', saveTimer: 0, phase: 0, modal: null, lastFocus: null, confirmResolve: null, winShown: false,
      gait: { phase: 0, amount: 0, moving: false, px: null, py: null },
      mm: { w: 0, h: 0, cell: 1, pad: 4, base: null, dirty: true, rect: null, vis: null, actor: null }
    };
    var mmCanvas = $('minimap'), mmCtx = mmCanvas.getContext('2d');

    /* ---- storage ---- */
    function store(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function bests() {
      try { var b = JSON.parse(load(BEST_KEY) || '{}'); return b && typeof b === 'object' ? b : {}; } catch (e) { return {}; }
    }
    function loadPrefs() {
      var p = null;
      try { p = JSON.parse(load(PREFS_KEY) || 'null'); } catch (e) { p = null; }
      p = p && typeof p === 'object' ? p : {};
      return {
        size: typeof p.size === 'string' && hasOwn(core.SIZES, p.size) ? p.size : 'medium', season: core.SEASONS.indexOf(p.season) >= 0 ? p.season : 'summer',
        animal: core.ANIMALS.indexOf(p.animal) >= 0 ? p.animal : 'dog', motion: MOTION_MODES.indexOf(p.motion) >= 0 ? p.motion : 'device'
      };
    }
    // Last-used size, season, animal and motion live apart from the field save, so choosing them never touches KEY.
    function savePrefs() {
      store(PREFS_KEY, JSON.stringify({ size: S.size, season: S.season, animal: S.animal, motion: ui.motionMode }));
    }
    /* The saved field in KEY is only replaced by this session's own work. The first real write keeps the earlier
       save as a one-deep checkpoint (PREV_KEY); if that cannot be kept, autosave pauses and the old save stays. */
    function claimSave() {
      var prev = load(KEY);
      if (prev) {
        var dest = core.parse(prev).ok ? PREV_KEY : BACKUP_KEY;
        if (load(dest) !== prev && !store(dest, prev)) {
          ui.saveBlocked = true;
          $('save-status').textContent = 'Autosave paused for this session to preserve your earlier save. Export this field to keep it.';
          return false;
        }
      }
      ui.ownsSave = true;
      return true;
    }
    /** edit = a real change to the field. Anything else (name, season, animal, maze toggle) only rides along once saving has started. */
    function scheduleSave(edit) {
      if (!edit && !ui.ownsSave) return;
      if (ui.saveBlocked) { $('save-status').textContent = 'Autosave paused for this session to preserve your earlier save. Export this field to keep it.'; return; }
      if (!ui.ownsSave && !claimSave()) return;
      $('save-status').textContent = 'Saving...';
      clearTimeout(ui.saveTimer);
      ui.saveTimer = setTimeout(function () {
        ui.saveTimer = 0;
        var ok = store(KEY, core.stringify(S, { tractor: true }));
        $('save-status').textContent = ok ? 'Autosaved on this device' : 'Autosave unavailable in this browser';
        updateResume();
      }, 350);
      updateResume();
    }
    function cancelSave() { clearTimeout(ui.saveTimer); ui.saveTimer = 0; }
    function resumeSource() { return ui.ownsSave ? load(PREV_KEY) : ui.resumeRaw; }
    function updateResume() {
      var raw = resumeSource(), ok = !!raw && core.parse(raw).ok;
      $('resume-card').hidden = !ok;
    }

    /* ---- helpers ---- */
    function say(msg) {
      var el = $('toast'); el.textContent = msg; el.classList.add('show');
      clearTimeout(say.t); say.t = setTimeout(function () { el.classList.remove('show'); }, 2600);
    }
    function fmt(ms) {
      var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
      return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    }
    function randSeed() { return Math.floor(Math.random() * 4294967296) >>> 0; }
    function randomAnimal() { return core.ANIMALS[Math.floor(Math.random() * 6)]; }

    function syncActors() {
      ui.vt.x = S.tractor.x; ui.vt.y = S.tractor.y; ui.vr.x = S.run.x; ui.vr.y = S.run.y;
      ui.gait.px = ui.vr.x; ui.gait.py = ui.vr.y; ui.gait.phase = 0; ui.gait.amount = 0; ui.gait.moving = false;
    }

    /* ---- running gait: driven by the distance the runner really travels, never by the clock ---- */
    function stepGait(dt) {
      var G = ui.gait, dx = ui.vr.x - G.px, dy = ui.vr.y - G.py, d = Math.sqrt(dx * dx + dy * dy);
      G.px = ui.vr.x; G.py = ui.vr.y;
      if (ui.reduce || d > 1.01) { G.phase = 0; G.amount = 0; G.moving = false; return; } // reduced motion, or a teleport (reset/load)
      G.moving = d > 0.002;
      if (G.moving) {
        G.phase = (G.phase + d * TAU * 0.4) % TAU;   // one full stride (both leg pairs) every 2.5 cells
        G.amount += (1 - G.amount) * Math.min(1, dt * 18);
      } else {
        // settle on the nearest neutral half-cycle (a multiple of PI), so the next tap starts with the other leg pair
        var rest = Math.round(G.phase / Math.PI) * Math.PI;
        G.amount -= G.amount * Math.min(1, dt * 12);
        G.phase += (rest - G.phase) * Math.min(1, dt * 12);
        if (G.amount < 0.02) { G.amount = 0; G.phase = rest % TAU; }
      }
    }

    /* ---- minimap: cached whole-field base (1 px per cell) plus a live viewport box and actor dot ---- */
    function drawMinimap() {
      var m = ui.mm, pal = PAL[S.season], c = m.cell, pd = m.pad, g = mmCtx, i;
      if (m.w !== S.w || m.h !== S.h) { // backing store only changes with the field size
        m.w = S.w; m.h = S.h; m.cell = c = Math.max(5, Math.floor(280 / S.w));
        mmCanvas.width = S.w * c + 2 * pd; mmCanvas.height = S.h * c + 2 * pd;
        m.base = document.createElement('canvas'); m.base.width = S.w; m.base.height = S.h; m.dirty = true;
      }
      if (m.dirty) {
        var bg = m.base.getContext('2d');
        for (var y = 0; y < S.h; y++) for (var x = 0; x < S.w; x++) {
          bg.fillStyle = S.grid[y * S.w + x] ? pal.leaf : pal.path; bg.fillRect(x, y, 1, 1);
        }
        m.dirty = false;
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = mix(pal.soil, -0.1); g.fillRect(0, 0, mmCanvas.width, mmCanvas.height);
      g.imageSmoothingEnabled = false;
      g.drawImage(m.base, pd, pd, S.w * c, S.h * c);
      function mx(v) { return pd + v * c; }
      if (S.purpose === 'maze') {
        if (S.start) { g.strokeStyle = '#e8735a'; g.lineWidth = 2; g.beginPath(); g.arc(mx(S.start.x + 0.5), mx(S.start.y + 0.5), c * 0.55, 0, TAU); g.stroke(); }
        if (S.exit) { g.fillStyle = '#e8735a'; g.fillRect(mx(S.exit.x) + c * 0.1, mx(S.exit.y) + c * 0.1, c * 0.8, c * 0.8); g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(mx(S.exit.x) + c * 0.1, mx(S.exit.y) + c * 0.1, c * 0.8, c * 0.8); }
      }
      // viewport in cell units (may extend past the field when the whole field is shown)
      var t = ui.t, r = { x: -ui.ox / t - ORG, y: -ui.oy / t - ORGY, w: ui.cw / t, h: ui.ch / t };
      var x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(S.w, r.x + r.w), y1 = Math.min(S.h, r.y + r.h);
      var vis = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
      g.lineWidth = 3; g.strokeStyle = 'rgba(40,30,20,0.55)'; g.strokeRect(mx(vis.x), mx(vis.y), vis.w * c, vis.h * c);
      g.lineWidth = 1.5; g.strokeStyle = '#ffffff'; g.strokeRect(mx(vis.x), mx(vis.y), vis.w * c, vis.h * c);
      var runActive = ui.mode === 'run' && core.isConfigured(S), a = runActive ? ui.vr : ui.vt;
      var ax = mx(a.x + 0.5), ay = mx(a.y + 0.5);
      g.beginPath(); g.arc(ax, ay, Math.max(3, c * 0.5), 0, TAU);
      g.fillStyle = runActive ? '#e8735a' : '#d94a3a'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
      m.rect = r; m.vis = vis; m.actor = { kind: runActive ? 'runner' : 'tractor', x: a.x, y: a.y };
    }

    /* ---- sidebar tabs ---- */
    var TABS = ['play', 'settings'];
    function selectTab(name, focus) {
      TABS.forEach(function (n) {
        var on = n === name, tab = $('tab-' + n);
        tab.setAttribute('aria-selected', on ? 'true' : 'false'); tab.tabIndex = on ? 0 : -1;
        $('panel-' + n).hidden = !on;
      });
      ui.tab = name;
      if (focus) $('tab-' + name).focus();
    }
    ui.tab = 'play';
    $('sidebar-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[role="tab"]'); if (b) selectTab(b.id.slice(4), false);
    });
    $('sidebar-tabs').addEventListener('keydown', function (e) {
      var i = TABS.indexOf(ui.tab), n = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % TABS.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i + TABS.length - 1) % TABS.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = TABS.length - 1;
      if (n < 0) return;
      e.preventDefault(); e.stopPropagation(); selectTab(TABS[n], true);
    });
    function resetTimer() { ui.startedAt = null; ui.elapsed = 0; ui.running = false; ui.winShown = false; $('win').hidden = true; }
    function changed() { ui.layerDirty = true; ui.hint = null; scheduleSave(true); updatePanel(); }
    function useState(ns) {
      showLoadedSupport(false);
      S = ns; resetTimer(); syncActors(); ui.layerDirty = true; ui.hint = null; ui.place = null;
      if (S.purpose === 'art' || !core.isConfigured(S)) ui.mode = 'carve';
      computeLayout(true); updatePanel();
    }

    /* ---- layout ---- */
    // The backing store is only touched when the measured size or DPR really changes (assigning
    // canvas.width clears it); a real change is redrawn at once, before the browser can paint a blank frame.
    function computeLayout(force) {
      var r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      var cw = Math.max(100, Math.round(r.width)), ch = Math.max(100, Math.round(r.height));
      var sized = cw !== ui.cw || ch !== ui.ch || dpr !== ui.dpr;
      if (!sized && !force) return;
      ui.cw = cw; ui.ch = ch; ui.dpr = dpr;
      if (sized) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
      // Whole-field tile: whole pixels while they are 4+, otherwise eighths of a pixel so the field always fits.
      var fitF = Math.min(cw / (S.w + 2 * ORG), ch / (S.h + ORGY + ORG + 0.4));
      var fit = fitF >= 4 ? Math.floor(fitF) : Math.max(0.5, Math.floor(fitF * 8) / 8);
      var t = fit;
      if (ui.view === 'close') {
        // Close-up tile, kept small enough that the full-field layer stays within LAYER_MAX_PIXELS at 1x.
        var maxT = Math.floor(Math.sqrt(LAYER_MAX_PIXELS / ((S.w + 2 * ORG) * (S.h + ORGY + ORG + 0.4))));
        t = Math.max(fit, Math.min(maxT, Math.max(38, Math.round(fit * 1.7))));
      }
      ui.close = ui.view === 'close';
      if (t !== ui.t || sized || !ui.layer) ui.layerDirty = true;
      ui.t = t;
      if (sized) draw(performance.now(), 0);
    }
    function updateViewButton() {
      $('btn-view').textContent = ui.close ? 'View: Close-up' : 'View: Whole field';
      $('btn-view').setAttribute('aria-pressed', ui.close ? 'true' : 'false');
      $('minimap-note').textContent = ui.close ? 'Close-up: the white box is what you see' : 'Showing the whole field';
    }

    /* ---- panel ---- */
    function mark(group, attr, val) {
      var bs = $(group).querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', bs[i].getAttribute(attr) === val ? 'true' : 'false');
    }
    function updatePanel() {
      document.body.setAttribute('data-season', S.season);
      mark('size-group', 'data-size', S.size); mark('season-group', 'data-season', S.season);
      mark('animal-group', 'data-animal', S.animal);
      if ($('creation-name') !== document.activeElement) $('creation-name').value = S.name;
      $('btn-undo').disabled = S.history.length === 0;
      $('btn-undo2').disabled = S.history.length === 0;
      mark('mode-group', 'data-mode', ui.mode);
      document.body.setAttribute('data-mode', ui.mode);
      var maze = S.purpose === 'maze', ready = core.isConfigured(S);
      document.body.setAttribute('data-purpose', S.purpose);
      var mazeBtn = $('btn-maze'), mazePanel = $('maze-panel');
      if (maze && mazeBtn.parentNode !== mazePanel) mazePanel.insertBefore(mazeBtn, mazePanel.firstChild);
      else if (!maze && mazeBtn.parentNode === mazePanel) $('field-toolbar').insertBefore(mazeBtn, $('maze-menu'));
      mazeBtn.setAttribute('aria-pressed', maze ? 'true' : 'false');
      $('btn-maze').textContent = maze ? 'Back to art' : 'Make it a maze';
      $('mode-run').disabled = !ready;
      $('btn-place-start').setAttribute('aria-pressed', ui.place === 'start' ? 'true' : 'false');
      $('btn-place-exit').setAttribute('aria-pressed', ui.place === 'exit' ? 'true' : 'false');
      $('btn-place-start').textContent = S.start ? 'Move start' : 'Place start';
      $('btn-place-exit').textContent = S.exit ? 'Move exit' : 'Place exit';
      $('gate-status').textContent = ui.place ? 'Tap or click a spot in the field for the ' + ui.place + '.'
        : (S.start ? 'Start placed. ' : 'Start not placed. ') + (S.exit ? 'Exit placed.' : 'Exit not placed.') +
          (ready ? '' : ' Place both to run.');
      canvas.setAttribute('aria-label', !maze
        ? 'Cornfield art field. Arrow keys or WASD drive the tractor and carve corn. U undoes.'
        : ui.place ? 'Cornfield maze. Tap or click a spot to place the ' + ui.place + ', or press Enter to place it under the tractor. Escape cancels.'
        : 'Cornfield maze. Arrow keys or WASD move the ' + (ui.mode === 'run' ? 'runner' : 'tractor') + '. M switches between Carve and Run, U undoes, H shows a hint.');
      canvas.style.cursor = ui.place ? 'crosshair' : '';
      updateViewButton();
    }
    function updateHud(now) {
      var el = ui.running ? now - ui.startedAt : ui.elapsed, c = core.counts(S);
      var route = !core.isConfigured(S) ? 'Place gates' : core.isSolvable(S) ? 'Open' : 'Not yet';
      var sig = Math.floor(el / 1000) + '|' + S.run.moves + '|' + c.corn + '|' + route;
      if (sig === ui.lastHud) return;
      ui.lastHud = sig;
      $('hud-time').textContent = fmt(el);
      $('hud-moves').textContent = S.run.moves;
      $('hud-corn').textContent = c.corn;
      $('hud-route').textContent = route;
      $('hud-route').parentNode.setAttribute('data-ok', route === 'Open' ? '1' : '0');
    }

    /* ---- particles ---- */
    function burst(x, y, kind, n) {
      if (ui.reduce) return;
      var pal = PAL[S.season];
      for (var i = 0; i < n; i++) {
        var a = Math.random() * TAU, sp = 0.8 + Math.random() * 2;
        ui.particles.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (kind === 'confetti' ? 2.5 : 0.6),
          life: 0.6 + Math.random() * 0.6, max: 1.2, kind: kind, rot: Math.random() * TAU,
          c: kind === 'confetti' ? ['#e8735a', '#f6c453', '#8fb28a', '#6aa6c7', '#f4a8bd'][i % 5] : (i % 2 ? pal.corn[1] : pal.leaf) });
      }
    }

    /* ---- audio (optional; see audio.js) ---- */
    var audio = window.CornfieldAudio;
    function sound(name) { if (audio && audio[name]) audio[name](); }
    function syncAudioButtons() {
      if (!audio) return;
      [['btn-music', 'Music', audio.music()], ['btn-sfx', 'Sounds', audio.sfx()]].forEach(function (b) {
        var el = $(b[0]);
        el.setAttribute('aria-pressed', b[2] ? 'true' : 'false');
        el.textContent = b[1] + ': ' + (b[2] ? 'On' : 'Off');
      });
    }
    function wireAudio() {
      if (!audio || !audio.supported) {
        $('btn-music').disabled = true; $('btn-sfx').disabled = true;
        $('audio-note').hidden = false;
        return;
      }
      $('btn-music').addEventListener('click', function () { audio.setMusic(!audio.music()); });
      $('btn-sfx').addEventListener('click', function () { audio.setSfx(!audio.sfx()); });
      audio.onChange(syncAudioButtons);
      syncAudioButtons();
    }
    wireAudio();

    /* ---- actions ---- */
    function startTimer() {
      // Called after a move, including a first-step win, which should record about 0:00.
      if (ui.running) return;
      ui.startedAt = performance.now() - ui.elapsed; ui.running = true;
    }
    function victory() {
      ui.elapsed = performance.now() - ui.startedAt; ui.running = false;
      var b = bests(), key = S.size, prev = b[key], newBest = !prev || ui.elapsed < prev;
      if (newBest) { b[key] = Math.round(ui.elapsed); store(BEST_KEY, JSON.stringify(b)); }
      $('win-title').textContent = 'Harvest home!';
      $('win-time').textContent = fmt(ui.elapsed);
      $('win-moves').textContent = S.run.moves;
      $('win-best').textContent = fmt(b[key]) + (newBest ? ' (new!)' : '');
      $('win-text').textContent = 'Your ' + S.animal + ' made it through "' + S.name + '".';
      $('win').hidden = false; ui.winShown = true;
      burst(S.exit.x, S.exit.y, 'confetti', 60);
      sound('victory');
      say('Your ' + S.animal + ' reached the flag in ' + fmt(ui.elapsed) + '!');
      setTimeout(function () { var b2 = $('win-again'); if (b2 && !$('win').hidden) b2.focus(); }, 50);
    }
    function act(dx, dy) {
      if (ui.modal || ui.winShown) return;
      if (ui.mode === 'run' && !core.isConfigured(S)) ui.mode = 'carve';
      if (ui.mode === 'carve') {
        if (!S.strokeOpen) core.beginStroke(S);
        clearTimeout(ui.strokeTimer);
        ui.strokeTimer = setTimeout(function () { core.endStroke(S); }, 450);
        var r = core.moveTractor(S, dx, dy);
        if (r.carved) { burst(r.x, r.y, 'chaff', 5); changed(); sound('carve'); }
        else if (!r.moved) say('That is the edge of the field.');
      } else {
        var m = core.moveRunner(S, dx, dy);
        if (m.moved) {
          startTimer(); ui.hint = null;
          if (m.won) victory(); else sound('step');
        } else if (m.blocked) { ui.bump = 0.25; sound('bump'); }
      }
    }
    function setMode(m) {
      if (m === ui.mode) return;
      if (m === 'run' && !core.isConfigured(S)) { say('Place a start and an exit first, in Maze mode.'); return; }
      ui.mode = m; ui.place = null;
      if (m === 'run' && S.run.won) { core.resetRun(S); resetTimer(); syncActors(); }
      updatePanel();
      say(m === 'run' ? 'Run mode: guide your ' + S.animal + ' to the flag.' : 'Carve mode: drive the tractor through the corn.');
    }
    function doUndo() {
      if (ui.winShown) { $('win').hidden = true; ui.winShown = false; }
      if (core.undo(S)) {
        if (ui.mode === 'run' && !core.isConfigured(S)) ui.mode = 'carve';
        syncActors(); resetTimer(); changed(); say('Undone.');
      } else say('Nothing to undo.');
    }
    function doReset() {
      if (!core.isConfigured(S)) { say('Place a start and an exit first.'); return; }
      core.resetRun(S); resetTimer(); syncActors(); ui.hint = null; updatePanel(); say('Runner back at the start.');
    }
    /* Art <-> Maze is a view preference: the planted field, tractor and undo history are untouched. */
    function toggleMaze() {
      var maze = S.purpose !== 'maze';
      core.setPurpose(S, maze ? 'maze' : 'art');
      resetTimer(); syncActors(); ui.hint = null; ui.place = null;
      if (!maze || !core.isConfigured(S)) ui.mode = 'carve';
      scheduleSave(false); updatePanel();
      var focusEl = $(maze ? 'maze-summary' : 'btn-maze');
      if (!document.activeElement || document.activeElement === document.body || document.activeElement.id === 'btn-maze' ||
          document.activeElement.id === 'maze-summary') focusEl.focus();
      say(maze ? 'Maze on. Place a start and an exit anywhere in the field.' : 'Back to art. Your field is untouched.');
    }
    function startPlace(which) {
      if (S.purpose !== 'maze') return;
      ui.place = ui.place === which ? null : which; updatePanel();
      if (ui.place) say('Tap or click a spot for the ' + which + '.');
    }
    function placeAt(which, x, y) {
      var r = core.placeGate(S, which, x, y);
      if (!r.ok) { say(r.error); return false; }
      ui.place = null; resetTimer(); syncActors(); changed();
      say((which === 'start' ? 'Start' : 'Exit') + ' placed.' + (core.isConfigured(S) ? ' Switch to Run to try it.' : ''));
      return true;
    }
    function doHint() {
      if (!core.isConfigured(S)) { say('Place a start and an exit first.'); return; }
      var p = core.findPath(S, S.run.x, S.run.y);
      if (S.run.won) { say('You already reached the flag!'); return; }
      if (!p) { say('No route yet. Carve a path from the start to the flag.'); return; }
      ui.hint = { path: p, until: performance.now() + 5000 };
      say(p.length + ' steps to the flag.');
    }
    function doGenerate() {
      if (S.purpose !== 'maze') return;
      confirmIf(S.dirty, 'Grow a new maze?', 'Your carved changes will be replaced by a freshly generated maze. You can still use Undo to bring them back.', 'Grow new maze', function () {
        core.regenerate(S, randSeed()); resetTimer(); syncActors(); ui.place = null; changed(); say('A new maze has sprouted.');
      });
    }
    function doReplant() {
      confirmIf(core.counts(S).cleared > 3, 'Replant the whole field?', 'Every carved path will be filled with corn so you can start again. You can still use Undo to bring it back.', 'Replant field', function () {
        core.replant(S); resetTimer(); syncActors(); changed(); say('Fresh corn everywhere. Drive the tractor to carve!');
        if (ui.mode !== 'carve') setMode('carve');
      });
    }
    function newField(size) {
      var maze = S.purpose === 'maze';
      var o = { size: size, season: S.season, animal: S.animal, seed: randSeed(), name: S.name };
      /* Settle any pending carving first so Continue reopens it, then release ownership: the fresh field
         is not written until it is carved, and its name/season/animal edits must not overwrite KEY. */
      if (ui.ownsSave) {
        if (ui.saveTimer) {
          cancelSave();
          if (!store(KEY, core.stringify(S, { tractor: true }))) { ui.saveBlocked = true; $('save-status').textContent = 'Autosave paused for this session to preserve your earlier save. Export this field to keep it.'; }
        }
        var latest = load(KEY);
        if (latest && core.parse(latest).ok) ui.resumeRaw = latest;
        ui.ownsSave = false;
      } else cancelSave();
      useState(maze ? core.newMaze(o) : core.newBlank(o)); savePrefs();
      updateResume();
      say(core.SIZES[size].label + (maze ? ': a new maze is ready.' : ': a fresh planted field.'));
    }
    function confirmIf(cond, title, body, okLabel, fn) {
      if (!cond) { fn(); return; }
      ask(title, body, okLabel).then(function (yes) { if (yes) fn(); });
    }

    /* ---- modals ---- */
    function showModal(id) {
      hideModal(true);
      var m = $(id); m.hidden = false; ui.modal = m; ui.lastFocus = document.activeElement;
      var f = m.querySelector('[data-autofocus]') || m.querySelector('button, textarea, input');
      if (f) f.focus();
    }
    function hideModal(keepFocus) {
      if (!ui.modal) return;
      ui.modal.hidden = true; ui.modal = null;
      if (ui.confirmResolve) { var r = ui.confirmResolve; ui.confirmResolve = null; r(false); }
      if (!keepFocus && ui.lastFocus && ui.lastFocus.focus) ui.lastFocus.focus();
    }
    function ask(title, body, okLabel) {
      $('confirm-title').textContent = title; $('confirm-body').textContent = body; $('confirm-ok').textContent = okLabel;
      return new Promise(function (resolve) { showModal('modal-confirm'); ui.confirmResolve = resolve; });
    }
    $('confirm-ok').addEventListener('click', function () {
      var r = ui.confirmResolve; ui.confirmResolve = null; hideModal(); if (r) r(true);
    });
    var closers = document.querySelectorAll('[data-close]');
    for (var ci = 0; ci < closers.length; ci++) closers[ci].addEventListener('click', function () { hideModal(); });

    /* ---- share / import ---- */
    function slug() { return (S.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cornfield'); }
    function download(blob, name) {
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }
    /* ---- toolbar menus (native details) ---- */
    var menus = document.querySelectorAll('#field-toolbar .menu');
    function openMenu() {
      for (var i = 0; i < menus.length; i++) if (menus[i].open) return menus[i];
      return null;
    }
    function closeMenus(focusSummary) {
      for (var i = 0; i < menus.length; i++) {
        if (!menus[i].open) continue;
        menus[i].open = false;
        if (focusSummary) menus[i].querySelector('summary').focus();
      }
    }
    Array.prototype.forEach.call(menus, function (m) {
      m.addEventListener('toggle', function () {
        if (!m.open) return;
        ui.held = null;
        Array.prototype.forEach.call(menus, function (o) { if (o !== m) o.open = false; });
      });
      m.addEventListener('focusout', function (e) {
        if (m.open && e.relatedTarget && !m.contains(e.relatedTarget)) m.open = false;
      });
      // capture phase: close and refocus the visible summary before the button's own handler opens a modal
      m.querySelector('.menu-panel').addEventListener('click', function (e) {
        if (e.target.closest('button')) { m.open = false; m.querySelector('summary').focus(); }
      }, true);
      m.querySelector('summary').addEventListener('pointerdown', function () { ui.held = null; });
    });
    document.addEventListener('click', function (e) {
      var m = openMenu();
      if (m && !m.contains(e.target)) m.open = false;
    });
    function openShare() {
      var txt = JSON.stringify(core.serialize(S), null, 1);
      $('share-text').value = txt;
      $('share-note').textContent = S.purpose === 'art' ? 'Your planted-field art. Send the file or paste the text to a friend.'
        : !core.isConfigured(S) ? 'Heads up: this maze does not have both a start and an exit yet.'
        : core.isSolvable(S) ? 'This field is solvable. Send the file or paste the text to a friend.'
        : 'Heads up: this field has no route from start to flag yet.';
      showModal('modal-share');
    }
    $('share-download').addEventListener('click', function () {
      download(new Blob([$('share-text').value], { type: 'application/json' }), slug() + '.cornfield.json');
    });
    $('share-copy').addEventListener('click', function () {
      var ta = $('share-text');
      function fallback() { ta.focus(); ta.select(); try { document.execCommand('copy'); say('Copied.'); } catch (e) { say('Press Ctrl+C to copy.'); } }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(function () { say('Copied to clipboard.'); }, fallback);
      else fallback();
    });
    function showLoadedSupport(shown) {
      $('loaded-support').hidden = !shown;
      var mainSupport = document.querySelector('.support-main');
      if (mainSupport) mainSupport.hidden = shown;
    }
    function openImport() {
      $('import-text').value = ''; $('import-error').textContent = ''; $('import-file').value = '';
      showLoadedSupport(false);
      showModal('modal-import');
    }
    $('import-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      if (f.size > core.MAX_JSON) { $('import-error').textContent = 'That file is too large to be a cornfield.'; return; }
      var rd = new FileReader();
      rd.onload = function () { $('import-text').value = String(rd.result); $('import-error').textContent = ''; };
      rd.onerror = function () { $('import-error').textContent = 'Could not read that file.'; };
      rd.readAsText(f);
    });
    $('import-load').addEventListener('click', function () {
      var res = core.parse($('import-text').value);
      if (!res.ok) { $('import-error').textContent = res.error; return; }
      hideModal(true);
      var apply = function () { cancelSave(); useState(res.state); S.dirty = false; scheduleSave(true); showLoadedSupport(true); say('Loaded "' + S.name + '".'); };
      if (S.dirty) ask('Replace your current field?', 'Importing "' + res.state.name + '" replaces the field you are working on. Export it first if you want to keep it. This cannot be undone.', 'Replace field').then(function (y) { if (y) apply(); });
      else apply();
    });
    function exportPng() {
      var cv = document.createElement('canvas'), t = Math.max(14, Math.min(40, Math.floor(1040 / (S.w + 2 * ORG))));
      var layer = buildLayer(S, S.season, t, 1, true), pal = PAL[S.season];
      var W = Math.ceil(layer.w) + 120, hd = 100, H = Math.ceil(layer.h) + hd + 70;
      var maze = core.isConfigured(S);
      cv.width = W; cv.height = H;
      var g = cv.getContext('2d');
      drawBackdrop(g, W, H, pal, 0);
      g.fillStyle = '#3b3a33'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.font = 'bold 40px Georgia, "Times New Roman", serif'; g.fillText(S.name, W / 2, 60, W - 80);
      g.fillStyle = '#6d6b5f'; g.font = '20px system-ui, sans-serif';
      g.fillText(core.SIZES[S.size].label + ' · ' + S.season + (maze ? ' · runner: ' + S.animal : ''), W / 2, 94);
      var lx = 60, ly = hd;
      g.drawImage(layer.canvas, lx, ly, layer.w, layer.h);
      var ox = ORG * t, oy = ORGY * t;
      if (maze) {
        drawFlag(g, lx + ox + (S.exit.x + 0.5) * t, ly + oy + (S.exit.y + 0.5) * t, t, 0);
        drawAnimal(g, S.animal, lx + ox + (S.start.x + 0.5) * t, ly + oy + (S.start.y + 0.5) * t - 0.14 * t, t * 0.5);
      }
      drawTractor(g, lx + ox + (S.tractor.x + 0.5) * t, ly + oy + (S.tractor.y + 0.5) * t, t, S.tractor.dir, 0);
      g.fillStyle = '#6d6b5f'; g.font = '18px system-ui, sans-serif';
      g.fillText(maze ? 'Hedge and Harvest · find the way to the flag' : 'Hedge and Harvest · a field of corn art', W / 2, H - 26);
      cv.toBlob(function (b) {
        if (b) { download(b, slug() + '.png'); say('Picture saved.'); } else say('Could not create the picture.');
      }, 'image/png');
    }

    /* ---- input ---- */
    var KEYS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1],
      d: [1, 0], a: [-1, 0], s: [0, 1], w: [0, -1], D: [1, 0], A: [-1, 0], S: [0, 1], W: [0, -1] };
    function isTyping(e) {
      var n = e.target && e.target.tagName;
      return n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT';
    }
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!ui.modal && openMenu()) { closeMenus(true); e.preventDefault(); return; }
        if (ui.modal) { hideModal(); e.preventDefault(); }
        else if (ui.place) { ui.place = null; updatePanel(); e.preventDefault(); }
        return;
      }
      if (ui.modal && e.key === 'Tab') {
        var f = ui.modal.querySelectorAll('button:not([disabled]), textarea, input'), first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
        return;
      }
      if (ui.modal || isTyping(e) || e.altKey) return;
      if (e.target.closest && e.target.closest('.menu')) return; // menu keys never drive an actor
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { doUndo(); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) return;
      if (e.target.closest && e.target.closest('[role="tablist"]')) return; // tab keys never drive an actor
      var d = KEYS[e.key];
      if (d) {
        e.preventDefault();
        if (!e.repeat) { act(d[0], d[1]); ui.held = d; ui.nextStep = performance.now() + 190; }
        return;
      }
      var k = e.key.toLowerCase();
      if (e.repeat) return;
      if (e.key === 'Enter' && ui.place && document.activeElement === canvas) { placeAt(ui.place, S.tractor.x, S.tractor.y); e.preventDefault(); return; }
      if (k === 'u') doUndo();
      else if (S.purpose !== 'maze') return;
      else if (k === 'h') doHint();
      else if (k === 'm') setMode(ui.mode === 'carve' ? 'run' : 'carve');
      else if (k === 'r') doReset();
    });
    window.addEventListener('keyup', function (e) {
      var d = KEYS[e.key];
      if (d && ui.held === d) ui.held = null;
    });
    window.addEventListener('blur', function () { ui.held = null; });

    var dp = document.querySelectorAll('.dpad-btn');
    dp.forEach(function (b) {
      var d = [parseInt(b.getAttribute('data-dx'), 10), parseInt(b.getAttribute('data-dy'), 10)];
      b.addEventListener('pointerdown', function (e) {
        e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
        act(d[0], d[1]); ui.held = d; ui.nextStep = performance.now() + 220;
      });
      var up = function () { if (ui.held === d) ui.held = null; };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
      b.addEventListener('contextmenu', function (e) { e.preventDefault(); });   // a long press must not open a menu and cancel the hold
      b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(d[0], d[1]); } });
    });

    function tileAt(e) {
      var r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      return { x: Math.floor((px - ui.ox - ORG * ui.t) / ui.t), y: Math.floor((py - ui.oy - ORGY * ui.t) / ui.t) };
    }
    function pointerAct(e) {
      var p = tileAt(e);
      if (!core.inBounds(S, p.x, p.y)) return;
      if (ui.mode === 'run' && !core.isConfigured(S)) return;
      var a = ui.mode === 'carve' ? S.tractor : S.run, dist = Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
      if (!ui.pointer.engaged) { if (dist <= (ui.pointer.fresh ? 3 : 2)) ui.pointer.engaged = true; else return; }
      if (ui.mode === 'carve') {
        var r = core.carveTo(S, p.x, p.y, 12);
        if (r.carved) { burst(S.tractor.x, S.tractor.y, 'chaff', 4); changed(); sound('carve'); }
      } else {
        var before = S.run.moves, n = core.runTo(S, p.x, p.y, 6);
        if (n) {
          startTimer(); ui.hint = null;
          if (S.run.won && S.run.moves !== before) victory(); else sound('step');
        }
      }
    }
    canvas.addEventListener('pointerdown', function (e) {
      if (ui.modal || ui.winShown) return;
      e.preventDefault(); canvas.focus();
      if (ui.place) { // placement tool: one tap puts the gate down, then the tool is done
        var gp = tileAt(e);
        if (!core.inBounds(S, gp.x, gp.y)) say('Pick a spot inside the field.');
        else placeAt(ui.place, gp.x, gp.y);
        return;
      }
      try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      ui.pointer = { id: e.pointerId, engaged: false, fresh: true };
      if (ui.mode === 'carve') { clearTimeout(ui.strokeTimer); core.beginStroke(S); }
      pointerAct(e); ui.pointer.fresh = false;
    });
    canvas.addEventListener('pointermove', function (e) {
      if (ui.pointer && ui.pointer.id === e.pointerId) pointerAct(e);
    });
    function pointerEnd() {
      if (!ui.pointer) return;
      ui.pointer = null; core.endStroke(S); updatePanel();
    }
    canvas.addEventListener('pointerup', pointerEnd);
    canvas.addEventListener('pointercancel', pointerEnd);

    /* ---- panel wiring ---- */
    $('mode-carve').addEventListener('click', function () { setMode('carve'); canvas.focus(); });
    $('mode-run').addEventListener('click', function () { setMode('run'); canvas.focus(); });
    $('btn-undo').addEventListener('click', doUndo);
    $('btn-undo2').addEventListener('click', doUndo);
    $('btn-reset').addEventListener('click', doReset);
    $('btn-hint').addEventListener('click', doHint);
    $('btn-generate').addEventListener('click', doGenerate);
    $('btn-replant').addEventListener('click', doReplant);
    $('btn-maze').addEventListener('click', toggleMaze);
    $('btn-place-start').addEventListener('click', function () { startPlace('start'); });
    $('btn-place-exit').addEventListener('click', function () { startPlace('exit'); });
    $('btn-view').addEventListener('click', function () {
      ui.view = ui.close ? 'fit' : 'close'; computeLayout(true); updateViewButton();
    });
    $('btn-export-json').addEventListener('click', openShare);
    $('btn-import').addEventListener('click', openImport);
    $('btn-png').addEventListener('click', exportPng);
    $('btn-help').addEventListener('click', function () { showModal('modal-help'); });
    $('win-again').addEventListener('click', function () { $('win').hidden = true; doReset(); setMode('run'); });
    $('win-new').addEventListener('click', function () {
      $('win').hidden = true; ui.winShown = false;
      if (!core.regenerate(S, randSeed())) return;
      resetTimer(); syncActors(); changed(); setMode('run');
    });
    $('win-share').addEventListener('click', openShare);
    $('creation-name').addEventListener('input', function () { S.name = core.cleanName(this.value); scheduleSave(false); });
    $('creation-name').addEventListener('blur', function () { this.value = S.name; });
    $('size-group').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var size = b.getAttribute('data-size');
      if (size === S.size) return;
      confirmIf(S.dirty, 'Switch field size?', 'A different size starts a new field and replaces your carved design. Export it first if you want to keep it. This cannot be undone.', 'Switch size', function () { newField(size); });
    });
    $('season-group').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      S.season = b.getAttribute('data-season'); ui.layerDirty = true; savePrefs(); scheduleSave(false); updatePanel();
      say(S.season.charAt(0).toUpperCase() + S.season.slice(1) + ' has arrived.');
    });
    $('animal-group').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      S.animal = b.getAttribute('data-animal'); savePrefs(); scheduleSave(false); updatePanel(); say('Your runner is now a ' + S.animal + '.');
    });
    // animal icons
    core.ANIMALS.forEach(function (a) {
      var b = document.querySelector('#animal-group [data-animal="' + a + '"]'), cv = b && b.querySelector('canvas');
      if (!cv) return;
      var d = Math.min(2, window.devicePixelRatio || 1), sz = 44;
      cv.width = cv.height = sz * d; var g = cv.getContext('2d'); g.scale(d, d);
      drawAnimal(g, a, sz / 2, sz / 2 - 3, sz * 0.34);
    });

    /* ---- motion: Device / Full / Reduced ---- */
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    function applyMotion() {
      ui.deviceReduce = !!(mq && mq.matches);
      ui.reduce = ui.motionMode === 'reduced' || (ui.motionMode === 'device' && ui.deviceReduce);
      $('motion-mode').value = ui.motionMode;
      $('motion-note').textContent = ui.motionMode === 'device'
        ? (ui.deviceReduce ? 'Your device asks for reduced motion, so running strides and swaying corn are off. Choose Full motion to turn them on anyway.'
          : 'Following your device: animation is on.')
        : ui.motionMode === 'full'
          ? 'Full motion is on' + (ui.deviceReduce ? ', even though your device asks for reduced motion.' : '.')
          : 'Reduced motion is on: strides and swaying corn stay still.';
      if (ui.reduce) { ui.gait.phase = 0; ui.gait.amount = 0; ui.gait.moving = false; }
    }
    $('motion-mode').addEventListener('change', function () {
      ui.motionMode = MOTION_MODES.indexOf(this.value) >= 0 ? this.value : 'device';
      applyMotion(); savePrefs();
    });
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', applyMotion); else if (mq.addListener) mq.addListener(applyMotion); }

    /* ---- music: song picker, Auto rotate, now playing (see audio.js) ---- */
    var npText = '';
    // The select and status follow the song actually heard (nowPlaying), not the saved/scheduled one. After a pick or skip
    // ui.pendingTrack remembers the target until that song's audible onset, so quick repeated skips keep advancing.
    function trackTitle(id) {
      for (var i = 0; i < audio.tracks.length; i++) if (audio.tracks[i].id === id) return audio.tracks[i].title;
      return '';
    }
    function syncMusicUI() {
      if (!audio || !audio.tracks) return;
      var np = audio.nowPlaying(), pend = ui.pendingTrack;
      if (pend && (np.id === pend || !np.playing || performance.now() - ui.trackAt > 6000)) pend = ui.pendingTrack = null;
      var shown = pend || np.id;
      var txt = pend ? 'Switching to: ' + trackTitle(pend)
        : np.playing ? 'Now playing: ' + np.title : (audio.music() ? 'Starting: ' + np.title : 'Music is off. Selected: ' + np.title);
      if ($('music-track').value !== shown) $('music-track').value = shown;
      $('music-rotate').checked = audio.autoRotate();
      if (txt !== npText) { npText = txt; $('now-playing').textContent = txt; }
    }
    function pickTrack(id) {
      ui.pendingTrack = id; ui.trackAt = performance.now();
      audio.setTrack(id);   // never touches the music switch: choosing a song does not unmute
      syncMusicUI();
    }
    function stepTrack(delta) {
      var ids = audio.tracks.map(function (tr) { return tr.id; }), cur = ids.indexOf(ui.pendingTrack || audio.nowPlaying().id);
      pickTrack(ids[((cur < 0 ? 0 : cur) + delta + ids.length) % ids.length]);
    }
    if (audio && audio.tracks) {
      audio.tracks.forEach(function (tr) {
        var o = document.createElement('option'); o.value = tr.id; o.textContent = tr.title; $('music-track').appendChild(o);
      });
      $('music-track').addEventListener('change', function () { pickTrack(this.value); });
      $('music-prev').addEventListener('click', function () { stepTrack(-1); });
      $('music-next').addEventListener('click', function () { stepTrack(1); });
      $('music-rotate').addEventListener('change', function () { audio.setAutoRotate(this.checked); });
      audio.onChange(syncMusicUI);
      syncMusicUI();
    } else {
      $('music-track').disabled = true; $('music-rotate').disabled = true; $('music-prev').disabled = true; $('music-next').disabled = true;
      $('now-playing').textContent = 'Music is not available.';
    }

    /* ---- Continue: reopen the last saved field, only when asked ---- */
    function doResume() {
      var raw = resumeSource(), res = raw ? core.parse(raw) : null;
      if (!res || !res.ok) { say('There is no saved field to continue.'); updateResume(); return; }
      var apply = function () {
        cancelSave();
        useState(res.state); S.dirty = true;
        ui.ownsSave = false; ui.resumeRaw = raw;   // the next real edit checkpoints it again
        if (store(KEY, raw)) $('save-status').textContent = 'Reopened your saved field';
        else $('save-status').textContent = 'Reopened your saved field (this browser cannot save it again)';
        updateResume(); showLoadedSupport(true); say('Reopened "' + S.name + '".');
      };
      if (S.dirty) ask('Replace your current field?', 'Continue reopens your last saved field and replaces the one you are working on. Export it first if you want to keep it. This cannot be undone.', 'Continue saved field').then(function (y) { if (y) apply(); });
      else apply();
    }
    $('btn-resume').addEventListener('click', doResume);

    // One resize source: the observer (window resize only as a fallback). Unchanged sizes are ignored.
    if (window.ResizeObserver) new ResizeObserver(function () { computeLayout(false); }).observe(canvas.parentNode);
    else window.addEventListener('resize', function () { computeLayout(false); });

    /* ---- loop ---- */
    var last = performance.now();
    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000); last = now; ui.phase += dt;
      // held movement
      if (ui.held && now >= ui.nextStep && !ui.pointer) { act(ui.held[0], ui.held[1]); ui.nextStep = now + (ui.mode === 'carve' ? 125 : 105); }
      // smoothing (none with reduced motion)
      var k = ui.reduce ? 1 : Math.min(1, dt * 16);
      ui.vt.x += (S.tractor.x - ui.vt.x) * k; ui.vt.y += (S.tractor.y - ui.vt.y) * k;
      ui.vr.x += (S.run.x - ui.vr.x) * k; ui.vr.y += (S.run.y - ui.vr.y) * k;
      stepGait(dt);
      if (now - (ui.musicTick || 0) > 250) { ui.musicTick = now; syncMusicUI(); }
      if (ui.bump) ui.bump = Math.max(0, ui.bump - dt);
      var i, p;
      for (i = ui.particles.length - 1; i >= 0; i--) {
        p = ui.particles[i]; p.life -= dt; if (p.life <= 0) { ui.particles.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.kind === 'confetti' ? 4 : 3) * dt; p.rot += dt * 5;
      }
      if (ui.hint && now > ui.hint.until) ui.hint = null;
      draw(now, dt);
      updateHud(now);
      requestAnimationFrame(frame);
    }

    function draw(now, dt) {
      var g = ctx, dpr = ui.dpr, t = ui.t, pal = PAL[S.season], i, p;
      // Bake corn once when zoomed too far out to see its sway, or when reduced motion is on.
      var sway = !ui.reduce && t >= MOTION_MIN_T;
      if (ui.layerDirty || !ui.layer || ui.layer.withCorn === sway) {
        ui.layer = buildLayer(S, S.season, t, dpr, !sway); ui.layerDirty = false; ui.mm.dirty = true;
        ui.sprites = sway ? getSprites(S.season, t, dpr) : null;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBackdrop(g, ui.cw, ui.ch, pal, now);
      // Camera: the whole field centred (fit); only the explicit close-up view follows the active actor.
      var L = ui.layer, ready = core.isConfigured(S), runActive = ui.mode === 'run' && ready;
      var a = runActive ? ui.vr : ui.vt, tx, ty;
      if (!ui.close || L.w <= ui.cw) tx = (ui.cw - L.w) / 2; else tx = Math.min(0, Math.max(ui.cw - L.w, ui.cw / 2 - (ORG + a.x + 0.5) * t));
      if (!ui.close || L.h <= ui.ch) ty = (ui.ch - L.h) / 2; else ty = Math.min(0, Math.max(ui.ch - L.h, ui.ch / 2 - (ORGY + a.y + 0.5) * t));
      ui.ox = Math.round(tx); ui.oy = Math.round(ty);
      g.drawImage(L.canvas, ui.ox, ui.oy, L.w, L.h);
      if (sway) {
        if (dt) ui.cornT += dt;
        ui.cornStats = drawCorn(g, S, ui.sprites, t, dpr, ui.ox, ui.oy, ui.cw, ui.ch, ui.cornT);
        ui.cornDrawn = ui.cornStats.drawn;
      } else { ui.cornDrawn = 0; ui.cornStats = { drawn: 0, activeCells: 0, activePlants: 0, visiblePlants: 0 }; }
      var bx = ui.ox + ORG * t, by = ui.oy + ORGY * t;
      function cx(x) { return bx + (x + 0.5) * t; }
      function cy(y) { return by + (y + 0.5) * t; }
      // gates: only in a maze, only once placed
      if (S.purpose === 'maze') {
        if (S.start) {
          g.save(); g.strokeStyle = 'rgba(232,115,90,0.7)'; g.lineWidth = Math.max(1.5, t * 0.06); g.setLineDash([t * 0.12, t * 0.1]);
          g.beginPath(); g.arc(cx(S.start.x), cy(S.start.y), t * 0.42, 0, TAU); g.stroke(); g.restore();
        }
        if (S.exit) drawFlag(g, cx(S.exit.x), cy(S.exit.y), t, 0);
      }
      // hint
      if (ui.hint) {
        var left = ui.hint.until - now, n = Math.min(ui.hint.path.length, 12);
        for (i = 0; i < n; i++) {
          var hp = ui.hint.path[i], pulse = ui.reduce ? 0.5 : 0.5 + 0.5 * Math.sin(now / 160 - i * 0.6);
          g.fillStyle = 'rgba(255,255,255,' + Math.min(0.9, left / 600) * (0.45 + 0.4 * pulse) + ')';
          g.beginPath(); g.arc(cx(hp[0]), cy(hp[1]), t * (0.1 + 0.06 * pulse), 0, TAU); g.fill();
          g.strokeStyle = 'rgba(232,115,90,' + Math.min(0.9, left / 600) * 0.8 + ')'; g.lineWidth = 1.5; g.stroke();
        }
      }
      // actors, back to front
      // actors are drawn over the plants, so neither is ever hidden; the active one is always on top
      var G = ui.gait, pose = G.amount > 0.001 ? { phase: G.phase, amount: G.amount } : null;
      var bob = pose ? -Math.abs(Math.sin(G.phase)) * 0.09 * t * G.amount : 0;
      var jig = ui.bump && !ui.reduce ? Math.sin(ui.bump * 60) * 0.06 * t : 0;
      var tractor = { f: function () { drawTractor(g, cx(ui.vt.x), cy(ui.vt.y), t, S.tractor.dir, (ui.vt.x + ui.vt.y) % 1); } };
      var runner = { f: function () { drawAnimal(g, S.animal, cx(ui.vr.x) + jig, cy(ui.vr.y) - 0.14 * t + bob, t * 0.5, pose, S.run.dir); } };
      var list = ready ? (runActive ? [tractor, runner] : [runner, tractor]) : [tractor];
      for (i = 0; i < list.length; i++) list[i].f();
      // particles
      for (i = 0; i < ui.particles.length; i++) {
        p = ui.particles[i];
        g.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
        if (p.kind === 'confetti') {
          g.save(); g.translate(bx + p.x * t, by + p.y * t); g.rotate(p.rot); g.fillStyle = p.c; g.fillRect(-4, -2, 8, 4); g.restore();
        } else flat(g, bx + p.x * t, by + p.y * t, t * 0.07, t * 0.05, p.c, p.rot);
      }
      g.globalAlpha = 1;
      drawMinimap();
    }

    /* ---- start ---- */
    // Every visit opens a fresh, fully planted field in the last-used size, season and animal. Nothing is written
    // to KEY here: the previous save stays untouched and is offered through Continue.
    var saved = load(KEY), res = saved ? core.parse(saved) : null, prefs = loadPrefs(), backedUp = false;
    if (res && res.ok) ui.resumeRaw = saved;
    else if (saved) {
      // A save we cannot read is copied aside before any later autosave could replace it.
      backedUp = load(BACKUP_KEY) === saved || store(BACKUP_KEY, saved);
      ui.saveBlocked = !backedUp;
    }
    ui.motionMode = prefs.motion;
    S = core.newBlank({ size: prefs.size, season: prefs.season, animal: prefs.animal, seed: randSeed(), name: DEFAULT_NAME });
    applyMotion();
    computeLayout(true);
    syncActors();
    updatePanel();
    updateResume();
    $('save-status').textContent = res && res.ok ? 'A saved field is ready under Continue; autosave starts when you carve'
      : backedUp ? 'Your earlier save could not be read; a copy is kept on this device'
      : ui.saveBlocked ? 'Autosave paused for this session to preserve your earlier save. Export this field to keep it.' : 'Autosave starts when you carve';
    if (!load('cornfield-carver:seen')) { store('cornfield-carver:seen', '1'); showModal('modal-help'); }
    requestAnimationFrame(frame);
    // test hooks for smoke and integration checks
    window.__cornfield = {
      state: function () { return S; }, core: core,
      view: function () {
        return { view: ui.view, close: ui.close, t: ui.t, ox: ui.ox, oy: ui.oy, org: ORG, orgY: ORGY,
          gridX: ui.ox + ORG * ui.t, gridY: ui.oy + ORGY * ui.t, cw: ui.cw, ch: ui.ch, dpr: ui.dpr,
          canvasW: canvas.width, canvasH: canvas.height, layerW: ui.layer ? ui.layer.w : 0, layerH: ui.layer ? ui.layer.h : 0,
          purpose: S.purpose, mode: ui.mode, place: ui.place, reduceMotion: ui.reduce, tab: ui.tab,
          motionMode: ui.motionMode, deviceReduce: ui.deviceReduce };
      },
      animation: function () { return { phase: ui.gait.phase, moving: ui.gait.moving, amount: ui.gait.amount, dir: S.run.dir }; },
      // active: corn is live-composited; drawn: corn cells drawn in the last frame (visible cells only);
      // activePlants / visiblePlants: stalks mid-burst vs stalks in the drawn cells; amplitude: max lean in radians
      cornMotion: function () {
        var c = ui.cornStats;
        return { active: !ui.reduce && !!ui.layer && !ui.layer.withCorn, drawn: ui.cornDrawn, activeCells: c.activeCells,
          activePlants: c.activePlants, visiblePlants: c.visiblePlants, amplitude: BURST_MAX, time: ui.cornT };
      },
      // PNG data URL of the real animal renderer in a fixed pose and facing (0 right, 1 down, 2 left, 3 up; default
      // front), on a transparent 224x160 canvas with room for the full horse profile
      posePreview: function (kind, phase, amount, dir) {
        if (core.ANIMALS.indexOf(kind) < 0) return null;
        var cv = document.createElement('canvas'), pg;
        cv.width = 224; cv.height = 160; pg = cv.getContext('2d');
        drawAnimal(pg, kind, 112, 66, 56, { phase: +phase || 0, amount: Math.max(0, Math.min(1, amount === undefined ? 1 : +amount || 0)) }, dir === undefined ? 1 : dir);
        return cv.toDataURL('image/png');
      },
      minimap: function () {
        var m = ui.mm, cp = function (o) { return o && { x: o.x, y: o.y, w: o.w, h: o.h }; };
        return { rect: cp(m.rect), visible: cp(m.vis), actor: m.actor && { kind: m.actor.kind, x: m.actor.x, y: m.actor.y },
          field: { w: S.w, h: S.h, cell: m.cell, pad: m.pad, canvasW: mmCanvas.width, canvasH: mmCanvas.height },
          close: ui.close, tab: ui.tab };
      }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);

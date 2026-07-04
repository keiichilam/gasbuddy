/* dungeon.js — procedural grid-maze dungeon generation, Bard's-Tale style.
 * Each cell tracks walls on its four sides plus optional features.
 * Directions: 0=N, 1=E, 2=S, 3=W.
 */
(function (BT) {
  'use strict';

  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  const OPP = [2, 3, 0, 1];
  BT.DIR = { N: 0, E: 1, S: 2, W: 3 };
  BT.DX = DX; BT.DY = DY; BT.OPP = OPP;
  BT.DIR_NAME = ['North', 'East', 'South', 'West'];

  function makeCell() {
    return {
      walls: [true, true, true, true], // all walls closed initially
      visited: false,   // explored by the player (automap)
      feature: null,    // 'stairsDown' | 'stairsUp' | 'chest' | 'trap' | 'fountain' | 'portal' | 'message' | 'artifact'
      data: null,
      encounter: 0      // per-step random-encounter weight
    };
  }

  class Level {
    constructor(depth, w, h) {
      this.depth = depth;
      this.w = w; this.h = h;
      this.cells = [];
      for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) row.push(makeCell());
        this.cells.push(row);
      }
      this.start = { x: 0, y: 0 };
      this.stairsDown = null;
      this.stairsUp = null;
    }
    inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
    cell(x, y) { return this.inBounds(x, y) ? this.cells[y][x] : null; }

    // Is passage open from (x,y) in direction dir? (no wall on either side)
    canMove(x, y, dir) {
      const c = this.cell(x, y);
      if (!c || c.walls[dir]) return false;
      const nx = x + DX[dir], ny = y + DY[dir];
      const n = this.cell(nx, ny);
      return !!n && !n.walls[OPP[dir]];
    }

    // Carve a passage between (x,y) and its neighbor in dir.
    carve(x, y, dir) {
      const c = this.cell(x, y);
      const nx = x + DX[dir], ny = y + DY[dir];
      const n = this.cell(nx, ny);
      if (!c || !n) return;
      c.walls[dir] = false;
      n.walls[OPP[dir]] = false;
    }
    wall(x, y, dir) {
      const c = this.cell(x, y);
      const nx = x + DX[dir], ny = y + DY[dir];
      const n = this.cell(nx, ny);
      if (c) c.walls[dir] = true;
      if (n) n.walls[OPP[dir]] = true;
    }
  }

  // Recursive-backtracker maze carved over the whole grid.
  function carveMaze(level, rng) {
    const { w, h } = level;
    const visited = Array.from({ length: h }, () => new Array(w).fill(false));
    const stack = [];
    let cx = rng.int(0, w - 1), cy = rng.int(0, h - 1);
    visited[cy][cx] = true;
    stack.push([cx, cy]);
    while (stack.length) {
      [cx, cy] = stack[stack.length - 1];
      const dirs = [0, 1, 2, 3].filter(d => {
        const nx = cx + DX[d], ny = cy + DY[d];
        return level.inBounds(nx, ny) && !visited[ny][nx];
      });
      if (dirs.length === 0) { stack.pop(); continue; }
      const d = rng.pick(dirs);
      level.carve(cx, cy, d);
      const nx = cx + DX[d], ny = cy + DY[d];
      visited[ny][nx] = true;
      stack.push([nx, ny]);
    }
  }

  // Punch out rectangular rooms and knock a few extra walls for loops.
  function addRoomsAndLoops(level, rng) {
    const { w, h } = level;
    const roomCount = rng.int(2, 4);
    for (let r = 0; r < roomCount; r++) {
      const rw = rng.int(2, 4), rh = rng.int(2, 4);
      const rx = rng.int(0, w - rw), ry = rng.int(0, h - rh);
      for (let y = ry; y < ry + rh; y++) {
        for (let x = rx; x < rx + rw; x++) {
          if (x + 1 < rx + rw) level.carve(x, y, BT.DIR.E);
          if (y + 1 < ry + rh) level.carve(x, y, BT.DIR.S);
        }
      }
    }
    // Braid: remove some dead-end-y walls to create loops.
    const extra = Math.floor(w * h * 0.12);
    for (let i = 0; i < extra; i++) {
      const x = rng.int(0, w - 1), y = rng.int(0, h - 1);
      const d = rng.int(0, 3);
      const nx = x + DX[d], ny = y + DY[d];
      if (level.inBounds(nx, ny)) level.carve(x, y, d);
    }
  }

  // Collect cells reachable from start (flood fill) to place features fairly.
  function reachableCells(level, sx, sy) {
    const seen = new Set();
    const q = [[sx, sy]];
    seen.add(sx + ',' + sy);
    while (q.length) {
      const [x, y] = q.shift();
      for (let d = 0; d < 4; d++) {
        if (level.canMove(x, y, d)) {
          const nx = x + DX[d], ny = y + DY[d];
          const key = nx + ',' + ny;
          if (!seen.has(key)) { seen.add(key); q.push([nx, ny]); }
        }
      }
    }
    return Array.from(seen).map(s => { const [x, y] = s.split(',').map(Number); return { x, y }; });
  }

  function dist(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

  function placeFeatures(level, rng, opts) {
    const start = level.start;
    const reachable = reachableCells(level, start.x, start.y);
    const pool = reachable.filter(c => !(c.x === start.x && c.y === start.y));
    rng.shuffle(pool);

    const used = new Set([start.x + ',' + start.y]);
    const take = (pred) => {
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        const key = c.x + ',' + c.y;
        if (used.has(key)) continue;
        if (pred && !pred(c)) continue;
        used.add(key);
        return c;
      }
      return null;
    };

    // Stairs down: place far from the start.
    if (!opts.isLast) {
      const far = pool.filter(c => dist(c, start) >= (level.w + level.h) / 2);
      const spot = (far.length ? rng.pick(far) : pool[pool.length - 1]);
      used.add(spot.x + ',' + spot.y);
      level.cell(spot.x, spot.y).feature = 'stairsDown';
      level.stairsDown = { x: spot.x, y: spot.y };
    } else {
      // Last level: the artifact & boss guard the deepest cell.
      const far = pool.filter(c => dist(c, start) >= (level.w + level.h) / 2);
      const spot = (far.length ? rng.pick(far) : pool[pool.length - 1]);
      used.add(spot.x + ',' + spot.y);
      const cell = level.cell(spot.x, spot.y);
      cell.feature = 'artifact';
      cell.data = { boss: true };
      level.artifactAt = { x: spot.x, y: spot.y };
    }

    // Treasure chests.
    const chests = rng.int(2, 4);
    for (let i = 0; i < chests; i++) {
      const c = take();
      if (c) { level.cell(c.x, c.y).feature = 'chest'; level.cell(c.x, c.y).data = { opened: false, tier: level.depth }; }
    }
    // Healing fountains (rare).
    if (rng.chance(0.7)) {
      const c = take();
      if (c) { level.cell(c.x, c.y).feature = 'fountain'; level.cell(c.x, c.y).data = { used: false }; }
    }
    // Traps.
    const traps = rng.int(1, 3);
    for (let i = 0; i < traps; i++) {
      const c = take();
      if (c) { level.cell(c.x, c.y).feature = 'trap'; level.cell(c.x, c.y).data = { sprung: false, dmg: level.depth }; }
    }
    // Lore message.
    const c = take();
    if (c) {
      const lore = rng.pick([
        'Etched runes warn: "Turn back, mortals."',
        'A faded mural depicts a sword swallowing the dark.',
        'Old bones clutch a torn map of the deeps.',
        'The air hums with distant, malevolent laughter.',
        'Scratched into stone: "Mangar waits below."'
      ]);
      level.cell(c.x, c.y).feature = 'message';
      level.cell(c.x, c.y).data = { text: lore, read: false };
    }

    // Random-encounter weighting: heavier the deeper you go.
    for (const rc of reachable) {
      level.cell(rc.x, rc.y).encounter = 0.10 + level.depth * 0.015;
    }
  }

  // Build a full dungeon of N levels. Stairs align between levels.
  function generateDungeon(seed, levelCount) {
    const rng = new BT.RNG(seed);
    levelCount = levelCount || 5;
    const levels = [];
    let prevStairsDown = null;
    for (let d = 1; d <= levelCount; d++) {
      const size = 8 + Math.min(6, d); // grows with depth, up to ~14
      const level = new Level(d, size, size);
      carveMaze(level, rng);
      addRoomsAndLoops(level, rng);

      // The upstairs sit where the previous level's downstairs were.
      if (prevStairsDown) {
        const sx = Math.min(prevStairsDown.x, level.w - 1);
        const sy = Math.min(prevStairsDown.y, level.h - 1);
        level.start = { x: sx, y: sy };
        level.stairsUp = { x: sx, y: sy };
      } else {
        level.start = { x: rng.int(0, level.w - 1), y: rng.int(0, level.h - 1) };
      }

      placeFeatures(level, rng, { isLast: d === levelCount });
      // Mark the upstairs feature (after features so it isn't overwritten).
      if (level.stairsUp) {
        const c = level.cell(level.stairsUp.x, level.stairsUp.y);
        if (c.feature == null) c.feature = 'stairsUp';
      }
      prevStairsDown = level.stairsDown;
      levels.push(level);
    }
    return { seed: rng.seed, levels };
  }

  BT.Level = Level;
  BT.generateDungeon = generateDungeon;
})(window.BT = window.BT || {});

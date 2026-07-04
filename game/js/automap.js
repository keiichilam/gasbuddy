/* automap.js — top-down explored-map overlay drawn to a canvas. */
(function (BT) {
  'use strict';

  const DX = BT.DX, DY = BT.DY;
  const FEATURE_GLYPH = {
    stairsDown: '↓', stairsUp: '↑', chest: '$', fountain: '~',
    trap: '!', portal: '@', message: '?', artifact: '★'
  };

  function draw(canvas, level, px, py, dir, revealAll) {
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width, H = rect.height;

    ctx.clearRect(0, 0, W, H);
    const pad = 8;
    const cell = Math.min((W - pad * 2) / level.w, (H - pad * 2) / level.h);
    const ox = (W - cell * level.w) / 2;
    const oy = (H - cell * level.h) / 2;

    ctx.fillStyle = '#0a0b12';
    ctx.fillRect(0, 0, W, H);

    for (let y = 0; y < level.h; y++) {
      for (let x = 0; x < level.w; x++) {
        const c = level.cell(x, y);
        if (!c.visited && !revealAll) continue;
        const sx = ox + x * cell, sy = oy + y * cell;
        // Floor.
        ctx.fillStyle = c.visited ? '#1c2233' : '#141826';
        ctx.fillRect(sx, sy, cell, cell);

        // Walls.
        ctx.strokeStyle = '#4a5878';
        ctx.lineWidth = Math.max(1, cell * 0.10);
        ctx.beginPath();
        if (c.walls[0]) { ctx.moveTo(sx, sy); ctx.lineTo(sx + cell, sy); }
        if (c.walls[1]) { ctx.moveTo(sx + cell, sy); ctx.lineTo(sx + cell, sy + cell); }
        if (c.walls[2]) { ctx.moveTo(sx, sy + cell); ctx.lineTo(sx + cell, sy + cell); }
        if (c.walls[3]) { ctx.moveTo(sx, sy); ctx.lineTo(sx, sy + cell); }
        ctx.stroke();

        // Feature glyph.
        if (c.feature && (c.visited || revealAll)) {
          const g = FEATURE_GLYPH[c.feature];
          if (g) {
            ctx.fillStyle = c.feature === 'artifact' ? '#ffd166' : '#8fb3ff';
            ctx.font = Math.floor(cell * 0.7) + 'px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(g, sx + cell / 2, sy + cell / 2 + 1);
          }
        }
      }
    }

    // Player arrow.
    const psx = ox + px * cell + cell / 2, psy = oy + py * cell + cell / 2;
    const ang = [(-Math.PI / 2), 0, (Math.PI / 2), Math.PI][dir];
    ctx.save();
    ctx.translate(psx, psy);
    ctx.rotate(ang);
    ctx.fillStyle = '#ffd166';
    const r = cell * 0.34;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.7, r * 0.7);
    ctx.lineTo(-r * 0.7, -r * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  BT.drawAutomap = draw;
})(window.BT = window.BT || {});

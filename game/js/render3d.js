/* render3d.js — first-person, grid-based pseudo-3D dungeon view.
 * Draws nested wall "frames" receding into the distance (Dungeon Master style),
 * with side walls as trapezoids and openings left dark for corridors.
 */
(function (BT) {
  'use strict';

  const DX = BT.DX, DY = BT.DY;

  // Relative → absolute cell. facing dir; forward f (>=0), right r (can be +/-).
  function project(px, py, dir, f, r) {
    // forward vector = DX[dir]; right vector = rotate dir by +1 (E of facing)
    const rd = (dir + 1) % 4;
    return {
      x: px + DX[dir] * f + DX[rd] * r,
      y: py + DY[dir] * f + DY[rd] * r
    };
  }

  // Is there a wall on the absolute `side` of cell (x,y)?
  function wallAt(level, x, y, side) {
    const c = level.cell(x, y);
    if (!c) return true;
    return c.walls[side];
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.maxDepth = 4;
      // Nested frame scales from near (index 0) to far.
      this.scales = [1.0, 0.60, 0.36, 0.22, 0.13, 0.08];
    }

    resize() {
      const c = this.canvas;
      const rect = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(320, Math.floor(rect.width * dpr));
      c.height = Math.max(240, Math.floor(rect.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.W = rect.width; this.H = rect.height;
    }

    frame(i) {
      const s = this.scales[Math.min(i, this.scales.length - 1)];
      const cx = this.W / 2, cy = this.H / 2;
      const hw = cx * 0.94 * s;
      const hh = cy * 0.94 * s;
      return { l: cx - hw, r: cx + hw, t: cy - hh, b: cy + hh };
    }

    // Fog: fade a color toward the background with distance.
    fog(hex, depth) {
      const bg = { r: 8, g: 9, b: 16 };
      const c = hexToRgb(hex);
      const t = Math.min(0.85, depth * 0.20);
      const r = Math.round(c.r + (bg.r - c.r) * t);
      const g = Math.round(c.g + (bg.g - c.g) * t);
      const b = Math.round(c.b + (bg.b - c.b) * t);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    poly(pts, fill, stroke) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    }

    render(level, px, py, dir) {
      this.resize();
      const ctx = this.ctx;
      const W = this.W, H = this.H;

      // Sky / ceiling gradient.
      const gTop = ctx.createLinearGradient(0, 0, 0, H / 2);
      gTop.addColorStop(0, '#0a0b12');
      gTop.addColorStop(1, '#1a1626');
      ctx.fillStyle = gTop;
      ctx.fillRect(0, 0, W, H / 2);
      const gBot = ctx.createLinearGradient(0, H / 2, 0, H);
      gBot.addColorStop(0, '#141018');
      gBot.addColorStop(1, '#05060a');
      ctx.fillStyle = gBot;
      ctx.fillRect(0, H / 2, W, H / 2);

      const dirRight = (dir + 1) % 4;
      const dirLeft = (dir + 3) % 4;

      // Draw from far to near so nearer geometry overdraws.
      let blockedAt = this.maxDepth + 1;
      // First find how far we can see forward before a wall.
      for (let f = 0; f <= this.maxDepth; f++) {
        const cell = project(px, py, dir, f, 0);
        // wall on the far (forward) side of this cell blocks view beyond.
        if (wallAt(level, cell.x, cell.y, dir)) { blockedAt = f; break; }
      }

      for (let f = Math.min(this.maxDepth, blockedAt); f >= 0; f--) {
        const near = this.frame(f);
        const far = this.frame(f + 1);
        const cell = project(px, py, dir, f, 0);
        if (!level.cell(cell.x, cell.y)) continue;

        const floorCol = this.fog('#2a2230', f);
        const ceilCol = this.fog('#1d1a2a', f);
        const wallL = this.fog('#4a4258', f);
        const wallR = this.fog('#3c364c', f);
        const wallF = this.fog('#5a5268', f);

        // Floor trapezoid (between near.b and far.b).
        this.poly([[near.l, near.b], [near.r, near.b], [far.r, far.b], [far.l, far.b]], floorCol);
        // Ceiling trapezoid.
        this.poly([[near.l, near.t], [near.r, near.t], [far.r, far.t], [far.l, far.t]], ceilCol);

        // Left wall: draw if wall present on left side of this cell.
        if (wallAt(level, cell.x, cell.y, dirLeft)) {
          this.poly([[near.l, near.t], [far.l, far.t], [far.l, far.b], [near.l, near.b]], wallL, 'rgba(0,0,0,0.35)');
        } else {
          // opening — hint of a side passage
          this.poly([[near.l, near.t], [far.l, far.t], [far.l, far.b], [near.l, near.b]], this.fog('#100e18', f + 1));
        }
        // Right wall.
        if (wallAt(level, cell.x, cell.y, dirRight)) {
          this.poly([[near.r, near.t], [far.r, far.t], [far.r, far.b], [near.r, near.b]], wallR, 'rgba(0,0,0,0.35)');
        } else {
          this.poly([[near.r, near.t], [far.r, far.t], [far.r, far.b], [near.r, near.b]], this.fog('#100e18', f + 1));
        }

        // Front wall if this cell is blocked ahead.
        if (f === blockedAt && wallAt(level, cell.x, cell.y, dir)) {
          this.poly([[far.l, far.t], [far.r, far.t], [far.r, far.b], [far.l, far.b]], wallF, 'rgba(0,0,0,0.4)');
          this._brick(far, f);
        }

        // Feature in this cell (chest, stairs, fountain, etc.).
        const c = level.cell(cell.x, cell.y);
        if (c.feature && f <= 2 && f < blockedAt + 1) {
          this._drawFeature(c.feature, near, far, f);
        }
      }

      // Torch vignette overlay for mood.
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.15, W / 2, H / 2, H * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }

    _brick(fr, depth) {
      // Subtle brick lines on a front wall.
      const ctx = this.ctx;
      ctx.strokeStyle = this.fog('#2a2436', depth);
      ctx.lineWidth = 1;
      const rows = 5, w = fr.r - fr.l, h = fr.b - fr.t;
      for (let i = 1; i < rows; i++) {
        const y = fr.t + (h / rows) * i;
        ctx.beginPath(); ctx.moveTo(fr.l, y); ctx.lineTo(fr.r, y); ctx.stroke();
      }
      for (let i = 1; i < 4; i++) {
        const x = fr.l + (w / 4) * i;
        ctx.beginPath(); ctx.moveTo(x, fr.t); ctx.lineTo(x, fr.b); ctx.stroke();
      }
    }

    _drawFeature(feature, near, far, depth) {
      const ctx = this.ctx;
      const cx = (near.l + near.r) / 2;
      const baseY = (near.b + far.b) / 2;
      const size = (near.b - near.t) * 0.22 * (1 - depth * 0.15);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const emojiMap = {
        stairsDown: '⬇️', stairsUp: '⬆️', chest: '🎁', fountain: '⛲',
        trap: '', portal: '🌀', message: '📜', artifact: '⚔️'
      };
      const glyph = emojiMap[feature];
      if (!glyph) { ctx.restore(); return; }
      ctx.globalAlpha = Math.max(0.35, 1 - depth * 0.25);
      ctx.font = Math.max(14, size) + 'px serif';
      // soft glow
      ctx.shadowColor = feature === 'artifact' ? '#ffd166' : '#7aa2ff';
      ctx.shadowBlur = 18;
      ctx.fillText(glyph, cx, baseY - size * 0.4);
      ctx.restore();
    }
  }

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }

  BT.Renderer = Renderer;
})(window.BT = window.BT || {});

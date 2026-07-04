/* rng.js — seeded pseudo-random number generator + dice helpers.
 * Deterministic so a given seed always reproduces the same dungeon.
 */
(function (BT) {
  'use strict';

  // Mulberry32 — small, fast, decent-quality 32-bit PRNG.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Hash a string into a 32-bit seed (xfnv-1a style).
  function hashSeed(str) {
    str = String(str);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  class RNG {
    constructor(seed) {
      this.seed = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed == null ? Date.now() + '' + Math.random() : seed);
      this._next = mulberry32(this.seed);
    }
    // float in [0,1)
    next() { return this._next(); }
    // integer in [min, max] inclusive
    int(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
    // float in [min, max)
    float(min, max) { return min + this.next() * (max - min); }
    // true with probability p
    chance(p) { return this.next() < p; }
    // pick a random element
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    // weighted pick: items = [{item, weight}] -> item
    weighted(items) {
      let total = 0;
      for (const it of items) total += it.weight;
      let r = this.next() * total;
      for (const it of items) {
        r -= it.weight;
        if (r <= 0) return it.item;
      }
      return items[items.length - 1].item;
    }
    // shuffle in place (Fisher–Yates)
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(this.next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    // roll dice: count dN + mod, e.g. roll(3,6) = 3d6
    roll(count, sides, mod) {
      let sum = mod || 0;
      for (let i = 0; i < count; i++) sum += this.int(1, sides);
      return sum;
    }
    // 4d6 drop lowest — classic ability score
    ability() {
      const dice = [this.int(1, 6), this.int(1, 6), this.int(1, 6), this.int(1, 6)];
      dice.sort((a, b) => a - b);
      return dice[1] + dice[2] + dice[3];
    }
    // parse & roll a dice string like "2d6+3", "1d8", "d4"
    dice(str) {
      const m = /^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i.exec(str);
      if (!m) return parseInt(str, 10) || 0;
      const count = m[1] ? parseInt(m[1], 10) : 1;
      const sides = parseInt(m[2], 10);
      const mod = m[3] ? parseInt(m[3].replace(/\s/g, ''), 10) : 0;
      return this.roll(count, sides, mod);
    }
  }

  BT.RNG = RNG;
  BT.hashSeed = hashSeed;
})(window.BT = window.BT || {});

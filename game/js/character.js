/* character.js — party members: generation, derived stats, XP & leveling. */
(function (BT) {
  'use strict';

  const mod = BT.abilityMod;

  // XP thresholds (cumulative) roughly following 5e milestones, capped at 12.
  const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000];

  function levelForXP(xp) {
    let lvl = 1;
    for (let i = 1; i < XP_TABLE.length; i++) {
      if (xp >= XP_TABLE[i]) lvl = i + 1;
    }
    return lvl;
  }

  function proficiency(level) { return 2 + Math.floor((level - 1) / 4); }

  class Character {
    constructor(opts) {
      Object.assign(this, {
        name: 'Adventurer', race: 'Human', cls: 'Fighter', level: 1, xp: 0,
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        hp: 10, maxHp: 10, sp: 0, maxSp: 0, gold: 0,
        equip: { weapon: 'Fists', armor: 'Robes', shield: false },
        spells: [], inventory: [], status: {}, dead: false
      }, opts || {});
    }

    get classData() { return BT.CLASSES[this.cls]; }
    get raceData() { return BT.RACES[this.race]; }

    mod(stat) { return mod(this.abilities[stat]); }

    // Armor class from worn armor + DEX (per armor type) + shield.
    get ac() {
      const armor = BT.ARMOR[this.equip.armor] || BT.ARMOR['Robes'];
      let base = armor.ac;
      const dexMod = this.mod('DEX');
      if (armor.type === 'light') base += dexMod;
      else if (armor.type === 'medium') base += Math.min(2, dexMod);
      // heavy: no dex
      if (this.equip.shield) base += BT.SHIELD_AC;
      if (this.status.shield) base += 5;
      return base;
    }

    get weapon() { return BT.WEAPONS[this.equip.weapon] || BT.WEAPONS['Fists']; }

    // Which ability drives attacks with the current weapon.
    get attackStat() {
      const w = this.weapon;
      if (w.ranged) return 'DEX';
      if (w.finesse) return this.mod('DEX') >= this.mod('STR') ? 'DEX' : 'STR';
      return 'STR';
    }

    get attackBonus() { return proficiency(this.level) + this.mod(this.attackStat); }

    // Spell attack / save DC uses the class' prime casting stat.
    get spellStat() { return this.classData.prime; }
    get spellDC() { return 8 + proficiency(this.level) + this.mod(this.spellStat); }
    get spellAttack() { return proficiency(this.level) + this.mod(this.spellStat); }

    get isCaster() { return !!this.classData.caster; }

    // Recompute max HP / SP for the current level.
    recalcMaxes() {
      const cd = this.classData;
      // Level 1 = full hit die; each further level = average roll.
      let hp = cd.hitDie + this.mod('CON');
      for (let l = 2; l <= this.level; l++) {
        hp += Math.ceil((cd.hitDie + 1) / 2) + this.mod('CON');
      }
      this.maxHp = Math.max(1, hp);
      if (this.isCaster) {
        this.maxSp = 2 + this.level * 2 + this.mod(this.spellStat);
      } else {
        this.maxSp = 0;
      }
    }

    addXP(amount) {
      this.xp += amount;
      const newLevel = Math.min(XP_TABLE.length, levelForXP(this.xp));
      let leveled = false;
      while (this.level < newLevel) {
        this.level++;
        leveled = true;
      }
      if (leveled) {
        const prevMax = this.maxHp;
        this.recalcMaxes();
        // Heal the difference gained so leveling feels rewarding.
        this.hp = Math.min(this.maxHp, this.hp + (this.maxHp - prevMax));
        this.sp = this.maxSp;
        // Learn new class spells as they scale up.
        this._learnSpells();
      }
      return leveled;
    }

    _learnSpells() {
      const known = new Set(this.spells);
      for (const s of this.classData.spells) known.add(s);
      // Unlock a signature high-level spell for casters at level 5.
      if (this.level >= 5 && this.classData.caster === 'arcane' && !known.has('Fireball')) known.add('Fireball');
      if (this.level >= 5 && this.classData.caster === 'divine' && !known.has('Guiding Bolt')) known.add('Guiding Bolt');
      this.spells = Array.from(known);
    }

    fullHeal() {
      this.hp = this.maxHp;
      this.sp = this.maxSp;
      this.dead = false;
      this.status = {};
    }

    get alive() { return !this.dead && this.hp > 0; }
  }

  // ---- Generation ------------------------------------------------------
  function randomName(rng) {
    return rng.pick(BT.NAME_PARTS.prefix) + rng.pick(BT.NAME_PARTS.suffix);
  }

  // Assign rolled scores to favor the class' key abilities.
  function assignScores(rng, cls) {
    const scores = [rng.ability(), rng.ability(), rng.ability(), rng.ability(), rng.ability(), rng.ability()];
    scores.sort((a, b) => b - a); // high to low
    const prime = BT.CLASSES[cls].prime;
    // Priority order: prime, then CON, then the rest.
    const order = [prime, 'CON'];
    for (const a of BT.ABILITIES) if (!order.includes(a)) order.push(a);
    const abilities = {};
    order.forEach((stat, i) => { abilities[stat] = scores[i]; });
    return abilities;
  }

  function createCharacter(rng, opts) {
    opts = opts || {};
    const cls = opts.cls || rng.pick(Object.keys(BT.CLASSES));
    const race = opts.race || rng.pick(Object.keys(BT.RACES));
    const abilities = opts.abilities || assignScores(rng, cls);
    // Apply racial bonuses.
    const bonuses = BT.RACES[race].bonuses;
    for (const k in bonuses) abilities[k] = (abilities[k] || 10) + bonuses[k];

    const cd = BT.CLASSES[cls];
    const ch = new Character({
      name: opts.name || randomName(rng),
      race, cls, abilities,
      equip: { weapon: cd.startWeapon, armor: cd.startArmor, shield: !!cd.shield },
      spells: cd.spells.slice(),
      inventory: [],
      gold: 0
    });
    ch.recalcMaxes();
    ch.hp = ch.maxHp;
    ch.sp = ch.maxSp;
    return ch;
  }

  // A balanced starting party of 4: front-line, healer, arcane, flex.
  function createParty(rng, size) {
    size = size || 4;
    const template = ['Fighter', 'Cleric', 'Wizard', 'Bard', 'Rogue', 'Ranger'];
    const party = [];
    for (let i = 0; i < size; i++) {
      party.push(createCharacter(rng, { cls: template[i % template.length] }));
    }
    return party;
  }

  BT.Character = Character;
  BT.createCharacter = createCharacter;
  BT.createParty = createParty;
  BT.levelForXP = levelForXP;
  BT.XP_TABLE = XP_TABLE;
})(window.BT = window.BT || {});

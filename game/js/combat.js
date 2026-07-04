/* combat.js — turn-based party-vs-monsters combat.
 * The UI gathers one action per living hero, then calls resolveRound().
 */
(function (BT) {
  'use strict';

  function makeMonster(rng, def, idx) {
    return {
      def, idx,
      name: def.name,
      ac: def.ac,
      maxHp: Math.max(1, rng.dice(def.hp)),
      hp: 0,
      atk: def.atk,
      dmg: def.dmg,
      xp: def.xp,
      glyph: def.glyph,
      color: def.color,
      alive: true,
      status: {},
      boss: !!def.boss,
      spells: def.spells || [],
      special: {
        poison: def.poison, paralyze: def.paralyze, drain: def.drain,
        regen: def.regen, psychic: def.psychic
      }
    };
  }

  // Spawn a monster group appropriate to a dungeon depth.
  function spawnEncounter(rng, depth, forceBoss) {
    if (forceBoss) {
      const boss = makeMonster(rng, BT.BOSS, 0);
      boss.hp = boss.maxHp;
      // A couple of minions accompany the boss.
      const minionDef = rng.pick(BT.MONSTERS.filter(m => m.tier >= 4));
      const monsters = [boss];
      const n = rng.dice('1d3');
      for (let i = 0; i < n; i++) {
        const m = makeMonster(rng, minionDef, i + 1);
        m.hp = m.maxHp; monsters.push(m);
      }
      return monsters;
    }
    const eligible = BT.MONSTERS.filter(m => m.tier <= depth + 1 && m.tier >= Math.max(1, depth - 2));
    const def = rng.pick(eligible.length ? eligible : BT.MONSTERS.filter(m => m.tier <= depth + 1));
    const count = Math.max(1, rng.dice(def.count));
    const monsters = [];
    for (let i = 0; i < count; i++) {
      const m = makeMonster(rng, def, i);
      m.hp = m.maxHp;
      monsters.push(m);
    }
    // Sometimes mix in a second, weaker type.
    if (rng.chance(0.25) && depth >= 2) {
      const def2 = rng.pick(BT.MONSTERS.filter(m => m.tier <= depth));
      const c2 = Math.max(1, rng.dice(def2.count) - 1);
      for (let i = 0; i < c2; i++) {
        const m = makeMonster(rng, def2, monsters.length);
        m.hp = m.maxHp;
        monsters.push(m);
      }
    }
    // Label duplicates A/B/C for clarity.
    const counts = {};
    for (const m of monsters) counts[m.name] = (counts[m.name] || 0) + 1;
    const seen = {};
    for (const m of monsters) {
      if (counts[m.name] > 1) {
        seen[m.name] = (seen[m.name] || 0) + 1;
        m.name = m.def.name + ' ' + String.fromCharCode(64 + seen[m.name]);
      }
    }
    return monsters;
  }

  class Combat {
    constructor(party, monsters, rng, depth) {
      this.party = party;
      this.monsters = monsters;
      this.rng = rng;
      this.depth = depth;
      this.round = 0;
      this.log = [];
      this.over = false;
      this.result = null; // 'won' | 'lost' | 'fled'
      this.rewardXp = 0;
      this.rewardGold = 0;
    }

    _log(msg, cls) { this.log.push({ msg, cls: cls || '' }); }

    livingHeroes() { return this.party.filter(h => h.alive); }
    livingMonsters() { return this.monsters.filter(m => m.alive); }

    // d20 attack: returns {hit, crit, roll}
    _attackRoll(bonus, targetAc, adv) {
      let r1 = this.rng.int(1, 20);
      if (adv) { const r2 = this.rng.int(1, 20); r1 = Math.max(r1, r2); }
      const crit = r1 === 20;
      const total = r1 + bonus;
      return { hit: crit || (r1 !== 1 && total >= targetAc), crit, roll: r1, total };
    }

    // ---- Resolve one full round given the heroes' chosen actions. -------
    // actions: Map heroIndex -> {type, target, spell, item}
    resolveRound(actions) {
      if (this.over) return;
      this.round++;
      this._log('— Round ' + this.round + ' —', 'round');

      // Build initiative: each combatant rolls d20 + DEX/agility.
      const order = [];
      for (const h of this.livingHeroes()) {
        order.push({ side: 'hero', ref: h, init: this.rng.int(1, 20) + h.mod('DEX') });
      }
      for (const m of this.livingMonsters()) {
        order.push({ side: 'monster', ref: m, init: this.rng.int(1, 20) + 1 });
      }
      order.sort((a, b) => b.init - a.init);

      // Flee attempt is resolved first, before initiative.
      let fleeing = false;
      for (const [idx, act] of actions) {
        if (act && act.type === 'flee') fleeing = true;
      }
      if (fleeing) {
        const chance = 0.5 + 0.05 * this.livingHeroes().length;
        if (this.rng.chance(chance)) {
          this._log('The party breaks away and flees!', 'flee');
          this.over = true; this.result = 'fled';
          return;
        } else {
          this._log('The party fails to escape!', 'flee');
        }
      }

      for (const entry of order) {
        if (this.over) break;
        if (entry.side === 'hero') {
          const h = entry.ref;
          if (!h.alive) continue;
          if (h.status.sleep || h.status.paralyze) {
            this._log(h.name + ' is incapacitated!', 'bad');
            continue;
          }
          const heroIdx = this.party.indexOf(h);
          const act = actions.get(heroIdx) || { type: 'attack' };
          if (act.type === 'flee') continue; // already handled
          this._heroAction(h, act);
        } else {
          const m = entry.ref;
          if (!m.alive) continue;
          this._monsterAction(m);
        }
        this._checkEnd();
      }

      // End-of-round effects: poison, regen, status decay.
      this._endOfRound();
      this._checkEnd();
    }

    _heroAction(h, act) {
      switch (act.type) {
        case 'defend':
          h.status.defending = 1;
          this._log(h.name + ' takes a defensive stance.', 'buff');
          break;
        case 'cast':
          this._castSpell(h, act.spell, act.target);
          break;
        case 'item':
          this._useItem(h, act.item, act.target);
          break;
        case 'attack':
        default: {
          const target = (act.target && act.target.alive) ? act.target : this.rng.pick(this.livingMonsters());
          if (!target) return;
          this._heroAttack(h, target);
          break;
        }
      }
    }

    _heroAttack(h, target) {
      const w = h.weapon;
      const adv = !!h.status.mark;
      let ac = target.ac;
      const res = this._attackRoll(h.attackBonus + (h.status.bless ? this.rng.int(1, 4) : 0), ac, adv);
      if (!res.hit) {
        this._log(h.name + ' misses ' + target.name + '.', 'miss');
        return;
      }
      let dmg = this.rng.dice(w.dmg) + h.mod(h.attackStat);
      if (res.crit) dmg += this.rng.dice(w.dmg);
      if (h.cls === 'Rogue') dmg += this.rng.roll(Math.ceil(h.level / 2), 6); // sneak-ish
      if (h.status.mark) dmg += this.rng.int(1, 6);
      dmg = Math.max(1, dmg);
      this._damageMonster(target, dmg, h.name, res.crit, w.name);
    }

    _castSpell(h, spellName, target) {
      const sp = BT.SPELLS[spellName];
      if (!sp) return;
      if (h.sp < sp.cost) { this._log(h.name + ' lacks the energy to cast ' + spellName + '.', 'miss'); return; }
      h.sp -= sp.cost;
      switch (sp.kind) {
        case 'attack': {
          if (sp.target === 'all-enemies') {
            this._log(h.name + ' unleashes ' + spellName + '!', 'spell');
            for (const m of this.livingMonsters().slice()) {
              let dmg = this.rng.dice(sp.dmg);
              // DEX save halves.
              if (sp.save) { const save = this.rng.int(1, 20) + 2; if (save >= h.spellDC) dmg = Math.floor(dmg / 2); }
              this._damageMonster(m, Math.max(1, dmg), h.name, false, spellName, true);
            }
          } else {
            const t = (target && target.alive) ? target : this.rng.pick(this.livingMonsters());
            if (!t) return;
            let hit = true;
            if (!sp.always) {
              const res = this._attackRoll(h.spellAttack, t.ac, false);
              hit = res.hit;
            }
            if (!hit) { this._log(h.name + "'s " + spellName + ' fizzles against ' + t.name + '.', 'miss'); return; }
            let dmg = this.rng.dice(sp.dmg);
            this._log(h.name + ' casts ' + spellName + '!', 'spell');
            this._damageMonster(t, Math.max(1, dmg), h.name, false, spellName, true);
            if (sp.debuff === 'daze') t.status.daze = 1;
          }
          break;
        }
        case 'heal': {
          const t = (target && target.alive) ? target : h;
          const heal = this.rng.dice(sp.heal) + h.mod(h.spellStat);
          t.hp = Math.min(t.maxHp, t.hp + heal);
          this._log(h.name + ' heals ' + t.name + ' for ' + heal + ' HP.', 'heal');
          break;
        }
        case 'buff': {
          if (sp.effect === 'bless') {
            for (const a of this.livingHeroes()) a.status.bless = 3;
            this._log(h.name + ' blesses the party!', 'buff');
          } else if (sp.effect === 'shield') {
            h.status.shield = 2;
            this._log(h.name + ' conjures a shimmering shield.', 'buff');
          } else if (sp.effect === 'mark') {
            h.status.mark = 5;
            this._log(h.name + ' marks the quarry.', 'buff');
          }
          break;
        }
        case 'debuff': {
          const t = (target && target.alive) ? target : this.rng.pick(this.livingMonsters());
          if (!t) return;
          if (sp.effect === 'sleep') {
            // Sleep affects lower-HP foes.
            if (t.hp <= 22 && !t.boss) { t.status.sleep = 2; this._log(t.name + ' falls asleep!', 'spell'); }
            else this._log(t.name + ' resists the slumber.', 'miss');
          }
          break;
        }
      }
    }

    _useItem(h, itemName, target) {
      const c = BT.CONSUMABLES[itemName];
      if (!c) return;
      const inv = h.inventory;
      const i = inv.indexOf(itemName);
      if (i < 0) { this._log(h.name + ' has no ' + itemName + '.', 'miss'); return; }
      inv.splice(i, 1);
      const t = target || h;
      if (c.heal) { const g = this.rng.dice(c.heal); t.hp = Math.min(t.maxHp, t.hp + g); this._log(h.name + ' uses ' + itemName + ' — ' + t.name + ' recovers ' + g + ' HP.', 'heal'); }
      if (c.sp) { t.sp = Math.min(t.maxSp, t.sp + c.sp); this._log(t.name + ' recovers ' + c.sp + ' SP.', 'buff'); }
      if (c.revive && t.dead) { t.dead = false; t.hp = 1; this._log(t.name + ' is revived!', 'heal'); }
      if (c.cure === 'poison') { delete t.status.poison; this._log(t.name + ' is cured of poison.', 'buff'); }
    }

    _damageMonster(target, dmg, source, crit, weaponName, magic) {
      target.hp -= dmg;
      const how = crit ? ' CRITS ' : ' hits ';
      this._log(source + how + target.name + (magic ? '' : ' with ' + weaponName) + ' for ' + dmg + ' damage.', crit ? 'crit' : 'hit');
      if (target.hp <= 0) {
        target.alive = false;
        target.hp = 0;
        this._log(target.name + ' is slain!', 'kill');
      }
    }

    _monsterAction(m) {
      if (m.status.sleep) { this._log(m.name + ' slumbers.', 'good'); return; }
      if (m.status.daze && this.rng.chance(0.5)) { this._log(m.name + ' is dazed and falters.', 'good'); return; }
      // Boss / caster monsters sometimes cast.
      if (m.spells.length && this.rng.chance(0.4)) {
        const spellName = this.rng.pick(m.spells);
        const sp = BT.SPELLS[spellName];
        if (sp && sp.kind === 'attack') {
          this._log(m.name + ' invokes ' + spellName + '!', 'spell');
          if (sp.target === 'all-enemies') {
            for (const h of this.livingHeroes().slice()) this._hitHero(m, h, this.rng.dice(sp.dmg), spellName);
          } else {
            const h = this.rng.pick(this.livingHeroes());
            if (h) this._hitHero(m, h, this.rng.dice(sp.dmg), spellName);
          }
          return;
        }
      }
      const target = this.rng.pick(this.livingHeroes());
      if (!target) return;
      let ac = target.ac + (target.status.defending ? 2 : 0);
      const res = this._attackRoll(m.atk, ac, false);
      if (!res.hit) { this._log(m.name + ' misses ' + target.name + '.', 'miss'); return; }
      let dmg = this.rng.dice(m.dmg);
      if (res.crit) dmg += this.rng.dice(m.dmg);
      this._hitHero(m, target, dmg, null, res.crit);
    }

    _hitHero(m, target, dmg, spellName, crit) {
      dmg = Math.max(1, dmg);
      target.hp -= dmg;
      const via = spellName ? ' with ' + spellName : '';
      this._log(m.name + (crit ? ' CRITS ' : ' hits ') + target.name + via + ' for ' + dmg + ' damage.', crit ? 'crit-bad' : 'bad');
      // Monster special effects.
      if (m.special.poison && this.rng.chance(0.4)) { target.status.poison = 3; this._log(target.name + ' is poisoned!', 'bad'); }
      if (m.special.paralyze && this.rng.chance(0.3)) { target.status.paralyze = 1; this._log(target.name + ' is paralyzed!', 'bad'); }
      if (m.special.drain && this.rng.chance(0.5)) { m.hp = Math.min(m.maxHp, m.hp + Math.floor(dmg / 2)); this._log(m.name + ' drains life!', 'bad'); }
      if (target.hp <= 0) {
        target.hp = 0; target.dead = true;
        this._log(target.name + ' has fallen!', 'death');
      }
    }

    _endOfRound() {
      for (const h of this.party) {
        if (!h.alive) continue;
        if (h.status.poison) {
          const d = this.rng.int(1, 4);
          h.hp -= d;
          this._log(h.name + ' suffers ' + d + ' poison damage.', 'bad');
          if (h.hp <= 0) { h.hp = 0; h.dead = true; this._log(h.name + ' succumbs to poison!', 'death'); }
        }
        // Decay timed statuses.
        for (const k of ['defending', 'bless', 'shield', 'mark', 'poison', 'paralyze', 'daze']) {
          if (h.status[k]) { h.status[k]--; if (h.status[k] <= 0) delete h.status[k]; }
        }
      }
      for (const m of this.monsters) {
        if (!m.alive) continue;
        if (m.special.regen) { m.hp = Math.min(m.maxHp, m.hp + m.special.regen); }
        for (const k of ['sleep', 'daze']) {
          if (m.status[k]) { m.status[k]--; if (m.status[k] <= 0) delete m.status[k]; }
        }
      }
    }

    _checkEnd() {
      if (this.over) return;
      if (this.livingMonsters().length === 0) {
        this.over = true; this.result = 'won';
        this.rewardXp = this.monsters.reduce((s, m) => s + m.xp, 0);
        this.rewardGold = this.monsters.reduce((s, m) => s + Math.max(1, Math.floor(m.xp / 8)), 0) + this.rng.int(0, this.depth * 5);
        return;
      }
      if (this.livingHeroes().length === 0) {
        this.over = true; this.result = 'lost';
      }
    }
  }

  BT.Combat = Combat;
  BT.spawnEncounter = spawnEncounter;
})(window.BT = window.BT || {});

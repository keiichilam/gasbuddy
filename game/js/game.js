/* game.js — main controller: screens, town, dungeon navigation, combat UI. */
(function (BT) {
  'use strict';

  const DX = BT.DX, DY = BT.DY, OPP = BT.OPP;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  const LEVEL_COUNT = 5;

  const G = {
    seed: null, rng: null, dungeon: null, levels: null,
    li: 0, px: 0, py: 0, dir: 1,
    party: null, renderer: null,
    combat: null, turnQueue: [], actions: null,
    awaiting: null, // {kind:'enemy'|'ally', heroIdx, action, spell, item}
    victoryPending: false
  };
  BT.G = G;

  // ================================================================
  // Screen management
  // ================================================================
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  // ================================================================
  // Title → party creation
  // ================================================================
  function initTitle() {
    $('btn-new').addEventListener('click', () => {
      const raw = $('seed-input').value.trim();
      G.seed = raw || ('' + Math.floor(Math.random() * 1e9));
      G.rng = new BT.RNG(G.seed);
      G.party = BT.createParty(G.rng, 4);
      renderRoster();
      showScreen('screen-create');
    });
    $('btn-restart').addEventListener('click', () => showScreen('screen-title'));
  }

  function renderRoster() {
    const wrap = $('roster');
    wrap.innerHTML = '';
    G.party.forEach((h, i) => wrap.appendChild(heroCard(h, i)));
  }

  function heroCard(h, i) {
    const card = el('div', 'hero-card');
    card.innerHTML =
      '<h3>' + h.name + '</h3>' +
      '<div class="cls">' + h.classData.name + '</div>' +
      '<div class="race">' + h.raceData.name + ' · ' + h.raceData.trait + '</div>' +
      '<div class="stat-grid">' + BT.ABILITIES.map(a => {
        const v = h.abilities[a], m = BT.abilityMod(v);
        return '<div class="stat"><b>' + a + '</b><span>' + v + ' <small>' + (m >= 0 ? '+' : '') + m + '</small></span></div>';
      }).join('') + '</div>' +
      '<div class="hero-meta">' +
        '<span class="hp">♥ ' + h.maxHp + ' HP</span>' +
        '<span class="ac">⛊ AC ' + h.ac + '</span>' +
        (h.maxSp ? '<span class="sp">✦ ' + h.maxSp + ' SP</span>' : '') +
        '<span>⚔ ' + h.weapon.name + '</span>' +
      '</div>';
    const rb = el('button', 'reroll-btn', 'reroll');
    rb.addEventListener('click', () => {
      G.party[i] = BT.createCharacter(G.rng, { cls: h.cls });
      renderRoster();
    });
    card.appendChild(rb);
    return card;
  }

  function initCreate() {
    $('btn-reroll-all').addEventListener('click', () => {
      G.party = BT.createParty(G.rng, 4);
      renderRoster();
    });
    $('btn-begin').addEventListener('click', () => {
      buildDungeon();
      enterTown();
    });
  }

  function buildDungeon() {
    const d = BT.generateDungeon(G.seed, LEVEL_COUNT);
    G.dungeon = d;
    G.levels = d.levels;
    G.li = 0;
    // Give each hero a couple of starting potions and some gold.
    G.party.forEach(h => {
      h.gold = 40 + G.rng.int(0, 30);
      h.inventory = ['Healing Potion', 'Healing Potion'];
    });
  }

  // ================================================================
  // Town hub
  // ================================================================
  function enterTown() {
    showScreen('screen-town');
    renderTownParty();
  }

  function partyGold() { return G.party.reduce((s, h) => s + h.gold, 0); }
  function spendGold(amount) {
    // Spend from richest first.
    let left = amount;
    const sorted = G.party.slice().sort((a, b) => b.gold - a.gold);
    for (const h of sorted) {
      const take = Math.min(h.gold, left);
      h.gold -= take; left -= take;
      if (left <= 0) break;
    }
  }

  function renderTownParty() {
    const strip = $('town-party');
    strip.innerHTML = '<div class="gold-line">Party gold: ' + partyGold() + ' 🪙</div>';
    strip.appendChild(hudColumn(G.party, null, false));
  }

  function initTown() {
    document.querySelectorAll('.town-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const w = tile.dataset.town;
        if (w === 'dungeon') enterDungeon();
        else if (w === 'temple') openTemple();
        else if (w === 'shop') openShop();
        else if (w === 'guild') openGuild();
      });
    });
  }

  // ---- Modal helper ----
  function openModal(html) {
    $('modal-body').innerHTML = '';
    if (typeof html === 'string') $('modal-body').innerHTML = html;
    else $('modal-body').appendChild(html);
    $('modal').classList.add('open');
  }
  function closeModal() { $('modal').classList.remove('open'); }

  function initModal() {
    $('modal-close').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  }

  // ---- Temple ----
  function openTemple() {
    const body = el('div');
    const wounded = G.party.filter(h => h.hp < h.maxHp || h.sp < h.maxSp || h.dead);
    const healCost = G.party.reduce((s, h) => s + (h.dead ? 100 : (h.maxHp - h.hp) + Math.max(0, h.maxSp - h.sp)), 0);
    body.innerHTML = '<h3>⛪ Temple of Light</h3>' +
      '<p class="muted">The priests restore body and spirit — for a donation.</p>' +
      '<p class="gold-line">Party gold: ' + partyGold() + ' 🪙</p>';
    const cost = Math.max(0, Math.round(healCost * 1.5));
    const btn = el('button', 'btn btn-primary', wounded.length ? ('Full heal &amp; revive — ' + cost + ' 🪙') : 'The party is already hale');
    btn.disabled = !wounded.length || partyGold() < cost;
    btn.addEventListener('click', () => {
      spendGold(cost);
      G.party.forEach(h => h.fullHeal());
      renderTownParty();
      openTemple();
    });
    body.appendChild(btn);
    if (wounded.length && partyGold() < cost) {
      body.appendChild(el('p', 'muted', 'Not enough gold for a full blessing.'));
    }
    openModal(body);
  }

  // ---- Shop ----
  function openShop() {
    const body = el('div');
    body.innerHTML = '<h3>🛒 Garth\'s Supplies</h3><p class="gold-line" id="shop-gold">Party gold: ' + partyGold() + ' 🪙</p>';
    const list = el('div', 'shop-list');

    const stock = []
      .concat(Object.values(BT.CONSUMABLES).map(c => ({ type: 'consumable', name: c.name, cost: c.cost, desc: c.desc })))
      .concat(['Studded Leather', 'Chain Shirt', 'Chain Mail', 'Plate Armor'].map(n => ({ type: 'armor', name: n, cost: BT.ARMOR[n].cost, desc: 'AC ' + BT.ARMOR[n].ac + ' · ' + BT.ARMOR[n].type })))
      .concat(['Rapier', 'Longsword', 'Battleaxe', 'Greataxe', 'Warhammer', 'Longbow'].map(n => ({ type: 'weapon', name: n, cost: BT.WEAPONS[n].cost, desc: 'Dmg ' + BT.WEAPONS[n].dmg })));

    stock.forEach(item => {
      const row = el('div', 'shop-row');
      row.innerHTML = '<div class="info">' + item.name + '<small>' + item.desc + '</small></div>' +
        '<div class="price">' + item.cost + ' 🪙</div>';
      const buy = el('button', 'btn small', 'Buy');
      buy.addEventListener('click', () => buyItem(item));
      row.appendChild(buy);
      list.appendChild(row);
    });
    body.appendChild(list);
    body.appendChild(el('p', 'muted', 'Consumables go to the first hero; gear opens a "who equips?" prompt.'));
    openModal(body);
  }

  function buyItem(item) {
    if (partyGold() < item.cost) { flash('Not enough gold.'); return; }
    if (item.type === 'consumable') {
      spendGold(item.cost);
      G.party[0].inventory.push(item.name);
      $('shop-gold').textContent = 'Party gold: ' + partyGold() + ' 🪙';
      flash(G.party[0].name + ' bought ' + item.name + '.');
    } else {
      // Choose which hero equips it.
      const pick = el('div');
      pick.innerHTML = '<h3>Equip ' + item.name + '</h3><p class="muted">Who takes it?</p>';
      const row = el('div', 'pick-hero');
      G.party.forEach(h => {
        const b = el('button', 'btn small', h.name);
        b.addEventListener('click', () => {
          spendGold(item.cost);
          if (item.type === 'armor') h.equip.armor = item.name;
          else h.equip.weapon = item.name;
          flash(h.name + ' equips ' + item.name + '.');
          openShop();
        });
        row.appendChild(b);
      });
      pick.appendChild(row);
      openModal(pick);
    }
  }

  function flash(msg) {
    const note = $('cell-note');
    // Reuse a small toast via modal footer if modal open; otherwise cell note.
    if ($('modal').classList.contains('open')) {
      let toast = $('modal-toast');
      if (!toast) { toast = el('p', 'gold-line'); toast.id = 'modal-toast'; $('modal-body').appendChild(toast); }
      toast.textContent = msg;
    } else {
      showCellNote(msg);
    }
  }

  // ---- Guild (inspect party) ----
  function openGuild() {
    const body = el('div');
    body.innerHTML = '<h3>🛡️ Adventurer\'s Guild</h3>';
    G.party.forEach(h => {
      const d = el('div', 'hud-card');
      d.style.marginBottom = '8px';
      d.innerHTML =
        '<div class="hud-top"><span class="nm">' + h.name + '</span><span class="lv">' + h.classData.name + ' Lv ' + h.level + '</span></div>' +
        '<div class="muted" style="font-size:.75rem">XP ' + h.xp + ' · AC ' + h.ac + ' · ' + h.weapon.name + ' · ' + BT.ARMOR[h.equip.armor].name + (h.equip.shield ? ' + Shield' : '') + '</div>' +
        '<div class="muted" style="font-size:.72rem;margin-top:3px">' + BT.ABILITIES.map(a => a + ' ' + h.abilities[a]).join(' · ') + '</div>' +
        (h.spells.length ? '<div class="muted" style="font-size:.72rem;margin-top:3px">Spells: ' + h.spells.join(', ') + '</div>' : '') +
        (h.inventory.length ? '<div class="muted" style="font-size:.72rem;margin-top:3px">Bag: ' + h.inventory.join(', ') + '</div>' : '') +
        '<div class="gold-line" style="font-size:.75rem">' + h.gold + ' 🪙</div>';
      body.appendChild(d);
    });
    openModal(body);
  }

  // ================================================================
  // HUD rendering (party cards with bars)
  // ================================================================
  function hudColumn(party, activeIndex, combat) {
    const col = el('div', 'party-hud');
    col.style.flex = '1';
    party.forEach((h, i) => col.appendChild(hudCard(h, i, activeIndex, combat)));
    return col;
  }

  function hudCard(h, i, activeIndex, combat) {
    const card = el('div', 'hud-card' + (h.alive ? '' : ' dead') + (activeIndex === i ? ' active-turn' : ''));
    card.dataset.hero = i;
    const hpPct = Math.max(0, (h.hp / h.maxHp) * 100);
    let inner =
      '<div class="hud-top"><span class="nm">' + h.name + (h.dead ? ' 💀' : '') + '</span>' +
      '<span class="lv">' + h.classData.name.slice(0, 3) + ' L' + h.level + '</span></div>' +
      '<div class="bar hp"><span style="width:' + hpPct + '%"></span></div>' +
      '<div class="bar-label"><span>HP</span><span>' + h.hp + '/' + h.maxHp + '</span></div>';
    if (h.maxSp) {
      const spPct = Math.max(0, (h.sp / h.maxSp) * 100);
      inner += '<div class="bar sp"><span style="width:' + spPct + '%"></span></div>' +
        '<div class="bar-label"><span>SP</span><span>' + h.sp + '/' + h.maxSp + '</span></div>';
    }
    const tags = [];
    for (const k in h.status) if (h.status[k]) tags.push(k);
    if (tags.length) {
      inner += '<div class="status-tags">' + tags.map(t => {
        const bad = ['poison', 'paralyze', 'sleep', 'daze'].includes(t);
        return '<span class="tag ' + (bad ? 'bad' : 'good') + '">' + t + '</span>';
      }).join('') + '</div>';
    }
    card.innerHTML = inner;
    return card;
  }

  // ================================================================
  // Dungeon
  // ================================================================
  function curLevel() { return G.levels[G.li]; }

  function enterDungeon() {
    const lvl = curLevel();
    if (G.px === 0 && G.py === 0 && G.dir === 1 && !lvl.cell(0, 0).visited) {
      // First entry: start position.
    }
    G.px = lvl.start.x; G.py = lvl.start.y; G.dir = 1;
    if (!G.renderer) G.renderer = new BT.Renderer($('view3d'));
    showScreen('screen-dungeon');
    logClear();
    logMsg('You enter level ' + lvl.depth + ' of the Deeps.', 'round');
    onEnterCell(true);
    renderDungeon();
  }

  function renderDungeon() {
    const lvl = curLevel();
    lvl.cell(G.px, G.py).visited = true;
    G.renderer.render(lvl, G.px, G.py, G.dir);
    BT.drawAutomap($('automap'), lvl, G.px, G.py, G.dir, false);
    $('depth-badge').textContent = 'Level ' + lvl.depth + '  ·  ' + posLabel();
    const hud = $('party-hud');
    hud.innerHTML = '';
    G.party.forEach((h, i) => hud.appendChild(hudCard(h, i)));
  }

  function posLabel() {
    return '(' + G.px + ',' + G.py + ') facing ' + BT.DIR_NAME[G.dir];
  }

  function move(kind) {
    if (!$('screen-dungeon').classList.contains('active')) return;
    if (kind === 'left') { G.dir = (G.dir + 3) % 4; renderDungeon(); return; }
    if (kind === 'right') { G.dir = (G.dir + 1) % 4; renderDungeon(); return; }
    const dir = kind === 'back' ? OPP[G.dir] : G.dir;
    const lvl = curLevel();
    if (!lvl.canMove(G.px, G.py, dir)) { bump(); return; }
    G.px += DX[dir]; G.py += DY[dir];
    renderDungeon();
    onEnterCell(false);
  }

  function bump() {
    showCellNote('A stone wall blocks the way.');
  }

  function onEnterCell(firstEntry) {
    const lvl = curLevel();
    const c = lvl.cell(G.px, G.py);
    c.visited = true;

    // Auto-spring traps.
    if (c.feature === 'trap' && c.data && !c.data.sprung) {
      c.data.sprung = true;
      const victim = G.rng.pick(G.party.filter(h => h.alive)) || G.party[0];
      const dmg = G.rng.roll(c.data.dmg, 6);
      victim.hp = Math.max(0, victim.hp - dmg);
      if (victim.hp === 0) { victim.dead = true; }
      logMsg('⚠ A trap springs! ' + victim.name + ' takes ' + dmg + ' damage.', 'bad');
      showCellNote('A hidden trap! ' + victim.name + ' is hurt.');
      renderDungeon();
      if (checkWipe()) return;
    }

    // Feature notes / prompts.
    const notes = {
      stairsDown: 'Stairs spiral downward. Press Use to descend.',
      stairsUp: 'Stairs lead up. Press Use to ascend.',
      chest: c.data && c.data.opened ? '' : 'A treasure chest sits here. Press Use to open.',
      fountain: c.data && c.data.used ? 'The fountain is dry.' : 'A glowing fountain bubbles. Press Use to drink.',
      artifact: 'A blade glows on an altar, guarded by a dread presence. Press Use.',
      message: 'Ancient writing covers the wall. Press Use to read.'
    };
    if (c.feature && notes[c.feature]) showCellNote(notes[c.feature]);

    // Random encounter (not on first entry / on stairs).
    if (!firstEntry && !c.feature && G.rng.chance(c.encounter)) {
      startCombat(BT.spawnEncounter(G.rng, lvl.depth, false));
    }
  }

  function interact() {
    if (!$('screen-dungeon').classList.contains('active')) return;
    const lvl = curLevel();
    const c = lvl.cell(G.px, G.py);
    if (!c.feature) { showCellNote('You search but find nothing of note.'); return; }
    switch (c.feature) {
      case 'stairsDown': descend(); break;
      case 'stairsUp': ascend(); break;
      case 'chest': openChest(c); break;
      case 'fountain': drinkFountain(c); break;
      case 'message': readMessage(c); break;
      case 'artifact': startArtifactBattle(c); break;
      default: showCellNote('Nothing happens.');
    }
  }

  function descend() {
    if (G.li >= G.levels.length - 1) { showCellNote('These are the deepest stairs.'); return; }
    G.li++;
    const lvl = curLevel();
    G.px = lvl.start.x; G.py = lvl.start.y;
    logMsg('You descend to level ' + lvl.depth + '.', 'round');
    onEnterCell(true);
    renderDungeon();
  }

  function ascend() {
    if (G.li === 0) {
      logMsg('You climb back to the surface.', 'round');
      enterTown();
      return;
    }
    G.li--;
    const lvl = curLevel();
    // Land on the downstairs of the level above.
    const s = lvl.stairsDown || lvl.start;
    G.px = s.x; G.py = s.y;
    logMsg('You ascend to level ' + lvl.depth + '.', 'round');
    onEnterCell(true);
    renderDungeon();
  }

  function openChest(c) {
    if (c.data.opened) { showCellNote('The chest is empty.'); return; }
    c.data.opened = true;
    const tier = c.data.tier;
    const gold = G.rng.roll(tier + 1, 20) + tier * 10;
    G.party[G.rng.int(0, G.party.length - 1)].gold += gold;
    let msg = 'You loot ' + gold + ' gold';
    // Chance of an item.
    if (G.rng.chance(0.5)) {
      const item = G.rng.pick(['Healing Potion', 'Greater Healing', 'Mana Draught', 'Scroll of Revive']);
      G.party[0].inventory.push(item);
      msg += ' and a ' + item;
    }
    // Rare gear on deeper levels.
    if (tier >= 3 && G.rng.chance(0.3)) {
      const gear = G.rng.pick(['Flame Tongue', 'Plate Armor', 'Vorpal Blade']);
      if (BT.WEAPONS[gear]) { G.party[0].equip.weapon = gear; msg += ' — and ' + G.party[0].name + ' claims the ' + gear + '!'; }
      else { G.party[0].equip.armor = gear; msg += ' — and ' + G.party[0].name + ' dons ' + gear + '!'; }
    }
    msg += '.';
    logMsg('💰 ' + msg, 'loot');
    showCellNote(msg);
    // A chest may be trapped or guarded.
    if (G.rng.chance(0.25)) {
      logMsg('The chest was guarded!', 'bad');
      startCombat(BT.spawnEncounter(G.rng, curLevel().depth, false));
    } else {
      renderDungeon();
    }
  }

  function drinkFountain(c) {
    if (c.data.used) { showCellNote('The fountain has run dry.'); return; }
    c.data.used = true;
    G.party.forEach(h => { if (h.alive) { h.hp = h.maxHp; h.sp = h.maxSp; } });
    logMsg('✨ The fountain restores the party to full vigor!', 'heal');
    showCellNote('Restorative waters! The party is fully healed.');
    renderDungeon();
  }

  function readMessage(c) {
    showCellNote(c.data.text);
    if (!c.data.read) { c.data.read = true; logMsg('📜 ' + c.data.text, 'buff'); }
  }

  function startArtifactBattle(c) {
    if (c.data.cleared) { showCellNote('The altar is empty; the Sword is yours.'); return; }
    logMsg('Mangar the Dark rises to defend the Sword of Zar!', 'death');
    G.victoryPending = true;
    G.artifactCell = c;
    startCombat(BT.spawnEncounter(G.rng, curLevel().depth, true));
  }

  function rest() {
    if (!$('screen-dungeon').classList.contains('active')) return;
    // Camp: heal ~30% and some SP, but risk an ambush.
    G.party.forEach(h => {
      if (!h.alive) return;
      h.hp = Math.min(h.maxHp, h.hp + Math.ceil(h.maxHp * 0.30));
      h.sp = Math.min(h.maxSp, h.sp + Math.ceil(h.maxSp * 0.4));
    });
    logMsg('The party makes camp and tends their wounds.', 'heal');
    renderDungeon();
    if (G.rng.chance(0.30)) {
      logMsg('Something stirs in the dark — ambush!', 'bad');
      startCombat(BT.spawnEncounter(G.rng, curLevel().depth, false));
    } else {
      showCellNote('You rest, undisturbed.');
    }
  }

  function checkWipe() {
    if (G.party.every(h => !h.alive)) { gameOver(); return true; }
    return false;
  }

  // ---- Cell note toast ----
  let noteTimer = null;
  function showCellNote(text) {
    const n = $('cell-note');
    if (!text) { n.classList.remove('show'); return; }
    n.textContent = text;
    n.classList.add('show');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => n.classList.remove('show'), 3200);
  }

  function initDungeonControls() {
    document.querySelectorAll('.pad').forEach(p => p.addEventListener('click', () => move(p.dataset.move)));
    document.querySelectorAll('#screen-dungeon [data-action]').forEach(b => {
      b.addEventListener('click', () => {
        const a = b.dataset.action;
        if (a === 'use') interact();
        else if (a === 'rest') rest();
        else if (a === 'town') enterTown();
      });
    });
  }

  // ================================================================
  // Combat
  // ================================================================
  function startCombat(monsters) {
    G.combat = new BT.Combat(G.party, monsters, G.rng, curLevel().depth);
    showScreen('screen-combat');
    $('combat-log').innerHTML = '';
    const names = summarizeFoes(monsters);
    combatLog('You are ambushed by ' + names + '!', 'round');
    renderCombat();
    beginRound();
  }

  function summarizeFoes(monsters) {
    const counts = {};
    monsters.forEach(m => { const base = m.def.name; counts[base] = (counts[base] || 0) + 1; });
    return Object.entries(counts).map(([n, c]) => (c > 1 ? c + ' ' + n + 's' : 'a ' + n)).join(', ');
  }

  function renderCombat(activeIndex) {
    // Enemies.
    const list = $('enemy-list');
    list.innerHTML = '';
    G.combat.monsters.forEach(m => {
      const e = el('div', 'enemy' + (m.alive ? '' : ' dead') + (m.boss ? ' boss' : ''));
      const pct = Math.max(0, (m.hp / m.maxHp) * 100);
      e.innerHTML = '<div class="glyph">' + m.glyph + '</div>' +
        '<div class="en-name">' + m.name + '</div>' +
        '<div class="bar hp" style="margin-top:4px"><span style="width:' + pct + '%"></span></div>' +
        '<div class="en-hp">' + (m.alive ? m.hp + '/' + m.maxHp + ' HP' : 'slain') + '</div>';
      e.dataset.mi = m.idx;
      e._mon = m;
      if (G.awaiting && G.awaiting.kind === 'enemy' && m.alive) {
        e.classList.add('selectable');
        e.addEventListener('click', () => chooseEnemyTarget(m));
      }
      list.appendChild(e);
    });
    // Party.
    const cp = $('combat-party');
    cp.innerHTML = '';
    G.party.forEach((h, i) => {
      const card = hudCard(h, i, activeIndex);
      if (G.awaiting && G.awaiting.kind === 'ally' && h.alive) {
        card.classList.add('active-turn');
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => chooseAllyTarget(h));
      }
      cp.appendChild(card);
    });
  }

  function beginRound() {
    G.actions = new Map();
    G.turnQueue = G.party.map((h, i) => i).filter(i => G.party[i].alive);
    G.awaiting = null;
    promptNextHero();
  }

  function promptNextHero() {
    renderCombat();
    if (G.turnQueue.length === 0) { resolveRound(); return; }
    const idx = G.turnQueue[0];
    const h = G.party[idx];
    if (!h.alive) { G.turnQueue.shift(); promptNextHero(); return; }
    renderCombat(idx);
    $('combat-prompt').textContent = 'Choose an action for ' + h.name + ' (' + h.classData.name + ')';
    const acts = $('combat-actions');
    acts.innerHTML = '';

    addActionBtn(acts, '⚔ Attack', () => beginTargeting(idx, { type: 'attack' }));
    if (h.isCaster && h.spells.length && h.sp > 0) {
      addActionBtn(acts, '✦ Cast', () => showSpellMenu(idx));
    }
    if (h.inventory.length) {
      addActionBtn(acts, '🧪 Item', () => showItemMenu(idx));
    }
    addActionBtn(acts, '🛡 Defend', () => { setAction(idx, { type: 'defend' }); });
    addActionBtn(acts, '🏃 Flee', () => { setAction(idx, { type: 'flee' }); });
    // Convenience.
    const auto = el('button', 'btn small', '⚡ Auto-attack rest');
    auto.addEventListener('click', autoResolve);
    acts.appendChild(auto);
  }

  function addActionBtn(container, label, fn) {
    const b = el('button', 'btn small', label);
    b.addEventListener('click', fn);
    container.appendChild(b);
  }

  function beginTargeting(idx, action) {
    const alive = G.combat.livingMonsters();
    if (alive.length === 1) { setAction(idx, Object.assign({}, action, { target: alive[0] })); return; }
    G.awaiting = { kind: 'enemy', heroIdx: idx, action };
    $('combat-prompt').textContent = 'Select a target…';
    renderCombat(idx);
  }

  function chooseEnemyTarget(m) {
    if (!G.awaiting) return;
    const { heroIdx, action } = G.awaiting;
    G.awaiting = null;
    setAction(heroIdx, Object.assign({}, action, { target: m }));
  }

  function chooseAllyTarget(h) {
    if (!G.awaiting) return;
    const { heroIdx, action } = G.awaiting;
    G.awaiting = null;
    setAction(heroIdx, Object.assign({}, action, { target: h }));
  }

  function showSpellMenu(idx) {
    const h = G.party[idx];
    const acts = $('combat-actions');
    acts.innerHTML = '';
    h.spells.forEach(name => {
      const sp = BT.SPELLS[name];
      const b = el('button', 'btn small', name + ' (' + sp.cost + ')');
      b.disabled = h.sp < sp.cost;
      b.title = sp.desc;
      b.addEventListener('click', () => selectSpell(idx, name));
      acts.appendChild(b);
    });
    const back = el('button', 'btn small', '← Back');
    back.addEventListener('click', () => promptNextHero());
    acts.appendChild(back);
  }

  function selectSpell(idx, name) {
    const sp = BT.SPELLS[name];
    const action = { type: 'cast', spell: name };
    if (sp.target === 'enemy') { beginTargeting(idx, action); }
    else if (sp.target === 'all-enemies' || sp.target === 'party' || sp.target === 'self') { setAction(idx, action); }
    else if (sp.target === 'ally') {
      const alive = G.party.filter(h => h.alive);
      if (alive.length === 1) { setAction(idx, Object.assign(action, { target: alive[0] })); return; }
      G.awaiting = { kind: 'ally', heroIdx: idx, action };
      $('combat-prompt').textContent = 'Select an ally to target…';
      renderCombat(idx);
    }
  }

  function showItemMenu(idx) {
    const h = G.party[idx];
    const acts = $('combat-actions');
    acts.innerHTML = '';
    const counts = {};
    h.inventory.forEach(n => counts[n] = (counts[n] || 0) + 1);
    Object.entries(counts).forEach(([name, c]) => {
      const b = el('button', 'btn small', name + ' ×' + c);
      b.addEventListener('click', () => selectItem(idx, name));
      acts.appendChild(b);
    });
    const back = el('button', 'btn small', '← Back');
    back.addEventListener('click', () => promptNextHero());
    acts.appendChild(back);
  }

  function selectItem(idx, name) {
    const c = BT.CONSUMABLES[name];
    const action = { type: 'item', item: name };
    if (c.heal || c.sp || c.revive || c.cure) {
      // Target an ally.
      const alive = G.party.filter(h => h.alive || (c.revive && h.dead));
      if (alive.length === 1) { setAction(idx, Object.assign(action, { target: alive[0] })); return; }
      G.awaiting = { kind: 'ally', heroIdx: idx, action };
      $('combat-prompt').textContent = 'Use ' + name + ' on whom?';
      // Allow targeting dead heroes for revive.
      renderCombatAllowDead(idx, !!c.revive);
    } else {
      setAction(idx, action);
    }
  }

  function renderCombatAllowDead(idx, allowDead) {
    renderCombat(idx);
    if (allowDead) {
      const cp = $('combat-party');
      cp.querySelectorAll('.hud-card').forEach(card => {
        const i = +card.dataset.hero;
        const h = G.party[i];
        if (h.dead) {
          card.classList.add('active-turn');
          card.style.cursor = 'pointer';
          card.addEventListener('click', () => chooseAllyTarget(h));
        }
      });
    }
  }

  function setAction(idx, action) {
    G.actions.set(idx, action);
    G.awaiting = null;
    G.turnQueue.shift();
    promptNextHero();
  }

  function autoResolve() {
    // Fill remaining heroes with attack on a random living foe.
    for (const idx of G.turnQueue) {
      const target = G.rng.pick(G.combat.livingMonsters());
      G.actions.set(idx, { type: 'attack', target });
    }
    G.turnQueue = [];
    G.awaiting = null;
    resolveRound();
  }

  function resolveRound() {
    $('combat-prompt').textContent = 'Resolving…';
    $('combat-actions').innerHTML = '';
    const before = G.combat.log.length;
    G.combat.resolveRound(G.actions);
    // Append new log lines.
    for (let i = before; i < G.combat.log.length; i++) {
      const e = G.combat.log[i];
      combatLog(e.msg, e.cls);
    }
    renderCombat();
    if (G.combat.over) { setTimeout(endCombat, 350); return; }
    setTimeout(beginRound, 250);
  }

  function endCombat() {
    const c = G.combat;
    if (c.result === 'won') {
      const per = Math.ceil(c.rewardXp / Math.max(1, G.party.filter(h => h.alive).length));
      combatLog('Victory! The party earns ' + c.rewardXp + ' XP and ' + c.rewardGold + ' gold.', 'loot');
      let leveled = [];
      G.party.forEach(h => { if (h.alive) { if (h.addXP(per)) leveled.push(h.name); } });
      G.party[0].gold += c.rewardGold;
      if (leveled.length) combatLog('⤴ Level up: ' + leveled.join(', ') + '!', 'good');

      if (G.victoryPending) {
        setTimeout(victory, 500);
        return;
      }
      setTimeout(() => { showScreen('screen-dungeon'); renderDungeon(); }, 900);
    } else if (c.result === 'fled') {
      combatLog('You escape back into the maze.', 'flee');
      setTimeout(() => { showScreen('screen-dungeon'); renderDungeon(); }, 700);
    } else {
      setTimeout(gameOver, 700);
    }
    G.victoryPending = false;
  }

  function combatLog(msg, cls) { logTo('combat-log', msg, cls); }

  // ================================================================
  // End states
  // ================================================================
  function gameOver() {
    showScreen('screen-end');
    $('end-title').textContent = '☠ The Party Has Fallen';
    $('end-text').innerHTML = 'Your heroes lie dead in the Deeps of Zar. The darkness endures… ' +
      'Seed: <b>' + G.seed + '</b>';
  }

  function victory() {
    if (G.artifactCell) { G.artifactCell.data.cleared = true; }
    showScreen('screen-end');
    $('end-title').textContent = '👑 The Sword of Zar is Reclaimed!';
    $('end-text').innerHTML = 'Mangar the Dark is destroyed and ' + BT.ARTIFACT.name +
      ' blazes in your hands. Light returns to Skara Brae. You are legends. ' +
      '<br><br>Seed: <b>' + G.seed + '</b> · Party level: ' +
      Math.max.apply(null, G.party.map(h => h.level));
  }

  // ================================================================
  // Logging
  // ================================================================
  function logTo(id, msg, cls) {
    const box = $(id);
    const p = el('p', cls || '', msg);
    box.appendChild(p);
    box.scrollTop = box.scrollHeight;
  }
  function logMsg(msg, cls) { logTo('log', msg, cls); }
  function logClear() { $('log').innerHTML = ''; }

  // ================================================================
  // Keyboard
  // ================================================================
  function initKeyboard() {
    window.addEventListener('keydown', (e) => {
      if ($('modal').classList.contains('open')) {
        if (e.key === 'Escape') closeModal();
        return;
      }
      if ($('screen-dungeon').classList.contains('active')) {
        const k = e.key.toLowerCase();
        if (k === 'w' || e.key === 'ArrowUp') { move('forward'); e.preventDefault(); }
        else if (k === 's' || e.key === 'ArrowDown') { move('back'); e.preventDefault(); }
        else if (k === 'a' || e.key === 'ArrowLeft') { move('left'); e.preventDefault(); }
        else if (k === 'd' || e.key === 'ArrowRight') { move('right'); e.preventDefault(); }
        else if (k === 'e' || k === ' ') { interact(); e.preventDefault(); }
        else if (k === 'r') { rest(); }
      }
    });
  }

  // ================================================================
  // Boot
  // ================================================================
  function boot() {
    initTitle();
    initCreate();
    initTown();
    initModal();
    initDungeonControls();
    initKeyboard();
    window.addEventListener('resize', () => {
      if ($('screen-dungeon').classList.contains('active')) renderDungeon();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.BT = window.BT || {});

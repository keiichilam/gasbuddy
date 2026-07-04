/* data.js — D&D-flavored content tables: races, classes, monsters, items, spells.
 * Uses SRD-inspired stats; simplified for an arcade dungeon crawler.
 */
(function (BT) {
  'use strict';

  // ---- Ability helpers -------------------------------------------------
  BT.ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  BT.abilityMod = function (score) { return Math.floor((score - 10) / 2); };

  // ---- Races -----------------------------------------------------------
  BT.RACES = {
    Human:     { name: 'Human',     bonuses: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 }, trait: 'Versatile' },
    Elf:       { name: 'Elf',       bonuses: { DEX: 2, INT: 1 },         trait: 'Keen Sight' },
    Dwarf:     { name: 'Dwarf',     bonuses: { CON: 2, STR: 1 },         trait: 'Stout' },
    Halfling:  { name: 'Halfling',  bonuses: { DEX: 2, CHA: 1 },         trait: 'Lucky' },
    HalfOrc:   { name: 'Half-Orc',  bonuses: { STR: 2, CON: 1 },         trait: 'Savage' },
    Gnome:     { name: 'Gnome',     bonuses: { INT: 2, DEX: 1 },         trait: 'Cunning' },
    HalfElf:   { name: 'Half-Elf',  bonuses: { CHA: 2, DEX: 1, CON: 1 }, trait: 'Charming' },
    Dragonborn:{ name: 'Dragonborn',bonuses: { STR: 2, CHA: 1 },         trait: 'Breath Weapon' }
  };

  // ---- Classes ---------------------------------------------------------
  // hitDie: sides for HP per level. prime: main stat. caster: 'arcane'|'divine'|null.
  BT.CLASSES = {
    Fighter: { name: 'Fighter', hitDie: 10, prime: 'STR', caster: null,
      startWeapon: 'Longsword', startArmor: 'Chain Mail', shield: true,
      spells: [], desc: 'Master of weapons and armor. Front-line bruiser.' },
    Paladin: { name: 'Paladin', hitDie: 10, prime: 'STR', caster: 'divine',
      startWeapon: 'Longsword', startArmor: 'Chain Mail', shield: true,
      spells: ['Cure Wounds', 'Bless'], desc: 'Holy warrior who smites foes and mends allies.' },
    Ranger:  { name: 'Ranger',  hitDie: 10, prime: 'DEX', caster: 'divine',
      startWeapon: 'Longbow', startArmor: 'Leather Armor', shield: false,
      spells: ['Cure Wounds', "Hunter's Mark"], desc: 'Wilderness hunter with bow and blade.' },
    Rogue:   { name: 'Rogue',   hitDie: 8,  prime: 'DEX', caster: null,
      startWeapon: 'Short Sword', startArmor: 'Leather Armor', shield: false,
      spells: [], desc: 'Nimble skirmisher who strikes from the shadows.' },
    Bard:    { name: 'Bard',    hitDie: 8,  prime: 'CHA', caster: 'arcane',
      startWeapon: 'Rapier', startArmor: 'Leather Armor', shield: false,
      spells: ['Cure Wounds', 'Vicious Mockery', 'Bless'], desc: 'Jack-of-all-trades whose songs inspire and confound.' },
    Cleric:  { name: 'Cleric',  hitDie: 8,  prime: 'WIS', caster: 'divine',
      startWeapon: 'Mace', startArmor: 'Chain Mail', shield: true,
      spells: ['Cure Wounds', 'Bless', 'Guiding Bolt'], desc: 'Divine healer wielding the power of the gods.' },
    Wizard:  { name: 'Wizard',  hitDie: 6,  prime: 'INT', caster: 'arcane',
      startWeapon: 'Dagger', startArmor: 'Robes', shield: false,
      spells: ['Magic Missile', 'Fire Bolt', 'Sleep', 'Shield'], desc: 'Scholar of arcane might. Fragile but devastating.' },
    Sorcerer:{ name: 'Sorcerer',hitDie: 6,  prime: 'CHA', caster: 'arcane',
      startWeapon: 'Dagger', startArmor: 'Robes', shield: false,
      spells: ['Fire Bolt', 'Magic Missile', 'Fireball'], desc: 'Innate wielder of raw elemental force.' }
  };

  // ---- Spells ----------------------------------------------------------
  // cost = spell points. kind: 'attack'|'heal'|'buff'|'debuff'.
  // dmg / heal are dice strings scaled by caster level via `scale`.
  BT.SPELLS = {
    'Magic Missile':   { name: 'Magic Missile',   cost: 2, kind: 'attack', target: 'enemy', dmg: '3d4+3', element: 'force', always: true, desc: 'Three darts of force that never miss.' },
    'Fire Bolt':       { name: 'Fire Bolt',       cost: 1, kind: 'attack', target: 'enemy', dmg: '1d10', scale: '1d10', element: 'fire', desc: 'A mote of fire hurled at a foe.' },
    'Fireball':        { name: 'Fireball',        cost: 5, kind: 'attack', target: 'all-enemies', dmg: '6d6', element: 'fire', save: 'DEX', desc: 'A roaring blast that engulfs all enemies.' },
    'Guiding Bolt':    { name: 'Guiding Bolt',    cost: 2, kind: 'attack', target: 'enemy', dmg: '4d6', element: 'radiant', desc: 'A lance of light that sears a single foe.' },
    'Vicious Mockery': { name: 'Vicious Mockery', cost: 1, kind: 'attack', target: 'enemy', dmg: '2d4', element: 'psychic', debuff: 'daze', desc: 'Cutting insults that wound the mind.' },
    'Sleep':           { name: 'Sleep',           cost: 3, kind: 'debuff', target: 'enemy', effect: 'sleep', desc: 'Lulls a weaker foe into slumber.' },
    'Cure Wounds':     { name: 'Cure Wounds',     cost: 2, kind: 'heal',   target: 'ally',  heal: '2d8', desc: 'Channels vitality to close an ally\'s wounds.' },
    'Bless':           { name: 'Bless',           cost: 2, kind: 'buff',   target: 'party', effect: 'bless', desc: 'Blesses the party, sharpening their strikes.' },
    'Shield':          { name: 'Shield',          cost: 1, kind: 'buff',   target: 'self',  effect: 'shield', desc: 'A shimmering barrier that turns aside blows.' },
    "Hunter's Mark":   { name: "Hunter's Mark",   cost: 1, kind: 'buff',   target: 'self',  effect: 'mark', desc: 'Marks your quarry for extra damage.' }
  };

  // ---- Items: weapons & armor -----------------------------------------
  // Weapon: dmg dice, prop 'finesse' uses DEX. ranged for archers.
  BT.WEAPONS = {
    'Fists':        { name: 'Fists',        dmg: '1d2',  cost: 0,   slot: 'weapon' },
    'Dagger':       { name: 'Dagger',       dmg: '1d4',  cost: 2,   slot: 'weapon', finesse: true },
    'Short Sword':  { name: 'Short Sword',  dmg: '1d6',  cost: 10,  slot: 'weapon', finesse: true },
    'Rapier':       { name: 'Rapier',       dmg: '1d8',  cost: 25,  slot: 'weapon', finesse: true },
    'Mace':         { name: 'Mace',         dmg: '1d6',  cost: 5,   slot: 'weapon' },
    'Longsword':    { name: 'Longsword',    dmg: '1d8',  cost: 15,  slot: 'weapon' },
    'Battleaxe':    { name: 'Battleaxe',    dmg: '1d10', cost: 20,  slot: 'weapon' },
    'Greataxe':     { name: 'Greataxe',     dmg: '1d12', cost: 30,  slot: 'weapon' },
    'Warhammer':    { name: 'Warhammer',    dmg: '1d10', cost: 22,  slot: 'weapon' },
    'Longbow':      { name: 'Longbow',      dmg: '1d8',  cost: 25,  slot: 'weapon', finesse: true, ranged: true },
    'Flame Tongue': { name: 'Flame Tongue', dmg: '1d8+2d6', cost: 0, slot: 'weapon', magic: true, desc: 'A sword wreathed in fire.' },
    'Vorpal Blade': { name: 'Vorpal Blade', dmg: '2d8+3',   cost: 0, slot: 'weapon', magic: true, desc: 'Legendary blade of the deep.' }
  };

  // Armor: base AC when worn. type 'heavy' ignores DEX; 'light' adds DEX; 'medium' caps at +2.
  BT.ARMOR = {
    'Robes':       { name: 'Robes',       ac: 10, type: 'light',  cost: 1,   slot: 'armor' },
    'Leather Armor':{ name: 'Leather Armor', ac: 11, type: 'light', cost: 10, slot: 'armor' },
    'Studded Leather': { name: 'Studded Leather', ac: 12, type: 'light', cost: 45, slot: 'armor' },
    'Chain Shirt': { name: 'Chain Shirt', ac: 13, type: 'medium', cost: 50, slot: 'armor' },
    'Chain Mail':  { name: 'Chain Mail',  ac: 16, type: 'heavy',  cost: 75, slot: 'armor' },
    'Plate Armor': { name: 'Plate Armor', ac: 18, type: 'heavy',  cost: 200, slot: 'armor' }
  };

  BT.SHIELD_AC = 2;

  // Consumables sold in the shop / found as loot.
  BT.CONSUMABLES = {
    'Healing Potion':   { name: 'Healing Potion',   cost: 25,  heal: '2d4+2', desc: 'Restores a modest amount of health.' },
    'Greater Healing':  { name: 'Greater Healing',  cost: 60,  heal: '4d4+4', desc: 'Restores a large amount of health.' },
    'Mana Draught':     { name: 'Mana Draught',     cost: 40,  sp: 5,        desc: 'Restores 5 spell points.' },
    'Antidote':         { name: 'Antidote',         cost: 20,  cure: 'poison', desc: 'Cures poison.' },
    'Scroll of Revive': { name: 'Scroll of Revive', cost: 120, revive: true,  desc: 'Returns a fallen ally to life at 1 HP.' }
  };

  // ---- Monsters (SRD-inspired) -----------------------------------------
  // tier = shallowest dungeon depth it appears on. xp = award. count = spawn group dice.
  BT.MONSTERS = [
    { name: 'Giant Rat',   ac: 12, hp: '2d4',    atk: 3, dmg: '1d4',    xp: 25,   tier: 1, count: '1d4', glyph: '🐀', color: '#8a6a4a' },
    { name: 'Goblin',      ac: 13, hp: '2d6',    atk: 4, dmg: '1d6+2',  xp: 50,   tier: 1, count: '1d4', glyph: '👺', color: '#5f8a3a' },
    { name: 'Kobold',      ac: 12, hp: '2d6-2',  atk: 4, dmg: '1d4+2',  xp: 25,   tier: 1, count: '2d4', glyph: '🦎', color: '#b5642a' },
    { name: 'Giant Spider',ac: 14, hp: '3d10',   atk: 5, dmg: '1d8+3',  xp: 200,  tier: 2, count: '1d3', glyph: '🕷️', color: '#4a3a5a', poison: true },
    { name: 'Skeleton',    ac: 13, hp: '2d8',    atk: 4, dmg: '1d6+2',  xp: 50,   tier: 2, count: '1d6', glyph: '💀', color: '#d8d0c0' },
    { name: 'Zombie',      ac: 8,  hp: '3d8+3',  atk: 3, dmg: '1d6+1',  xp: 50,   tier: 2, count: '1d4', glyph: '🧟', color: '#6a8a5a' },
    { name: 'Orc',         ac: 13, hp: '2d8+6',  atk: 5, dmg: '1d12+3', xp: 100,  tier: 2, count: '1d4', glyph: '👹', color: '#3a7a4a' },
    { name: 'Wolf',        ac: 13, hp: '2d8',    atk: 4, dmg: '2d4+2',  xp: 50,   tier: 2, count: '1d4', glyph: '🐺', color: '#7a7a7a' },
    { name: 'Bandit',      ac: 12, hp: '2d8',    atk: 3, dmg: '1d6+1',  xp: 25,   tier: 2, count: '1d4', glyph: '🗡️', color: '#9a5a3a' },
    { name: 'Ghoul',       ac: 12, hp: '5d8',    atk: 4, dmg: '2d6+2',  xp: 200,  tier: 3, count: '1d3', glyph: '🧛', color: '#8a7a9a', paralyze: true },
    { name: 'Ogre',        ac: 11, hp: '7d10+21',atk: 6, dmg: '2d8+4',  xp: 450,  tier: 3, count: '1d2', glyph: '👿', color: '#a5764a' },
    { name: 'Gnoll',       ac: 15, hp: '5d8',    atk: 5, dmg: '1d10+2', xp: 100,  tier: 3, count: '1d4', glyph: '🐕', color: '#8a6a3a' },
    { name: 'Wraith',      ac: 13, hp: '9d8+27', atk: 6, dmg: '4d8+3',  xp: 1800, tier: 4, count: '1d2', glyph: '👻', color: '#5a6a8a', drain: true },
    { name: 'Owlbear',     ac: 13, hp: '7d10+21',atk: 7, dmg: '2d8+5',  xp: 700,  tier: 4, count: '1d2', glyph: '🦉', color: '#7a5a3a' },
    { name: 'Basilisk',    ac: 15, hp: '8d8+16', atk: 6, dmg: '2d6+3',  xp: 700,  tier: 4, count: '1d2', glyph: '🐍', color: '#4a7a5a', poison: true },
    { name: 'Troll',       ac: 15, hp: '8d10+40',atk: 7, dmg: '2d6+4',  xp: 1800, tier: 5, count: '1d2', glyph: '🧌', color: '#5a8a4a', regen: 5 },
    { name: 'Vampire',     ac: 16, hp: '17d8+51',atk: 8, dmg: '2d8+4',  xp: 5000, tier: 5, count: '1',   glyph: '🧛‍♂️', color: '#8a2a3a', drain: true },
    { name: 'Mind Flayer', ac: 15, hp: '13d8+26',atk: 7, dmg: '4d10',   xp: 2900, tier: 5, count: '1d2', glyph: '🐙', color: '#8a4a8a', psychic: true }
  ];

  // Boss that guards the artifact on the final level.
  BT.BOSS = {
    name: 'Mangar the Dark', ac: 18, hp: '20d10+80', atk: 10, dmg: '3d8+6',
    xp: 15000, glyph: '🐉', color: '#c0392b', boss: true,
    spells: ['Fireball', 'Magic Missile'],
    desc: 'The archmage who curses these depths.'
  };

  // Fun name fragments for procedural character names.
  BT.NAME_PARTS = {
    prefix: ['Ael', 'Bran', 'Cor', 'Dra', 'El', 'Fen', 'Gor', 'Hal', 'Ith', 'Kel', 'Lor', 'Mor', 'Nym', 'Ori', 'Pyr', 'Ques', 'Rho', 'Syl', 'Thal', 'Val', 'Wren', 'Zar'],
    suffix: ['adan', 'ric', 'wyn', 'thas', 'ion', 'dor', 'iel', 'mund', 'gar', 'ana', 'wen', 'ius', 'oth', 'ara', 'en', 'ir', 'os', 'eth']
  };

  BT.ARTIFACT = { name: 'The Sword of Zar', desc: 'A legendary blade said to end the darkness.' };
})(window.BT = window.BT || {});

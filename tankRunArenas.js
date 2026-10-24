// ============================================================
//  NOUVEAUX TERRAINS (800 × 480, même format que le terrain de base)
//  - desert : sable, rochers, cactus, clôtures en bois
//  - usine  : béton, conteneurs, bidons, murs d'acier
// ============================================================

const T = 14; // épaisseur de l'enceinte
const BORDER = [
  { type: 'border', x: 0, y: 0, w: 800, h: T },
  { type: 'border', x: 0, y: 480 - T, w: 800, h: T },
  { type: 'border', x: 0, y: 0, w: T, h: 480 },
  { type: 'border', x: 800 - T, y: 0, w: T, h: 480 },
];

const SPAWNS = {
  bl: { x: 64, y: 416, corner: 'bl' },
  br: { x: 736, y: 416, corner: 'br' },
  tl: { x: 64, y: 64, corner: 'tl' },
  tr: { x: 736, y: 64, corner: 'tr' },
};

export const ARENAS = {
  desert: {
    id: 'desert',
    name: 'Désert',
    theme: { id: 'desert' },
    spawns: SPAWNS,
    obstacles: [
      ...BORDER,
      { type: 'rock', x: 370, y: 210, w: 60, h: 60 },
      { type: 'rock', x: 150, y: 150, w: 56, h: 44 },
      { type: 'rock', x: 594, y: 286, w: 56, h: 44 },
      { type: 'cactus', x: 300, y: 70, w: 26, h: 26 },
      { type: 'cactus', x: 474, y: 384, w: 26, h: 26 },
      { type: 'cactus', x: 110, y: 300, w: 26, h: 26 },
      { type: 'cactus', x: 664, y: 154, w: 26, h: 26 },
      { type: 'cactus', x: 520, y: 60, w: 26, h: 26 },
      { type: 'cactus', x: 254, y: 394, w: 26, h: 26 },
      { type: 'crate', x: 230, y: 230, w: 44, h: 44 },
      { type: 'crate', x: 526, y: 206, w: 44, h: 44 },
      { type: 'fence', x: 430, y: 120, w: 100, h: 12 },
      { type: 'fence', x: 270, y: 348, w: 100, h: 12 },
      { type: 'fence', x: 80, y: 120, w: 12, h: 90 },
      { type: 'fence', x: 708, y: 270, w: 12, h: 90 },
    ],
  },

  usine: {
    id: 'usine',
    name: 'Usine',
    theme: { id: 'usine' },
    spawns: SPAWNS,
    obstacles: [
      ...BORDER,
      { type: 'steel', x: 350, y: 236, w: 100, h: 8 },
      { type: 'steel', x: 396, y: 196, w: 8, h: 88 },
      { type: 'container', x: 320, y: 100, w: 90, h: 36 },
      { type: 'container', x: 390, y: 344, w: 90, h: 36 },
      { type: 'container', x: 120, y: 200, w: 36, h: 90 },
      { type: 'container', x: 644, y: 190, w: 36, h: 90 },
      { type: 'steel', x: 500, y: 300, w: 80, h: 12 },
      { type: 'steel', x: 220, y: 168, w: 80, h: 12 },
      { type: 'barrel', x: 230, y: 300, w: 24, h: 24 },
      { type: 'barrel', x: 546, y: 156, w: 24, h: 24 },
      { type: 'barrel', x: 560, y: 60, w: 24, h: 24 },
      { type: 'barrel', x: 216, y: 396, w: 24, h: 24 },
      { type: 'barrel', x: 90, y: 100, w: 24, h: 24 },
      { type: 'barrel', x: 686, y: 356, w: 24, h: 24 },
    ],
  },
};

export const ARENA_LIST = Object.values(ARENAS);

/** Accepte : un objet terrain, 'desert' | 'usine', 'random', ou rien (→ terrain d'origine). */
export function resolveArena(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    if (v === 'random') return ARENA_LIST[Math.floor(Math.random() * ARENA_LIST.length)];
    return ARENAS[v] || null;
  }
  return v.obstacles ? v : null;
}

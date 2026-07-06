/** Generates src/office/data/map.json from the guild-hall shell + zone
 * placements below. Edit PIECES/PLACEMENTS/ANCHORS and re-run:
 *   node scripts/build-office-map.mjs
 * Coordinates are in 16px tiles; the shell is 21×14 (from the CraftPix
 * example map). map.json can also be hand-edited afterwards. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'src', 'office', 'data');
const shell = JSON.parse(fs.readFileSync(path.join(dataDir, 'shell.json'), 'utf8'));

/* pixel rects inside Interior_objects.png (x,y,w,h) — measured exactly by
 * alpha-scanning the sheet (see BUILD_LOG 2026-07-06), not eyeballed.
 * fw×fh tiles at the BOTTOM of the piece block movement. */
const PIECES = {
  bookcase_a: { x: 75, y: 100, w: 47, h: 58, fw: 3, fh: 1 },
  bookcase_b: { x: 135, y: 100, w: 47, h: 58, fw: 3, fh: 1 },
  dresser: { x: 11, y: 114, w: 47, h: 44, fw: 3, fh: 1 },
  board_a: { x: 51, y: 169, w: 41, h: 49, fw: 0, fh: 0 },
  board_b: { x: 99, y: 169, w: 41, h: 49, fw: 0, fh: 0 },
  magic_circle: { x: 58, y: 12, w: 62, h: 45, fw: 0, fh: 0 }, // floor décor — walkable
  desk_book: { x: 220, y: 227, w: 56, h: 33, fw: 4, fh: 1 },
  desk_scroll: { x: 300, y: 226, w: 56, h: 34, fw: 4, fh: 1 },
  rug: { x: 7, y: 228, w: 65, h: 69, fw: 0, fh: 0 }, // walkable
  bench_long: { x: 92, y: 235, w: 47, h: 23, fw: 3, fh: 1 },
  banner: { x: 122, y: 311, w: 52, h: 41, fw: 0, fh: 0 }, // hangs on wall
  plant_a: { x: 228, y: 309, w: 18, h: 33, fw: 1, fh: 1 },
  plant_b: { x: 267, y: 308, w: 17, h: 34, fw: 1, fh: 1 },
  plant_c: { x: 296, y: 309, w: 18, h: 33, fw: 1, fh: 1 },
  chest: { x: 245, y: 357, w: 23, h: 20, fw: 2, fh: 1 },
  vase_blue: { x: 371, y: 257, w: 13, h: 31, fw: 1, fh: 1 },
};

/* [piece, tileX, tileY of the piece's BOTTOM-LEFT corner, layer, opts?]
 * layer 'wall' renders flat on the wall (no y-sort); 'floor' renders under
 * everything; 'furniture' y-sorts against agents. */
const PLACEMENTS = [
  // command centre — the arc-reactor circle (screen-blended cyan at runtime)
  ['magic_circle', 8.5, 9, 'floor', { tint: '#46e8ff', blend: 'screen' }],
  ['banner', 9, 4, 'wall'],

  // the archive (vault) — left
  ['bookcase_a', 4, 6, 'furniture'],
  ['bookcase_b', 7, 6, 'furniture'],
  ['rug', 3, 10, 'floor'],
  ['chest', 4.2, 10, 'furniture'],
  ['dresser', 1, 10, 'furniture'],

  // research bay — boards on the wall + desk, left of the door
  ['board_a', 12.4, 4, 'wall'],
  ['board_b', 0.9, 4, 'wall'],
  ['desk_book', 14, 8, 'furniture'],
  ['vase_blue', 15.4, 5, 'furniture'],

  // dev corner — bottom right (holo-screens added at runtime)
  ['desk_scroll', 13, 10, 'furniture'],

  // shared space
  ['bench_long', 5, 11, 'furniture'],
  ['plant_a', 8, 10.6, 'furniture'],
  ['plant_b', 17.3, 5.6, 'furniture'],
  ['plant_c', 2.5, 5.6, 'furniture'],
];

/* stand anchors (tile coords, fractional = fine) */
const ANCHORS = {
  seats: {
    jarvis: { x: 10.4, y: 7.6, rig: 'guildmaster' },
    'vault-librarian': { x: 5.0, y: 7.8, rig: 'reader' },
    researcher: { x: 14.2, y: 6.9, rig: 'citizen1' },
    coder: { x: 13.4, y: 8.6, rig: 'citizen2' },
  },
  spares: [
    { x: 6.5, y: 9.5 },
    { x: 12.5, y: 7.5 },
  ],
  stations: {
    vault_read: { x: 5.5, y: 7.4 },
    vault_write: { x: 5.5, y: 7.4 },
    research: { x: 14.2, y: 6.9 },
    terminal: { x: 13.4, y: 8.6 },
  },
  totem: { x: 13.6, y: 6.3 },
  door: { x: 17.5, y: 7.5 }, // right-side opening — walkable, agents enter here
};

/* holo-screens (runtime cyan Graphics): x,y,w,h in tiles */
const HOLO = [
  { x: 13.4, y: 8.0, w: 2.6, h: 1.1 }, // dev corner screens
  { x: 14.5, y: 6.2, w: 1.8, h: 0.9 }, // research desk screen
];

/* ── build collision ─────────────────────────────────────────────────── */
const { cols, rows } = shell;
const walk = [];
for (let y = 0; y < rows; y++) {
  walk.push(
    Array.from({ length: cols }, (_, x) =>
      shell.floor[y][x] && !shell.walls[y][x] && !shell.above[y][x] ? 1 : 0,
    ),
  );
}
// fence the side/bottom openings so agents stay in the room
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    if (x < 3 || x > 17 || y > 10) walk[y][x] = 0;
  }
}
// furniture footprints
for (const [name, tx, ty] of PLACEMENTS) {
  const p = PIECES[name];
  for (let dy = 0; dy < p.fh; dy++) {
    for (let dx = 0; dx < p.fw; dx++) {
      const y = Math.floor(ty) - dy;
      const x = Math.floor(tx) + dx;
      if (walk[y]?.[x] !== undefined) walk[y][x] = 0;
    }
  }
}
// totem tile
walk[Math.floor(ANCHORS.totem.y)][Math.floor(ANCHORS.totem.x)] = 0;

const map = {
  tile: shell.tile,
  cols,
  rows,
  layers: { floor: shell.floor, walls: shell.walls, above: shell.above },
  pieces: PIECES,
  placements: PLACEMENTS,
  anchors: ANCHORS,
  holo: HOLO,
  walkable: walk,
};
fs.writeFileSync(path.join(dataDir, 'map.json'), JSON.stringify(map));
console.log('map.json written:', cols, 'x', rows, '· placements:', PLACEMENTS.length);
console.log(walk.map((r) => r.map((v) => (v ? '.' : '#')).join('')).join('\n'));

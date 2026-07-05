/** Pixel-art factory: sprites are drawn as ASCII grids and rendered to
 * canvases → PixiJS textures with nearest-neighbour scaling. All art lives
 * here as readable, versionable text. Palette matches the HUD. */

import { Texture } from 'pixi.js';

export const PAL: Record<string, string> = {
  '.': '',            // transparent
  o: '#081018',       // outline
  D: '#16303f',       // steel
  d: '#0f2230',       // steel dark
  C: '#46e8ff',       // cyan bright
  c: '#2a8fa5',       // cyan dim
  W: '#d8f7ff',       // white glow
  g: '#ffc96b',       // gold
  r: '#ff4d5e',       // red
  b: '#0a141d',       // floor base
  l: '#122335',       // floor line
};

export function drawGrid(rows: string[], palette: Record<string, string> = PAL): HTMLCanvasElement {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = palette[row[x]];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  });
  return cv;
}

export function tex(rows: string[], palette?: Record<string, string>): Texture {
  const t = Texture.from(drawGrid(rows, palette));
  t.source.scaleMode = 'nearest';
  return t;
}

/* ── droid bodies (12×13) — head, torso with core, legs ──────────────── */

const BODY_STAND = [
  '....CCCC....',
  '...CddddC...',
  '..CdWddWdC..',
  '..CddddddC..',
  '...CddddC...',
  '....dddd....',
  '..DDDDDDDD..',
  '.DDdCWWCdDD.',
  '.DDddddddDD.',
  '..DDDDDDDD..',
  '...dd..dd...',
  '...dd..dd...',
  '..odd..ddo..',
];

const BODY_WALK_A = [
  ...BODY_STAND.slice(0, 10),
  '...dd..dd...',
  '..dd....dd..',
  '.odd....ddo.',
];

const BODY_WALK_B = [
  ...BODY_STAND.slice(0, 10),
  '...dd..dd...',
  '....dddd....',
  '...odddd o..',
];

const BODY_BLINK = BODY_STAND.map((r, i) => (i === 2 ? '..CddddddC..' : r));

/* antenna crowns (12 wide, 3 tall) stacked above the body per agent */
const CROWNS: Record<string, string[]> = {
  jarvis: ['.....WW.....', '.....CC.....', '.....CC.....'],
  researcher: ['...C....C...', '....C..C....', '.....CC.....'],
  coder: ['............', '..CCCCCCCC..', '...dddddd...'],
  'vault-librarian': ['..W.........', '..C.........', '..C.........'],
  generic: ['............', '............', '.....C......'],
};

export interface DroidFrames {
  stand: Texture;
  blink: Texture;
  walkA: Texture;
  walkB: Texture;
}

export function droidFrames(kind: string): DroidFrames {
  const crown = CROWNS[kind] ?? CROWNS.generic;
  const make = (body: string[]) => tex([...crown, ...body]);
  return {
    stand: make(BODY_STAND),
    blink: make(BODY_BLINK),
    walkA: make(BODY_WALK_A),
    walkB: make(BODY_WALK_B),
  };
}

/* ── furniture ───────────────────────────────────────────────────────── */

export const FURNITURE = {
  bookshelf: [
    'oDDDDDDDDDDDDDDo',
    'oDcCgcDCcDgcCcDo',
    'oDcCgcDCcDgcCcDo',
    'oDDDDDDDDDDDDDDo',
    'oDCcDgCcCDcCgcDo',
    'oDCcDgCcCDcCgcDo',
    'oDDDDDDDDDDDDDDo',
    'oDgcCcDcCgDCcDCo',
    'oDgcCcDcCgDCcDCo',
    'oDDDDDDDDDDDDDDo',
    'oo............oo',
  ],
  rackA: [
    'oDDDDDDDDDDDDo',
    'oDCc.......dDo',
    'oDddddddddddDo',
    'oDc.C......dDo',
    'oDddddddddddDo',
    'oDC..c.....dDo',
    'oDddddddddddDo',
    'oDc...C....dDo',
    'oDDDDDDDDDDDDo',
    'oo..........oo',
  ],
  rackB: [
    'oDDDDDDDDDDDDo',
    'oDcC.......dDo',
    'oDddddddddddDo',
    'oDC.c......dDo',
    'oDddddddddddDo',
    'oDc..C.....dDo',
    'oDddddddddddDo',
    'oDC....c...dDo',
    'oDDDDDDDDDDDDo',
    'oo..........oo',
  ],
  deskA: [
    '....cCCCCCCc....',
    '....CddddddC....',
    '....CdWWWWdC....',
    '....cCCCCCCc....',
    'oDDDDDDDDDDDDDDo',
    'oDddddddddddddDo',
    'oDDDDDDDDDDDDDDo',
    '.od..........do.',
    '.od..........do.',
  ],
  deskB: [
    '....cCCCCCCc....',
    '....CddddddC....',
    '....CdWdWddC....',
    '....cCCCCCCc....',
    'oDDDDDDDDDDDDDDo',
    'oDddddddddddddDo',
    'oDDDDDDDDDDDDDDo',
    '.od..........do.',
    '.od..........do.',
  ],
  globeA: [
    '......cCCc......',
    '.....CdcCdC.....',
    '....CcdCcdcC....',
    '....CdcCcdcC....',
    '.....CdcCdC.....',
    '......cCCc......',
    '.......DD.......',
    '.....DDDDDD.....',
    '....oDDDDDDo....',
  ],
  globeB: [
    '......cCCc......',
    '.....CcdCdC.....',
    '....CdcCdccC....',
    '....CcdCcdcC....',
    '.....CcdCdC.....',
    '......cCCc......',
    '.......DD.......',
    '.....DDDDDD.....',
    '....oDDDDDDo....',
  ],
  coreA: [
    '......CCCC......',
    '....CC....CC....',
    '...C..CWWC..C...',
    '..C..CWWWWC..C..',
    '..C..CWWWWC..C..',
    '...C..CWWC..C...',
    '....CC....CC....',
    '......CCCC......',
    '......dDDd......',
    '.....dDDDDd.....',
    '....oDDDDDDo....',
    '....oDDDDDDo....',
  ],
  coreB: [
    '......cCCc......',
    '....Cc....cC....',
    '...C..CWWC..C...',
    '..C..WWWWWW..C..',
    '..C..WWWWWW..C..',
    '...C..CWWC..C...',
    '....Cc....cC....',
    '......cCCc......',
    '......dDDd......',
    '.....dDDDDd.....',
    '....oDDDDDDo....',
    '....oDDDDDDo....',
  ],
  totemA: [
    '...CC...',
    '..CWWC..',
    '..CWWC..',
    '...CC...',
    '...dd...',
    '...dd...',
    '...dd...',
    '..oDDo..',
  ],
  totemB: [
    '...cc...',
    '..cCCc..',
    '..cCCc..',
    '...cc...',
    '...dd...',
    '...dd...',
    '...dd...',
    '..oDDo..',
  ],
  plant: [
    '....C..c....',
    '..c.CC.C.c..',
    '...cCCCCc...',
    '....cCCc....',
    '.....CC.....',
    '....oDDo....',
    '....DddD....',
    '.....DD.....',
  ],
  window: [
    'oooooooooooooooo',
    'occcccccccccccco',
    'oc............co',
    'oc............co',
    'occcccccccccccco',
    'oooooooooooooooo',
  ],
};

/* floor tile drawn procedurally so it can vary subtly */
export function floorTile(seed: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 16;
  cv.height = 16;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = PAL.b;
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = PAL.l;
  ctx.fillRect(0, 0, 16, 1);
  ctx.fillRect(0, 0, 1, 16);
  // sparse holo-flecks, deterministic per tile
  if (seed % 7 === 0) {
    ctx.fillStyle = 'rgba(70,232,255,0.10)';
    ctx.fillRect(4 + (seed % 8), 6 + (seed % 5), 1, 1);
  }
  return cv;
}

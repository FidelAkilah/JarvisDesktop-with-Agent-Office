/** Character rigs sliced from the CraftPix sheets. Frame counts are detected
 * by alpha-scanning cells, so sheet quirks can't break us. */

import { Rectangle, Texture } from 'pixi.js';

import citizen1IdleUrl from './assets/Citizen1_Idle.png';
import citizen1WalkUrl from './assets/Citizen1_Walk.png';
import citizen2IdleUrl from './assets/Citizen2_Idle.png';
import citizen2WalkUrl from './assets/Citizen2_Walk.png';
import guildmasterUrl from './assets/Guildmaster.png';
import readerUrl from './assets/Reader1.png';

export type Dir = 'front' | 'back' | 'left' | 'right';

export interface WalkerRig {
  kind: 'walker';
  idle: Record<Dir, Texture[]>;
  walk: Record<Dir, Texture[]>;
}
export interface FixedRig {
  kind: 'fixed';
  frames: Texture[]; // playlist, uniform timing
  frameMs: number;
}
export type Rig = WalkerRig | FixedRig;

/* row order in the citizen sheets (verified visually; adjust here if a
 * direction ever looks mirrored) */
const CITIZEN_ROWS: Dir[] = ['front', 'left', 'right', 'back'];

async function loadCanvas(url: string): Promise<HTMLCanvasElement> {
  // NB: Image.decode() can hang forever in backgrounded/headless pages —
  // classic onload is reliable everywhere.
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`failed to load ${url}`));
    el.src = url;
  });
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  cv.getContext('2d')!.drawImage(img, 0, 0);
  return cv;
}

function cellEmpty(cv: HTMLCanvasElement, x: number, y: number, w: number, h: number): boolean {
  const data = cv.getContext('2d')!.getImageData(x, y, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 10) return false;
  return true;
}

function textureFromCanvas(cv: HTMLCanvasElement): Texture {
  const t = Texture.from(cv);
  t.source.scaleMode = 'nearest';
  return t;
}

/** slice one row of fixed-size cells, dropping empty ones */
function sliceRow(cv: HTMLCanvasElement, base: Texture, rowY: number, cellW: number, cellH: number): Texture[] {
  const out: Texture[] = [];
  for (let x = 0; x + cellW <= cv.width; x += cellW) {
    if (cellEmpty(cv, x, rowY, cellW, cellH)) continue;
    out.push(new Texture({ source: base.source, frame: new Rectangle(x, rowY, cellW, cellH) }));
  }
  return out;
}

async function loadWalker(idleUrl: string, walkUrl: string): Promise<WalkerRig> {
  const [idleCv, walkCv] = await Promise.all([loadCanvas(idleUrl), loadCanvas(walkUrl)]);
  const idleTex = textureFromCanvas(idleCv);
  const walkTex = textureFromCanvas(walkCv);
  const idle = {} as Record<Dir, Texture[]>;
  const walk = {} as Record<Dir, Texture[]>;
  CITIZEN_ROWS.forEach((dir, row) => {
    idle[dir] = sliceRow(idleCv, idleTex, row * 32, 32, 32);
    walk[dir] = sliceRow(walkCv, walkTex, row * 32, 32, 32);
  });
  return { kind: 'walker', idle, walk };
}

async function loadFixed(url: string, cellW: number, cellH: number, playlist?: number[]): Promise<FixedRig> {
  const cv = await loadCanvas(url);
  const base = textureFromCanvas(cv);
  const raw = sliceRow(cv, base, 0, cellW, cellH);
  const frames = (playlist ?? raw.map((_, i) => i)).map((i) => raw[Math.min(i, raw.length - 1)]);
  return { kind: 'fixed', frames, frameMs: 150 };
}

export async function loadRigs(): Promise<Record<string, Rig>> {
  const [citizen1, citizen2, guildmaster, reader] = await Promise.all([
    loadWalker(citizen1IdleUrl, citizen1WalkUrl),
    loadWalker(citizen2IdleUrl, citizen2WalkUrl),
    // playlist straight from the pack's own Tiled animation definition
    loadFixed(guildmasterUrl, 48, 32, [0, 0, 1, 2, 3, 4, 4, 5, 5, 5, 5, 5]),
    loadFixed(readerUrl, 32, 48),
  ]);
  return { citizen1, citizen2, guildmaster, reader };
}

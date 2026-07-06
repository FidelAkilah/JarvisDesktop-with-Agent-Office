/** The pixel office — CraftPix guild-hall interior, rebuilt as data-driven
 * layered tilemaps (floor / walls / furniture / above + collision), with the
 * pack's own characters as the agents. Every animation remains a pure
 * function of the real event stream. Map data: data/map.json (regenerate via
 * scripts/build-office-map.mjs). */

import { Application, Assets, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { AgentActor } from './actors';
import { loadRigs, type Rig } from './rigs';
import { FURNITURE, tex } from './pixels';
import mapData from './data/map.json';

import wallsUrl from './assets/Walls_interior.png';
import objectsUrl from './assets/Interior_objects.png';
import windowsUrl from './assets/Windows_doors.png';

const TILE = 16;
const MAP = mapData as any;
const NATIVE_W = MAP.cols * TILE;
const NATIVE_H = MAP.rows * TILE;

/* tilesets exactly as in the pack's Tiled map */
const TILESET_DEFS = [
  { first: 369, count: 192, url: wallsUrl, columns: 24 },
  { first: 561, count: 576, url: objectsUrl, columns: 24 },
  { first: 1761, count: 324, url: windowsUrl, columns: 18 },
];

interface OfficeEvent {
  agentId?: string;
  source?: string;
  state?: string;
  activity?: string;
  tool?: string;
  target?: string;
  message?: string;
}

const pxOf = (tx: number, ty: number) => ({ x: (tx + 0.5) * TILE, y: (ty + 0.95) * TILE });

export class Office {
  private app: Application | null = null;
  private world = new Container();
  private actors = new Map<string, AgentActor>();
  private rigs: Record<string, Rig> = {};
  private spareIdx = 0;
  private mounting = false;
  private started = false; // true only once rigs + sheets are fully loaded

  private gidCache = new Map<number, Texture>();
  private sheets: { first: number; count: number; columns: number; texture: Texture }[] = [];
  private circleSprite: Sprite | null = null;
  private circleBaseTint = 0xffffff;
  private totem: { sprite: Sprite; bright: Texture; dim: Texture } | null = null;
  private voiceGlow: 'dim' | 'bright' | 'muted' = 'dim';
  private holos: Graphics[] = [];

  constructor(private onSelect: (agentId: string) => void) {}

  async mount(host: HTMLElement): Promise<void> {
    if (this.mounting) return;
    this.mounting = true;

    const app = new Application();
    await app.init({ backgroundAlpha: 0, antialias: false, resizeTo: host, roundPixels: true });
    (app.canvas as HTMLCanvasElement).style.imageRendering = 'pixelated';
    host.appendChild(app.canvas);
    this.app = app;

    // load sheets + rigs in parallel
    const [sheetTextures, rigs] = await Promise.all([
      Promise.all(TILESET_DEFS.map((t) => Assets.load<Texture>(t.url))),
      loadRigs(),
    ]);
    this.rigs = rigs;
    this.sheets = TILESET_DEFS.map((t, i) => {
      sheetTextures[i].source.scaleMode = 'nearest';
      return { first: t.first, count: t.count, columns: t.columns, texture: sheetTextures[i] };
    });

    this.world.sortableChildren = true;
    app.stage.addChild(this.world);
    this.buildRoom();
    this.started = true;
    this.spawn('jarvis');
    this.spawn('vault-librarian');

    const fit = () => {
      const scale = Math.max(
        1,
        Math.floor(Math.min(app.screen.width / NATIVE_W, app.screen.height / NATIVE_H)),
      );
      this.world.scale.set(scale);
      this.world.x = Math.round((app.screen.width - NATIVE_W * scale) / 2);
      this.world.y = Math.round((app.screen.height - NATIVE_H * scale) / 2);
    };
    fit();
    app.renderer.on('resize', fit);

    app.ticker.add((t) => {
      const dt = t.deltaMS;
      for (const a of this.actors.values()) a.update(dt);
      const now = performance.now();
      for (const [i, h] of this.holos.entries()) {
        h.alpha = 0.75 + 0.25 * Math.sin(now / 700 + i * 1.7);
      }
      if (this.totem) {
        const pulse = this.voiceGlow === 'bright' && Math.floor(now / 180) % 2 === 0;
        this.totem.sprite.texture =
          this.voiceGlow === 'bright' && pulse ? this.totem.bright : this.totem.dim;
        this.totem.sprite.tint = this.voiceGlow === 'muted' ? 0xff8f9a : 0xffffff;
      }
    });
  }

  /* ── tiles ────────────────────────────────────────────────────────── */

  private gidTexture(gid: number): Texture | null {
    const id = gid & 0x0fffffff;
    if (!id) return null;
    const hit = this.gidCache.get(id);
    if (hit) return hit;
    for (const s of [...this.sheets].reverse()) {
      if (id >= s.first && id < s.first + s.count) {
        const local = id - s.first;
        const t = new Texture({
          source: s.texture.source,
          frame: new Rectangle((local % s.columns) * TILE, Math.floor(local / s.columns) * TILE, TILE, TILE),
        });
        this.gidCache.set(id, t);
        return t;
      }
    }
    return null;
  }

  private renderGrid(grid: number[][], z: number): void {
    for (let y = 0; y < MAP.rows; y++) {
      for (let x = 0; x < MAP.cols; x++) {
        const t = this.gidTexture(grid[y][x]);
        if (!t) continue;
        const s = new Sprite(t);
        s.x = x * TILE;
        s.y = y * TILE;
        s.zIndex = z;
        this.world.addChild(s);
      }
    }
  }

  private objectsTexture(r: { x: number; y: number; w: number; h: number }): Texture {
    const sheet = this.sheets.find((s) => s.first === 561)!;
    const t = new Texture({ source: sheet.texture.source, frame: new Rectangle(r.x, r.y, r.w, r.h) });
    return t;
  }

  private buildRoom(): void {
    this.renderGrid(MAP.layers.floor, -1000);
    this.renderGrid(MAP.layers.walls, -600);
    this.renderGrid(MAP.layers.above, 10000);

    // projection frame — ties the diorama to the HUD
    const frame = new Graphics()
      .roundRect(-6, -6, NATIVE_W + 12, NATIVE_H + 12, 4)
      .stroke({ color: 0x46e8ff, width: 1, alpha: 0.3 });
    frame.zIndex = -1200;
    this.world.addChild(frame);

    for (const [name, tx, ty, layer, opts] of MAP.placements as any[]) {
      const piece = MAP.pieces[name];
      const s = new Sprite(this.objectsTexture(piece));
      s.anchor.set(0, 1);
      s.x = tx * TILE;
      s.y = (ty + 1) * TILE;
      if (opts?.tint) s.tint = parseInt(String(opts.tint).replace('#', ''), 16);
      if (opts?.alpha) s.alpha = opts.alpha;
      if (opts?.blend) s.blendMode = opts.blend;
      s.zIndex = layer === 'floor' ? -900 : layer === 'wall' ? -400 : s.y;
      this.world.addChild(s);
      if (name === 'magic_circle') {
        this.circleSprite = s;
        this.circleBaseTint = s.tint as number;
      }
    }

    // glow pools under key stations (additive, subtle)
    for (const key of Object.keys(MAP.anchors.seats)) {
      const a = MAP.anchors.seats[key];
      const g = new Graphics().ellipse(0, 0, 16, 7).fill({ color: 0x46e8ff, alpha: 0.09 });
      const p = pxOf(a.x, a.y);
      g.x = p.x;
      g.y = p.y;
      g.blendMode = 'add';
      g.zIndex = -850;
      this.world.addChild(g);
    }

    // holo-screens (the JARVIS retrofit of a medieval hall)
    for (const h of MAP.holo as any[]) {
      const g = new Graphics();
      const w = h.w * TILE;
      const ht = h.h * TILE;
      g.roundRect(0, 0, w, ht, 2)
        .fill({ color: 0x46e8ff, alpha: 0.13 })
        .stroke({ color: 0x46e8ff, width: 0.6, alpha: 0.7 });
      for (let ly = 3; ly < ht - 2; ly += 4) {
        g.moveTo(2, ly).lineTo(w - 2, ly).stroke({ color: 0x9adff2, width: 0.4, alpha: 0.35 });
      }
      g.x = h.x * TILE;
      g.y = h.y * TILE;
      g.zIndex = (h.y + h.h) * TILE + 20;
      this.world.addChild(g);
      this.holos.push(g);
    }

    // voice totem (kept from phase 4 — it's the mic presence)
    const totemDim = tex(FURNITURE.totemB);
    const totemBright = tex(FURNITURE.totemA);
    const sprite = new Sprite(totemDim);
    sprite.anchor.set(0.5, 1);
    const tp = pxOf(MAP.anchors.totem.x, MAP.anchors.totem.y);
    sprite.x = tp.x;
    sprite.y = tp.y;
    sprite.zIndex = tp.y;
    this.world.addChild(sprite);
    this.totem = { sprite, bright: totemBright, dim: totemDim };
  }

  /* ── pathfinding (BFS on the collision grid) ─────────────────────── */

  private nearestWalkable(tx: number, ty: number): { x: number; y: number } | null {
    const W = MAP.cols, H = MAP.rows;
    const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
    if (inb(tx, ty) && MAP.walkable[ty][tx]) return { x: tx, y: ty };
    const seen = new Set<number>([ty * W + tx]);
    const q = [{ x: tx, y: ty }];
    while (q.length) {
      const c = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = c.x + dx, ny = c.y + dy;
        if (!inb(nx, ny) || seen.has(ny * W + nx)) continue;
        if (MAP.walkable[ny][nx]) return { x: nx, y: ny };
        seen.add(ny * W + nx);
        q.push({ x: nx, y: ny });
      }
    }
    return null;
  }

  /** BFS returning the tile path from start to goal (both snapped to the
   * nearest walkable cell). Tile centers, no aggressive merging. */
  private findPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
    const W = MAP.cols, H = MAP.rows;
    const start = this.nearestWalkable(from.x, from.y);
    const goal = this.nearestWalkable(to.x, to.y);
    if (!start || !goal) return [];
    if (start.x === goal.x && start.y === goal.y) return [start];
    const prev = new Int32Array(W * H).fill(-1);
    const idx = (p: { x: number; y: number }) => p.y * W + p.x;
    prev[idx(start)] = idx(start);
    const q = [start];
    let found = false;
    while (q.length) {
      const c = q.shift()!;
      if (c.x === goal.x && c.y === goal.y) { found = true; break; }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = { x: c.x + dx, y: c.y + dy };
        if (n.x < 0 || n.y < 0 || n.x >= W || n.y >= H) continue;
        if (!MAP.walkable[n.y][n.x] || prev[idx(n)] !== -1) continue;
        prev[idx(n)] = idx(c);
        q.push(n);
      }
    }
    if (!found) return [start];
    const tiles: { x: number; y: number }[] = [];
    let cur = idx(goal);
    while (prev[cur] !== cur) {
      tiles.push({ x: cur % W, y: Math.floor(cur / W) });
      cur = prev[cur];
    }
    tiles.push(start);
    tiles.reverse();
    // keep only corner tiles (direction changes) — smooth straight runs
    return tiles
      .filter((t, i) => {
        if (i === 0 || i === tiles.length - 1) return true;
        const a = tiles[i - 1], b = tiles[i + 1];
        const dirIn = Math.sign(t.x - a.x) * 10 + Math.sign(t.y - a.y);
        const dirOut = Math.sign(b.x - t.x) * 10 + Math.sign(b.y - t.y);
        return dirIn !== dirOut;
      })
      .map((t) => ({ x: (t.x + 0.5) * TILE, y: (t.y + 0.5) * TILE }));
  }

  private walkActorTo(actor: AgentActor, ax: number, ay: number): void {
    if (!actor.canWalk) return;
    const fromTile = { x: Math.round(actor.x / TILE - 0.5), y: Math.round(actor.y / TILE - 0.5) };
    const toTile = { x: Math.floor(ax), y: Math.floor(ay) };
    const pts = this.findPath(fromTile, toTile);
    pts.push(pxOf(ax - 0.5, ay - 0.95)); // exact seat/station anchor
    actor.setPath(pts);
  }

  /* ── actors ───────────────────────────────────────────────────────── */

  private spawn(agentId: string): AgentActor {
    let actor = this.actors.get(agentId);
    if (actor) return actor;

    const seatDef = MAP.anchors.seats[agentId];
    const seat = seatDef ?? MAP.anchors.spares[this.spareIdx++ % MAP.anchors.spares.length];
    const rigName = seatDef?.rig ?? 'citizen2';
    const rig = this.rigs[rigName] ?? this.rigs.citizen2;
    const tint = seatDef ? undefined : 0x9adff2; // guests are holo-tinted

    actor = new AgentActor(agentId, rig, tint);
    const home = pxOf(seat.x - 0.5, seat.y - 0.95);
    actor.homeX = seat.x * TILE;
    actor.homeY = seat.y * TILE;

    if (actor.canWalk) {
      // walkers enter at the (walkable) doorway and head to their seat
      const door = pxOf(MAP.anchors.door.x - 0.5, MAP.anchors.door.y - 0.95);
      actor.x = door.x;
      actor.y = door.y;
      this.walkActorTo(actor, seat.x, seat.y);
      void home;
    } else {
      actor.x = home.x;
      actor.y = home.y;
    }

    actor.on('pointertap', () => this.onSelect(agentId));
    this.world.addChild(actor);
    this.actors.set(agentId, actor);
    return actor;
  }

  /* ── the contract: animation is a pure function of real events ───── */

  handleEvent(ev: OfficeEvent): void {
    if (!this.started || !ev.agentId || ev.agentId === 'voice') return;
    const actor = this.spawn(ev.agentId);

    switch (ev.state) {
      case 'thinking':
        actor.clearBubble();
        actor.say('', 'think');
        break;
      case 'working': {
        actor.clearBubble('think');
        const station =
          ev.activity && ev.activity !== 'typing'
            ? (MAP.anchors.stations as any)[ev.activity]
            : null;
        if (station) this.walkActorTo(actor, station.x, station.y);
        else this.walkActorTo(actor, actor.homeX / TILE, actor.homeY / TILE);
        if (ev.tool) {
          const chip =
            ev.tool === 'Agent'
              ? `→ ${ev.target}`
              : `${ev.tool}${ev.target ? ' · ' + shortTarget(ev.target) : ''}`;
          actor.say(chip, 'tool');
        }
        break;
      }
      case 'talking':
        actor.clearBubble();
        actor.faceFront();
        if (ev.message) actor.say(ev.message, 'talk');
        break;
      case 'done':
        actor.clearBubble();
        actor.checkmark();
        this.walkActorTo(actor, actor.homeX / TILE, actor.homeY / TILE);
        break;
      case 'error':
        actor.clearBubble();
        actor.flash(0xff4d5e);
        actor.say(ev.message ?? 'error', 'error');
        break;
      case 'waiting':
        actor.clearBubble('think');
        actor.faceFront();
        break;
      case 'idle':
        actor.clearBubble('think');
        this.walkActorTo(actor, actor.homeX / TILE, actor.homeY / TILE);
        break;
    }
  }

  /** the command-centre circle mirrors the HUD reactor's temperature */
  setCoreMood(mood: 'thinking' | 'normal' | 'muted'): void {
    if (!this.circleSprite) return;
    this.circleSprite.tint =
      mood === 'thinking' ? 0xffc96b : mood === 'muted' ? 0x5a6f7a : this.circleBaseTint;
  }

  setVoiceState(state: string): void {
    this.voiceGlow = state === 'listening' ? 'bright' : state === 'waiting' ? 'muted' : 'dim';
  }
}

function shortTarget(t: string): string {
  const last = t.split('/').filter(Boolean).pop() ?? t;
  return last.length > 24 ? last.slice(0, 21) + '…' : last;
}

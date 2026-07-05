/** The pixel office — a holographic room JARVIS renders of itself. Every
 * animation is a pure function of the real event stream: droids walk to the
 * station matching their actual activity. */

import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { FURNITURE, floorTile, tex } from './pixels';
import { AgentActor } from './actors';

const TILE = 16;
const COLS = 20;
const ROWS = 12;
const NATIVE_W = COLS * TILE; // 320
const NATIVE_H = ROWS * TILE; // 192
const CORRIDOR_Y = 7 * TILE + 8;

const px = (tx: number, ty: number) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE - 2 });

/** where each activity happens (stand tiles) */
const STATIONS: Record<string, { x: number; y: number }> = {
  terminal: px(15.5, 3),
  vault_read: px(2.5, 3),
  vault_write: px(2.5, 3),
  research: px(13.5, 8),
  typing: px(0, 0), // resolved per-agent (own desk)
};

/** home/desk stand tiles per known agent; spares assigned to newcomers */
const SEATS: Record<string, { x: number; y: number }> = {
  jarvis: px(11.5, 6),
  coder: px(5.5, 8),
  researcher: px(13.5, 8),
  'vault-librarian': px(2.5, 3),
};
const SPARE_SEATS = [px(8.5, 9), px(17.5, 7), px(7.5, 5)];

const DROID_KIND: Record<string, string> = {
  jarvis: 'jarvis',
  coder: 'coder',
  researcher: 'researcher',
  'vault-librarian': 'vault-librarian',
};

interface OfficeEvent {
  agentId?: string;
  source?: string;
  state?: string;
  activity?: string;
  tool?: string;
  target?: string;
  message?: string;
}

export class Office {
  private app: Application | null = null;
  private world = new Container();
  private actors = new Map<string, AgentActor>();
  private spareIdx = 0;
  private animated: { sprite: Sprite; frames: Texture[]; ms: number; t: number }[] = [];
  private core: Sprite | null = null;
  private totem: { sprite: Sprite; bright: Texture; dim: Texture } | null = null;
  private voiceGlow: 'dim' | 'bright' | 'muted' = 'dim';
  private started = false;

  constructor(private onSelect: (agentId: string) => void) {}

  async mount(host: HTMLElement): Promise<void> {
    if (this.started) return;
    this.started = true;
    const app = new Application();
    await app.init({ backgroundAlpha: 0, antialias: false, resizeTo: host });
    (app.canvas as HTMLCanvasElement).style.imageRendering = 'pixelated';
    host.appendChild(app.canvas);
    this.app = app;

    this.world.sortableChildren = true;
    app.stage.addChild(this.world);
    this.buildRoom();
    this.spawn('jarvis');

    const fit = () => {
      const scale = Math.max(1, Math.floor(Math.min(app.screen.width / NATIVE_W, app.screen.height / NATIVE_H)));
      this.world.scale.set(scale);
      this.world.x = (app.screen.width - NATIVE_W * scale) / 2;
      this.world.y = (app.screen.height - NATIVE_H * scale) / 2;
    };
    fit();
    app.renderer.on('resize', fit);

    app.ticker.add((t) => {
      const dt = t.deltaMS;
      for (const a of this.actors.values()) a.update(dt);
      for (const f of this.animated) {
        f.t += dt;
        f.sprite.texture = f.frames[Math.floor(f.t / f.ms) % f.frames.length];
      }
      if (this.totem) {
        const pulse = this.voiceGlow === 'bright' && Math.floor(performance.now() / 180) % 2 === 0;
        this.totem.sprite.texture = this.voiceGlow === 'bright' && pulse ? this.totem.bright : this.totem.dim;
        this.totem.sprite.tint = this.voiceGlow === 'muted' ? 0xff8f9a : 0xffffff;
      }
    });
  }

  /* ── the room ─────────────────────────────────────────────────────── */

  private place(rows: string[], tx: number, ty: number, opts: { scale?: number; anim?: string[][]; ms?: number } = {}): Sprite {
    const frames = (opts.anim ?? [rows]).map((r) => tex(r));
    const s = new Sprite(frames[0]);
    s.anchor.set(0.5, 1);
    const p = px(tx, ty);
    s.x = p.x;
    s.y = p.y;
    s.scale.set(opts.scale ?? 1);
    s.zIndex = s.y - 4; // furniture sits just behind an actor on the same tile
    this.world.addChild(s);
    if (frames.length > 1) this.animated.push({ sprite: s, frames, ms: opts.ms ?? 700, t: Math.random() * 999 });
    return s;
  }

  private buildRoom(): void {
    // holographic projection frame — the room reads as a diorama JARVIS renders
    const frame = new Graphics()
      .roundRect(-5, -5, NATIVE_W + 10, NATIVE_H + 10, 4)
      .stroke({ color: 0x46e8ff, width: 1, alpha: 0.35 });
    for (const [cx, cy] of [[-5, -5], [NATIVE_W + 5, -5], [-5, NATIVE_H + 5], [NATIVE_W + 5, NATIVE_H + 5]] as const) {
      frame.moveTo(cx - 4, cy).lineTo(cx + 4, cy).stroke({ color: 0x46e8ff, width: 1, alpha: 0.8 });
      frame.moveTo(cx, cy - 4).lineTo(cx, cy + 4).stroke({ color: 0x46e8ff, width: 1, alpha: 0.8 });
    }
    frame.zIndex = -1100;
    this.world.addChild(frame);

    // floor
    for (let y = 1; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = Texture.from(floorTile(x * 31 + y * 17));
        t.source.scaleMode = 'nearest';
        const s = new Sprite(t);
        s.x = x * TILE;
        s.y = y * TILE;
        s.zIndex = -1000;
        this.world.addChild(s);
      }
    }
    // top wall band + windows
    const wall = new Graphics().rect(0, 0, NATIVE_W, TILE + 6).fill(0x071019);
    wall.zIndex = -900;
    this.world.addChild(wall);
    for (const wx of [4.5, 9.5, 14.5]) {
      const w = this.place(FURNITURE.window, wx, 0.9);
      w.zIndex = -890;
    }

    // stations
    this.place(FURNITURE.bookshelf, 1.5, 2);
    this.place(FURNITURE.bookshelf, 2.5, 2);
    this.place(FURNITURE.bookshelf, 3.5, 2);
    this.place(FURNITURE.rackA, 15.5, 2, { anim: [FURNITURE.rackA, FURNITURE.rackB], ms: 520 });
    this.place(FURNITURE.deskA, 5.5, 9, { anim: [FURNITURE.deskA, FURNITURE.deskB], ms: 900 });
    this.place(FURNITURE.deskA, 8.5, 10, { anim: [FURNITURE.deskB, FURNITURE.deskA], ms: 1100 });
    this.place(FURNITURE.globeA, 13.5, 9, { anim: [FURNITURE.globeA, FURNITURE.globeB], ms: 650 });
    this.core = this.place(FURNITURE.coreA, 10, 5.6, { scale: 2, anim: [FURNITURE.coreA, FURNITURE.coreB], ms: 800 });
    const totemDim = tex(FURNITURE.totemB);
    const totemBright = tex(FURNITURE.totemA);
    const totemSprite = this.place(FURNITURE.totemB, 7.6, 5.4);
    this.totem = { sprite: totemSprite, bright: totemBright, dim: totemDim };
    this.place(FURNITURE.plant, 0.9, 10.8);
    this.place(FURNITURE.plant, 18.9, 10.8);
    this.place(FURNITURE.plant, 18.9, 2);
  }

  /* ── actors ───────────────────────────────────────────────────────── */

  private spawn(agentId: string): AgentActor {
    let actor = this.actors.get(agentId);
    if (actor) return actor;
    const seat = SEATS[agentId] ?? SPARE_SEATS[this.spareIdx++ % SPARE_SEATS.length];
    actor = new AgentActor(agentId, DROID_KIND[agentId] ?? 'generic');
    actor.x = seat.x;
    actor.y = seat.y;
    actor.homeX = seat.x;
    actor.homeY = seat.y;
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
            ? STATIONS[ev.activity]
            : { x: actor.homeX, y: actor.homeY };
        if (station) actor.walkTo(station.x, station.y, CORRIDOR_Y);
        if (ev.tool) {
          const chip = ev.tool === 'Agent' ? `→ ${ev.target}` : `${ev.tool}${ev.target ? ' · ' + shortTarget(ev.target) : ''}`;
          actor.say(chip, 'tool');
        }
        break;
      }
      case 'talking':
        actor.clearBubble();
        if (ev.message) actor.say(ev.message, 'talk');
        break;
      case 'done':
        actor.clearBubble();
        actor.checkmark();
        actor.walkTo(actor.homeX, actor.homeY, CORRIDOR_Y);
        break;
      case 'error':
        actor.clearBubble();
        actor.flash(0xff4d5e);
        actor.say(ev.message ?? 'error', 'error');
        break;
      case 'idle':
        actor.clearBubble('think');
        actor.walkTo(actor.homeX, actor.homeY, CORRIDOR_Y);
        break;
    }
  }

  /** the core pillar mirrors the HUD reactor's temperature */
  setCoreMood(mood: 'thinking' | 'normal' | 'muted'): void {
    if (!this.core) return;
    this.core.tint = mood === 'thinking' ? 0xffc96b : mood === 'muted' ? 0x6a7f8a : 0xffffff;
  }

  setVoiceState(state: string): void {
    this.voiceGlow = state === 'listening' ? 'bright' : state === 'waiting' ? 'muted' : 'dim';
  }
}

function shortTarget(t: string): string {
  const last = t.split('/').filter(Boolean).pop() ?? t;
  return last.length > 24 ? last.slice(0, 21) + '…' : last;
}

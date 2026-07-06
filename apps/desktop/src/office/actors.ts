/** Agent actors driven by real events: CraftPix character rigs, path
 * walking, thought/talk/tool bubbles, error flash, done checkmark. */

import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Dir, Rig } from './rigs';

export type BubbleKind = 'talk' | 'tool' | 'think' | 'error';

const WALK_SPEED = 46; // native px/s
const BUBBLE_TTL: Record<BubbleKind, number> = { talk: 4500, tool: 2800, think: Infinity, error: 4500 };
const BUBBLE_BG: Record<BubbleKind, number> = {
  talk: 0x0b1d29, tool: 0x0b1d29, think: 0x231a08, error: 0x2a0d12,
};
const BUBBLE_BORDER: Record<BubbleKind, number> = {
  talk: 0x46e8ff, tool: 0x2a8fa5, think: 0xffc96b, error: 0xff4d5e,
};
const BUBBLE_FG: Record<BubbleKind, number> = {
  talk: 0xc9e9f2, tool: 0x9adff2, think: 0xffc96b, error: 0xff8f9a,
};

export class AgentActor extends Container {
  readonly agentId: string;
  private rig: Rig;
  private body: Sprite;
  private facing: Dir = 'front';
  private frameIdx = 0;
  private frameT = 0;

  private bubble: Container | null = null;
  private bubbleKind: BubbleKind | null = null;
  private bubbleUntil = 0;
  private thinkDots: Text | null = null;

  private waypoints: { x: number; y: number }[] = [];
  private moving = false;
  private spawnT = 600; // hologram materialize
  private animT = 0;
  private flashT = 0;
  private flashColor = 0xffffff;

  homeX = 0;
  homeY = 0;

  constructor(agentId: string, rig: Rig, tint?: number) {
    super();
    this.agentId = agentId;
    this.rig = rig;
    const first = rig.kind === 'walker' ? rig.idle.front[0] : rig.frames[0];
    this.body = new Sprite(first);
    this.body.anchor.set(0.5, 1);
    if (tint) this.body.tint = tint;
    this.addChild(this.body);

    const label = new Text({
      text: agentId.toUpperCase(),
      style: { fontFamily: 'Rajdhani, sans-serif', fontSize: 6, fontWeight: '600', fill: 0x9adff2, letterSpacing: 1 },
      resolution: 4,
    });
    label.anchor.set(0.5, 0);
    label.y = 1;
    this.addChild(label);

    this.eventMode = 'static';
    this.cursor = 'pointer';
  }

  get canWalk(): boolean {
    return this.rig.kind === 'walker';
  }

  setPath(points: { x: number; y: number }[]): void {
    if (!this.canWalk) return;
    this.waypoints = points;
    this.moving = points.length > 0;
  }

  /* ── bubbles (unchanged contract from phase 4) ── */
  say(text: string, kind: BubbleKind): void {
    this.clearBubble();
    const trimmed = text.length > 52 ? text.slice(0, 49) + '…' : text;
    const bubble = new Container();
    const label =
      kind === 'think'
        ? (this.thinkDots = new Text({
            text: '· · ·',
            style: { fontFamily: 'monospace', fontSize: 8, fill: BUBBLE_FG.think, fontWeight: '700' },
            resolution: 4,
          }))
        : new Text({
            text: trimmed,
            style: {
              fontFamily: '"Plex Mono", monospace', fontSize: 6, fill: BUBBLE_FG[kind],
              wordWrap: true, wordWrapWidth: 86, lineHeight: 8,
            },
            resolution: 4,
          });
    const padX = 4, padY = 3;
    const bg = new Graphics()
      .roundRect(0, 0, label.width + padX * 2, label.height + padY * 2, 3)
      .fill({ color: BUBBLE_BG[kind], alpha: 0.92 })
      .stroke({ color: BUBBLE_BORDER[kind], width: 0.75, alpha: 0.9 });
    bg.poly([6, label.height + padY * 2, 11, label.height + padY * 2, 6, label.height + padY * 2 + 4])
      .fill({ color: BUBBLE_BG[kind], alpha: 0.92 });
    label.x = padX;
    label.y = padY;
    bubble.addChild(bg, label);
    bubble.x = -6;
    bubble.y = -this.body.height - bubble.height - 4;
    this.addChild(bubble);
    this.bubble = bubble;
    this.bubbleKind = kind;
    this.bubbleUntil = performance.now() + BUBBLE_TTL[kind];
  }

  clearBubble(kind?: BubbleKind): void {
    if (kind && this.bubbleKind !== kind) return;
    this.bubble?.destroy();
    this.bubble = null;
    this.bubbleKind = null;
    this.thinkDots = null;
  }

  flash(color: number): void {
    this.flashT = 700;
    this.flashColor = color;
  }

  checkmark(): void {
    const check = new Text({
      text: '✓',
      style: { fontFamily: 'monospace', fontSize: 10, fill: 0xd8f7ff, fontWeight: '700' },
      resolution: 4,
    });
    check.anchor.set(0.5, 1);
    check.y = -this.body.height - 2;
    this.addChild(check);
    const t0 = performance.now();
    const rise = () => {
      const dt = performance.now() - t0;
      check.y = -this.body.height - 2 - dt / 60;
      check.alpha = Math.max(0, 1 - dt / 900);
      if (dt < 900) requestAnimationFrame(rise);
      else check.destroy();
    };
    requestAnimationFrame(rise);
  }

  /* ── per-frame ── */
  update(dtMs: number): void {
    this.animT += dtMs;
    this.frameT += dtMs;

    if (this.spawnT > 0) {
      this.spawnT -= dtMs;
      this.alpha = this.spawnT > 0 ? (Math.floor(this.animT / 60) % 2 ? 0.35 : 0.9) : 1;
    }

    if (this.rig.kind === 'fixed') {
      if (this.frameT > this.rig.frameMs) {
        this.frameT = 0;
        this.frameIdx = (this.frameIdx + 1) % this.rig.frames.length;
        this.body.texture = this.rig.frames[this.frameIdx];
      }
    } else {
      // movement along waypoints
      if (this.moving && this.waypoints.length) {
        const wp = this.waypoints[0];
        const dx = wp.x - this.x;
        const dy = wp.y - this.y;
        const dist = Math.hypot(dx, dy);
        const step = Math.max((WALK_SPEED * dtMs) / 1000, 1.2); // clean arrival, no sub-px jitter
        if (dist <= step) {
          this.x = wp.x;
          this.y = wp.y;
          this.waypoints.shift();
          if (!this.waypoints.length) this.moving = false;
        } else {
          this.x += (dx / dist) * step;
          this.y += (dy / dist) * step;
          this.facing =
            Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'back' : 'front';
        }
      }
      const frames = this.moving ? this.rig.walk[this.facing] : this.rig.idle[this.facing];
      const ms = this.moving ? 110 : 180;
      if (this.frameT > ms) {
        this.frameT = 0;
        this.frameIdx++;
      }
      this.body.texture = frames[this.frameIdx % frames.length];
    }

    if (this.flashT > 0) {
      this.flashT -= dtMs;
      this.body.tint = Math.floor(this.animT / 90) % 2 ? this.flashColor : 0xffffff;
      if (this.flashT <= 0) this.body.tint = 0xffffff;
    }

    if (this.bubble && performance.now() > this.bubbleUntil) this.clearBubble();
    if (this.thinkDots) {
      const n = Math.floor(this.animT / 350) % 3;
      this.thinkDots.text = ['·    ', '· ·  ', '· · ·'][n];
    }

    this.zIndex = this.y;
  }

  /** face the room's camera (used for idle-at-seat and waiting) */
  faceFront(): void {
    this.facing = 'front';
  }
}

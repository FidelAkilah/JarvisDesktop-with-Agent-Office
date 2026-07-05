/** Droid actors: walking, working, thinking, talking — driven only by real
 * events. One south-facing body, mirrored when walking left. */

import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { droidFrames, type DroidFrames } from './pixels';

export type BubbleKind = 'talk' | 'tool' | 'think' | 'error';

const WALK_SPEED = 42; // native px/s
const BUBBLE_TTL: Record<BubbleKind, number> = { talk: 4500, tool: 2600, think: Infinity, error: 4500 };
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
  private frames: DroidFrames;
  private body: Sprite;
  private bubble: Container | null = null;
  private bubbleKind: BubbleKind | null = null;
  private bubbleUntil = 0;
  private thinkDots: Text | null = null;

  private waypoints: { x: number; y: number }[] = [];
  private mode: 'idle' | 'walk' = 'idle';
  private animT = 0;
  private blinkAt = 1500 + Math.random() * 4000;
  private spawnT = 0; // hologram materialize
  private flashT = 0;
  private flashColor = 0xffffff;

  homeX = 0;
  homeY = 0;

  constructor(agentId: string, kind: string) {
    super();
    this.agentId = agentId;
    this.frames = droidFrames(kind);

    const shadow = new Graphics().ellipse(0, 0, 5.5, 2).fill({ color: 0x000000, alpha: 0.4 });
    shadow.y = -0.5;
    this.addChild(shadow);

    this.body = new Sprite(this.frames.stand);
    this.body.anchor.set(0.5, 1);
    this.addChild(this.body);

    const label = new Text({
      text: agentId.toUpperCase(),
      style: { fontFamily: 'Rajdhani, sans-serif', fontSize: 6, fontWeight: '600', fill: 0x4f7b8a, letterSpacing: 1 },
      resolution: 4,
    });
    label.anchor.set(0.5, 0);
    label.y = 2;
    this.addChild(label);

    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.spawnT = 500;
  }

  /* ── movement ── */
  walkTo(px: number, py: number, corridorY: number): void {
    const from = { x: this.x, y: this.y };
    if (Math.abs(from.x - px) < 2 && Math.abs(from.y - py) < 2) return;
    this.waypoints = [
      { x: from.x, y: corridorY },
      { x: px, y: corridorY },
      { x: px, y: py },
    ].filter((w, i, a) => {
      const prev = i === 0 ? from : a[i - 1];
      return Math.abs(prev.x - w.x) > 1 || Math.abs(prev.y - w.y) > 1;
    });
    if (this.waypoints.length) this.mode = 'walk';
  }

  /* ── bubbles ── */
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
    // tail
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

  /* ── reactions ── */
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

    // hologram materialize
    if (this.spawnT > 0) {
      this.spawnT -= dtMs;
      this.alpha = this.spawnT > 0 ? (Math.floor(this.animT / 60) % 2 ? 0.35 : 0.9) : 1;
      if (this.spawnT <= 0) this.alpha = 1;
    }

    // movement
    if (this.mode === 'walk' && this.waypoints.length) {
      const wp = this.waypoints[0];
      const dx = wp.x - this.x;
      const dy = wp.y - this.y;
      const dist = Math.hypot(dx, dy);
      const step = (WALK_SPEED * dtMs) / 1000;
      if (dist <= step) {
        this.x = wp.x;
        this.y = wp.y;
        this.waypoints.shift();
        if (!this.waypoints.length) this.mode = 'idle';
      } else {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
        if (Math.abs(dx) > 1) this.body.scale.x = dx < 0 ? -1 : 1;
      }
      this.body.texture = Math.floor(this.animT / 140) % 2 ? this.frames.walkA : this.frames.walkB;
    } else {
      // idle: soft bob + occasional blink
      this.body.texture = this.frames.stand;
      this.body.y = Math.sin(this.animT / 480) > 0.6 ? -1 : 0;
      this.blinkAt -= dtMs;
      if (this.blinkAt < 0) {
        this.body.texture = this.frames.blink;
        if (this.blinkAt < -140) this.blinkAt = 1800 + Math.random() * 4200;
      }
    }

    // error/done flash tint
    if (this.flashT > 0) {
      this.flashT -= dtMs;
      this.body.tint = Math.floor(this.animT / 90) % 2 ? this.flashColor : 0xffffff;
      if (this.flashT <= 0) this.body.tint = 0xffffff;
    }

    // bubbles
    if (this.bubble && performance.now() > this.bubbleUntil) this.clearBubble();
    if (this.thinkDots) {
      const n = Math.floor(this.animT / 350) % 3;
      this.thinkDots.text = ['·    ', '· ·  ', '· · ·'][n];
    }

    this.zIndex = this.y;
  }
}

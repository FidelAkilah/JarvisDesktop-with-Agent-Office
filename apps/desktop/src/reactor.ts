/** The arc reactor — the HUD's signature instrument. Everything it shows is
 * real: the waveform ring is live mic energy, rotation tempo and palette
 * follow the actual system state (gold = the brain is thinking). */

export type CoreState =
  | 'offline'
  | 'standby'
  | 'armed'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'muted';

const CYAN = { r: 70, g: 232, b: 255 };
const GOLD = { r: 255, g: 201, b: 107 };
const RED = { r: 255, g: 77, b: 94 };
const SLATE = { r: 79, g: 123, b: 138 };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Reactor {
  state: CoreState = 'offline';

  private ctx: CanvasRenderingContext2D;
  private levels = new Float32Array(96).fill(0.02); // live mic energy ring
  private head = 0;
  private smooth = 0.02;
  private tint = { ...SLATE };
  private glow = 0.3;
  private raf = 0;
  private t0 = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { clientWidth: w, clientHeight: h } = canvas;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    new ResizeObserver(fit).observe(canvas);
    fit();
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pushLevel(v: number): void {
    this.smooth = this.smooth * 0.6 + v * 0.4;
    this.levels[this.head] = this.smooth;
    this.head = (this.head + 1) % this.levels.length;
  }

  private targetTint() {
    switch (this.state) {
      case 'thinking': return GOLD;
      case 'muted': return RED;
      case 'offline': return SLATE;
      case 'standby': return SLATE;
      default: return CYAN;
    }
  }

  private targetGlow(): number {
    switch (this.state) {
      case 'offline': return 0.16;
      case 'standby': return 0.3;
      case 'armed': return 0.45;
      case 'muted': return 0.28;
      default: return 0.85;
    }
  }

  private draw(): void {
    const { ctx } = this;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const cx = w / 2;
    const cy = h / 2 - h * 0.03;
    const R = Math.min(w, h) * 0.31;
    const t = (performance.now() - this.t0) / 1000;

    // idle decay so the waveform settles when levels stop arriving
    this.levels[this.head] = this.smooth = this.smooth * 0.97;
    this.head = (this.head + 1) % this.levels.length;

    // ease palette + glow toward state targets
    const tgt = this.targetTint();
    this.tint.r = lerp(this.tint.r, tgt.r, 0.06);
    this.tint.g = lerp(this.tint.g, tgt.g, 0.06);
    this.tint.b = lerp(this.tint.b, tgt.b, 0.06);
    this.glow = lerp(this.glow, this.targetGlow(), 0.05);

    const col = (a: number) =>
      `rgba(${this.tint.r | 0},${this.tint.g | 0},${this.tint.b | 0},${a})`;

    ctx.clearRect(0, 0, w, h);

    const speed = this.state === 'thinking' ? 2.2 : this.state === 'listening' ? 1.5 : 1;

    // ── outer tick ring ──
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.08 * speed);
    for (let i = 0; i < 72; i++) {
      const major = i % 6 === 0;
      ctx.rotate((Math.PI * 2) / 72);
      ctx.strokeStyle = col(major ? 0.5 * this.glow + 0.1 : 0.22 * this.glow + 0.05);
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(R * 1.32, 0);
      ctx.lineTo(R * (major ? 1.38 : 1.35), 0);
      ctx.stroke();
    }
    ctx.restore();

    // ── dashed mid ring (counter-rotating) ──
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.14 * speed);
    ctx.setLineDash([Math.PI * R * 0.05, Math.PI * R * 0.028]);
    ctx.strokeStyle = col(0.3 * this.glow + 0.06);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // ── three arc segments ──
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.4 * speed);
    ctx.strokeStyle = col(0.65 * this.glow + 0.1);
    ctx.lineWidth = 2.4;
    ctx.shadowColor = col(0.8);
    ctx.shadowBlur = 12 * this.glow;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.1, (k * Math.PI * 2) / 3, (k * Math.PI * 2) / 3 + Math.PI * 0.42);
      ctx.stroke();
    }
    ctx.restore();

    // ── live waveform ring ──
    const n = this.levels.length;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineWidth = 2.2;
    for (let i = 0; i < n; i++) {
      let v = this.levels[(this.head + i) % n];
      if (this.state === 'speaking') {
        // no mic feed while talking — a synthetic cadence stands in
        v = 0.18 + 0.14 * Math.abs(Math.sin(t * 6 + i * 0.55)) * (0.6 + 0.4 * Math.sin(t * 1.7));
      } else if (this.state === 'thinking') {
        v = 0.08 + 0.06 * Math.abs(Math.sin(t * 2.4 + i * 0.22));
      }
      const len = Math.min(v, 1) * R * 0.34 + 1.5;
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      const alpha = 0.14 + Math.min(v, 1) * 0.75;
      ctx.strokeStyle = col(alpha * Math.max(this.glow, 0.35));
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * R * 0.86, Math.sin(ang) * R * 0.86);
      ctx.lineTo(Math.cos(ang) * (R * 0.86 + len), Math.sin(ang) * (R * 0.86 + len));
      ctx.stroke();
    }
    ctx.restore();

    // ── core disc ──
    const breathe =
      this.state === 'armed' || this.state === 'standby'
        ? 0.5 + 0.5 * Math.sin(t * 1.3)
        : this.state === 'listening'
          ? Math.min(this.smooth * 3, 1)
          : 0.55 + 0.45 * Math.sin(t * (this.state === 'thinking' ? 3.4 : 2));
    const coreR = R * 0.62 + breathe * R * 0.03;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    g.addColorStop(0, col(0.55 * this.glow + 0.18));
    g.addColorStop(0.55, col(0.22 * this.glow + 0.05));
    g.addColorStop(1, col(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    // inner ring
    ctx.strokeStyle = col(0.7 * this.glow + 0.12);
    ctx.lineWidth = 1.4;
    ctx.shadowColor = col(0.9);
    ctx.shadowBlur = 16 * this.glow;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

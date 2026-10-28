/**
 * ReelEngine — Pixi.js-based slot reel renderer.
 *
 * Replaces the CSS/img-grid reels with real scrolling symbol strips,
 * velocity motion blur, staggered bounce-settle stops, scatter
 * anticipation, and win-line overlays.
 *
 * Written against the installed pixi.js v7 API.
 *
 * Imperative API (via ref):
 *   engine.spin(finalSymbols, opts)  — start spinning; call stop per reel
 *   engine.stopReel(i)               — begin bounce-settle to final symbols
 *   engine.showWinLines(lines)       — animate payline overlays
 *   engine.clearWinLines()           — remove overlays
 *   engine.setAnticipation(i, on)    — glow a pending reel (2-scatter tease)
 *   engine.destroy()
 */

import { Application, Container, Sprite, Texture, Graphics } from "pixi.js";

export interface WinLine {
  positions: Array<[number, number]>; // [reel, row]
  color: number;
  payout?: number;
}

export interface SpinOptions {
  turbo?: boolean;
  stopDelays: number[]; // ms per reel
  onReelStopped?: (reelIndex: number) => void;
  onAllStopped?: () => void;
  anticipationReel?: number | null; // reel index to slow down for tease
}

const SYMBOL_KEYS = [
  "zeus",
  "thunderbolt",
  "pegasus",
  "temple",
  "harp",
  "amphora",
  "helmet",
  "shield",
  "ace",
  "king",
  "queen",
] as const;

const ROWS = 3;
const STRIP_EXTRA = 4; // symbols above the visible window per strip

function randomSymbolKey(): string {
  return SYMBOL_KEYS[Math.floor(Math.random() * SYMBOL_KEYS.length)];
}

export class ReelEngine {
  private app: Application;
  private host: HTMLElement;
  private reels: number;
  private reelContainers: Container[] = [];
  private strips: Sprite[][] = [];
  private stripPos: number[] = []; // float position along strip (in symbol units)
  private velocities: number[] = [];
  private states: Array<"idle" | "spinning" | "stopping" | "settling"> = [];
  private finalSymbols: string[][] = [[], [], [], [], []];
  private spinOpts: SpinOptions | null = null;
  private winLayer: Container;
  private winGlow: Graphics | null = null;
  private panels: Graphics[] = [];
  private symbolTextures = new Map<string, Texture>();
  private cellSize = 0;
  private anticipationReel: number | null = null;
  private destroyed = false;
  private reducedMotion: boolean;
  private resizeObserver: ResizeObserver | null = null;

  constructor(host: HTMLElement, reels = 5) {
    this.host = host;
    this.reels = reels;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Assigned in init(); declared with `!` to satisfy strict init checks.
    this.app = undefined as unknown as Application;
    this.winLayer = undefined as unknown as Container;
  }

  async init(): Promise<void> {
    // Guard: if layout hasn't given the host a size yet (fonts/CSR timing),
    // wait one frame and re-measure — otherwise cellSize computes to 0 and
    // the board renders invisible.
    if (this.host.clientWidth === 0 || this.host.clientHeight === 0) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    const w = this.host.clientWidth || 640;
    const h = this.host.clientHeight || 384;

    this.app = new Application({
      backgroundColor: 0x0a0a0f,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      width: w,
      height: h,
      resizeTo: this.host,
    });
    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }
    const view = this.app.view as HTMLCanvasElement;
    this.host.appendChild(view);
    view.style.display = "block";
    view.style.width = "100%";
    view.style.height = "100%";

    await this.loadTextures();
    this.buildReels();
    this.app.ticker.add(this.update);

    // Keep the canvas geometry in sync with layout changes
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.host);
    }

    // ?debug=1 exposes engine health in the tab title (remote diagnostics)
    if (new URLSearchParams(window.location.search).has("debug")) {
      document.title = `Zeus ${this.app.screen.width}x${this.app.screen.height} tex=${this.symbolTextures.size}`;
    }
  }

  private makeFallbackTexture(key: string): Texture {
    // Emergency tile: a symbol cell must NEVER render invisible. If the
    // artwork cannot be loaded (slow/blocked network, restrictive
    // webview), draw a gold-on-dark tile with the symbol's mark instead.
    const marks: Record<string, string> = {
      zeus: "ZE", thunderbolt: "\u03DF", pegasus: "PE", temple: "TE",
      harp: "HA", amphora: "AM", helmet: "HE", shield: "SH",
      ace: "A", king: "K", queen: "Q",
    };
    const mark = marks[key] ?? "?";
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const grad = ctx.createLinearGradient(0, 0, 0, size);
      grad.addColorStop(0, "#23202f");
      grad.addColorStop(1, "#12101c");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = "#d4af37";
      ctx.lineWidth = 6;
      ctx.strokeRect(10, 10, size - 20, size - 20);
      ctx.fillStyle = "#f4d03f";
      ctx.font = `bold ${mark.length > 1 ? 92 : 120}px Georgia, serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(mark, size / 2, size / 2 + 6);
    }
    return Texture.from(canvas);
  }

  private loadOneTexture(key: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const img = new Image();
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.symbolTextures.set(
          key,
          ok ? Texture.from(img) : this.makeFallbackTexture(key),
        );
        resolve();
      };
      const timer = setTimeout(() => finish(false), 8000);
      img.onload = () => { clearTimeout(timer); finish(true); };
      img.onerror = () => { clearTimeout(timer); finish(false); };
      img.src = `/assets/symbol-${key}.webp`;
    });
  }

  private async loadTextures(): Promise<void> {
    // U1: genuinely await every artwork image (8s per-image timeout,
    // canvas fallback on failure). Texture.from() used to be
    // fire-and-forget, so on slow networks or restrictive webviews the
    // sprites rendered invisible until (or unless) their image arrived
    // — the "blank board" players reported.
    await Promise.all(SYMBOL_KEYS.map((key) => this.loadOneTexture(key)));
  }

  private buildReels(): void {
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    this.cellSize = Math.min(width / this.reels, height / ROWS);

    const gapX = (width - this.cellSize * this.reels) / (this.reels + 1);
    const gapY = (height - this.cellSize * ROWS) / 2;

    this.winLayer = new Container();
    this.app.stage.addChild(this.winLayer);

    for (let r = 0; r < this.reels; r++) {
      // U1/G9: subtle per-column panel behind the strip so reels read as
      // distinct columns (previously one undifferentiated black slab).
      const panel = new Graphics();
      this.drawPanel(panel, gapX + r * (this.cellSize + gapX), gapY, this.cellSize);
      this.app.stage.addChild(panel);
      this.panels.push(panel);

      const container = new Container();
      container.x = gapX + r * (this.cellSize + gapX);
      container.y = gapY;

      // Clip to the visible window
      const mask = new Graphics();
      mask.beginFill(0xffffff, 1);
      mask.drawRect(0, 0, this.cellSize, this.cellSize * ROWS);
      mask.endFill();
      container.addChild(mask);
      container.mask = mask;

      const strip: Sprite[] = [];
      const count = ROWS + STRIP_EXTRA;
      for (let i = 0; i < count; i++) {
        const key = randomSymbolKey();
        const sprite = new Sprite(this.symbolTextures.get(key) ?? Texture.WHITE);
        sprite.width = this.cellSize * 0.82;
        sprite.height = this.cellSize * 0.82;
        sprite.x = this.cellSize * 0.09;
        sprite.y = (count - 1 - i) * this.cellSize + this.cellSize * 0.09;
        sprite.anchor.set(0, 0);
        container.addChild(sprite);
        strip.push(sprite);
      }

      this.app.stage.addChild(container);
      this.reelContainers.push(container);
      this.strips.push(strip);
      this.stripPos.push(0);
      this.velocities.push(0);
      this.states.push("idle");
    }
    // Win overlays render above the symbol sprites: the artwork has
    // opaque backgrounds, so lines/glow below the sprites never showed.
    this.app.stage.addChild(this.winLayer);
  }

  private drawPanel(g: Graphics, x: number, y: number, cell: number): void {
    g.clear();
    g.beginFill(0x101019, 0.9);
    g.lineStyle(1, 0x2a2a35, 0.7);
    g.drawRoundedRect(x - 4, y - 4, cell + 8, cell * ROWS + 8, 12);
    g.endFill();
  }

  /** Snap strips to display the given visible symbols. */
  private syncStripToSymbols(reel: number, symbols: string[]): void {
    const strip = this.strips[reel];
    const count = strip.length;
    // Bottom 3 sprites in the strip show the visible window: positions 2,1,0 from bottom
    for (let row = 0; row < ROWS; row++) {
      const spriteIndex = ROWS - 1 - row;
      const key = symbols[row] ?? randomSymbolKey();
      const tex = this.symbolTextures.get(key) ?? Texture.WHITE;
      strip[spriteIndex].texture = tex;
    }
    // Randomize the off-screen extra symbols
    for (let i = ROWS; i < count; i++) {
      strip[i].texture = this.symbolTextures.get(randomSymbolKey()) ?? Texture.WHITE;
    }
    this.stripPos[reel] = 0;
    this.applyStripOffset(reel);
  }

  private applyStripOffset(reel: number): void {
    const strip = this.strips[reel];
    const offset = this.stripPos[reel];
    for (let i = 0; i < strip.length; i++) {
      // strip index i sits at y = (len-1-i)*cell originally; scrolling down wraps
      let y = (strip.length - 1 - i) * this.cellSize + offset * this.cellSize;
      const total = strip.length * this.cellSize;
      y = (((y % total) + total) % total) - this.cellSize * STRIP_EXTRA;
      strip[i].y = y + this.cellSize * 0.09;
    }
  }

  /** Public: set the visible grid without spinning (initial state). */
  setSymbols(grid: string[][]): void {
    for (let r = 0; r < this.reels; r++) {
      this.syncStripToSymbols(r, grid[r] ?? []);
    }
  }

  /** Public: update the target symbols while reels are spinning. */
  setFinalSymbols(finalSymbols: string[][]): void {
    this.finalSymbols = finalSymbols;
  }

  /** Begin spinning all reels. Call stopReel(i) per reel after delays. */
  spin(finalSymbols: string[][], opts: SpinOptions): void {
    this.finalSymbols = finalSymbols;
    this.spinOpts = opts;
    this.anticipationReel = opts.anticipationReel ?? null;
    for (let r = 0; r < this.reels; r++) {
      this.states[r] = "spinning";
      this.velocities[r] = this.reducedMotion
        ? 4
        : opts.turbo
          ? 26
          : 20;
    }
  }

  /** Trigger the bounce-settle stop for a reel using eased decay. */
  stopReel(reel: number): void {
    if (this.states[reel] !== "spinning") return;
    this.states[reel] = "settling";
    const symbols = this.finalSymbols[reel] ?? [];

    // Let it scroll for a short settle window with decaying velocity, then snap.
    const settleMs = this.reducedMotion ? 40 : this.spinOpts?.turbo ? 90 : 130;
    const startVel = this.velocities[reel];
    const startTime = performance.now();

    const settle = (now: number) => {
      if (this.destroyed || this.states[reel] !== "settling") return;
      const t = Math.min((now - startTime) / settleMs, 1);
      // ease-out cubic decay of velocity
      this.velocities[reel] = startVel * (1 - t) * (1 - t);
      this.stripPos[reel] += (this.velocities[reel] * this.app.ticker.deltaMS) / 1000;
      this.applyStripOffset(reel);

      if (t >= 1) {
        // Snap to final symbols with a small overshoot bounce
        this.syncStripToSymbols(reel, symbols);
        const container = this.reelContainers[reel];
        const baseY = container.y;
        const overshoot = this.reducedMotion ? 0 : this.cellSize * 0.08;
        // Bounce: down-up-settle via ticker-free keyframes
        const bounceStart = performance.now();
        const bounceDur = this.reducedMotion ? 1 : 140;
        const bounce = (bNow: number) => {
          if (this.destroyed) return;
          const bt = Math.min((bNow - bounceStart) / bounceDur, 1);
          // sine overshoot then settle
          container.y = baseY + Math.sin(bt * Math.PI * 1.5) * overshoot * (1 - bt);
          if (bt < 1) {
            requestAnimationFrame(bounce);
          } else {
            container.y = baseY;
            this.states[reel] = "idle";
            this.velocities[reel] = 0;
            this.spinOpts?.onReelStopped?.(reel);
          }
        };
        requestAnimationFrame(bounce);
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }

  /** Highlight a reel pending stop (scatter anticipation). */
  setAnticipation(reel: number | null): void {
    this.anticipationReel = reel;
    for (let r = 0; r < this.reels; r++) {
      const c = this.reelContainers[r];
      if (r === reel) {
        c.alpha = 1;
        // pulsing handled in update()
      } else if (reel !== null) {
        c.alpha = 0.55; // dim others
      } else {
        c.alpha = 1;
      }
    }
  }

  /** Draw animated win-line overlays. */
  showWinLines(lines: WinLine[]): void {
    this.clearWinLines();
    for (const line of lines) {
      const g = new Graphics();
      const pts = line.positions.map(([r, row]) => {
        const x = this.reelContainers[r].x + this.cellSize / 2;
        const y = this.reelContainers[r].y + row * this.cellSize + this.cellSize / 2;
        return { x, y };
      });
      if (pts.length < 2) continue;
      g.lineStyle(5, line.color, 0.9, 0.5);
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      // Animated reveal: start fully transparent, ticker fades in
      g.alpha = 0;
      g.scale.set(1);
      (g as Graphics & { __reveal?: number }).__reveal = 0;
      this.winLayer.addChild(g);
    }
    // D2: pulsing highlight boxes over the winning symbols themselves.
    const glow = new Graphics();
    for (const line of lines) {
      for (const [r, row] of line.positions) {
        const x = this.reelContainers[r].x;
        const y = this.reelContainers[r].y + row * this.cellSize;
        glow.lineStyle(3, 0xffd54f, 0.95);
        glow.beginFill(0xffd54f, 0.13);
        glow.drawRoundedRect(x + 3, y + 3, this.cellSize - 6, this.cellSize - 6, 10);
        glow.endFill();
      }
    }
    this.winGlow = glow;
    this.winLayer.addChildAt(glow, 0);
  }

  clearWinLines(): void {
    this.winGlow = null;
    this.winLayer?.removeChildren().forEach((c) => c.destroy());
  }

  private update = (): void => {
    if (this.destroyed) return;

    for (let r = 0; r < this.reels; r++) {
      if (this.states[r] === "spinning") {
        let vel = this.velocities[r];
        // Slow the anticipation reel slightly for tension
        if (this.anticipationReel === r) vel *= 0.45;
        this.stripPos[r] += (vel * this.app.ticker.deltaMS) / 1000;
        this.applyStripOffset(r);
      }
    }

    // anticipation pulse on the pending reel
    if (this.anticipationReel !== null) {
      const c = this.reelContainers[this.anticipationReel];
      const t = this.app.ticker.lastTime / 1000;
      c.scale.set(1 + Math.sin(t * 6) * 0.015);
    }

    // D2: breathe the win-symbol glow while win lines are shown.
    if (this.winGlow) {
      const t = this.app.ticker.lastTime / 1000;
      this.winGlow.alpha = 0.6 + Math.sin(t * 5) * 0.4;
    }

    // fade win lines in, then pulse
    for (const child of this.winLayer?.children ?? []) {
      const g = child as Graphics & { __reveal?: number };
      g.__reveal = Math.min((g.__reveal ?? 0) + this.app.ticker.deltaMS / 300, 1);
      g.alpha = 0.65 + Math.sin(g.__reveal * Math.PI * 4) * 0.35;
    }
  };

  resize(): void {
    // Pixi resizeTo handles it; rebuild masks on significant change
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const newCell = Math.min(width / this.reels, height / ROWS);
    if (Math.abs(newCell - this.cellSize) > 8) {
      // rebuild layout positions
      this.cellSize = newCell;
      const gapX = (width - this.cellSize * this.reels) / (this.reels + 1);
      const gapY = (height - this.cellSize * ROWS) / 2;
      for (let r = 0; r < this.reels; r++) {
        this.reelContainers[r].x = gapX + r * (this.cellSize + gapX);
        this.reelContainers[r].y = gapY;
        if (this.panels[r]) {
          this.drawPanel(this.panels[r], this.reelContainers[r].x, gapY, this.cellSize);
        }
        for (const sprite of this.strips[r]) {
          sprite.width = this.cellSize * 0.82;
          sprite.height = this.cellSize * 0.82;
          sprite.x = this.cellSize * 0.09;
        }
        this.applyStripOffset(r);
      }
    }
  }

  isAllIdle(): boolean {
    return this.states.every((s) => s === "idle");
  }

  destroy(): void {
    this.destroyed = true;
    try {
      this.resizeObserver?.disconnect();
      this.app.ticker.remove(this.update);
      this.app.destroy(true, { children: true });
    } catch {
      // already destroyed
    }
  }
}

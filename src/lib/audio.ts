import { Howl, Howler } from "howler";

/**
 * Central audio manager for Zeus Slot.
 * Channels: music (looping beds/themes) + sfx (one-shots).
 * Volumes persist to localStorage. Howler auto-unlocks on first gesture.
 */

type Channel = "music" | "sfx";

const LS_KEY = "zeus.audio.v1";

interface AudioPrefs {
  enabled: boolean;
  master: number; // 0-100
  music: number; // 0-100
  sfx: number; // 0-100
}

const DEFAULTS: AudioPrefs = { enabled: true, master: 80, music: 55, sfx: 80 };

function loadPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

const CORE_SFX = [
  "ui-click",
  "reel-stop-1", "reel-stop-2", "reel-stop-3", "reel-stop-4", "reel-stop-5",
  "symbol-land", "win-small", "count-tick",
];

class SoundManager {
  private prefs: AudioPrefs = loadPrefs();
  private loops = new Map<string, Howl>();
  private pool = new Map<string, Howl>();
  private unlocked = false;
  private listeners = new Set<(prefs: AudioPrefs) => void>();

  constructor() {
    Howler.volume(this.effectiveMaster());
  }

  getPrefs(): AudioPrefs {
    return { ...this.prefs };
  }

  onChange(fn: (prefs: AudioPrefs) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.prefs));
    } catch {
      // ignore
    }
    this.listeners.forEach((fn) => fn({ ...this.prefs }));
  }

  /** 0-1 multiplier applied to a channel */
  private chGain(ch: Channel): number {
    if (!this.prefs.enabled) return 0;
    return (this.prefs.master / 100) * (this.prefs[ch] / 100);
  }

  private effectiveMaster(): number {
    return this.prefs.enabled ? this.prefs.master / 100 : 0;
  }

  /** Call once from a user gesture to allow autoplay. */
  unlock() {
    // U3: also resume a suspended AudioContext (mobile webviews suspend
    // it until a gesture lands in the right place) and warm the core SFX
    // pool so the first spin is not silent while files stream in.
    const ctx = (Howler as unknown as { ctx?: AudioContext }).ctx;
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => { /* a later gesture will retry */ });
    }
    if (this.unlocked) return;
    this.unlocked = true;
    Howler.volume(this.effectiveMaster());
    this.preloadCore();
  }

  /** Preload the small, every-spin sounds so play() never waits on I/O. */
  private preloadCore() {
    for (const name of CORE_SFX) {
      if (this.pool.has(name)) continue;
      this.pool.set(name, new Howl({
        src: [`/assets/audio/${name}.wav`],
        preload: true,
        volume: this.chGain("sfx"),
      }));
    }
  }

  setEnabled(on: boolean) {
    this.prefs.enabled = on;
    Howler.mute(!on);
    this.save();
    this.refreshLoops();
  }

  setMaster(v: number) {
    this.prefs.master = v;
    Howler.volume(this.effectiveMaster());
    this.save();
    this.refreshLoops();
  }

  setChannel(ch: Channel, v: number) {
    this.prefs[ch] = v;
    this.save();
    this.refreshLoops();
  }

  private refreshLoops() {
    this.loops.forEach((howl, key) => {
      const ch: Channel = key.startsWith("music") ? "music" : "sfx";
      howl.volume(this.chGain(ch));
    });
  }

  /** One-shot SFX from public/assets/audio */
  play(name: string, gain = 1) {
    if (!this.unlocked || !this.prefs.enabled) return;
    const volume = Math.min(1, this.chGain("sfx") * gain);
    // U3: pooled core sounds play instantly (already decoded); anything
    // else keeps the create-on-demand path for rare celebration sounds.
    const pooled = this.pool.get(name);
    if (pooled) {
      const id = pooled.play();
      pooled.volume(volume, id);
      return;
    }
    const howl = new Howl({
      src: [`/assets/audio/${name}.wav`],
      volume,
      preload: true,
    });
    howl.play();
    howl.once("end", () => howl.unload());
  }

  /** Start a named loop (idempotent). `file` may be an array of
   * formats for one sound (Howler picks the first the browser can
   * play — used by the base-game music: Opus with an AAC fallback). */
  startLoop(key: string, file: string | string[], ch: Channel = "sfx", gain = 1) {
    if (!this.unlocked || this.loops.has(key)) return;
    const files = Array.isArray(file) ? file : [file];
    const howl = new Howl({
      src: files.map((f) => `/assets/audio/${f}`),
      loop: true,
      volume: this.chGain(ch) * gain,
      preload: true,
    });
    howl.play();
    this.loops.set(key, howl);
  }

  stopLoop(key: string) {
    const howl = this.loops.get(key);
    if (howl) {
      howl.fade(howl.volume(), 0, 250);
      howl.once("fade", () => {
        howl.stop();
        howl.unload();
      });
      this.loops.delete(key);
    }
  }

  stopAllLoops() {
    this.loops.forEach((_, key) => this.stopLoop(key));
  }
}

export const audio = new SoundManager();

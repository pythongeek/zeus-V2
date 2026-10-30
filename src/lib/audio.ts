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
  // Dedicated background-music switch (owner, 2026-10-31): ON by
  // default; turning it off silences the music channel only and
  // leaves SFX and the player's music volume untouched.
  musicEnabled: boolean;
}

const DEFAULTS: AudioPrefs = { enabled: true, master: 80, music: 55, sfx: 80, musicEnabled: true };

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
  private loops = new Map<string, { howl: Howl; ch: Channel; gain: number }>();
  /** Music ducking during spins (owner, 2026-10-31): while the
   * reels roll, the music channel fades to a whisper so the reel
   * sounds own the mix; it swells back when the spin settles. */
  private musicDuck = 1;
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
    if (ch === "music" && !this.prefs.musicEnabled) return 0;
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
    if (!on) this.stopCelebrationSting(true);
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

  /** Background-music switch: silences/restores music loops in
   * place (they keep playing at gain 0, so re-enabling is instant). */
  setMusicEnabled(on: boolean) {
    this.prefs.musicEnabled = on;
    this.save();
    this.refreshLoops();
  }

  private sting: Howl | null = null;

  /** Win-celebration sting — the "Throne of the Storm" finale
   * (owner, 2026-10-31). Plays on the SFX channel while a big /
   * mega / jackpot celebration overlay is on screen; the game
   * stops it when the overlay closes. One-shot, ~11 s. */
  playCelebrationSting() {
    if (!this.prefs.enabled) return;
    this.stopCelebrationSting(true);
    const h = new Howl({
      src: ["/assets/audio/win-celebration.opus", "/assets/audio/win-celebration.m4a"],
      volume: this.chGain("sfx"),
      onend: () => {
        h.unload();
        if (this.sting === h) this.sting = null;
      },
    });
    this.sting = h;
    h.play();
  }

  stopCelebrationSting(immediate = false) {
    const h = this.sting;
    if (!h) return;
    this.sting = null;
    if (immediate) {
      try { h.stop(); } catch { /* already gone */ }
      h.unload();
      return;
    }
    try { h.fade(h.volume(), 0, 300); } catch { /* ignore */ }
    setTimeout(() => {
      try { h.stop(); } catch { /* ignore */ }
      h.unload();
    }, 350);
  }

  private loopVolume(ch: Channel, gain: number): number {
    return this.chGain(ch) * gain * (ch === "music" ? this.musicDuck : 1);
  }

  private refreshLoops() {
    this.loops.forEach(({ howl, ch, gain }) => {
      howl.volume(this.loopVolume(ch, gain));
    });
  }

  /** Fade the music bed down while reels spin (duck=true) and back
   * up when they settle. SFX loops are never ducked. */
  duckMusic(duck: boolean) {
    const target = duck ? 0.12 : 1;
    if (this.musicDuck === target) return;
    this.musicDuck = target;
    this.loops.forEach(({ howl, ch, gain }) => {
      if (ch !== "music") return;
      try { howl.fade(howl.volume(), this.loopVolume(ch, gain), 200); } catch { /* ignore */ }
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
      volume: this.loopVolume(ch, gain),
      preload: true,
    });
    howl.play();
    this.loops.set(key, { howl, ch, gain });
  }

  stopLoop(key: string) {
    const entry = this.loops.get(key);
    if (entry) {
      const { howl } = entry;
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

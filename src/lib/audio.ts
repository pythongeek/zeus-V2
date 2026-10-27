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

class SoundManager {
  private prefs: AudioPrefs = loadPrefs();
  private loops = new Map<string, Howl>();
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
    if (this.unlocked) return;
    this.unlocked = true;
    Howler.volume(this.effectiveMaster());
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
    const howl = new Howl({
      src: [`/assets/audio/${name}.wav`],
      volume: Math.min(1, this.chGain("sfx") * gain),
      preload: true,
    });
    howl.play();
    howl.once("end", () => howl.unload());
  }

  /** Start a named loop (idempotent). */
  startLoop(key: string, file: string, ch: Channel = "sfx", gain = 1) {
    if (!this.unlocked || this.loops.has(key)) return;
    const howl = new Howl({
      src: [`/assets/audio/${file}`],
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

import { Howl, Howler } from "howler";

/**
 * Central audio manager for Zeus Slot.
 * Channels: music (looping beds/themes) + sfx (one-shots).
 * Volumes persist to localStorage. Howler auto-unlocks on first gesture.
 *
 * Music reliability (owner report, 2026-11-01: "after some minutes it
 * makes noise no music"): the base bed is a 158 s loop — when its loop
 * seam ever fails (browser suspends the context, a decode hiccup, a
 * fade racing the seam) the bed stayed silent while the storm ambience
 * kept rustling, i.e. noise with no music. The music channel now has
 * three layers of defence:
 *   1. onplayerror / onend self-recovery on every music Howl;
 *   2. a 3 s watchdog that restarts (and, twice failed, fully
 *      recreates) any music loop that should be audible but isn't;
 *   3. auto-pause when the tab is hidden and resume when it returns,
 *      so mobile never kills the context mid-loop in the first place.
 *
 * Spin/sync behaviour (owner request, 2026-11-01): structured game
 * sounds (reel loop, anticipation, celebration sting) now *pause* the
 * music channel outright — fade to silence, suspend, and swell back
 * the moment the last of them ends — instead of ducking to a whisper.
 * Suppression is reference-counted with a 90 s failsafe, so no code
 * path can leave the music permanently muted again.
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

interface LoopEntry {
  howl: Howl;
  ch: Channel;
  gain: number;
  files: string[];
  /** consecutive watchdog-restart failures → triggers a full recreate */
  fails: number;
}

class SoundManager {
  private prefs: AudioPrefs = loadPrefs();
  private loops = new Map<string, LoopEntry>();
  /** Music-activity suppression (owner, 2026-11-01): while any key is
   * active here the music channel is faded to silence and paused —
   * the spin/animation sounds own the mix — and swells back the
   * moment the set empties. Reference-counted so overlapping sounds
   * (reel loop + celebration sting) can't resume the bed too early,
   * and a 90 s failsafe evicts stuck keys so the music can never be
   * lost for good (the old scalar `musicDuck` had exactly that bug). */
  private sfxActivity = new Map<string, number>();
  private pool = new Map<string, Howl>();
  private unlocked = false;
  private listeners = new Set<(prefs: AudioPrefs) => void>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private hidden = typeof document !== "undefined" && document.visibilityState === "hidden";

  constructor() {
    Howler.volume(this.effectiveMaster());
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        this.hidden = document.visibilityState === "hidden";
        if (this.hidden) this.pauseMusicLoops();
        else this.resumeMusicLoops();
      });
    }
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
    this.ensureWatchdog();
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
   * place (paused at gain 0, so re-enabling is instant). */
  setMusicEnabled(on: boolean) {
    this.prefs.musicEnabled = on;
    this.save();
    this.refreshLoops();
  }

  private sting: Howl | null = null;

  /** Win-celebration sting — the "Throne of the Storm" finale
   * (owner, 2026-10-31). Plays on the SFX channel while a big /
   * mega / jackpot celebration overlay is on screen; the game
   * stops it when the overlay closes. One-shot, ~11 s. The music
   * bed pauses for the duration and resumes automatically. */
  playCelebrationSting() {
    if (!this.prefs.enabled) return;
    this.stopCelebrationSting(true);
    this.suspendMusic("sting");
    const h = new Howl({
      src: ["/assets/audio/win-celebration.opus", "/assets/audio/win-celebration.m4a"],
      volume: this.chGain("sfx"),
      onend: () => {
        h.unload();
        if (this.sting === h) this.sting = null;
        this.resumeMusic("sting");
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
    } else {
      try { h.fade(h.volume(), 0, 300); } catch { /* ignore */ }
      setTimeout(() => {
        try { h.stop(); } catch { /* ignore */ }
        h.unload();
      }, 350);
    }
    this.resumeMusic("sting");
  }

  /** Final audible target for a loop: channel gain × mix gain, with
   * the music channel forced to 0 whenever it is suppressed. */
  private loopVolume(ch: Channel, gain: number): number {
    if (ch === "music" && this.musicSuppressed()) return 0;
    return this.chGain(ch) * gain;
  }

  /** Music is suppressed while any structured sound (spin, sting,
   * anticipation) is active — the bed is faded out and paused, then
   * swells back when the last one ends (owner request, 2026-11-01). */
  private musicSuppressed(): boolean {
    if (this.sfxActivity.size === 0) return false;
    // Failsafe: evict entries older than 90 s so a forgotten key can
    // never mute the music forever (the stuck-duck bug class).
    const now = Date.now();
    for (const [key, at] of this.sfxActivity) {
      if (now - at > 90_000) this.sfxActivity.delete(key);
    }
    return this.sfxActivity.size > 0;
  }

  suspendMusic(key: string) {
    const wasIdle = this.sfxActivity.size === 0;
    this.sfxActivity.set(key, Date.now());
    if (!wasIdle) return; // already silenced for another sound
    this.loops.forEach(({ howl, ch }) => {
      if (ch !== "music") return;
      try {
        if (howl.playing()) {
          const v = howl.volume();
          howl.fade(v, 0, 180);
          setTimeout(() => {
            try { if (this.musicSuppressed()) howl.pause(); } catch { /* gone */ }
          }, 200);
        } else {
          // Still loading: a queued play() would start the moment the
          // file decodes — pin it silent and paused so the spin sounds
          // stay alone even when the bed never got a chance to start.
          howl.volume(0);
          howl.pause();
        }
      } catch { /* ignore */ }
    });
  }

  resumeMusic(key: string) {
    this.sfxActivity.delete(key);
    if (this.sfxActivity.size > 0) return; // another sound still owns the mix
    this.resumeMusicLoops();
  }

  /** Back-compat wrapper for the spin paths (duck=true while the
   * reels roll, duck=false when they settle). */
  duckMusic(duck: boolean, key = "spin") {
    if (duck) this.suspendMusic(key);
    else this.resumeMusic(key);
  }

  /** Apply current prefs + suppression to every loop; music loops
   * are fully paused while inaudible so restart is instant and the
   * tab stays battery-friendly. */
  private refreshLoops() {
    this.loops.forEach(({ howl, ch, gain }) => {
      const target = this.loopVolume(ch, gain);
      const audible = target > 0;
      try {
        if (!audible) {
          if (howl.playing()) {
            howl.fade(howl.volume(), 0, 180);
            setTimeout(() => { try { howl.pause(); } catch { /* gone */ } }, 200);
          } else {
            howl.volume(0);
          }
        } else if (ch === "music") {
          const wasSilent = howl.volume() === 0;
          if (!howl.playing()) {
            howl.volume(this.hidden ? 0 : target);
            howl.play();
            if (wasSilent && !this.hidden) howl.fade(0, target, 350);
          } else if (wasSilent) {
            howl.fade(0, target, 350);
          } else {
            howl.volume(target);
          }
        } else {
          howl.volume(target);
        }
      } catch { /* loop may be mid-unload */ }
    });
  }

  /** Fade out + pause every music loop (tab hidden, or channel muted). */
  private pauseMusicLoops() {
    this.loops.forEach(({ howl, ch }) => {
      if (ch !== "music" || !howl.playing()) return;
      try {
        howl.fade(howl.volume(), 0, 250);
        setTimeout(() => {
          try {
            if (this.hidden || !this.prefs.musicEnabled || !this.prefs.enabled) howl.pause();
          } catch { /* gone */ }
        }, 280);
      } catch { /* ignore */ }
    });
  }

  /** Bring music back after visibility/mute/suppression clears. */
  private resumeMusicLoops() {
    if (this.hidden || !this.prefs.enabled || !this.prefs.musicEnabled) return;
    this.loops.forEach(({ howl, ch, gain }) => {
      if (ch !== "music" || this.musicSuppressed()) return;
      const target = this.chGain("music") * gain;
      try {
        if (!howl.playing()) {
          howl.volume(0);
          howl.play();
          howl.fade(0, target, 500);
        } else if (howl.volume() < target) {
          howl.fade(howl.volume(), target, 500);
        }
      } catch { /* ignore */ }
    });
  }

  /** 3 s watchdog — the "rotating infinitely" guarantee: any music
   * loop that should be audible right now but isn't playing gets
   * restarted; two consecutive failures recreate the Howl from
   * scratch (fresh decode), which recovers from every failure mode
   * we've seen (suspended context, dropped buffer, loop-seam stall). */
  private ensureWatchdog() {
    if (this.watchdog || typeof window === "undefined") return;
    this.watchdog = setInterval(() => {
      if (this.hidden) return; // loops are intentionally paused
      const ctx = (Howler as unknown as { ctx?: AudioContext }).ctx;
      if (ctx && ctx.state === "suspended") {
        void ctx.resume().catch(() => { /* next tick */ });
        return;
      }
      this.loops.forEach((entry, key) => {
        const { howl, ch, gain, files } = entry;
        if (ch !== "music") return;
        const target = this.chGain("music") * gain;
        if (target <= 0 || this.musicSuppressed()) {
          entry.fails = 0;
          // Enforce suppression: any music that slipped through (load
          // race) is faded out and paused here.
          try {
            if (howl.playing() && howl.volume() > 0.01) {
              howl.fade(howl.volume(), 0, 150);
              setTimeout(() => {
                try { if (this.musicSuppressed()) howl.pause(); } catch { /* gone */ }
              }, 180);
            }
          } catch { /* ignore */ }
          return;
        }
        if (howl.playing()) {
          entry.fails = 0;
          return;
        }
        entry.fails++;
        try {
          howl.volume(0);
          howl.play();
          howl.fade(0, target, 400);
          if (entry.fails < 3) return;
        } catch { /* fall through to recreate */ }
        // Full recreate: the underlying Howl is wedged.
        try { howl.stop(); howl.unload(); } catch { /* already gone */ }
        const fresh = this.buildMusicHowl(files, key, gain);
        this.loops.set(key, { ...entry, howl: fresh, fails: 0 });
      });
    }, 3000);
  }

  /** Create a music Howl with self-recovery handlers attached. */
  private buildMusicHowl(files: string[], key: string, gain: number): Howl {
    const target = this.chGain("music") * gain;
    const howl = new Howl({
      src: files.map((f) => `/assets/audio/${f}`),
      loop: true,
      volume: target,
      preload: true,
      html5: false,
      onplayerror: () => {
        // Decode/device errors: a fresh Howl with unlocked playback
        // recovers; Howler documents this exact dance.
        try {
          howl.stop();
          howl.unload();
        } catch { /* gone */ }
        if (this.loops.get(key)?.howl === howl) {
          this.loops.delete(key);
          this.startLoop(key, files, "music", gain);
        }
      },
      onend: () => {
        // loop:true should never end; if the browser drops the loop
        // at the seam, restart on the next tick (watchdog as backup).
        setTimeout(() => {
          try { if (!howl.playing() && target > 0 && !this.musicSuppressed()) howl.play(); } catch { /* watchdog will rebuild */ }
        }, 50);
      },
    });
    if (this.musicSuppressed() || this.hidden) {
      howl.pause();
      howl.volume(0);
    } else {
      howl.play();
    }
    return howl;
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
   * play — used by the base-game music: Opus with an AAC fallback).
   * Music-channel loops get the watchdog + self-recovery treatment. */
  startLoop(key: string, file: string | string[], ch: Channel = "sfx", gain = 1) {
    if (!this.unlocked || this.loops.has(key)) return;
    const files = Array.isArray(file) ? file : [file];
    let howl: Howl;
    if (ch === "music") {
      this.ensureWatchdog();
      howl = this.buildMusicHowl(files, key, gain);
    } else {
      howl = new Howl({
        src: files.map((f) => `/assets/audio/${f}`),
        loop: true,
        volume: this.loopVolume(ch, gain),
        preload: true,
      });
      howl.play();
    }
    this.loops.set(key, { howl, ch, gain, files, fails: 0 });
  }

  stopLoop(key: string) {
    const entry = this.loops.get(key);
    if (entry) {
      const { howl } = entry;
      let vol = 0;
      try { vol = howl.volume(); } catch { /* gone */ }
      if (vol <= 0.001) {
        // Already silent (suppressed/paused): a fade would never emit
        // its event — tear down immediately.
        try { howl.stop(); howl.unload(); } catch { /* gone */ }
      } else {
        howl.fade(vol, 0, 250);
        howl.once("fade", () => {
          howl.stop();
          howl.unload();
        });
      }
      this.loops.delete(key);
    }
  }

  stopAllLoops() {
    this.loops.forEach((_, key) => this.stopLoop(key));
    // Full teardown (logout/unmount) also resets the mix state — a
    // fresh mount must not inherit a stale suppression.
    this.sfxActivity.clear();
  }

  /** Support/ diagnostics snapshot (exposed as window.__zeusAudio). */
  debugState() {
    const loops: Record<string, { ch: Channel; playing: boolean; vol: number; fails: number }> = {};
    this.loops.forEach((e, k) => {
      loops[k] = { ch: e.ch, playing: (() => { try { return e.howl.playing(); } catch { return false; } })(), vol: (() => { try { return e.howl.volume(); } catch { return -1; } })(), fails: e.fails };
    });
    const ctx = (Howler as unknown as { ctx?: AudioContext }).ctx;
    return {
      unlocked: this.unlocked,
      prefs: { ...this.prefs },
      suppressed: [...this.sfxActivity.keys()],
      ctxState: ctx ? ctx.state : "none",
      hidden: this.hidden,
      loops,
    };
  }
}

export const audio = new SoundManager();

// Support hook: lets the owner (or QA) inspect the live mix from the
// console — window.__zeusAudio.debugState().
declare global {
  interface Window { __zeusAudio?: SoundManager }
}
if (typeof window !== "undefined") window.__zeusAudio = audio;

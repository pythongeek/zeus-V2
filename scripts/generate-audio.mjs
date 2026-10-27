/**
 * generate-audio.mjs — synthesizes the Zeus Slot sound set as WAV files.
 * Pure Node (no deps). All sounds are original, generated in-house.
 * Output: public/assets/audio/*.wav  + CREDITS.md handled separately.
 *
 * Usage: node scripts/generate-audio.mjs
 */
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

const SR = 22050; // sample rate (mono)
const OUT = path.resolve("public/assets/audio");
mkdirSync(OUT, { recursive: true });

// ---------- core helpers ----------
function writeWav(name, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  writeFileSync(path.join(OUT, name), buf);
  console.log(`  ${name} (${(n / SR).toFixed(2)}s)`);
}

const sec = (s) => Math.round(s * SR);
const zeros = (s) => new Float32Array(Math.max(0, Math.round(s)));

// deterministic PRNG
let seed = 42;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function addInto(dst, src, at = 0, gain = 1) {
  for (let i = 0; i < src.length; i++) {
    const j = at + i;
    if (j >= 0 && j < dst.length) dst[j] += src[i] * gain;
  }
}

function envAD(n, attack, decayCurve = 4) {
  const e = new Float32Array(n);
  const a = Math.round(attack * n);
  for (let i = 0; i < n; i++) {
    if (i < a) e[i] = i / a;
    else e[i] = Math.pow(1 - (i - a) / (n - a), decayCurve);
  }
  return e;
}

function sine(freq, n, detune = 0) {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    o[i] = Math.sin((2 * Math.PI * i * freq) / SR) + 0.4 * Math.sin((2 * Math.PI * i * (freq * 1.005 + detune)) / SR);
  }
  return o;
}

function saw(freq, n) {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * freq) / SR;
    o[i] = 2 * (p - Math.floor(p + 0.5));
  }
  return o;
}

function noise(n) {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = rnd() * 2 - 1;
  return o;
}

// one-pole lowpass
function lowpass(src, cutoff, dst) {
  const out = dst ?? new Float32Array(src.length);
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / SR;
  const alpha = dt / (rc + dt);
  let prev = 0;
  for (let i = 0; i < src.length; i++) {
    prev += alpha * (src[i] - prev);
    out[i] = prev;
  }
  return out;
}

function highpass(src, cutoff) {
  const lp = lowpass(src, cutoff);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] - lp[i] * 0.98;
  return out;
}

/** make a loop seamless: crossfade last `fade` samples onto the head */
function loopify(src, fadeSec = 0.05) {
  const f = sec(fadeSec);
  const out = new Float32Array(src.length - f);
  for (let i = 0; i < out.length; i++) out[i] = src[i];
  for (let i = 0; i < f; i++) {
    const t = i / f;
    out[i] = out[i] * t + src[src.length - f + i] * (1 - t);
  }
  return out;
}

function normalize(src, peak = 0.9) {
  let max = 0;
  for (let i = 0; i < src.length; i++) max = Math.max(max, Math.abs(src[i]));
  if (max === 0) return src;
  const g = peak / max;
  for (let i = 0; i < src.length; i++) src[i] *= g;
  return src;
}

const NOTE = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, Bb4: 466.16, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, C6: 1046.5 };

// ---------- sounds ----------

console.log("Generating sound set...");

// 1. UI click
{
  const n = sec(0.05);
  const s = noise(n);
  highpass(s, 1800);
  const ping = sine(1900, n);
  addInto(s, ping, 0, 0.5);
  for (let i = 0; i < n; i++) s[i] *= Math.pow(1 - i / n, 6);
  writeWav("ui-click.wav", normalize(s, 0.5));
}

// 2. reel spin loop (whirr)
{
  const raw = noise(sec(1.4));
  lowpass(raw, 900);
  const tone = sine(85, raw.length);
  addInto(raw, tone, 0, 0.6);
  // rhythmic pulses ~20/sec (symbol pass rate)
  const puls = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const phase = (i * 20) / SR;
    puls[i] = 0.5 + 0.5 * Math.sin(2 * Math.PI * phase);
  }
  for (let i = 0; i < raw.length; i++) raw[i] *= 0.6 + 0.4 * puls[i];
  writeWav("reel-spin-loop.wav", normalize(loopify(raw), 0.45));
}

// 3-7. reel stop ticks (ascending pitch per reel)
for (let reel = 0; reel < 5; reel++) {
  const n = sec(0.16);
  const f = 420 + reel * 130;
  const s = zeros(n);
  addInto(s, sine(f, n), 0, 0.9);
  addInto(s, sine(f * 2.01, n), 0, 0.3);
  const thud = noise(sec(0.03));
  lowpass(thud, 500);
  addInto(s, thud, 0, 0.8);
  for (let i = 0; i < n; i++) s[i] *= Math.pow(1 - i / n, 5);
  writeWav(`reel-stop-${reel + 1}.wav`, normalize(s, 0.65));
}

// 8. symbol land thud
{
  const n = sec(0.09);
  const s = zeros(n);
  addInto(s, sine(140, n), 0, 1);
  const nz = noise(n);
  lowpass(nz, 300);
  addInto(s, nz, 0, 0.7);
  for (let i = 0; i < n; i++) s[i] *= Math.pow(1 - i / n, 4);
  writeWav("symbol-land.wav", normalize(s, 0.6));
}

// 9. anticipation loop (heartbeat)
{
  const beat = (freq, dur) => {
    const n = sec(dur);
    const s = zeros(n);
    addInto(s, sine(freq, n), 0, 1);
    addInto(s, sine(freq * 1.5, n), 0, 0.3);
    for (let i = 0; i < n; i++) s[i] *= Math.pow(1 - i / n, 3);
    return s;
  };
  const s = zeros(sec(1.0));
  addInto(s, beat(70, 0.16), 0);
  addInto(s, beat(62, 0.14), sec(0.34));
  // riser tail
  const riser = saw(NOTE.C4 / 2, sec(0.4));
  lowpass(riser, 600);
  for (let i = 0; i < riser.length; i++) riser[i] *= i / riser.length;
  addInto(s, riser, sec(0.6), 0.25);
  writeWav("anticipation-loop.wav", normalize(loopify(s), 0.7));
}

// 10. win small (chime)
{
  const notes = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6];
  const s = zeros(sec(0.9));
  notes.forEach((f, i) => {
    const n = sec(0.5);
    const tone = sine(f, n);
    addInto(s, tone, sec(i * 0.11), 0.8 - i * 0.1);
  });
  for (let i = 0; i < s.length; i++) s[i] *= 0.9;
  writeWav("win-small.wav", normalize(s, 0.7));
}

// 11. count tick
{
  const n = sec(0.03);
  const s = zeros(n);
  addInto(s, sine(1300, n), 0, 0.7);
  addInto(s, sine(2600, n), 0, 0.3);
  for (let i = 0; i < n; i++) s[i] *= 1 - i / n;
  writeWav("count-tick.wav", normalize(s, 0.4));
}

// fanfare builder: notes with saw+sine pads and detune
function fanfare(notes, noteDur, gapSec, finalChord, finalDur) {
  const total = sec(gapSec * (notes.length - 1) + finalDur + 0.3);
  const s = zeros(total === 0 ? sec(1) : total);
  notes.forEach((f, i) => {
    const n = sec(noteDur);
    const tone = zeros(n);
    addInto(tone, saw(f, n), 0, 0.4);
    addInto(tone, sine(f, n), 0, 0.8);
    addInto(tone, sine(f * 2.002, n), 0, 0.15);
    lowpass(tone, 2600);
    const e = envAD(n, 0.15, 2.5);
    for (let j = 0; j < n; j++) tone[j] *= e[j];
    addInto(s, tone, sec(i * gapSec), 0.9);
    // snare-ish accent
    const hit = noise(sec(0.06));
    highpass(hit, 2500);
    addInto(s, hit, sec(i * gapSec), 0.25);
  });
  // final chord
  const cn = sec(finalDur);
  const chord = zeros(cn);
  finalChord.forEach((f) => {
    addInto(chord, saw(f, cn), 0, 0.22);
    addInto(chord, sine(f, cn), 0, 0.45);
    addInto(chord, sine(f * 2.003, cn), 0, 0.1);
  });
  lowpass(chord, 3200);
  const e = envAD(cn, 0.08, 2.2);
  for (let j = 0; j < cn; j++) chord[j] *= e[j];
  addInto(s, chord, sec(notes.length * gapSec), 1);
  return s;
}

// 12. win big
{
  const s = fanfare([NOTE.C5, NOTE.G5, NOTE.C6, NOTE.E5], 0.4, 0.22, [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6], 1.2);
  writeWav("win-big.wav", normalize(s, 0.85));
}

// 13. win mega
{
  const s = fanfare([NOTE.C5, NOTE.F5, NOTE.A5, NOTE.C6, NOTE.G5], 0.42, 0.24, [NOTE.C5, NOTE.F5, NOTE.A5, NOTE.C6, NOTE.F5], 1.6);
  // shimmer layer
  const sh = zeros(s.length);
  for (let i = 0; i < 30; i++) {
    const f = 2000 + rnd() * 2500;
    const n = sec(0.08);
    const ping = sine(f, n);
    for (let j = 0; j < n; j++) ping[j] *= 1 - j / n;
    addInto(sh, ping, sec(0.3 + rnd() * 1.8), 0.12);
  }
  addInto(s, sh, 0, 1);
  writeWav("win-mega.wav", normalize(s, 0.88));
}

// 14. win jackpot (epic)
{
  const riser = noise(sec(1.0));
  lowpass(riser, 400);
  for (let i = 0; i < riser.length; i++) {
    riser[i] *= Math.pow(i / riser.length, 2) * 2.2;
  }
  const body = fanfare(
    [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6, NOTE.D5, NOTE.E5],
    0.38,
    0.2,
    [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6, NOTE.E5],
    2.0,
  );
  const s = zeros(riser.length + body.length - sec(0.3));
  addInto(s, riser, 0, 1);
  addInto(s, body, sec(0.7), 1);
  writeWav("win-jackpot.wav", normalize(s, 0.92));
}

// 15. coin cascade
{
  const s = zeros(sec(1.5));
  for (let i = 0; i < 44; i++) {
    const f = 2200 + rnd() * 2800;
    const n = sec(0.05);
    const ping = zeros(n);
    addInto(ping, sine(f, n), 0, 1);
    addInto(ping, sine(f * 1.51, n), 0, 0.4);
    for (let j = 0; j < n; j++) ping[j] *= Math.pow(1 - j / n, 3);
    addInto(s, ping, sec(0.05 + rnd() * 1.15), 0.5);
  }
  writeWav("coin-cascade.wav", normalize(s, 0.6));
}

// 16. lightning crack
{
  const n = sec(1.3);
  const crack = noise(sec(0.07));
  highpass(crack, 1200);
  const rumble = noise(n);
  lowpass(rumble, 150);
  for (let i = 0; i < n; i++) rumble[i] *= Math.pow(1 - i / n, 1.6);
  const s = zeros(n);
  addInto(s, crack, 0, 1.0);
  addInto(s, rumble, sec(0.04), 0.9);
  writeWav("lightning-crack.wav", normalize(s, 0.9));
}

// 17. distant thunder
{
  const n = sec(2.2);
  const s = noise(n);
  lowpass(s, 110);
  for (let i = 0; i < n; i++) {
    const swell = Math.sin((Math.PI * i) / n);
    s[i] *= swell * swell;
  }
  writeWav("thunder-distant.wav", normalize(s, 0.55));
}

// 18. storm bed (loopable 12s)
{
  const raw = noise(sec(12.4));
  lowpass(raw, 1400); // rain hiss
  // slow amplitude waves
  for (let i = 0; i < raw.length; i++) {
    const t = i / SR;
    raw[i] *= 0.7 + 0.3 * Math.sin(2 * Math.PI * t / 6) + 0.15 * Math.sin(2 * Math.PI * t / 2.3);
  }
  // two baked distant rumbles
  const r1 = noise(sec(1.6));
  lowpass(r1, 130);
  for (let i = 0; i < r1.length; i++) r1[i] *= Math.sin((Math.PI * i) / r1.length) * 2.4;
  addInto(raw, r1, sec(3.2), 1);
  const r2 = noise(sec(1.4));
  lowpass(r2, 100);
  for (let i = 0; i < r2.length; i++) r2[i] *= Math.sin((Math.PI * i) / r2.length) * 2.0;
  addInto(raw, r2, sec(8.6), 1);
  writeWav("storm-bed.wav", normalize(loopify(raw, 0.3), 0.5));
}

// 19/20. music loops — dark epic pad progression Dm Bb F C Dm Bb Gm A
function musicLoop(intense) {
  const prog = intense
    ? [NOTE.D4, NOTE.Bb4, NOTE.F4, NOTE.A4]
    : [NOTE.D4, NOTE.Bb4, NOTE.F4, NOTE.C5];
  const chordDur = intense ? 2.6 : 3.4;
  const total = chordDur * prog.length;
  const s = zeros(sec(total));
  const bassGain = intense ? 0.7 : 0.5;
  const padGain = intense ? 0.4 : 0.3;
  const arpGain = intense ? 0.3 : 0.18;

  prog.forEach((root, ci) => {
    const chordTones = [root, root * 1.2, root * 1.5]; // minor-ish third + fifth
    if (ci === prog.length - 1 && !intense) chordTones[1] = root * 1.26; // major third on last
    const at = sec(ci * chordDur);
    const cn = sec(chordDur * 1.15);
    const pad = zeros(cn);
    chordTones.forEach((f) => {
      addInto(pad, saw(f / 2, cn), 0, 0.25);
      addInto(pad, sine(f, cn), 0, 0.35);
      addInto(pad, saw(f * 1.004, cn), 0, 0.2);
    });
    lowpass(pad, intense ? 1500 : 900);
    const e = envAD(cn, 0.3, 1.6);
    for (let j = 0; j < cn; j++) pad[j] *= e[j];
    addInto(s, pad, at, padGain);

    // bass
    const bn = sec(chordDur * 0.95);
    const bass = zeros(bn);
    addInto(bass, sine(root / 2, bn), 0, 0.9);
    addInto(bass, sine(root / 2 * 1.001, bn), 0, 0.4);
    const be = envAD(bn, 0.05, 1.4);
    for (let j = 0; j < bn; j++) bass[j] *= be[j];
    addInto(s, bass, at, bassGain);

    // arp plucks (8th notes)
    const step = chordDur / 8;
    for (let k = 0; k < 8; k++) {
      const f = chordTones[k % 3] * (k % 2 === 0 ? 2 : 1);
      const n = sec(0.14);
      const pluck = zeros(n);
      addInto(pluck, sine(f * 2, n), 0, 0.8);
      addInto(pluck, sine(f * 2.01, n), 0, 0.3);
      for (let j = 0; j < n; j++) pluck[j] *= Math.pow(1 - j / n, 4);
      addInto(s, pluck, sec(ci * chordDur + k * step), arpGain);
    }
  });
  return normalize(loopify(s, 0.25), intense ? 0.75 : 0.6);
}

writeWav("music-theme.wav", musicLoop(false));
writeWav("music-freespins.wav", musicLoop(true));

console.log("Done. Files in", OUT);

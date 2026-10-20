/*
 * Synthesised sounds and the music-edit helpers for the decide film, copied from the Agent Notch promo (audio/synth.mts,
 * plus 'sub' and 'keyclick' from its v7_synth.mts). Everything is synthesised; the music file stays gitignored.
 * Used by audio/mix.mts.
 */
import {writeFileSync, existsSync, unlinkSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {FPS, FPB, OFFSET_FRAMES, BPM, TRACK_DROP_S, TRACK_BPM, type MusicSeg} from '../src/timeline.ts';

export type Cue = {f: number; s: string; d?: number; v?: number; p?: number};
export const SR = 48000;
export const BEAT_S = 60 / BPM;
export const TAU = Math.PI * 2;

/* ---------- deterministic noise ---------- */
let seed = 1;
export const setSeed = (v: number) => { seed = v; };
export const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
export const noise = () => rnd() * 2 - 1;

/* ---------- buses ---------- */
export type Bus = {L: Float32Array; R: Float32Array};
export const bus = (n: number): Bus => ({L: new Float32Array(n), R: new Float32Array(n)});

/** Writes a mono voice into a bus with pan (-1..1) and an optional reverb send. */
export class Mix {
  dry: Bus; wet: Bus; n: number;
  constructor(n: number) { this.n = n; this.dry = bus(n); this.wet = bus(n); }
  put(t0: number, dur: number, fn: (t: number, i: number) => number, gain = 1, pan = 0, send = 0) {
    const s0 = Math.round(t0 * SR), len = Math.round(dur * SR);
    const gl = gain * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = gain * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
    for (let i = 0; i < len; i++) {
      const k = s0 + i;
      if (k < 0) continue;
      if (k >= this.n) break;
      const v = fn(i / SR, i);
      this.dry.L[k] += v * gl; this.dry.R[k] += v * gr;
      if (send) { this.wet.L[k] += v * gl * send; this.wet.R[k] += v * gr * send; }
    }
  }
}

/* ---------- filters ---------- */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  set(type: 'lp' | 'hp' | 'bp', f: number, q = 0.707) {
    const w = TAU * Math.min(f, SR * 0.45) / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
    let b0: number, b1: number, b2: number;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = a; b1 = 0; b2 = -a; }
    const a0 = 1 + a;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - a) / a0;
    return this;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export const saw = (ph: number) => 2 * (ph - Math.floor(ph + 0.5));
export const sq = (ph: number) => (ph - Math.floor(ph) < 0.5 ? 1 : -1);
const env = (t: number, a: number, d: number) => (t < a ? t / a : Math.exp(-(t - a) / d));
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/* ---------- instruments ---------- */
const kick = (m: Mix, t0: number, g = 1) => {
  let ph = 0;
  m.put(t0, 0.45, (t) => {
    const f = 45 + 110 * Math.exp(-t / 0.035);
    ph += f / SR;
    const click = t < 0.004 ? noise() * 0.5 * (1 - t / 0.004) : 0;
    return (Math.sin(TAU * ph) * Math.exp(-t / 0.16) + click) * 0.95;
  }, g);
};
const clap = (m: Mix, t0: number, g = 1) => {
  const bp = new Biquad().set('bp', 1400, 0.9);
  m.put(t0, 0.3, (t) => {
    const bursts = [0, 0.011, 0.022].reduce((s, o) => s + (t >= o ? Math.exp(-(t - o) / (o === 0.022 ? 0.09 : 0.008)) : 0), 0);
    return bp.run(noise()) * bursts * 1.6;
  }, g, 0.05, 0.25);
};
const hat = (m: Mix, t0: number, open: boolean, g = 1, pan = 0.25) => {
  const hp = new Biquad().set('hp', 7000, 0.8);
  m.put(t0, open ? 0.25 : 0.06, (t) => hp.run(noise()) * Math.exp(-t / (open ? 0.07 : 0.014)), g * 0.28, pan, 0.04);
};
const bassNote = (m: Mix, t0: number, f: number, dur: number, g = 1) => {
  const lp = new Biquad();
  let ph = 0, ph2 = 0;
  m.put(t0, dur, (t, i) => {
    if (i % 32 === 0) lp.set('lp', 180 + 900 * Math.exp(-t / 0.06), 1.1);
    ph += f / SR; ph2 += (f * 1.005) / SR;
    const v = saw(ph) * 0.6 + saw(ph2) * 0.4 + Math.sin(TAU * ph * 0.5) * 0.5;
    return lp.run(v) * env(t, 0.004, 0.18) * (t > dur - 0.01 ? (dur - t) / 0.01 : 1);
  }, g * 0.5);
};
const padChord = (m: Mix, t0: number, notes: number[], dur: number, g = 1, bright = 1) => {
  notes.forEach((n, k) => {
    [-0.09, 0.0, 0.08].forEach((det, j) => {
      const lp = new Biquad().set('lp', 900 * bright, 0.7);
      const f = mtof(n + det);
      let ph = rnd();
      m.put(t0, dur, (t) => {
        ph += f / SR;
        const a = Math.min(1, t / 0.35) * Math.min(1, (dur - t) / 0.4);
        return lp.run(saw(ph)) * a;
      }, g * 0.05, (j - 1) * 0.6 + (k - 1) * 0.1, 0.6);
    });
  });
};
const pluck = (m: Mix, t0: number, n: number, g = 1, pan = 0) => {
  const lp = new Biquad();
  const f = mtof(n);
  let ph = 0;
  m.put(t0, 0.35, (t, i) => {
    if (i % 32 === 0) lp.set('lp', 600 + 5000 * Math.exp(-t / 0.05), 1.4);
    ph += f / SR;
    return lp.run(sq(ph) * 0.6 + saw(ph * 2.0) * 0.3) * Math.exp(-t / 0.09);
  }, g * 0.16, pan, 0.45);
};
const tickSnd = (m: Mix, t0: number, g = 1, p = 1) => {
  m.put(t0, 0.05, (t) => Math.sin(TAU * 2600 * p * t) * Math.exp(-t / 0.006) + noise() * 0.2 * Math.exp(-t / 0.002), g * 0.5, 0.15, 0.15);
};
const thump = (m: Mix, t0: number, g = 1) => {
  let ph = 0;
  m.put(t0, 0.35, (t) => { ph += (40 + 50 * Math.exp(-t / 0.05)) / SR; return Math.sin(TAU * ph) * Math.exp(-t / 0.12); }, g);
};

/* ---------- SFX ---------- */
export const sfx = (m: Mix, c: Cue, t0: number) => {
  const v = c.v ?? 1, p = c.p ?? 1, d = (c.d ?? 8) / FPS;
  switch (c.s) {
    case 'whoosh': {
      const bp = new Biquad();
      const len = Math.max(0.18, d + 0.12);
      m.put(t0 - 0.06, len, (t, i) => {
        const x = t / len;
        if (i % 16 === 0) bp.set('bp', 250 * Math.pow(14, x), 1.2);
        const a = Math.sin(Math.PI * Math.pow(x, 0.8));
        return bp.run(noise()) * a * 1.8;
      }, v * 0.55, 0, 0.3);
      break;
    }
    case 'impact': {
      let ph = 0;
      const lp = new Biquad().set('lp', 900, 0.7);
      m.put(t0, 1.4, (t) => {
        ph += (32 + 90 * Math.exp(-t / 0.06)) / SR;
        return Math.sin(TAU * ph) * Math.exp(-t / 0.45) * 0.9 + lp.run(noise()) * Math.exp(-t / 0.12) * 0.7;
      }, v * 0.85, 0, 0.5);
      break;
    }
    case 'boom': {
      m.put(t0, 2.2, (t) => Math.sin(TAU * 38 * t) * Math.exp(-t / 0.7) * Math.min(1, t / 0.01), v * 0.55);
      break;
    }
    case 'click':
      m.put(t0, 0.03, (t) => (Math.sin(TAU * 3800 * t) * 0.6 + noise() * 0.5) * Math.exp(-t / 0.003), v * 0.55, 0.1, 0.1);
      break;
    case 'dclick':
      sfx(m, {...c, s: 'click'}, t0); sfx(m, {...c, s: 'click'}, t0 + 0.09);
      break;
    case 'key': {
      const bp = new Biquad().set('bp', 2400, 1.5);
      let ph = 0;
      m.put(t0, 0.09, (t) => { ph += 170 / SR; return bp.run(noise()) * Math.exp(-t / 0.01) * 1.4 + Math.sin(TAU * ph) * Math.exp(-t / 0.025) * 0.8; }, v * 0.6, -0.1, 0.12);
      break;
    }
    case 'tick':
      tickSnd(m, t0, v, p);
      break;
    case 'pop': {
      let ph = 0;
      m.put(t0, 0.12, (t) => { ph += (420 * p + 700 * p * Math.exp(-t / 0.015)) / SR; return Math.sin(TAU * ph) * Math.exp(-t / 0.03); }, v * 0.5, (p - 1.2) * 1.5, 0.2);
      break;
    }
    case 'glitch': {
      const steps = 9;
      for (let k = 0; k < steps; k++) {
        const f = 80 + rnd() * 1800, crush = 4 + Math.floor(rnd() * 12), on = rnd() > 0.25;
        if (!on) continue;
        let hold = 0, ph = 0;
        m.put(t0 + k * 0.028, 0.026, (t, i) => {
          ph += f / SR;
          if (i % crush === 0) hold = sq(ph) * 0.5 + noise() * 0.5;
          return hold;
        }, v * 0.32, rnd() * 1.4 - 0.7);
      }
      break;
    }
    case 'riser': {
      const hp = new Biquad();
      let ph = 0;
      m.put(t0, d, (t, i) => {
        const x = t / d;
        if (i % 16 === 0) hp.set('hp', 300 + 6000 * x * x, 0.9);
        ph += (180 + 900 * x * x) / SR;
        return (hp.run(noise()) * 0.8 + Math.sin(TAU * ph) * 0.25) * x * x;
      }, v * 0.6, 0, 0.3);
      break;
    }
    case 'thud': {
      let ph = 0;
      const lp = new Biquad().set('lp', 500, 0.7);
      m.put(t0, 0.9, (t) => {
        ph += (44 + 60 * Math.exp(-t / 0.04)) / SR;
        return Math.sin(TAU * ph) * Math.exp(-t / 0.22) + lp.run(noise()) * Math.exp(-t / 0.03) * 0.6;
      }, v * 0.9, 0, 0.55);
      break;
    }
    case 'beep':
      [0, 0.12].forEach((o) => m.put(t0 + o, 0.09, (t) => Math.sin(TAU * 988 * t) * Math.min(1, t / 0.004) * Math.min(1, (0.09 - t) / 0.01), v * 0.22, 0.2, 0.3));
      break;
    case 'chime': {
      const f = 660 * p;
      m.put(t0, 1.2, (t) => [1, 2.76, 5.4].reduce((s, h, k) => s + Math.sin(TAU * f * h * t) * Math.exp(-t / (0.5 / (k + 1))) / (k + 1.5), 0) * Math.min(1, t / 0.002), v * 0.4, 0, 0.5);
      break;
    }
    case 'buzz': {
      let ph1 = 0, ph2 = 0;
      const lp = new Biquad().set('lp', 2200, 0.9);
      m.put(t0, 0.7, (t) => {
        ph1 += 55 / SR; ph2 += 58.3 / SR;
        const raw = Math.tanh((saw(ph1) + saw(ph2)) * 2.5) + sq(t * (t < 0.2 ? 440 : 350)) * 0.25;
        return lp.run(raw) * Math.exp(-t / 0.3);
      }, v * 0.5, 0, 0.3);
      break;
    }
    case 'type': {
      for (let t = 0; t < d; t += 0.055 + rnd() * 0.03) sfx(m, {f: 0, s: 'key', v: v * (0.5 + rnd() * 0.4)}, t0 + t);
      break;
    }
    case 'approve': {
      [0, 0.07].forEach((o, k) => m.put(t0 + o, 0.22, (t) => {
        const f = (k ? 1318.5 : 987.8) * p;
        return (Math.sin(TAU * f * t) + Math.sin(TAU * f * 2 * t) * 0.2) * Math.min(1, t / 0.003) * Math.exp(-t / 0.07);
      }, v * 0.3, 0.15, 0.35));
      break;
    }
    case 'deny': {
      [0, 0.09].forEach((o, k) => {
        const lp = new Biquad().set('lp', 1800, 0.8);
        let ph = 0;
        m.put(t0 + o, 0.2, (t) => { ph += (k ? 233 : 311) / SR; return lp.run(sq(ph) * 0.5 + Math.sin(TAU * ph)) * Math.min(1, t / 0.003) * Math.exp(-t / 0.08); }, v * 0.3, -0.15, 0.25);
      });
      break;
    }
    case 'glass': {
      const f = 1567.98 * p;
      m.put(t0, 1.6, (t) => [1, 2.32, 4.25, 6.63].reduce((s, h, k) => s + Math.sin(TAU * f * h * t + k) * Math.exp(-t / (0.7 / (k + 1))) / (k + 1.2), 0) * Math.min(1, t / 0.001), v * 0.32, 0.2, 0.6);
      break;
    }
    case 'rewind': {
      const bp = new Biquad();
      let ph = 0;
      const len = 0.45;
      m.put(t0, len, (t, i) => {
        const x = t / len;
        if (i % 16 === 0) bp.set('bp', 3200 * Math.pow(0.12, x), 2);
        ph += (900 * Math.pow(0.2, x)) / SR;
        return (bp.run(noise()) * 1.2 + saw(ph) * 0.15) * Math.sin(Math.PI * x);
      }, v * 0.5, 0, 0.3);
      break;
    }
    case 'sub': {
      // sub-bass hit: sine dropping 62 -> 42 Hz, ~1 s
      let ph = 0;
      m.put(t0, 1.1, (t) => {
        ph += (42 + 20 * Math.exp(-t / 0.08)) / SR;
        return (Math.sin(TAU * ph) + Math.sin(TAU * ph * 2) * 0.12 * Math.exp(-t / 0.1)) * Math.min(1, t / 0.006) * Math.exp(-t / 0.38) * Math.min(1, (1.1 - t) / 0.15);
      }, v * 0.9, 0, 0.08);
      break;
    }
    case 'keyclick': {
      // a real laptop key: short travel click, brighter than 'key'
      const bp = new Biquad().set('bp', 3600, 1.3), lp = new Biquad().set('lp', 900, 0.8);
      let ph = 0, ph2 = 0;
      m.put(t0, 0.07, (t) => {
        ph += 1900 / SR; ph2 += 210 / SR;
        const top = bp.run(noise()) * Math.exp(-t / 0.004) * 1.5 + Math.sin(TAU * ph) * Math.exp(-t / 0.003) * 0.5;
        const bot = (t > 0.022 ? 1 : 0) * (lp.run(noise()) * 0.5 + Math.sin(TAU * ph2)) * Math.exp(-(t - 0.022) / 0.012) * 0.4; // bottom-out
        return top + bot;
      }, v * 0.5, -0.05, 0.1);
      break;
    }
    case 'swell': {
      const lp = new Biquad();
      m.put(t0, 0.7, (t, i) => {
        if (i % 16 === 0) lp.set('lp', 400 + 3000 * (t / 0.7), 0.8);
        return lp.run(noise()) * Math.sin(Math.PI * t / 0.7) * 0.8;
      }, v * 0.35, 0, 0.6);
      break;
    }
  }
};

/* ---------- reverb (Schroeder) ---------- */
export const reverb = (x: Float32Array, n: number, off: number, fb = 0.8) => {
  const out = new Float32Array(n);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({buf: new Float32Array(d + off), i: 0, fb, lp: 0}));
  const aps = [225, 556].map((d) => ({buf: new Float32Array(d + off), i: 0}));
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * 0.75 + c.lp * 0.25;
      c.buf[c.i] = x[k] + c.lp * c.fb;
      c.i = (c.i + 1) % c.buf.length;
      s += y;
    }
    s *= 0.25;
    for (const a of aps) {
      const b = a.buf[a.i];
      const y = -s + b;
      a.buf[a.i] = s + b * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      s = y;
    }
    out[k] = s;
  }
  return out;
};

/* ---------- music: the track, edited ---------- */
export const filmT = (beat: number) => (OFFSET_FRAMES + beat * FPB) / FPS; // exact, not frame-rounded
export const srcT = (beat: number) => TRACK_DROP_S + (beat * 60) / TRACK_BPM;

export const decode = (file: string): Bus | null => {
  if (!existsSync(file)) return null;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], {maxBuffer: 1 << 30});
  const n = raw.length / 8;
  const f = new Float32Array(raw.buffer, raw.byteOffset, n * 2);
  const out = bus(n);
  for (let k = 0; k < n; k++) { out.L[k] = f[2 * k]; out.R[k] = f[2 * k + 1]; }
  return out;
};

/** Copies track [s0, s0 + len) to film time t0 with raised-cosine fades (fi, fo seconds) at the ends. */
export const place = (dst: Bus, src: Bus, t0: number, s0: number, len: number, fi: number, fo: number) => {
  const a = Math.round(t0 * SR), b = Math.round(s0 * SR), n = Math.round(len * SR);
  const ni = Math.max(1, Math.round(fi * SR)), no = Math.max(1, Math.round(fo * SR));
  for (let i = 0; i < n; i++) {
    const k = a + i, j = b + i;
    if (k < 0 || j < 0) continue;
    if (k >= dst.L.length || j >= src.L.length) break;
    const g = (i < ni ? 0.5 - 0.5 * Math.cos((Math.PI * i) / ni) : 1) * (i > n - no ? 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / no) : 1);
    dst.L[k] += src.L[j] * g; dst.R[k] += src.R[j] * g;
  }
};

const XF = 0.01; // crossfade at every cut
export const editTrack = (dst: Bus, track: Bus, segs: MusicSeg[], hit?: number) => {
  const pts: string[] = [];
  segs.forEach((s, i) => {
    const prev = segs[i - 1], next = segs[i + 1];
    const joinedIn = prev && prev.to === s.from, joinedOut = next && next.from === s.to;
    let t0 = filmT(s.from), s0 = srcT(s.src);
    const t1 = filmT(s.to);
    if (s.from === 0) { s0 -= t0; t0 = 0; } // the film starts a few frames before beat 0
    const pre = joinedIn ? XF / 2 : 0, post = joinedOut ? XF / 2 : 0;
    // a hard cut (no neighbour) gets a 2 ms fade so the drop's attack survives; the film start fades in
    const fi = s.from === 0 ? 0.08 : joinedIn ? XF : 0.002;
    const fo = s.to === hit ? 0.03 : joinedOut ? XF : 0.002;
    place(dst, track, t0 - pre, s0 - pre, t1 - t0 + pre + post, fi, fo);
    pts.push(`film ${t0.toFixed(3)}-${t1.toFixed(3)} s <- track ${s0.toFixed(3)}-${(s0 + t1 - t0).toFixed(3)} s`);
  });
  return pts;
};

/* ---------- render ---------- */
export const writeWav = (file: string, L: Float32Array, R: Float32Array) => {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 8);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 8, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 8, 40);
  for (let k = 0; k < n; k++) { buf.writeFloatLE(L[k], 44 + k * 8); buf.writeFloatLE(R[k], 48 + k * 8); }
  writeFileSync(file, buf);
};

export const LUFS = -14, TP = -1.5;
export const ACCENTS = new Set(['impact', 'boom', 'thud', 'riser', 'swell', 'whoosh']);
export const measure = (file: string, extra = '') => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', `${extra}loudnorm=I=${LUFS}:TP=${TP}:LRA=11:print_format=json`, '-f', 'null', '-'], {encoding: 'utf8', maxBuffer: 1 << 26}).stderr;
  return JSON.parse(r.slice(r.lastIndexOf('{'), r.lastIndexOf('}') + 1));
};

/** The loudnorm master (second pass, linear) used by every film: raw wav in, mastered 16-bit wav out. */
export const master = (tmp: string, file: string, peakGuard = false) => {
  const m1 = measure(tmp);
  const ln = `loudnorm=I=${LUFS}:TP=${TP}:LRA=11:measured_I=${m1.input_i}:measured_TP=${m1.input_tp}:measured_LRA=${m1.input_lra}:measured_thresh=${m1.input_thresh}:offset=${m1.target_offset}:linear=true`;
  // Oversampled ceiling guard for v7: loudnorm's linear pass can overshoot its requested true peak.
  const guard = peakGuard ? `,aresample=192000,alimiter=limit=${Math.pow(10, (TP - 0.1) / 20)}:level=false:latency=true` : '';
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-af', `${ln}${guard},aresample=${SR}`, '-c:a', 'pcm_s16le', '-ar', String(SR), file]);
  if (r.status !== 0) throw new Error(`ffmpeg master failed: ${r.stderr}`);
  unlinkSync(tmp);
  return measure(file);
};

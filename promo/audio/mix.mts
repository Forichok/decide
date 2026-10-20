/*
 * The decide film soundtrack: public/music-suno-v2-4.wav (gitignored) edited to the beat grid in src/timeline.ts (MUSIC),
 * plus the synthesised UI sounds from cues(). Run: node audio/mix.mts  (Node >= 22.18, ffmpeg on PATH) -> public/audio/film.wav
 *
 * Beats 8-10 are a dead stop under "Your answers are.": no music, and the tails of earlier sounds are cut into it.
 * UI sounds duck the music (up to 6 dB); accents (impact, sub, whoosh ...) sit with it. Master: -14 LUFS, TP -1.5.
 */
import {mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {FPS, LEN, MUSIC, MUSIC_FILE, cues} from '../src/timeline.ts';
import {SR, setSeed, bus, Mix, sfx, reverb, filmT, srcT, decode, place, writeWav, ACCENTS, master, type Cue, type Bus} from './synth.mts';

const ACC = new Set<string>([...ACCENTS, 'sub']);

/** Locate the source attack in atempo's output; WSOLA can shift it by several milliseconds (Agent Notch v7). */
const alignAttack = (clip: Bus, track: Bus, source: number, expected: number) => {
  const src = Math.round(source * SR), guess = Math.round(expected * SR);
  if (src < 0) return expected;
  const width = Math.round(0.03 * SR), search = Math.round(0.04 * SR);
  let best = -Infinity, found = guess;
  for (let offset = Math.max(0, guess - search); offset <= Math.min(clip.L.length - width, guess + search); offset += 4) {
    let xy = 0, xx = 0, yy = 0;
    for (let k = 0; k < width && src + k < track.L.length; k += 4) {
      const x = track.L[src + k] + track.R[src + k], y = clip.L[offset + k] + clip.R[offset + k];
      xy += x * y; xx += x * x; yy += y * y;
    }
    const score = xy / Math.sqrt(Math.max(1e-20, xx * yy));
    if (score > best) { best = score; found = offset; }
  }
  if (best < 0.7) throw new Error(`Unable to align source attack ${source}: correlation ${best}`);
  return found / SR;
};

/** Each segment through atempo (pitch kept), its attack aligned, 40 ms crossfades where segments touch. */
const editMusic = (dst: Bus, track: Bus) => {
  const raw = Buffer.alloc(track.L.length * 8);
  for (let k = 0; k < track.L.length; k++) { raw.writeFloatLE(track.L[k], k * 8); raw.writeFloatLE(track.R[k], k * 8 + 4); }
  const pts: string[] = [];
  MUSIC.forEach((s, i) => {
    const rate = s.rate ?? 1;
    const joinedIn = MUSIC[i - 1]?.to === s.from, joinedOut = MUSIC[i + 1]?.from === s.to;
    let t0 = filmT(s.from), s0 = srcT(s.src);
    const t1 = filmT(s.to);
    if (s.from === 0) { s0 -= t0 * rate; t0 = 0; }
    const handle = Math.max(0, Math.min(0.25, s0 / rate));
    const start = Math.max(0, s0 - handle * rate);
    const finish = Math.min(track.L.length / SR, s0 + (t1 - t0 + 0.25) * rate);
    const filtered = execFileSync('ffmpeg', ['-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', 'pipe:0', '-af', `atempo=${rate}`, '-f', 'f32le', '-ac', '2', '-ar', String(SR), 'pipe:1'],
      {input: raw.subarray(Math.round(start * SR) * 8, Math.round(finish * SR) * 8), maxBuffer: 1 << 28});
    const clip = bus(filtered.length / 8);
    for (let k = 0; k < clip.L.length; k++) { clip.L[k] = filtered.readFloatLE(k * 8); clip.R[k] = filtered.readFloatLE(k * 8 + 4); }
    const xf = 0.04, pre = joinedIn ? xf / 2 : 0, post = joinedOut ? xf / 2 : 0;
    const fi = s.from === 0 ? 0.08 : joinedIn ? xf : 0.002;
    // the intro is cut hard into the dead stop (30 ms), the track's own ending plays out
    const fo = joinedOut ? xf : s.to === 8 ? 0.03 : 0.002;
    const expected = (s0 - start) / rate;
    const aligned = alignAttack(clip, track, s0, expected);
    place(dst, clip, t0 - pre, aligned - pre, t1 - t0 + pre + post, fi, fo);
    pts.push(`beats ${s.from}-${s.to} = film ${t0.toFixed(3)}-${t1.toFixed(3)} s <- track ${s0.toFixed(3)} s, rate ${rate.toFixed(6)}, attack ${((aligned - expected) * 1000).toFixed(2)} ms`);
  });
  return pts;
};

const render = (file: string) => {
  setSeed(7);
  const n = Math.round((LEN / FPS) * SR);
  const sfxMix = new Mix(n), accent = new Mix(n);
  const mus = bus(n);
  const track = decode(new URL(`../public/${MUSIC_FILE}`, import.meta.url).pathname);
  if (!track) throw new Error(`music file public/${MUSIC_FILE} is missing`);
  const edit = editMusic(mus, track);

  for (const c of cues()) sfx(ACC.has(c.s) ? accent : sfxMix, c as Cue, c.f / FPS);
  const wetL = reverb(sfxMix.wet.L, n, 0), wetR = reverb(sfxMix.wet.R, n, 23);
  const aWL = reverb(accent.wet.L, n, 0), aWR = reverb(accent.wet.R, n, 23);
  const sL = new Float32Array(n), sR = new Float32Array(n), aL = new Float32Array(n), aR = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    sL[k] = Math.tanh((sfxMix.dry.L[k] + wetL[k] * 0.9) * 0.6); sR[k] = Math.tanh((sfxMix.dry.R[k] + wetR[k] * 0.9) * 0.6);
    aL[k] = Math.tanh((accent.dry.L[k] + aWL[k] * 0.9) * 0.6); aR[k] = Math.tanh((accent.dry.R[k] + aWR[k] * 0.9) * 0.6);
  }
  // the dead stop: every tail is cut with a 30 ms fade into beat 8 and stays off until the drop at beat 10
  {
    const k1 = Math.round(filmT(8) * SR), k0 = k1 - Math.round(0.03 * SR), k2 = Math.round(filmT(10) * SR) - 4;
    for (let k = k0; k < k2; k++) {
      const g = k < k1 ? 0.5 + 0.5 * Math.cos((Math.PI * (k - k0)) / (k1 - k0)) : 0;
      sL[k] *= g; sR[k] *= g; aL[k] *= g; aR[k] *= g;
    }
  }
  // duck: follow the UI-sound level (5 ms attack, 180 ms release), pull the music down up to 6 dB
  const att = Math.exp(-1 / (0.005 * SR)), rel = Math.exp(-1 / (0.18 * SR));
  let e = 0;
  const L = new Float32Array(n), R = new Float32Array(n);
  const MUS = 0.85, SFX = 0.75;
  for (let k = 0; k < n; k++) {
    const x = Math.max(Math.abs(sL[k]), Math.abs(sR[k]));
    e = x > e ? att * e + (1 - att) * x : rel * e + (1 - rel) * x;
    const duck = 1 - 0.5 * Math.min(1, e / 0.25);
    L[k] = mus.L[k] * MUS * duck + (sL[k] + aL[k] * 0.8) * SFX;
    R[k] = mus.R[k] * MUS * duck + (sR[k] + aR[k] * 0.8) * SFX;
  }
  const tmp = file.replace(/\.wav$/, '.raw.wav');
  writeWav(tmp, L, R);
  const m = master(tmp, file, true);
  console.log(`${file}: ${(n / SR).toFixed(2)} s · ${m.input_i} LUFS · TP ${m.input_tp} dBTP · LRA ${m.input_lra}`);
  console.log('  music edit:\n  ' + edit.join('\n  '));
};

const out = new URL('../public/audio/', import.meta.url).pathname;
mkdirSync(out, {recursive: true});
render(out + 'film.wav');

/* Shared motion helpers, colours, the shot context (beats -> local frames) and the type roles. */
import React, {createContext, useContext} from 'react';
import {Easing, interpolate, useCurrentFrame} from 'remotion';
import {BODY, DISPLAY} from './fonts';
import {EV, FPB, type Placed, type ShotId, beatFrame} from './timeline';

/* decide's own dark theme (ui/css/tokens.css) */
export const C = {
  bg: '#050507',
  page: '#0c0c0f',
  text: '#f4f4f5',
  sub: '#a3a3ab',
  faint: '#5c5c64',
  pink: '#ff5d8f',
  pinkDeep: '#e8457a',
  violet: '#7c4dff',
  green: '#34d399',
};

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const easeIO = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.55, 0, 0.9, 0.4);
export const expoOut = Easing.bezier(0.16, 1, 0.3, 1);
export const lin = (t: number) => t;
export const range = (f: number, a: number, b: number, e: (t: number) => number = ease) =>
  interpolate(f, [a, b], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: e});
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ---------- shot context ---------- */
export const ShotCtx = createContext<Placed | null>(null);
/** Inside a shot: f = local frame, b(x) = local frame of in-shot beat x, ev.* = local frames of the named events. */
export const useShot = <K extends ShotId>(id: K) => {
  const p = useContext(ShotCtx)!;
  const f = useCurrentFrame();
  const b = (beat: number) => beatFrame(p.start + beat) - p.from;
  const evs = EV[id] as Record<string, number>;
  const ev = Object.fromEntries(Object.entries(evs).map(([k, v]) => [k, b(v)])) as {[P in keyof (typeof EV)[K]]: number};
  return {f, b, ev, len: p.to - p.from, fpb: FPB};
};

/* ---------- camera: page CSS point (fx, fy) lands on screen point (ax, ay) at s screen px per CSS px ---------- */
export type Cam = {s: number; fx: number; fy: number; ax: number; ay: number};
export type CamKey = Cam & {f: number; e?: (t: number) => number};
export const camAt = (frame: number, keys: CamKey[]): Cam => {
  if (frame <= keys[0].f) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (frame <= b.f) {
      const t = (b.e ?? easeIO)(clamp01((frame - a.f) / Math.max(1, b.f - a.f)));
      return {s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), t)), fx: lerp(a.fx, b.fx, t), fy: lerp(a.fy, b.fy, t), ax: lerp(a.ax, b.ax, t), ay: lerp(a.ay, b.ay, t)};
    }
  }
  return keys[keys.length - 1];
};

/* ---------- the decide mark (the app's favicon: pink rounded square, white check) ---------- */
export const Mark: React.FC<{size: number; round?: number; check?: number; glow?: number}> = ({size, round = 9 / 32, check = 1, glow = 0}) => (
  <div style={{width: size, height: size, borderRadius: size * round, background: `linear-gradient(160deg, ${C.pink}, ${C.pinkDeep})`, position: 'relative',
    boxShadow: glow > 0 ? `0 0 ${size * 0.9 * glow}px ${size * 0.15 * glow}px rgba(255,93,143,${0.55 * glow})` : undefined}}>
    {check > 0 && (
      <svg viewBox="0 0 32 32" width={size} height={size} style={{position: 'absolute', inset: 0}}>
        <path d="M10 16.5l4 4 8-9" fill="none" stroke="white" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - check} />
      </svg>
    )}
  </div>
);

/* ---------- type ---------- */
/** One caption at a time, beside the UI: a Geist headline (accent words in pink) and an optional Inter detail line. */
export const Caption: React.FC<{f: number; from: number; to: number; x: number; y: number; w?: number; size?: number; children: React.ReactNode; sub?: React.ReactNode; align?: 'left' | 'center' | 'right'}> = ({
  f, from, to, x, y, w, size = 76, children, sub, align = 'left',
}) => {
  if (f < from || f >= to) return null;
  const p = range(f, from, from + 10, expoOut);
  const out = range(f, to - 6, to, easeIn);
  const ps = range(f, from + 5, from + 15, expoOut);
  return (
    <div style={{position: 'absolute', left: x, top: y, width: w, textAlign: align, opacity: p * (1 - out),
      transform: `translateY(${(1 - p) * 22 - out * 8}px)`, filter: p < 0.98 ? `blur(${(1 - p) * 8}px)` : undefined, textShadow: '0 4px 40px rgba(0,0,0,0.6)'}}>
      <div style={{fontFamily: DISPLAY, fontWeight: 650, fontSize: size, letterSpacing: -size * 0.035, lineHeight: 1.04, color: C.text}}>{children}</div>
      {sub && <div style={{fontFamily: BODY, fontWeight: 500, fontSize: 32, color: C.sub, marginTop: 18, lineHeight: 1.3, opacity: ps}}>{sub}</div>}
    </div>
  );
};
export const Pink: React.FC<{children: React.ReactNode}> = ({children}) => <span style={{color: C.pink}}>{children}</span>;

/** "Dramatisation" corner label for staged or sped-up shots. */
export const Dramatisation: React.FC<{f: number; len: number; text?: string}> = ({f, len, text = 'DRAMATISATION · SPED UP'}) => (
  <div style={{position: 'absolute', right: 56, bottom: 40, fontFamily: BODY, fontWeight: 600, fontSize: 20, letterSpacing: 4, color: 'rgba(255,255,255,0.55)',
    opacity: range(f, 2, 10) * (1 - range(f, len - 6, len))}}>{text}</div>
);

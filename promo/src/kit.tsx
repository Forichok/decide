/* Drawn pieces that are not decide UI: the agent's terminal (text only), the pointer, a keycap, typed text. */
import React from 'react';
import {BODY, CODE} from './fonts';
import {C, clamp01, easeIO, lerp, range} from './lib';
import {typeBeat} from './timeline';

/* ---------- terminal ---------- */
export type Line = {k: 'user' | 'agent' | 'dim' | 'ok' | 'head'; text: React.ReactNode; a?: number};
export const Term: React.FC<{x: number; y: number; w: number; h: number; lines: Line[]; size?: number; lh?: number; title?: string; scale?: number; caret?: boolean; f?: number; opacity?: number; transform?: string; children?: React.ReactNode}> = ({
  x, y, w, h, lines, size = 26, lh = 1.45, title = 'agent — task-app', scale = 1, caret = false, f = 0, opacity = 1, transform, children,
}) => (
  <div style={{position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: 18, background: 'rgba(12,12,15,0.94)', overflow: 'hidden', opacity, transform,
    boxShadow: '0 40px 120px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.09)'}}>
    <div style={{height: 46, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 9, borderBottom: '1px solid rgba(255,255,255,0.06)'}}>
      {[0, 1, 2].map((i) => <div key={i} style={{width: 13, height: 13, borderRadius: '50%', background: '#2c2c33'}} />)}
      <div style={{flex: 1, textAlign: 'center', marginRight: 60, fontFamily: BODY, fontWeight: 500, fontSize: 17, color: C.faint}}>{title}</div>
    </div>
    <div style={{position: 'absolute', left: 30, top: 46 + 22, right: 30, transform: `scale(${scale})`, transformOrigin: '0 0', fontFamily: CODE, fontSize: size, lineHeight: lh}}>
      {lines.map((l, i) => (
        <div key={i} style={{opacity: l.a ?? 1, color: l.k === 'agent' ? C.text : l.k === 'user' ? C.text : l.k === 'ok' ? C.text : l.k === 'head' ? C.sub : C.faint, whiteSpace: 'pre-wrap', marginTop: l.k === 'user' || l.k === 'head' ? size * 0.5 : 0}}>
          {l.k === 'user' && <span style={{color: C.pink}}>› </span>}
          {l.k === 'ok' && <span style={{color: C.green}}>✓ </span>}
          {l.text}
          {caret && i === lines.length - 1 && <span style={{display: 'inline-block', width: size * 0.55, height: size * 1.05, background: Math.floor(f / 9) % 2 ? 'transparent' : C.text, verticalAlign: 'text-bottom', marginLeft: 2}} />}
        </div>
      ))}
    </div>
    {children}
  </div>
);

/** How much of `text` is typed at local frame f, with char k landing on beat typeBeat(a, b, n, k) (the key sounds use the same). */
export const typed = (f: number, bf: (beat: number) => number, a: number, b: number, text: string) => {
  let n = 0;
  for (let k = 0; k < text.length; k++) if (f >= bf(typeBeat(a, b, text.length, k))) n = k + 1;
  return text.slice(0, n);
};

/* ---------- pointer ---------- */
export const Cursor: React.FC<{x: number; y: number; press?: number; opacity?: number; size?: number}> = ({x, y, press = 0, opacity = 1, size = 46}) =>
  opacity <= 0.001 ? null : (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{position: 'absolute', left: x - size * 0.17, top: y - size * 0.08, opacity, transform: `scale(${1 - 0.15 * press})`,
      transformOrigin: `${size * 0.17}px ${size * 0.08}px`, filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.6))', overflow: 'visible'}}>
      <path d="M4 2 L4 19 L8.6 14.8 L11.6 21.6 L14.4 20.4 L11.4 13.8 L17.6 13.6 Z" fill="#fff" stroke="#000" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
/** Pointer gliding from a to b (arriving at `arrive`), pressing at `click`; returns position, press and a ripple phase. */
export const glide = (f: number, from: number, arrive: number, a: {x: number; y: number}, b: {x: number; y: number}, click: number) => {
  const p = range(f, from, arrive, easeIO);
  const arc = Math.sin(p * Math.PI);
  const press = range(f, click - 3, click) * (1 - range(f, click + 1, click + 6));
  return {x: lerp(a.x, b.x, p) + arc * 30, y: lerp(a.y, b.y, p) - arc * 20, press, op: range(f, from, from + 6), ripple: f >= click ? clamp01((f - click) / 18) : 0};
};
export const Ripple: React.FC<{x: number; y: number; t: number}> = ({x, y, t}) =>
  t <= 0 || t >= 1 ? null : (
    <div style={{position: 'absolute', left: x - 36, top: y - 36, width: 72, height: 72, borderRadius: '50%', border: `3px solid ${C.pink}`, opacity: (1 - t) * 0.9, transform: `scale(${0.3 + t * 1.3})`}} />
  );

/* ---------- keycap ---------- */
export const Keycap: React.FC<{children: React.ReactNode; pressed?: number; size?: number}> = ({children, pressed = 0, size = 92}) => (
  <div style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: size, height: size, padding: `0 ${size * 0.22}px`, borderRadius: size * 0.22, boxSizing: 'border-box',
    fontFamily: BODY, fontSize: size * 0.46, fontWeight: 600, color: C.text, background: pressed > 0.5 ? 'linear-gradient(#2c2c31, #232327)' : 'linear-gradient(#36363c, #26262b)',
    boxShadow: `0 ${size * 0.09 * (1 - pressed * 0.8)}px 0 #0b0b0d, 0 0 0 1px rgba(255,255,255,0.12) inset${pressed > 0.3 ? `, 0 0 ${size * 0.7}px rgba(255,93,143,0.5)` : ''}`,
    outline: pressed > 0.3 ? `2px solid ${C.pink}` : undefined, outlineOffset: 2, transform: `translateY(${pressed * size * 0.07}px)`}}>{children}</div>
);
/** Press envelope of a key hit at frame `at`. */
export const pressAt = (f: number, at: number, hold = 10) => range(f, at - 3, at) * (1 - range(f, at + hold, at + hold + 5));

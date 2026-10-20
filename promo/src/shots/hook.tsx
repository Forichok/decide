/*
 * are + drop: "Your answers are." holds the dead stop; on the drop its period turns pink and grows into the decide
 * mark, the line leaves, the mark takes its place beside the caption and the page rises out of the liquid.
 */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {DISPLAY} from '../fonts';
import {C, Caption, Mark, Pink, easeIO, expoOut, lerp, range, useShot} from '../lib';
import {Panel} from '../ui';

/* "Your answers are." is right-aligned so its period sits at a known point. */
const HOOK_SIZE = 150;
const RIGHT = 1550; // right edge of the line (the period's right side)
const BASE_Y = 500; // baseline-ish top of the line box
const DOT = HOOK_SIZE * 0.17; // the drawn period
export const DOT_X = RIGHT - DOT / 2;
export const DOT_Y = BASE_Y + HOOK_SIZE * 0.6;

const Line: React.FC<{text: string; a?: number; blur?: number; dx?: number}> = ({text, a = 1, blur = 0, dx = 0}) => (
  <div style={{position: 'absolute', right: 1920 - RIGHT + DOT * 1.25, top: BASE_Y - HOOK_SIZE * 0.25, fontFamily: DISPLAY, fontWeight: 650, fontSize: HOOK_SIZE,
    letterSpacing: -HOOK_SIZE * 0.04, lineHeight: 1, color: C.text, whiteSpace: 'nowrap', opacity: a, filter: blur > 0.05 ? `blur(${blur}px)` : undefined,
    transform: `translateX(${dx}px)`}}>{text}</div>
);
const Dot: React.FC<{color: string}> = ({color}) => (
  <div style={{position: 'absolute', left: DOT_X - DOT / 2, top: DOT_Y - DOT / 2, width: DOT, height: DOT, borderRadius: '50%', background: color}} />
);

export const Are: React.FC = () => {
  const {f} = useShot('are');
  const p = range(f, 0, 6, expoOut);
  return (
    <AbsoluteFill style={{background: C.bg}}>
      <div style={{position: 'absolute', inset: 0, opacity: p, transform: `scale(${1.04 - 0.04 * p})`}}>
        <Line text="Your answers are" />
        <Dot color={C.text} />
      </div>
    </AbsoluteFill>
  );
};

/* where the mark settles: beside the caption, left column */
const MARK_END = {x: 110 + 56, y: 380 + 56, size: 112};
export const DROP_CAM = {s: 0.8, fx: 720, fy: 450, ax: 1250, ay: 560};

export const Drop: React.FC = () => {
  const {f, ev, b, len} = useShot('drop');
  const end = 1 - range(f, len - 8, len);
  // 1. the period turns pink and grows to a big mark at its own spot
  const grow = range(f, ev.bloom, ev.bloom + 9, expoOut);
  // 2. the mark travels to the caption column while the page rises
  const go = range(f, ev.rise + 2, ev.rise + 20, easeIO);
  const big = 300;
  const size = lerp(lerp(DOT, big, grow), MARK_END.size, go);
  const cx = lerp(lerp(DOT_X, 960, grow), MARK_END.x, go);
  const cy = lerp(lerp(DOT_Y, 520, grow), MARK_END.y, go);
  const round = lerp(0.5, 9 / 32, range(f, 0, 6));
  const check = range(f, 5, 14, expoOut);
  const glow = 1.2 * Math.exp(-f / 10) + 0.25;
  // the line leaves left, out of focus
  const leave = range(f, 0, 9, expoOut);
  // the page
  const rise = range(f, ev.rise, ev.rise + 26, expoOut);
  const cam = {...DROP_CAM, ay: lerp(1500, DROP_CAM.ay, rise)};
  const tilt = lerp(-22, -7, rise);
  return (
    <AbsoluteFill>
      {leave < 1 && <Line text="Your answers are" a={1 - leave} blur={leave * 14} dx={-leave * 160} />}
      <Panel state="p-top" cam={cam} opacity={range(f, ev.rise, ev.rise + 6)} transform={`perspective(2400px) rotateY(${tilt}deg) rotateX(${lerp(10, 2, rise)}deg)`} radius={16} rim={0.6 * (1 - range(f, b(2), b(4)))} />
      {/* one soft ring leaves the mark on the drop */}
      {f < 26 && (() => {
        const r = lerp(40, 1100, range(f, 1, 26, expoOut));
        return <div style={{position: 'absolute', left: 960 - r, top: 520 - r, width: r * 2, height: r * 2, borderRadius: '50%', border: '3px solid rgba(255,93,143,0.8)',
          opacity: range(f, 0, 2) * (1 - range(f, 4, 26, (t) => t)), boxShadow: '0 0 60px rgba(255,93,143,0.5), inset 0 0 60px rgba(255,93,143,0.3)'}} />;
      })()}
      <div style={{position: 'absolute', left: cx - size * 1.6, top: cy - size * 1.6, width: size * 3.2, height: size * 3.2, borderRadius: '50%', opacity: Math.min(1, glow) * end,
        background: 'radial-gradient(closest-side, rgba(255,93,143,0.55), rgba(255,93,143,0))'}} />
      <div style={{position: 'absolute', left: cx - size / 2, top: cy - size / 2, opacity: end}}>
        <Mark size={size} round={round} check={check} />
      </div>
      <Caption f={f} from={ev.caption} to={len - 6} x={110} y={MARK_END.y + MARK_END.size / 2 + 40} w={540} size={80}>
        Answer like<br />you <Pink>mean it.</Pink>
      </Caption>
    </AbsoluteFill>
  );
};

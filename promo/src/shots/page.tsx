/*
 * The page round, shot by shot: pick (the agent's pick and why, key 1), see (mockups side by side, a click),
 * live (a live mockup ticked), ask (a question typed under the options) and done (the rest answered, review, send).
 * Every image is a captured state of the real page; the camera is anchored to the question card (cardCam).
 */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {BODY, DISPLAY} from '../fonts';
import {C, Caption, type Cam, Pink, easeIO, expoOut, lerp, range, useShot} from '../lib';
import {Cursor, Keycap, Ripple, glide, pressAt, typed} from '../kit';
import {EV, TYPED} from '../timeline';
import {Halo, PAGE_H, PAGE_W, Panel, box, toScreen, type Box} from '../ui';
import {CARD_CLIP, cardCam} from './reply';
import {DROP_CAM} from './hook';

const mixCam = (a: Cam, b: Cam, t: number): Cam => ({s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), t)), fx: lerp(a.fx, b.fx, t), fy: lerp(a.fy, b.fy, t), ax: lerp(a.ax, b.ax, t), ay: lerp(a.ay, b.ay, t)});
const mixBox = (a: Box, b: Box, t: number): Box => ({x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t)});
const FULL: Box = {x: 0, y: 0, w: PAGE_W, h: PAGE_H};
const center = (b: Box) => ({x: b.x + b.w / 2, y: b.y + b.h / 2});

/* ---------- pick ---------- */
export const Pick: React.FC = () => {
  const {f, ev, b, len} = useShot('pick');
  const picked = f >= ev.key;
  const state = picked ? 'p-goal-picked' : 'p-goal';
  // from the drop's tilted full page into the question card
  const t = range(f, 0, 18, easeIO);
  const A = cardCam('p-goal', 390, 600, 1.3, 1300, 540);
  const B = cardCam(state, 390, 640, 1.5, 1300, 560);
  const push = range(f, 18, b(5), easeIO);
  const cam = f < 18 ? mixCam({...DROP_CAM, fx: DROP_CAM.fx, fy: DROP_CAM.fy}, A, t) : mixCam(cardCam(state, 390, 600, 1.3, 1300, 540), B, push);
  const clip = mixBox(FULL, CARD_CLIP, t);
  const tilt = lerp(-7, 0, t);
  const opt = box(state, 'opt1');
  return (
    <AbsoluteFill>
      <Panel state={state} cam={cam} clip={clip} radius={lerp(16, 0, t)} fade={t > 0.5 ? [120, 160] : undefined} transform={`perspective(2400px) rotateY(${tilt}deg) rotateX(${lerp(2, 0, t)}deg)`} />
      {f < 4 && <Panel state="p-top" cam={DROP_CAM} opacity={1 - range(f, 0, 4)} radius={16} transform="perspective(2400px) rotateY(-7deg) rotateX(2deg)" />}
      <Halo cam={cam} b={opt} a={picked ? range(f, ev.key, ev.key + 4) * (1 - range(f, ev.key + 20, ev.key + 40)) : 0} radius={12} />
      <Caption f={f} from={8} to={len + 1} x={110} y={330} w={580} size={58}>
        Every option comes<br />with the agent's<br /><Pink>pick. And why.</Pink>
      </Caption>
      <div style={{position: 'absolute', left: 110, top: 640, opacity: range(f, ev.key - 12, ev.key - 4) * (1 - range(f, len - 6, len))}}>
        <Keycap pressed={pressAt(f, ev.key)}>1</Keycap>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- see ---------- */
export const See: React.FC = () => {
  const {f, ev, b, len} = useShot('see');
  const picked = f >= ev.click;
  const state = picked ? 'p-layout-picked' : 'p-layout';
  const today = box(state, 'today');
  const c = box(state, 'card');
  const tc = {x: today.x - c.x + today.w / 2, y: today.y - c.y + today.h / 2};
  const A = cardCam(state, 390, 420, 1.12, 1300, 540);
  const B = cardCam(state, tc.x, tc.y, 1.75, 1300, 540);
  const cam = mixCam(A, B, range(f, ev.click + 6, b(5.5), easeIO));
  // the clip narrows to the picked mockup as the camera pushes in, so nothing slides under the caption's column
  const clip = mixBox(CARD_CLIP, {x: today.x - 8, y: 0, w: today.w + 16, h: 805}, range(f, ev.click + 6, b(5.5), easeIO));
  const tgt = toScreen(cam, today.x + today.w / 2, today.y + 140);
  const g = glide(f, b(1), ev.click - 2, {x: 1900, y: 1000}, tgt, ev.click);
  return (
    <AbsoluteFill>
      <Panel state={state} cam={cam} clip={clip} radius={0} fade={[100, 140]} />
      <Halo cam={cam} b={today} a={picked ? range(f, ev.click, ev.click + 4) : 0} radius={10} pad={3} />
      <Ripple x={g.x} y={g.y} t={g.ripple} />
      <Cursor x={g.x} y={g.y} press={g.press} opacity={g.op * (1 - range(f, ev.click + 10, ev.click + 18))} />
      <Caption f={f} from={6} to={len - 6} x={110} y={420} w={640} size={76}>
        See what<br />you're <Pink>choosing.</Pink>
      </Caption>
    </AbsoluteFill>
  );
};

/* ---------- live ---------- */
export const Live: React.FC = () => {
  const {f, ev, len} = useShot('live');
  const ticked = f >= ev.tick;
  const state = ticked ? 'p-card-ticked' : 'p-card';
  const frame = box(state, 'frame');
  const c = box(state, 'card');
  const cam = mixCam(cardCam(state, 390, 300, 1.45, 1270, 520), cardCam(state, 390, 290, 1.62, 1270, 520), range(f, 0, len, (x) => x));
  const tick = toScreen(cam, 711, 409); // the task card's checkbox inside the live mockup (p-card-ticked)
  const g = glide(f, 8, ev.tick - 2, {x: 1880, y: 980}, tick, ev.tick);
  return (
    <AbsoluteFill>
      <Panel state={state} cam={cam} clip={{x: c.x - 14, y: c.y - 10, w: c.w + 28, h: c.h + 20}} radius={18 * cam.s} />
      <Halo cam={cam} b={frame} a={ticked ? range(f, ev.tick, ev.tick + 4) * (1 - range(f, ev.tick + 24, ev.tick + 44)) : 0} radius={8} pad={2} />
      <Ripple x={g.x} y={g.y} t={g.ripple} />
      <Cursor x={g.x} y={g.y} press={g.press} opacity={g.op * (1 - range(f, len - 8, len))} />
      <Caption f={f} from={4} to={len + 1} x={110} y={420} w={480} size={76}>
        The mockups<br />are <Pink>live.</Pink>
      </Caption>
    </AbsoluteFill>
  );
};

/* ---------- ask ---------- */
const TEXT = {x0: 521, x1: 672, y0: 414, y1: 442}; // the typed line in the ask box (p-ask-22, page px)
export const Ask: React.FC = () => {
  const {f, ev, b, len} = useShot('ask');
  const open = b(0.6);
  const sent = f >= ev.send;
  const state = f < open ? 'p-rollout' : sent ? 'p-ask-sent' : f >= ev.type ? 'p-ask-22' : 'p-ask-0';
  const flag = box('p-rollout', 'flag');
  const fc = box('p-rollout', 'card');
  // opens on the whole card, title to the flag, then pushes down into the ask box
  const A = cardCam(state, 390, 420, 1.1, 1250, 540);
  const B = cardCam(state, 390, 850, 1.6, 1250, 540);
  const cam = f < open ? A : mixCam(cardCam(state, 390, 420, 1.1, 1250, 540), B, range(f, open, open + 22, easeIO));
  const text = typed(f, b, EV.ask.type, EV.ask.typed, TYPED.ask);
  const share = text.length / TYPED.ask.length;
  const revealX = TEXT.x0 + (TEXT.x1 - TEXT.x0) * share;
  const p0 = toScreen(cam, revealX, TEXT.y0), p1 = toScreen(cam, TEXT.x1 + 4, TEXT.y1);
  return (
    <AbsoluteFill>
      <Panel state={state} cam={cam} clip={CARD_CLIP} radius={0} fade={[120, 160]} />
      {f < open && <Halo cam={cam} b={flag} a={range(f, 2, 6)} radius={12} />}
      {state === 'p-ask-22' && (
        <>
          <div style={{position: 'absolute', left: p0.x, top: p0.y, width: Math.max(0, p1.x - p0.x), height: p1.y - p0.y, background: '#15151a'}} />
          <div style={{position: 'absolute', left: p0.x + 1, top: p0.y + 2, width: 3, height: p1.y - p0.y - 4, background: Math.floor(f / 8) % 2 ? 'transparent' : C.text}} />
        </>
      )}
      <Caption f={f} from={4} to={len + 1} x={110} y={420} w={520} size={76}>
        Don't know?<br /><Pink>Ask.</Pink>
      </Caption>
      <div style={{position: 'absolute', left: 110, top: 640, display: 'flex', gap: 10, opacity: range(f, ev.send - 12, ev.send - 4) * (1 - range(f, len - 6, len))}}>
        <Keycap pressed={pressAt(f, ev.send)} size={76}>⌘</Keycap>
        <Keycap pressed={pressAt(f, ev.send)} size={76}>↵</Keycap>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- done ---------- */
const MONTAGE: [string, number][] = [['p-rollout-picked', -1], ['p-features', EV.done.features], ['p-order', EV.done.order], ['p-confidence', EV.done.confidence], ['p-migration', EV.done.migration]];
export const Done: React.FC = () => {
  const {f, ev, b, len} = useShot('done');
  let i = 0;
  while (i + 1 < MONTAGE.length && f >= b(MONTAGE[i + 1][1])) i++;
  const camOf = (st: string, k: number) => {
    if (k === 0) return cardCam(st, 390, 520, 1.62, 1170, 560); // where reply left it
    const c = box(st, 'card');
    return cardCam(st, 390, c.h / 2, 1.45, 1250, 540);
  };
  const tIn = i === 0 ? 1 : range(f, b(MONTAGE[i][1]), b(MONTAGE[i][1]) + 9, expoOut);
  const decided = 4 + i;
  const review = f >= ev.done;
  const handing = f >= ev.send;
  const doneState = f >= ev.received ? 'p-done' : 'p-handing';
  // the review modal: the whole page, centred on the modal
  const modal = box('p-review', 'modal');
  const RCAM: Cam = {s: 1.12, fx: center(modal).x, fy: center(modal).y, ax: 1180, ay: 540};
  const send = box('p-review', 'send');
  const g = glide(f, b(9), ev.send - 2, {x: 1880, y: 1040}, toScreen(RCAM, center(send).x, center(send).y), ev.send);
  // the done page: title and the exact answers
  const DCLIP: Box = {x: 340, y: 180, w: 760, h: 510};
  const DCAM: Cam = {s: 1.55, fx: 720, fy: 465, ax: 1240, ay: 560};
  const inRev = range(f, ev.done, ev.done + 10, expoOut);
  const inDone = range(f, ev.send, ev.send + 10, expoOut);
  return (
    <AbsoluteFill>
      {!review && (
        <>
          {i > 0 && tIn < 1 && <Panel state={MONTAGE[i - 1][0]} cam={camOf(MONTAGE[i - 1][0], i - 1)} clip={CARD_CLIP} radius={0} fade={[120, 160]} opacity={1 - tIn} transform={`translateY(${-tIn * 380}px)`} />}
          <Panel state={MONTAGE[i][0]} cam={camOf(MONTAGE[i][0], i)} clip={CARD_CLIP} radius={0} fade={[120, 160]} opacity={tIn} transform={`translateY(${(1 - tIn) * 380}px)`} />
          {i > 0 && <Halo cam={camOf(MONTAGE[i][0], i)} b={box(MONTAGE[i][0], 'card')} a={(1 - range(f, b(MONTAGE[i][1]) + 6, b(MONTAGE[i][1]) + 24)) * tIn} radius={16} pad={0} />}
          <div style={{position: 'absolute', left: 110, top: 380}}>
            <div style={{fontFamily: DISPLAY, fontWeight: 650, fontSize: 200, letterSpacing: -9, lineHeight: 1, color: decided === 8 ? C.green : C.text, fontVariantNumeric: 'tabular-nums',
              transform: `scale(${1 + 0.07 * (i > 0 ? Math.exp(-(f - b(MONTAGE[i][1])) / 5) : 0)})`, transformOrigin: '0 100%'}}>{decided}<span style={{color: C.faint, fontSize: 110}}>/8</span></div>
            <div style={{fontFamily: BODY, fontWeight: 500, fontSize: 34, color: C.sub, marginTop: 10}}>decided</div>
          </div>
        </>
      )}
      {review && !handing && (
        <>
          <Panel state="p-review" cam={{...RCAM, s: lerp(1.0, RCAM.s, inRev)}} radius={18} opacity={inRev} />
          <Ripple x={g.x} y={g.y} t={g.ripple} />
          <Cursor x={g.x} y={g.y} press={g.press} opacity={g.op} />
          <Caption f={f} from={ev.done + 4} to={ev.send} x={110} y={440} w={360} size={64}>
            Review.<br />Send.
          </Caption>
        </>
      )}
      {handing && (
        <>
          <Panel state={doneState} cam={{...DCAM, s: lerp(1.3, DCAM.s, inDone)}} clip={DCLIP} radius={20} opacity={inDone} rim={f >= ev.received ? 1 - range(f, ev.received, ev.received + 24) : 0} />
          <Caption f={f} from={ev.received} to={len + 1} x={110} y={420} w={420} size={76}>
            8 answered.<br /><Pink>23 to go.</Pink>
          </Caption>
        </>
      )}
    </AbsoluteFill>
  );
};

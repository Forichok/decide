/*
 * swipe: the set piece. 23 cards answered with the arrow keys on the beat (sped up, labelled), each card flies off
 * toward its side; the brief on the left is rewritten by the agent after every batch of four; card 11 fits neither
 * side and gets a typed answer. Every frame is a real captured state (capture/swipe.mjs); only the flight is drawn.
 */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {BODY, DISPLAY} from '../fonts';
import {C, Caption, Dramatisation, type Cam, easeIn, expoOut, range, useShot} from '../lib';
import {Panel, box, toScreen} from '../ui';
import {typed} from '../kit';
import {EV, SWIPE_PUSHED, SWIPE_SIDES, TYPED, swipeBeat} from '../timeline';

type Side = 'left' | 'right';
const PUSHED = new Set(SWIPE_PUSHED);
const nn = (k: number) => String(k).padStart(2, '0');

// layout: the deck column, big; the brief beside it
export const DECK_CLIP = {x: 585, y: 80, w: 636, h: 600};
export const DECK_CAM: Cam = {s: 1.5, fx: 585, fy: 80, ax: 600, ay: 36};
export const BRIEF_CAM: Cam = {s: 1.12, fx: 120, fy: 16, ax: 110, ay: 54};
const CARD_REGION = {x: 592, y: 229, w: 622, h: 304};
const FLY = 8; // frames a card is in flight

export const Swipe: React.FC = () => {
  const {f, b, len} = useShot('swipe');
  const ev = EV.swipe;
  const at = (k: number) => b(swipeBeat(k));
  // which card is answered last, and the state on screen
  let k = 0;
  while (k < 23 && f >= at(k + 1)) k++;
  let state = k === 0 ? 's-00' : `s-${nn(k)}`;
  if (k > 0 && PUSHED.has(k) && f >= at(k) + b(0.5) - b(0)) state = `s-${nn(k)}-pushed`;
  if (k === 23 && f >= at(23) + b(1.25) - b(0)) state = 's-end';
  // the own answer: Enter opens the field, the text is typed in two captured steps
  // the own answer: Enter opens the field; the captured full text is revealed char by char (same timing as the keys)
  const owningInput = k === 10 && f >= b(ev.ownAt);
  if (owningInput) state = 's-11-own-b';
  const ownText = typed(f, b, ev.ownType, ev.ownSend - 0.4, TYPED.own);
  const OWN_TEXT = {x0: 630, x1: 810, y0: 436, y1: 459};
  const rx = OWN_TEXT.x0 + (OWN_TEXT.x1 - 4 - OWN_TEXT.x0) * (ownText.length / TYPED.own.length);
  const q0 = toScreen(DECK_CAM, ownText.length ? rx : OWN_TEXT.x0, OWN_TEXT.y0), q1 = toScreen(DECK_CAM, OWN_TEXT.x1, OWN_TEXT.y1);
  // the card in flight: the previous state's card, toward its side
  const flying = k > 0 && f < at(k) + FLY ? k : 0;
  const prev = flying ? (flying === 1 ? 's-00' : PUSHED.has(flying - 1) ? `s-${nn(flying - 1)}-pushed` : `s-${nn(flying - 1)}`) : '';
  const flyFrom = flying === 11 ? 's-11-own-b' : prev;
  const fs = flying ? SWIPE_SIDES[flying - 1] : 'own';
  const dir = fs === 'own' ? 0 : fs === 'left' ? -1 : 1;
  const t = flying ? range(f, at(flying), at(flying) + FLY, easeIn) : 0;
  const rise = flying ? range(f, at(flying), at(flying) + FLY + 2, expoOut) : 1;
  // brief: lights when the agent pushes a rewrite
  const pushedAt = [...PUSHED].map((p) => at(p) + b(0.5) - b(0));
  const lastPush = pushedAt.filter((p) => f >= p).pop();
  const rim = lastPush === undefined ? 0 : 1 - range(f, lastPush, lastPush + 24);
  // arrows in the caption light on their key
  const ls = k > 0 ? SWIPE_SIDES[k - 1] : 'own';
  const lastSide: Side | null = ls === 'own' ? null : ls;
  const keyLit = k > 0 ? 1 - range(f, at(k), at(k) + 10) : 0;
  const owning = f >= b(ev.ownAt) && f < b(ev.ownSend + 1.5);
  const arrow = (s: Side) => ({color: lastSide === s && keyLit > 0 ? `rgba(255,93,143,${0.35 + 0.65 * keyLit})` : C.text});
  return (
    <AbsoluteFill>
      <Panel state={state} cam={DECK_CAM} clip={DECK_CLIP} radius={22} />
      {owningInput && (
        <>
          <div style={{position: 'absolute', left: q0.x, top: q0.y, width: Math.max(0, q1.x - q0.x), height: q1.y - q0.y, background: '#15151a'}} />
          <div style={{position: 'absolute', left: q0.x + 1, top: q0.y + 2, width: 3, height: q1.y - q0.y - 4, background: Math.floor(f / 8) % 2 ? 'transparent' : C.text}} />
        </>
      )}
      {flying > 0 && (
        <>
          {/* the next card comes up from under the one leaving */}
          <div style={{position: 'absolute', left: DECK_CAM.ax + (CARD_REGION.x - DECK_CAM.fx) * DECK_CAM.s, top: DECK_CAM.ay + (CARD_REGION.y - DECK_CAM.fy) * DECK_CAM.s,
            width: CARD_REGION.w * DECK_CAM.s, height: CARD_REGION.h * DECK_CAM.s, background: '#0a0a0d'}} />
          <Panel state={state} cam={DECK_CAM} clip={CARD_REGION} radius={18 * DECK_CAM.s} shadow={false} opacity={Math.min(1, rise * 2.5)} transform={`scale(${0.92 + 0.08 * rise})`} />
          <Panel state={flyFrom} cam={DECK_CAM} clip={CARD_REGION} radius={18 * DECK_CAM.s} opacity={1 - range(t, 0.6, 1, (x) => x)}
            transform={dir === 0 ? `translateY(${-t * 500}px) scale(${1 - 0.1 * t})` : `translateX(${dir * t * 1100}px) translateY(${t * 60}px) rotate(${dir * t * 14}deg)`} />
        </>
      )}
      {/* the brief sits above the flight: cards answered left tuck under it */}
      <Panel state={state} cam={BRIEF_CAM} clip={{...box(state, 'brief'), x: 120, y: 16, w: 330}} radius={16 * BRIEF_CAM.s} rim={rim} />
      <Dramatisation f={f} len={len} />
      {!owning ? (
        <Caption f={f} from={b(0.25)} to={len + 1} x={600} y={958} size={60}>
          <span style={arrow('left')}>←</span> no. <span style={arrow('right')}>→</span> yes.
        </Caption>
      ) : (
        <Caption f={f} from={b(ev.ownAt)} to={b(ev.ownSend + 1.5)} x={600} y={958} size={60}>
          Neither? Type your own.
        </Caption>
      )}
      <Counter f={f} left={23 - k} x={1640} y={560} />
    </AbsoluteFill>
  );
};

/** The through-line count: questions left, big, right of the deck. */
export const Counter: React.FC<{f: number; left: number; x: number; y: number}> = ({f, left, x, y}) => (
  <div style={{position: 'absolute', left: x, top: y, opacity: range(f, 0, 10), textAlign: 'left'}}>
    <div style={{fontFamily: DISPLAY, fontWeight: 650, fontSize: 150, letterSpacing: -6, lineHeight: 1, color: left === 0 ? C.green : C.text, fontVariantNumeric: 'tabular-nums'}}>{left}</div>
    <div style={{fontFamily: BODY, fontWeight: 500, fontSize: 30, color: C.sub, marginTop: 8}}>questions<br />left</div>
  </div>
);

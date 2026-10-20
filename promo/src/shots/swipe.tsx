/*
 * swipe: the set piece. 23 cards answered with the arrow keys on the beat (sped up, labelled), each card flies off
 * toward its side; the brief on the left is rewritten by the agent after every batch of four; card 11 fits neither
 * side and gets a typed answer. Every frame is a real captured state (capture/swipe.mjs); only the flight is drawn.
 */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import deck from '../../fixtures/home.deck.json';
import {BODY, DISPLAY} from '../fonts';
import {C, Caption, Dramatisation, type Cam, easeIn, expoOut, range, useShot} from '../lib';
import {Panel, box} from '../ui';

type Side = 'left' | 'right';
type Card = {id: string; recommended?: Side; left: unknown; right: unknown};
const CARDS = (deck as {cards: Card[]}).cards;
// same picks as capture/swipe.mjs
const AGAINST = new Set(['count', 'motion', 'beta']);
const OWN = new Set(['nodate']);
const sideOf = (c: Card): Side => (AGAINST.has(c.id) ? (c.recommended === 'left' ? 'right' : 'left') : c.recommended || 'left');
const PUSHED = new Set([4, 8, 12, 16, 20, 23]);
const nn = (k: number) => String(k).padStart(2, '0');

/** In-shot beat at which card k (1-based) is answered. */
export const answerBeat = (k: number, ev: {first: number; ownAt: number; ownSend: number}) => {
  if (k <= 10) return ev.first + (k - 1) * 0.95;
  if (k === 11) return ev.ownSend;
  return ev.ownSend + 0.5 + (k - 12) * 0.75;
};
export const SWIPE_EV = {first: 0.5, ownAt: 10, ownType: 10.5, ownSend: 13.5};

// layout: the deck column, big; the brief beside it
const DECK_CLIP = {x: 585, y: 80, w: 636, h: 600};
const DECK_CAM: Cam = {s: 1.5, fx: 585, fy: 80, ax: 600, ay: 36};
const BRIEF_CAM: Cam = {s: 1.12, fx: 120, fy: 16, ax: 110, ay: 54};
const CARD_REGION = {x: 592, y: 229, w: 622, h: 304};
const FLY = 8; // frames a card is in flight

export const Swipe: React.FC = () => {
  const {f, b, len} = useShot('swipe');
  const ev = SWIPE_EV;
  const at = (k: number) => b(answerBeat(k, ev));
  // which card is answered last, and the state on screen
  let k = 0;
  while (k < 23 && f >= at(k + 1)) k++;
  let state = k === 0 ? 's-00' : `s-${nn(k)}`;
  if (k > 0 && PUSHED.has(k) && f >= at(k) + b(0.5) - b(0)) state = `s-${nn(k)}-pushed`;
  if (k === 23 && f >= at(23) + b(1.25) - b(0)) state = 's-end';
  // the own answer: Enter opens the field, the text is typed in two captured steps
  if (k === 10 && f >= b(ev.ownAt)) state = f >= b(ev.ownType + 1.5) ? 's-11-own-b' : f >= b(ev.ownType) ? 's-11-own-a' : state;
  // the card in flight: the previous state's card, toward its side
  const flying = k > 0 && f < at(k) + FLY ? k : 0;
  const prev = flying ? (flying === 1 ? 's-00' : PUSHED.has(flying - 1) ? `s-${nn(flying - 1)}-pushed` : `s-${nn(flying - 1)}`) : '';
  const flyFrom = flying === 11 ? 's-11-own-b' : prev;
  const dir = flying ? (OWN.has(CARDS[flying - 1].id) ? 0 : sideOf(CARDS[flying - 1]) === 'left' ? -1 : 1) : 0;
  const t = flying ? range(f, at(flying), at(flying) + FLY, easeIn) : 0;
  const rise = flying ? range(f, at(flying), at(flying) + FLY + 2, expoOut) : 1;
  // brief: lights when the agent pushes a rewrite
  const pushedAt = [...PUSHED].map((p) => at(p) + b(0.5) - b(0));
  const lastPush = pushedAt.filter((p) => f >= p).pop();
  const rim = lastPush === undefined ? 0 : 1 - range(f, lastPush, lastPush + 24);
  // arrows in the caption light on their key
  const lastSide = k > 0 && !OWN.has(CARDS[k - 1].id) ? sideOf(CARDS[k - 1]) : null;
  const keyLit = k > 0 ? 1 - range(f, at(k), at(k) + 10) : 0;
  const owning = f >= b(ev.ownAt) && f < b(ev.ownSend + 1.5);
  const arrow = (s: Side) => ({color: lastSide === s && keyLit > 0 ? `rgba(255,93,143,${0.35 + 0.65 * keyLit})` : C.text});
  return (
    <AbsoluteFill>
      <Panel state={state} cam={DECK_CAM} clip={DECK_CLIP} radius={22} />
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
const Counter: React.FC<{f: number; left: number; x: number; y: number}> = ({f, left, x, y}) => (
  <div style={{position: 'absolute', left: x, top: y, opacity: range(f, 0, 10), textAlign: 'left'}}>
    <div style={{fontFamily: DISPLAY, fontWeight: 650, fontSize: 150, letterSpacing: -6, lineHeight: 1, color: left === 0 ? C.green : C.text, fontVariantNumeric: 'tabular-nums'}}>{left}</div>
    <div style={{fontFamily: BODY, fontWeight: 500, fontSize: 30, color: C.sub, marginTop: 8}}>questions<br />left</div>
  </div>
);

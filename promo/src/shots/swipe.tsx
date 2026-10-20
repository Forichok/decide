/*
 * swipe: the set piece. The deck answered with the arrow keys on the beat (sped up, labelled): one answer taken back
 * with ⌫, ↓ on the sync card and the agent's reply on the card, three follow-up cards the agent adds because of the
 * offline answer, one own answer typed, risks and a conflict in the brief, confidence 40 -> 96. Every frame is a real
 * captured state (capture/swipe.mjs -> src/swipe-steps.ts); only the card flights and the typing are drawn.
 */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {BODY, DISPLAY} from '../fonts';
import {C, Caption, Dramatisation, Pink, type Cam, easeIn, expoOut, range, useShot} from '../lib';
import {Halo, Panel, box, toScreen, type Box} from '../ui';
import {typed} from '../kit';
import {EV, SWIPE_BEATS, TYPED} from '../timeline';
import {SWIPE_STEPS} from '../swipe-steps';

// layout: the deck column, big; the brief beside it
export const DECK_CLIP = {x: 585, y: 80, w: 636, h: 610};
export const DECK_CAM: Cam = {s: 1.5, fx: 585, fy: 80, ax: 600, ay: 36};
export const BRIEF_CAM: Cam = {s: 1.12, fx: 120, fy: 16, ax: 110, ay: 54};
const FLY = 8; // frames a card is in flight
const BG = '#15151a'; // the input field's fill, under the typed text
// the typed line inside the ask and own fields (page px, measured on sw-12 and sw-26)
const ASK_TEXT = {x0: 629, x1: 764, y0: 343, y1: 364};
const OWN_TEXT = {x0: 629, x1: 809, y0: 436, y1: 457};

const cardOf = (i: number): Box | null => {
  for (let k = i; k >= 0; k--) {
    const b = boxOrNull(SWIPE_STEPS[k].name, 'card');
    if (b) return b;
  }
  return null;
};
const boxOrNull = (state: string, key: string) => {
  try {
    return box(state, key);
  } catch {
    return null;
  }
};

/** The typed text revealed char by char over the captured full line: cover the rest, draw the caret. */
const Typing: React.FC<{f: number; text: string; full: string; at: {x0: number; x1: number; y0: number; y1: number}}> = ({f, text, full, at}) => {
  const rx = at.x0 + (at.x1 - 4 - at.x0) * (text.length / full.length);
  const q0 = toScreen(DECK_CAM, text.length ? rx : at.x0, at.y0), q1 = toScreen(DECK_CAM, at.x1, at.y1);
  return (
    <>
      <div style={{position: 'absolute', left: q0.x, top: q0.y, width: Math.max(0, q1.x - q0.x), height: q1.y - q0.y, background: BG}} />
      <div style={{position: 'absolute', left: q0.x + 1, top: q0.y + 2, width: 3, height: q1.y - q0.y - 4, background: Math.floor(f / 8) % 2 ? 'transparent' : C.text}} />
    </>
  );
};

export const Swipe: React.FC = () => {
  const {f, b, len} = useShot('swipe');
  const ev = EV.swipe;
  const at = (i: number) => b(SWIPE_BEATS[i]);
  let i = 0;
  while (i < SWIPE_STEPS.length - 1 && f >= at(i + 1)) i++;
  const step = SWIPE_STEPS[i];
  const since = f - at(i);
  const prev = i > 0 ? SWIPE_STEPS[i - 1] : step;

  // a card in flight: an answer sends the previous front card off toward its side; ⌫ brings the card back
  const answering = step.act === 'answer' && i > 0 && since < FLY;
  const undoing = step.act === 'undo' && since < FLY + 2;
  const undoneSide = step.act === 'undo' ? [...SWIPE_STEPS.slice(0, i)].reverse().find((s) => s.act === 'answer')?.side : undefined;
  const base = undoing ? prev.name : step.name;
  const leaving = cardOf(i - 1), toBox = cardOf(i);
  const dir = step.side === 'own' ? 0 : step.side === 'left' ? -1 : 1;
  const t = answering ? range(f, at(i), at(i) + FLY, easeIn) : 0;
  const rise = answering ? range(f, at(i), at(i) + FLY + 2, expoOut) : 1;
  const back = undoing ? range(f, at(i), at(i) + FLY + 2, expoOut) : 1;
  const bdir = undoneSide === 'left' ? -1 : 1;

  // typing, over the captured full line
  const askText = typed(f, b, ev.askType[0], ev.askType[1], TYPED.explain);
  const ownText = typed(f, b, ev.ownType[0], ev.ownType[1], TYPED.own);

  // the brief lights on every push; the counter pops when cards are added
  const lastPush = [...SWIPE_STEPS.keys()].filter((k) => k <= i && SWIPE_STEPS[k].act === 'push').pop();
  const rim = lastPush === undefined ? 0 : 1 - range(f, at(lastPush), at(lastPush) + 24);
  const addedAt = SWIPE_STEPS.findIndex((s) => s.added);
  const pop = addedAt >= 0 && i >= addedAt ? Math.exp(-(f - at(addedAt)) / 10) : 0;
  // risks: a ring on the risk and conflict groups once the conflict is in
  const risksOn = range(f, b(ev.risks) + 4, b(ev.risks) + 14) * (1 - range(f, b(ev.risks + 4.5), b(ev.risks + 5)));
  const riskBox = boxOrNull(step.name, 'risk'), problemBox = boxOrNull(step.name, 'problem');
  // the first follow-up: its "Because you answered" line lights once
  const firstFrom = SWIPE_STEPS.findIndex((s) => s.act === 'answer' && boxOrNull(s.name, 'from'));
  const fromBox = i === firstFrom ? box(step.name, 'from') : null;
  const fromOn = fromBox ? range(f, at(i) + 6, at(i) + 14) * (1 - range(f, at(i + 1) - 6, at(i + 1))) : 0;

  // captions: one at a time; the arrows light on their key
  const lastAnswer = [...SWIPE_STEPS.slice(0, i + 1)].reverse().find((s) => s.act === 'answer');
  const lastIdx = lastAnswer ? SWIPE_STEPS.lastIndexOf(lastAnswer) : -1;
  const keyLit = lastIdx >= 0 ? 1 - range(f, at(lastIdx), at(lastIdx) + 10) : 0;
  const arrow = (s: 'left' | 'right') => ({color: lastAnswer?.side === s && keyLit > 0 ? `rgba(255,93,143,${0.35 + 0.65 * keyLit})` : C.text});
  const special: [number, number, React.ReactNode, React.ReactNode?][] = [
    [ev.undo, ev.undo + 2.6, <>Changed your mind? <Pink>⌫</Pink></>],
    [ev.ask, ev.follow - 0.6, <>Not sure? <Pink>↓</Pink> Ask.</>],
    [ev.follow, ev.follow + 5, <>It asks <Pink>back.</Pink></>, 'Three new questions from one answer.'],
    [ev.own, ev.own + 3.5, <>Neither? <Pink>Type your own.</Pink></>],
    [ev.risks, ev.risks + 4.5, <>Risks show up <Pink>too.</Pink></>, 'And conflicts between your answers.'],
  ];
  const cap = special.find(([a, z]) => f >= b(a) && f < b(z));
  const gaps: [number, number][] = [[0.25, special[0][0]], ...special.map(([, z], k): [number, number] => [z, special[k + 1]?.[0] ?? SWIPE_BEATS[SWIPE_BEATS.length - 1]])];

  return (
    <AbsoluteFill>
      <Panel state={base} cam={DECK_CAM} clip={DECK_CLIP} radius={22} />
      {step.act === 'ask-typed' && <Typing f={f} text={askText} full={TYPED.explain} at={ASK_TEXT} />}
      {step.act === 'own-typed' && <Typing f={f} text={ownText} full={TYPED.own} at={OWN_TEXT} />}
      {answering && leaving && (
        <>
          {/* the next card comes up from under the one leaving */}
          {toBox && <Cover b={leaving} />}
          {toBox && <Panel state={step.name} cam={DECK_CAM} clip={toBox} radius={18 * DECK_CAM.s} shadow={false} opacity={Math.min(1, rise * 2.5)} transform={`scale(${0.92 + 0.08 * rise})`} />}
          <Panel state={prev.name} cam={DECK_CAM} clip={leaving} radius={18 * DECK_CAM.s} opacity={1 - range(t, 0.6, 1, (x) => x)}
            transform={dir === 0 ? `translateY(${-t * 500}px) scale(${1 - 0.1 * t})` : `translateX(${dir * t * 1100}px) translateY(${t * 60}px) rotate(${dir * t * 14}deg)`} />
        </>
      )}
      {undoing && toBox && (
        <Panel state={step.name} cam={DECK_CAM} clip={toBox} radius={18 * DECK_CAM.s} opacity={Math.min(1, back * 2)}
          transform={`translateX(${bdir * (1 - back) * 1100}px) translateY(${(1 - back) * 60}px) rotate(${bdir * (1 - back) * 14}deg)`} />
      )}
      {/* the brief sits above the flight: cards answered left tuck under it */}
      <Panel state={step.name} cam={BRIEF_CAM} clip={{...box(step.name, 'brief'), x: 120, y: 16, w: 330}} radius={16 * BRIEF_CAM.s} rim={rim} />
      {fromBox && <Halo cam={DECK_CAM} b={fromBox} a={fromOn} pad={5} radius={8} />}
      {riskBox && <Halo cam={BRIEF_CAM} b={riskBox} a={risksOn} pad={4} radius={12} />}
      {problemBox && <Halo cam={BRIEF_CAM} b={problemBox} a={risksOn} pad={4} radius={12} />}
      <Dramatisation f={f} len={len} />
      {cap ? (
        <Caption key={cap[0]} f={f} from={b(cap[0])} to={b(cap[1])} x={600} y={cap[3] ? 930 : 958} size={60} sub={cap[3]}>{cap[2]}</Caption>
      ) : (
        gaps.map(([a, z]) => (
          <Caption key={a} f={f} from={b(a)} to={b(z)} x={600} y={958} size={60}>
            <span style={arrow('left')}>←</span> no. <span style={arrow('right')}>→</span> yes.
          </Caption>
        ))
      )}
      <Counter f={f} left={step.left} x={1640} y={560} pop={pop} added={SWIPE_STEPS[addedAt]?.added} />
    </AbsoluteFill>
  );
};

/** Hides the leaving card's place in the base state while the next card rises into it. */
const Cover: React.FC<{b: Box}> = ({b}) => {
  const tl = toScreen(DECK_CAM, b.x, b.y);
  return <div style={{position: 'absolute', left: tl.x, top: tl.y, width: b.w * DECK_CAM.s, height: b.h * DECK_CAM.s, background: '#0a0a0d', borderRadius: 18 * DECK_CAM.s}} />;
};

/** The through-line count: questions left, big, right of the deck; "+3" pops when the agent adds cards. */
export const Counter: React.FC<{f: number; left: number; x: number; y: number; pop?: number; added?: number}> = ({f, left, x, y, pop = 0, added}) => (
  <div style={{position: 'absolute', left: x, top: y, opacity: range(f, 0, 10), textAlign: 'left'}}>
    <div style={{fontFamily: DISPLAY, fontWeight: 650, fontSize: 150, letterSpacing: -6, lineHeight: 1, color: left === 0 ? C.green : C.text, fontVariantNumeric: 'tabular-nums',
      transform: `scale(${1 + 0.12 * pop})`, transformOrigin: '0 50%'}}>{left}</div>
    <div style={{fontFamily: BODY, fontWeight: 500, fontSize: 30, color: C.sub, marginTop: 8}}>questions<br />left</div>
    {added && pop > 0.02 && (
      <div style={{position: 'absolute', left: 0, top: -64 - (1 - pop) * 30, fontFamily: DISPLAY, fontWeight: 650, fontSize: 56, color: C.pink, opacity: Math.min(1, pop * 2)}}>+{added}</div>
    )}
  </div>
);

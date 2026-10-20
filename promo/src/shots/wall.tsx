/*
 * wall: the hook. The agent's questions pour into the terminal (6 -> 14 -> 31, the same 31 the film answers later),
 * the camera pulls back over the wall, and the person replies the way everyone does: "1b 2 yes 3 idk".
 */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import page from '../../fixtures/home.questions.json';
import deck from '../../fixtures/home.deck.json';
import {DISPLAY, BODY} from '../fonts';
import {C, Caption, easeIO, expoOut, lerp, range, useShot} from '../lib';
import {Term, typed, type Line} from '../kit';
import {EV, TYPED} from '../timeline';

export const QUESTIONS: string[] = [...(page as {questions: {title: string}[]}).questions.map((q) => q.title), ...(deck as {cards: {title: string}[]}).cards.map((c) => c.title)];
/** Beat (in the wall shot) at which question q (1-based) lands; the sound uses the same formula. */
const landBeat = (q: number) => (q <= 6 ? -1 : q <= 14 ? ((q - 6) / 8) * 2 : 2 + ((q - 14) / 17) * 2);

export const Wall: React.FC = () => {
  const {f, b, len} = useShot('wall');
  const shown = QUESTIONS.filter((_, i) => f >= b(landBeat(i + 1))).length;
  const count = f >= b(4) ? 31 : f >= b(2) ? 14 : 6;
  const jump = [0, 2, 4].map((x) => b(x)).filter((x) => f >= x).pop() ?? 0;
  const pop = Math.exp(-(f - jump) / 5);
  const scale = lerp(1.9, 1, range(f, 0, b(4.6), easeIO));
  const reply = typed(f, b, EV.wall.reply, EV.wall.reply + 2, TYPED.wall);
  const lines: Line[] = [
    {k: 'user', text: 'build the home screen of my task app'},
    {k: 'head', text: 'Before I write any code, a few questions:'},
    ...QUESTIONS.slice(0, shown).map((q, i): Line => ({k: 'agent', text: `${String(i + 1).padStart(2, ' ')}. ${q}`, a: range(f, b(landBeat(i + 1)), b(landBeat(i + 1)) + 4)})),
  ];
  if (f >= b(EV.wall.reply) - 4) lines.push({k: 'user', text: reply});
  const intro = range(f, 0, 8, expoOut);
  return (
    <AbsoluteFill>
      <Term x={760} y={70} w={1080} h={940} lines={lines} size={19} lh={1.25} scale={scale} caret={f >= b(EV.wall.reply) - 4} f={f} opacity={intro} />
      <div style={{position: 'absolute', left: 110, top: 250, opacity: intro}}>
        <div style={{fontFamily: DISPLAY, fontWeight: 650, fontSize: 200, letterSpacing: -9, lineHeight: 1, color: C.pink, transform: `scale(${1 + 0.08 * pop})`, transformOrigin: '0 100%', fontVariantNumeric: 'tabular-nums'}}>{count}</div>
        <div style={{fontFamily: BODY, fontWeight: 500, fontSize: 34, color: C.sub, marginTop: 6}}>questions before any code</div>
      </div>
      <Caption f={f} from={b(EV.wall.caption)} to={len + 1} x={110} y={560} w={600} size={92}>
        Your agent<br />isn't dumb.
      </Caption>
    </AbsoluteFill>
  );
};

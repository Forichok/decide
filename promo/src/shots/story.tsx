/*
 * turn: the agent has the 8 answers and offers the 23 small ones; /decide:swipe is typed and the deck deals.
 * build: Finish sends the brief; the agent builds with nothing left to guess.
 * end: the mark, the line, install for Claude Code and Codex, the repo. The track's own final hit lands ~1 beat in.
 */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {BODY, CODE, DISPLAY} from '../fonts';
import {C, Caption, Mark, Pink, Wordmark, easeIO, expoOut, lerp, range, useShot} from '../lib';
import {Keycap, Term, pressAt, typed, type Line} from '../kit';
import {BUILD_FILES, EV, HIT_BEAT, TYPED, shot} from '../timeline';
import {Panel, box, toScreen} from '../ui';
import {BRIEF_CAM, COUNTER_Y, Counter, DECK_CAM, DECK_CLIP, KeyPad} from './swipe';

/* ---------- turn ---------- */
export const Turn: React.FC = () => {
  const {f, ev, b, len} = useShot('turn');
  const cmd = typed(f, b, EV.turn.type, EV.turn.enter - 0.5, TYPED.turn);
  const lines: Line[] = [
    {k: 'dim', text: '› /decide'},
    {k: 'head', text: 'Got your 8 answers:'},
    {k: 'agent', text: '  layout    → Today view'},
    {k: 'agent', text: '  card      → Yes, go with it'},
    {k: 'agent', text: '  rollout   → Gradually'},
    {k: 'agent', text: '  migration → A separate "No date" section'},
    {k: 'agent', text: '  … 4 more'},
    {k: 'head', text: '23 small decisions left. Faster to swipe them.'},
    {k: 'user', text: cmd},
  ];
  if (f >= ev.enter) lines.push({k: 'dim', text: 'Opening the deck in your browser…'});
  const deal = range(f, ev.deal, len, expoOut);
  const intro = range(f, 0, 10, expoOut);
  return (
    <AbsoluteFill>
      <Term x={760} y={lerp(300, 260, intro)} w={1080} h={560} lines={lines} size={27} lh={1.45} caret={f < ev.enter} f={f}
        opacity={intro * (1 - range(f, ev.deal, ev.deal + 10))} transform={`translateY(${deal * 80}px) scale(${1 - 0.06 * deal})`} />
      <Caption f={f} from={6} to={ev.deal + 4} x={110} y={420} w={600} size={80}>
        23 small ones?<br /><Pink>Swipe them.</Pink>
      </Caption>
      <div style={{position: 'absolute', left: 110, top: 660, opacity: range(f, ev.enter - 12, ev.enter - 4) * (1 - range(f, ev.deal, ev.deal + 6))}}>
        <Keycap pressed={pressAt(f, ev.enter)} size={84}>↵</Keycap>
      </div>
      {/* the deck deals into the swipe layout */}
      {f >= ev.deal && (
        <>
          <Panel state="s-00" cam={DECK_CAM} clip={DECK_CLIP} radius={22} opacity={range(f, ev.deal, ev.deal + 6)} transform={`translateY(${(1 - deal) * 700}px) rotate(${(1 - deal) * 6}deg)`} />
          <Panel state="s-00" cam={BRIEF_CAM} clip={{...box('s-00', 'brief'), x: 120, y: 16, w: 330}} radius={16 * BRIEF_CAM.s} opacity={range(f, ev.deal + 3, ev.deal + 9)}
            transform={`translateX(${(1 - range(f, ev.deal + 3, len, expoOut)) * -500}px)`} />
        </>
      )}
    </AbsoluteFill>
  );
};

/* ---------- build ---------- */
const FINISH = {x: 863, y: 467, w: 100, h: 44};
export const Build: React.FC = () => {
  const {f, ev, b, len, fpb} = useShot('build');
  const out = range(f, ev.brief - 6, ev.brief + 8, easeIO);
  const lines: Line[] = [{k: 'head', text: 'Brief received.'}, {k: 'agent', text: '26 decisions · 2 risks · 1 conflict flagged'}];
  if (f >= b(EV.build.brief + 1)) lines.push({k: 'head', text: 'Building the Today screen:'});
  BUILD_FILES.forEach((file, i) => { if (f >= b(EV.build.files + i * 0.5)) lines.push({k: 'ok', text: file, a: range(f, b(EV.build.files + i * 0.5), b(EV.build.files + i * 0.5) + 4)}); });
  const tin = range(f, ev.brief, ev.brief + 14, expoOut);
  const exit = 1 - range(f, len - 8, len);
  return (
    <AbsoluteFill>
      <Panel state="s-end" cam={BRIEF_CAM} clip={{...box('s-end', 'brief'), x: 120, y: 16, w: 330}} radius={16 * BRIEF_CAM.s} rim={1 - range(f, ev.brief, ev.brief + 20)} opacity={exit} />
      {/* Finish: Enter on the deck's done card, then the deck leaves */}
      <Panel state="s-end" cam={DECK_CAM} clip={DECK_CLIP} radius={22} opacity={1 - out} transform={`translateX(${out * 300}px) scale(${1 - 0.08 * out})`} />
      {f < ev.brief && (() => {
        // the Finish button, measured on the s-end frame (the card box was taken while the card was still sliding in)
        const tl = toScreen(DECK_CAM, FINISH.x, FINISH.y), a = range(f, ev.stop, ev.stop + 4);
        return <div style={{position: 'absolute', left: tl.x - 6, top: tl.y - 6, width: FINISH.w * DECK_CAM.s + 12, height: FINISH.h * DECK_CAM.s + 12, borderRadius: 18,
          boxShadow: `0 0 0 3px rgba(255,93,143,${0.95 * a}), 0 0 50px rgba(255,93,143,${0.5 * a})`}} />;
      })()}
      <div style={{position: 'absolute', inset: 0, opacity: 1 - range(f, 0, 10)}}>
        <Counter f={30} left={0} x={1640} y={COUNTER_Y} />
      </div>
      {/* the swipe's keys carry over: ↵ presses Finish, then they leave with the deck */}
      <KeyPad f={f} beat={(f - b(0)) / fpb} presses={[{key: 'enter', at: ev.stop}]} opacity={1 - range(f, ev.brief, ev.brief + 8)} />
      <Term x={640} y={70} w={1200} h={640} lines={lines} size={30} lh={1.5} f={f} opacity={tin * exit} transform={`translateX(${(1 - tin) * 200}px)`} title="agent — task-app" />
      <Caption f={f} from={ev.caption} to={len + 1} x={640} y={820} w={1200} size={104}>
        34 answers. <Pink>0 guesses.</Pink>
      </Caption>
    </AbsoluteFill>
  );
};

/* ---------- end ---------- */
const INSTALL: [string, string][] = [
  ['Claude Code', '/plugin install decide --marketplace Forichok/decide'],
  ['Codex', 'codex plugin marketplace add Forichok/decide'],
  ['', 'codex plugin add decide@forichok'],
];
export const End: React.FC = () => {
  const {f, ev, b} = useShot('end');
  const hit = b(HIT_BEAT - shot('end').start);
  const pulse = f >= hit ? Math.exp(-(f - hit) / 6) : 0;
  const mark = lerp(0.35, 1, range(f, ev.mark, ev.mark + 12, expoOut));
  const line = range(f, ev.line, ev.line + 10, expoOut);
  const inst = range(f, ev.install, ev.install + 10, expoOut);
  const url = range(f, ev.url, ev.url + 10, expoOut);
  return (
    <AbsoluteFill style={{alignItems: 'center'}}>
      <AbsoluteFill style={{background: 'rgba(5,5,7,0.45)', opacity: range(f, 0, 8)}} />
      <Caption f={f} from={-30} to={6} x={640} y={820} w={1200} size={104}>
        34 answers. <Pink>0 guesses.</Pink>
      </Caption>
      <div style={{position: 'absolute', top: 110, display: 'flex', alignItems: 'center', gap: 36, opacity: mark, transform: `translateY(${(1 - mark) * 30}px) scale(${1 + 0.04 * pulse})`}}>
        <div style={{position: 'relative'}}>
          <div style={{position: 'absolute', left: -120, top: -120, width: 380, height: 380, borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(255,93,143,0.5), rgba(255,93,143,0))', opacity: 0.4 + 0.6 * pulse}} />
          <Mark size={140} />
        </div>
        <Wordmark size={150} />
      </div>
      <div style={{position: 'absolute', top: 330, width: '100%', textAlign: 'center', opacity: line, transform: `translateY(${(1 - line) * 16}px)`,
        fontFamily: DISPLAY, fontWeight: 600, fontSize: 60, letterSpacing: -2, color: C.text, lineHeight: 1.15}}>
        Your agent asks on a page.<br /><Pink>You answer in clicks.</Pink>
      </div>
      <div style={{position: 'absolute', top: 545, padding: '26px 38px', borderRadius: 18, background: 'rgba(14,14,17,0.92)', boxShadow: '0 0 0 1px rgba(255,255,255,0.09)',
        opacity: inst, transform: `translateY(${(1 - inst) * 16}px)`, display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 34, rowGap: 12, alignItems: 'baseline'}}>
        {INSTALL.map(([who, cmd], i) => (
          <React.Fragment key={i}>
            <div style={{fontFamily: BODY, fontWeight: 600, fontSize: 26, color: C.sub, textAlign: 'right'}}>{who}</div>
            <div style={{fontFamily: CODE, fontSize: 32, color: C.text, whiteSpace: 'nowrap'}}>{cmd}</div>
          </React.Fragment>
        ))}
      </div>
      <div style={{position: 'absolute', top: 870, width: '100%', textAlign: 'center', opacity: url, transform: `translateY(${(1 - url) * 12}px)`}}>
        <div style={{fontFamily: BODY, fontWeight: 600, fontSize: 44, color: C.text}}>github.com/Forichok/decide</div>
        <div style={{fontFamily: BODY, fontWeight: 500, fontSize: 30, color: C.sub, marginTop: 12}}>Free and open source · MIT</div>
      </div>
    </AbsoluteFill>
  );
};

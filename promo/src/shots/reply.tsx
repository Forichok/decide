/*
 * reply: on the downbeat the agent's answer lands under the person's question (the real reply, sent through the
 * explain tool during capture); then the person picks "Gradually", the option the reply argued for.
 * The camera is anchored to the question card, so states with different scroll line up.
 */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {Caption, type Cam, easeIO, expoOut, lerp, range, useShot} from '../lib';
import {Halo, Panel, box} from '../ui';

/** A camera aimed at a point given relative to the question card of `state`. */
export const cardCam = (state: string, cx: number, cy: number, s: number, ax: number, ay: number): Cam => {
  const c = box(state, 'card');
  return {s, fx: c.x + cx, fy: c.y + cy, ax, ay};
};
// the card column only: the page's side nav and bottom bar stay off screen, so the caption has the left column
export const CARD_CLIP = {x: 456, y: 0, w: 808, h: 805};

export const Reply: React.FC = () => {
  const {f, ev, len} = useShot('reply');
  const picked = f >= ev.pick;
  const state = picked ? 'p-rollout-picked' : 'p-reply';
  // camera: on the reply, slow push; after the pick, up to the picked option
  const toPick = range(f, ev.pick - 10, ev.pick + 4, easeIO);
  const s = lerp(1.5, 1.62, range(f, 0, ev.pick, (t) => t));
  const cy = lerp(905, 520, toPick);
  const cam = cardCam(state, 390, cy, s, 1170, lerp(520, 560, toPick));
  const land = range(f, ev.land, ev.land + 9, expoOut);
  const reply = box(state, 'reply');
  const pickBox = picked ? box('p-rollout-picked', 'gradual') : null;
  return (
    <AbsoluteFill>
      <Panel state={state} cam={cam} clip={CARD_CLIP} fade={[120, 160]} radius={0} />
      {/* the landing: the reply block settles from slightly below with a pink light that fades */}
      <Halo cam={cam} b={reply} a={(1 - range(f, ev.land + 8, ev.land + 30)) * land} radius={12} />
      {pickBox && <Halo cam={cam} b={pickBox} a={range(f, ev.pick, ev.pick + 4) * (1 - range(f, ev.pick + 22, ev.pick + 40))} radius={12} />}
      <Caption f={f} from={ev.land + 3} to={len + 1} x={110} y={420} w={400} size={72}>
        It answers<br />right here.
      </Caption>
    </AbsoluteFill>
  );
};

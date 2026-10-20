/*
 * The stage: near-black with slow liquid light in decide's pink and violet (the gate 1 "liquid" preview, made
 * deterministic per frame). Energy follows the music: dim in the intro and the breakdowns, dark on the dead stop,
 * a flare on the drop.
 */
import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {C, clamp01, lerp, range} from './lib';
import {beatFrame, shot} from './timeline';

const BLOBS: [number, number, number, number][] = [
  [255, 93, 143, 0.8],
  [124, 77, 255, 0.7],
  [255, 140, 90, 0.25],
  [90, 60, 200, 0.4],
];

/** Stage energy at film frame g (1 = the gate 1 preview). */
export const energyAt = (g: number) => {
  const are = shot('are'), drop = shot('drop'), ask = shot('ask'), turn = shot('turn'), end = shot('end');
  const keys: [number, number][] = [
    [0, 0.3], [are.from - 4, 0.38], [are.from + 2, 0], [drop.from - 1, 0], [drop.from + 3, 1.7], [drop.from + 40, 0.95],
    [ask.from - 4, 0.95], [ask.from + 10, 0.45], [ask.to - 6, 0.5], [ask.to + 4, 1.05], [ask.to + 30, 0.9],
    [turn.from - 4, 0.9], [turn.from + 10, 0.45], [turn.to - 4, 0.5], [turn.to + 4, 1.2], [turn.to + 40, 0.95],
    [end.from - 2, 0.95], [beatFrame(end.start + 1), 1.4], [beatFrame(end.start + 3), 1.0], [1e6, 1.0],
  ];
  for (let i = 1; i < keys.length; i++) if (g <= keys[i][0]) return lerp(keys[i - 1][1], keys[i][1], clamp01((g - keys[i - 1][0]) / Math.max(1, keys[i][0] - keys[i - 1][0])));
  return 1;
};

export const Liquid: React.FC<{energy?: number}> = ({energy}) => {
  const g = useCurrentFrame();
  const e = energy ?? energyAt(g);
  const t = (g / 30) * 1000;
  const W = 1920, H = 1080;
  return (
    <AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
      {BLOBS.map((k, i) => {
        const a = t / 4000 + i * 1.7;
        const R = H * (0.45 + 0.12 * Math.sin(t / 3000 + i)) * (1 + 0.12 * clamp01(e - 1));
        const px = W * (0.5 + 0.38 * Math.cos(a * 0.9 + i));
        const py = H * (0.55 + 0.35 * Math.sin(a * 1.3 + i * 2));
        const al = k[3] * Math.min(1.6, e);
        return (
          <div key={i} style={{position: 'absolute', left: px - R, top: py - R, width: R * 2, height: R * 2, borderRadius: '50%', mixBlendMode: 'screen',
            background: `radial-gradient(closest-side, rgba(${k[0]},${k[1]},${k[2]},${al}), rgba(${k[0]},${k[1]},${k[2]},0))`}} />
        );
      })}
      <AbsoluteFill style={{background: 'radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.55))'}} />
    </AbsoluteFill>
  );
};

/** A darkening veil over the stage behind type-only moments (0 = none). */
export const Veil: React.FC<{a: number}> = ({a}) => (a <= 0.001 ? null : <AbsoluteFill style={{background: `rgba(5,5,7,${clamp01(a)})`}} />);

/* The decide launch film: the liquid stage under every shot, each shot in its own Sequence on the beat grid. */
import React from 'react';
import {AbsoluteFill, Sequence} from 'remotion';
import {loadFonts} from './fonts';
import {ShotCtx} from './lib';
import {Liquid} from './stage';
import {PLACED, type ShotId} from './timeline';
import {Are, Drop} from './shots/hook';
import {Reply} from './shots/reply';
import {Swipe} from './shots/swipe';
import {Todo} from './shots/todo';

loadFonts();

const SHOT: Partial<Record<ShotId, React.FC>> = {are: Are, drop: Drop, reply: Reply, swipe: Swipe};

export const Film: React.FC = () => (
  <AbsoluteFill style={{background: '#050507'}}>
    <Liquid />
    {PLACED.map((p) => {
      const S = SHOT[p.id] ?? (() => <Todo id={p.id} />);
      return (
        <Sequence key={p.id} from={p.from} durationInFrames={p.to - p.from} name={p.id}>
          <ShotCtx.Provider value={p}>
            <S />
          </ShotCtx.Provider>
        </Sequence>
      );
    })}
  </AbsoluteFill>
);

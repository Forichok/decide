/* The decide launch film: the liquid stage under every shot, each shot in its own Sequence on the beat grid. */
import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import {loadFonts} from './fonts';
import {ShotCtx} from './lib';
import {Liquid} from './stage';
import {PLACED, type ShotId} from './timeline';
import {Are, Drop} from './shots/hook';
import {Ask, Done, Live, Pick, See} from './shots/page';
import {Reply} from './shots/reply';
import {Build, End, Turn} from './shots/story';
import {Swipe} from './shots/swipe';
import {Wall} from './shots/wall';
import {Todo} from './shots/todo';

loadFonts();

const SHOT: Partial<Record<ShotId, React.FC>> = {wall: Wall, are: Are, drop: Drop, pick: Pick, see: See, live: Live, ask: Ask, reply: Reply, done: Done, turn: Turn, swipe: Swipe, build: Build, end: End};

export const Film: React.FC = () => (
  <AbsoluteFill style={{background: '#050507'}}>
    <Liquid />
    <Audio src={staticFile('audio/film.wav')} />
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

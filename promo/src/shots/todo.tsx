/* Placeholder for shots not built yet (gate 2 builds only the three key stills). */
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {BODY} from '../fonts';

export const Todo: React.FC<{id: string}> = ({id}) => (
  <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', fontFamily: BODY, fontSize: 40, color: 'rgba(255,255,255,0.4)'}}>{id}</AbsoluteFill>
);

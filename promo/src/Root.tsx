import React from 'react';
import {Composition} from 'remotion';
import {Film} from './Film';
import {FPS, LEN} from './timeline';

export const Root: React.FC = () => <Composition id="Film" component={Film} durationInFrames={LEN} fps={FPS} width={1920} height={1080} />;

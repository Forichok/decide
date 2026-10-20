/*
 * Real decide UI: viewport PNGs captured at 3x (capture/run.mjs, capture/swipe.mjs) shown through a 2D camera.
 * Coordinates are the page's CSS px (1440x900 viewport); boxes.json holds the element boxes per state.
 */
import React from 'react';
import {Img, staticFile} from 'remotion';
import boxesJson from '../public/ui/boxes.json';
import type {Cam} from './lib';

export const PAGE_W = 1440, PAGE_H = 900;
export type Box = {x: number; y: number; w: number; h: number};
const BOXES = boxesJson as unknown as Record<string, Record<string, Box | null>>;
export const box = (state: string, key: string): Box => {
  const b = BOXES[state]?.[key];
  if (!b) throw new Error(`no box ${key} in ${state}`);
  return b;
};

/** Screen position of a page point under a camera. */
export const toScreen = (cam: Cam, x: number, y: number) => ({x: cam.ax + (x - cam.fx) * cam.s, y: cam.ay + (y - cam.fy) * cam.s});

/**
 * A region of a captured state (clip, page CSS px) through the camera, as a floating panel: rounded, shadowed,
 * optionally faded at the top and bottom so it rises out of the stage.
 */
export const Panel: React.FC<{
  state: string;
  cam: Cam;
  clip?: Box;
  radius?: number;
  fade?: [number, number];
  opacity?: number;
  shadow?: boolean;
  transform?: string;
  rim?: number;
}> = ({state, cam, clip = {x: 0, y: 0, w: PAGE_W, h: PAGE_H}, radius = 18, fade, opacity = 1, shadow = true, transform, rim = 0}) => {
  if (opacity <= 0.001) return null;
  const tl = toScreen(cam, clip.x, clip.y);
  const w = clip.w * cam.s, h = clip.h * cam.s;
  const mask = fade ? `linear-gradient(to bottom, transparent 0, #000 ${fade[0]}px, #000 calc(100% - ${fade[1]}px), transparent 100%)` : undefined;
  return (
    <div style={{position: 'absolute', left: tl.x, top: tl.y, width: w, height: h, opacity, transform, transformOrigin: '50% 50%'}}>
      {shadow && <div style={{position: 'absolute', inset: 0, borderRadius: radius, boxShadow: '0 40px 120px rgba(0,0,0,0.7)', WebkitMaskImage: mask}} />}
      <div style={{position: 'absolute', inset: 0, borderRadius: radius, overflow: 'hidden', WebkitMaskImage: mask,
        boxShadow: `0 0 0 1px rgba(255,255,255,0.08)${rim > 0 ? `, 0 0 ${60 * rim}px ${6 * rim}px rgba(255,93,143,${0.35 * rim})` : ''}`}}>
        <Img src={staticFile(`ui/${state}.png`)} style={{position: 'absolute', left: -clip.x * cam.s, top: -clip.y * cam.s, width: PAGE_W * cam.s, height: PAGE_H * cam.s, maxWidth: 'none'}} />
      </div>
    </div>
  );
};

/** A soft pink light on a page region (an answer landing, a pick). */
export const Halo: React.FC<{cam: Cam; b: Box; a: number; pad?: number; radius?: number}> = ({cam, b, a, pad = 6, radius = 14}) => {
  if (a <= 0.001) return null;
  const tl = toScreen(cam, b.x - pad, b.y - pad);
  return (
    <div style={{position: 'absolute', left: tl.x, top: tl.y, width: (b.w + pad * 2) * cam.s, height: (b.h + pad * 2) * cam.s, borderRadius: radius * cam.s,
      boxShadow: `0 0 0 ${2 * cam.s}px rgba(255,93,143,${0.9 * a}), 0 0 ${40 * cam.s}px rgba(255,93,143,${0.45 * a})`}} />
  );
};

/* Geist (display) and Inter (body), both SIL OFL, bundled from npm so renders never fetch fonts. */
import {continueRender, delayRender} from 'remotion';
import geistVar from '../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2';
import geistMono from '../node_modules/geist/dist/fonts/geist-mono/GeistMono-Medium.woff2';
import geistMonoBold from '../node_modules/geist/dist/fonts/geist-mono/GeistMono-SemiBold.woff2';
import inter400 from '../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2';
import inter500 from '../node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2';
import inter600 from '../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2';
import inter700 from '../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2';

export const DISPLAY = '"Geist", "Inter", -apple-system, sans-serif';
export const BODY = '"Inter", -apple-system, "Geist", sans-serif';
export const CODE = '"Geist Mono", ui-monospace, monospace';

const faces: [string, string, string][] = [
  ['Geist', geistVar, '100 900'],
  ['Geist Mono', geistMono, '500'],
  ['Geist Mono', geistMonoBold, '600'],
  ['Inter', inter400, '400'],
  ['Inter', inter500, '500'],
  ['Inter', inter600, '600'],
  ['Inter', inter700, '700'],
];

let started = false;
export const loadFonts = () => {
  if (started || typeof document === 'undefined') return;
  started = true;
  const handle = delayRender('fonts', {retries: 2, timeoutInMilliseconds: 60000});
  Promise.all(
    faces.map(([family, url, weight]) => {
      const f = new FontFace(family, `url(${url}) format("woff2")`, {weight});
      document.fonts.add(f);
      return f.load();
    }),
  )
    .then(() => continueRender(handle))
    .catch((e) => {
      console.error('font load failed', e);
      continueRender(handle);
    });
};

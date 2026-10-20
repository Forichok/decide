// Render a list of frames of Film to out/stills/f<N>.jpg with one bundle: node scripts/stills.mjs 120 300 455
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition, openBrowser} from '@remotion/renderer';
import path from 'node:path';
const frames = process.argv.slice(2).map(Number);
const serveUrl = await bundle({entryPoint: path.resolve('src/index.ts')});
const browser = await openBrowser('chrome', {chromiumOptions: {args: ['--mute-audio']}});
const composition = await selectComposition({serveUrl, id: 'Film', puppeteerInstance: browser});
for (const frame of frames) {
  await renderStill({composition, serveUrl, frame, output: `out/stills/f${frame}.jpg`, imageFormat: 'jpeg', jpegQuality: 85, scale: 0.5, puppeteerInstance: browser});
  console.log('ok', frame);
}
await browser.close({silent: true});

/*
 * The decide launch film: every cut, in-shot event and sound cue, in beats of the music.
 * Plain TypeScript with erasable types only: Node runs this file directly (audio/synth.mts).
 *
 * Music: music-suno-v2-4.wav (the Agent Notch track, owner's pick at gate 0). Its grid was measured for Agent Notch
 * (promo/src/timeline.ts and src/v7/timeline7.ts there): 123.05 BPM, the drop's attack at 3.968 s, the final hit at
 * 55.07565 s. Film beat 10 (the drop) lands at exactly 5.0 s. The track plays its intro under beats 0-8, stops dead for
 * "Your answers are." (8-10), runs from the drop to track beat 80, repeats its groove phrase 32-48 once (film 90-106,
 * for the longer swipe) and goes on from track beat 80 to its own ending. Joins sit on 8-beat phrase lines.
 */
import {SWIPE_STEPS} from './swipe-steps.ts';

export const FPS = 30;
export const BPM = 123.05;
export const OFFSET_FRAMES = 150 - (10 * FPS * 60) / BPM;
export const FPB = (FPS * 60) / BPM;
export const beatFrame = (beat: number) => Math.round(OFFSET_FRAMES + beat * FPB);
export const beatSec = (beat: number) => (OFFSET_FRAMES + beat * FPB) / FPS;

export const MUSIC_FILE = 'music-suno-v2-4.wav';
export const TRACK_DROP_S = 3.968;
export const TRACK_BPM = BPM;
export type MusicSeg = {from: number; to: number; src: number; rate?: number};
/** src: track beat from the drop; rate: source seconds per film second (measured for Agent Notch v7, MUSIC7). */
const R = 1.007907851474;
export const MUSIC: MusicSeg[] = [
  {from: 0, to: 8, src: -8.081064603175, rate: 1.01181420068},
  // 8-10: dead stop
  // track beat n sits at src 0.013449 + n * R
  {from: 10, to: 90, src: 0.013449002268, rate: R},
  {from: 90, to: 106, src: 0.013449002268 + 32 * R, rate: R}, // the groove phrase after breakdown 1, once more
  {from: 106, to: 138, src: 0.013449002268 + 80 * R, rate: R},
];
/** The track's own final hit (55.07565 s) in film beats: 10 + (track beat 104.81 - 0.0134) / R, plus the 16 inserted beats. */
export const HIT_BEAT = 26 + ((55.07565 - TRACK_DROP_S) / (60 / TRACK_BPM) - 0.013449002268) / R;

export type ShotId = 'wall' | 'are' | 'drop' | 'pick' | 'see' | 'live' | 'ask' | 'reply' | 'done' | 'turn' | 'swipe' | 'build' | 'end';
export type Shot = {id: ShotId; beats: number};
export const SHOTS: Shot[] = [
  {id: 'wall', beats: 8}, // intro: the agent's questions pour in; "Your agent isn't dumb."
  {id: 'are', beats: 2}, // dead stop: "Your answers are."
  {id: 'drop', beats: 4}, // the drop: the period becomes the decide mark, the page rises
  {id: 'pick', beats: 6},
  {id: 'see', beats: 7},
  {id: 'live', beats: 7},
  {id: 'ask', beats: 8}, // breakdown 1 (track 24-32)
  {id: 'reply', beats: 8}, // groove back on the reply
  {id: 'done', beats: 16},
  {id: 'turn', beats: 8}, // breakdown 2 (track 56-64)
  {id: 'swipe', beats: 42}, // the last, biggest groove (16 beats of it inserted)
  {id: 'build', beats: 13},
  {id: 'end', beats: 9}, // the final hit lands ~1 beat in
];
export type Placed = Shot & {start: number; from: number; to: number};
export const PLACED: Placed[] = (() => {
  let b = 0;
  return SHOTS.map((s, i) => {
    const start = b;
    b += s.beats;
    return {...s, start, from: i === 0 ? 0 : beatFrame(start), to: beatFrame(start + s.beats)};
  });
})();
export const TOTAL_BEATS = SHOTS.reduce((a, s) => a + s.beats, 0);
export const LEN = beatFrame(TOTAL_BEATS);
export const shot = (id: ShotId) => PLACED.find((p) => p.id === id)!;

/* ---------- events, in beats from the shot start ---------- */
export const EV = {
  wall: {n6: 0, n14: 2, n31: 4, reply: 5, caption: 0.5},
  are: {},
  drop: {bloom: 0, rise: 0.5, caption: 1.2},
  pick: {key: 3},
  see: {click: 3.5},
  live: {tick: 3},
  ask: {type: 1, typed: 6, send: 7},
  reply: {land: 0, pick: 5},
  done: {features: 1, order: 2.5, confidence: 4, migration: 5.5, done: 8, send: 10.5, received: 12},
  turn: {type: 1.5, enter: 5.5, deal: 6},
  // swipe: the beat of every captured step is in SWIPE_BEATS; these are the typed spans and the captions
  swipe: {undo: 3.75, ask: 8.75, askType: [9.25, 10.75], explained: 12, follow: 16.5, own: 24.5, ownType: [25, 27], risks: 31.5, skip: 36.1},
  build: {stop: 0.5, brief: 1.5, files: 4, caption: 6},
  end: {mark: 0, line: 1, install: 2, url: 2.5},
} as const;

/* ---------- swipe schedule (shared by the shot and the sound) ---------- */
/** In-shot beat of each captured step in SWIPE_STEPS (src/swipe-steps.ts, written by capture/swipe.mjs). */
export const SWIPE_BEATS = [
  0, // start
  1, 2, 3, // empty, overdue, count (against the pick)
  3.75, // ⌫ count comes back
  4.5, 5.25, 5.75, // count the other way, later, push 50 %
  6.5, 7.25, 8, // swipe-done, undo, offline: sync in front
  8.75, 9.25, 11, 12, // ↓ ask opens, typed, waiting, the agent's reply on the card
  16, 16.5, // sync → Ask the user (the groove comes back), push: +3 follow-ups
  17.5, 19, 20, 21, 21.5, // snooze, then the three follow-ups, push 70 %
  22.25, 23, 23.75, // subtasks, time, week: nodate in front
  24.5, 25, 27.5, 28, // ↵ own answer, typed, sent, push 78 %
  28.75, 29.5, 30.25, 31, 31.5, // default, quiet, dark, density, push 86 %: the conflict
  32.4, 33.2, 34, 34.5, // motion, beta, feedback, push 92 %
  35.3, 36.1, 36.9, 37.4, // old, ↑ search skipped, widget, push 96 %
  38.4, // end: the done card
];
if (SWIPE_BEATS.length !== SWIPE_STEPS.length) throw new Error(`SWIPE_BEATS has ${SWIPE_BEATS.length} beats for ${SWIPE_STEPS.length} captured steps`);
/** Typed strings: their per-character timing drives both the picture and the key sounds. */
export const TYPED = {
  wall: '1b 2 yes 3 idk',
  ask: "what's a feature flag?",
  turn: '/decide:swipe',
  explain: 'both phones offline?',
  own: 'Pin them to the top of Later',
};
/** Build log: one file per half beat from EV.build.files. */
export const BUILD_FILES = [
  'src/screens/Today.tsx',
  'src/components/TaskCard.tsx',
  'src/components/LaterSection.tsx',
  'src/lib/snooze.ts',
  'src/lib/reminders.ts',
  'src/lib/offline-cache.ts',
  'tests/today.test.tsx',
];

/* ---------- sound ---------- */
export type Sfx = 'click' | 'key' | 'keyclick' | 'tick' | 'whoosh' | 'impact' | 'boom' | 'sub' | 'chime' | 'pop' | 'approve' | 'riser';
export type Cue = {b: number; s: Sfx; d?: number; v?: number; p?: number};
export type AbsCue = {f: number; s: Sfx; d: number; v: number; p: number};

/** Character k of a typed string (n chars) typed between beats a and b: its beat. */
export const typeBeat = (a: number, b: number, n: number, k: number) => a + ((b - a) * k) / n;

/** Every sound cue of the film, in film frames (exact, not rounded). */
export const cues = (): AbsCue[] => {
  const out: AbsCue[] = [];
  const at = (id: ShotId, list: Cue[]) => {
    const p = shot(id);
    for (const c of list) out.push({f: OFFSET_FRAMES + (p.start + c.b) * FPB, s: c.s, d: c.d ?? 8, v: c.v ?? 1, p: c.p ?? 1});
  };
  const typing = (a: number, b: number, text: string, v = 0.7): Cue[] =>
    [...text].map((ch, k) => ({b: typeBeat(a, b, text.length, k), s: 'keyclick' as Sfx, v: ch === ' ' ? v * 0.6 : v, p: 0.9 + ((k * 7) % 5) * 0.05}));
  // wall: a tick per question that lands (6 at the start, 14 by beat 2, 31 by beat 4), then the lazy reply
  const wall: Cue[] = [];
  for (let q = 7; q <= 31; q++) {
    const b = q <= 14 ? ((q - 6) / 8) * 2 : 2 + ((q - 14) / 17) * 2;
    wall.push({b, s: 'tick', v: 0.35, p: 0.8 + (q / 31) * 0.6});
  }
  at('wall', [...wall, ...typing(EV.wall.reply, EV.wall.reply + 2, TYPED.wall, 0.8)]);
  at('drop', [{b: 0, s: 'sub', v: 1}, {b: 0, s: 'impact', v: 0.7}, {b: EV.drop.rise, s: 'whoosh', d: 18, v: 0.5}]);
  at('pick', [{b: EV.pick.key, s: 'keyclick', v: 1.1}, {b: EV.pick.key + 0.05, s: 'pop', v: 0.5}]);
  at('see', [{b: EV.see.click, s: 'click'}, {b: EV.see.click + 0.6, s: 'whoosh', d: 14, v: 0.35}]);
  at('live', [{b: EV.live.tick, s: 'click'}, {b: EV.live.tick + 0.1, s: 'pop', v: 0.5, p: 1.3}]);
  at('ask', [{b: 0.6, s: 'click', v: 0.8}, ...typing(EV.ask.type, EV.ask.typed, TYPED.ask), {b: EV.ask.send, s: 'key', v: 0.9}]);
  at('reply', [{b: EV.reply.land, s: 'chime', v: 0.8}, {b: EV.reply.pick, s: 'click'}]);
  const d = EV.done;
  at('done', [...[d.features, d.order, d.confidence, d.migration, d.done].map((b): Cue => ({b, s: 'click', v: 0.9})), {b: d.send, s: 'click'}, {b: d.received, s: 'approve', v: 0.8}]);
  at('turn', [...typing(EV.turn.type, EV.turn.enter - 0.5, TYPED.turn), {b: EV.turn.enter, s: 'key'}, {b: EV.turn.deal, s: 'whoosh', d: 16, v: 0.5}]);
  const sw: Cue[] = [];
  const E = EV.swipe;
  SWIPE_STEPS.forEach((st, i) => {
    const b = SWIPE_BEATS[i];
    if (st.act === 'answer' && st.side !== 'own') {
      sw.push({b, s: 'whoosh', d: 7, v: 0.4, p: st.side === 'left' ? 0.9 : st.side === 'skip' ? 1.35 : 1.1});
      sw.push({b, s: 'tick', v: 0.45, p: 0.8 + (i / SWIPE_STEPS.length) * 0.7});
    }
    if (st.act === 'answer' && st.side === 'own') sw.push({b, s: 'key', v: 0.9});
    if (st.act === 'undo') sw.push({b, s: 'key', v: 0.8, p: 0.9}, {b: b + 0.05, s: 'whoosh', d: 9, v: 0.35, p: 0.8});
    if (st.act === 'ask-open' || st.act === 'own-open') sw.push({b, s: 'key', v: 0.8});
    if (st.act === 'ask-wait') sw.push({b, s: 'key', v: 0.9});
    if (st.act === 'explained') sw.push({b, s: 'chime', v: 0.6});
    if (st.act === 'push') sw.push({b, s: 'pop', v: 0.6, p: 1.2});
    if (st.added) for (let k = 0; k < st.added; k++) sw.push({b: b + 0.25 + k * 0.2, s: 'tick', v: 0.55, p: 1.3 + k * 0.12});
  });
  sw.push(...typing(E.askType[0], E.askType[1], TYPED.explain, 0.55), ...typing(E.ownType[0], E.ownType[1], TYPED.own, 0.55));
  at('swipe', sw);
  at('build', [{b: EV.build.stop, s: 'key'}, {b: EV.build.brief, s: 'chime', v: 0.7},
    ...BUILD_FILES.map((_, i) => ({b: EV.build.files + i * 0.5, s: 'tick' as Sfx, v: 0.5, p: 1 + i * 0.05}))]);
  // a soft bell under the URL, so the card does not sit in the track's fade-out alone
  at('end', [{b: EV.end.url, s: 'chime', v: 0.45, p: 0.75}]);
  return out.sort((a, b) => a.f - b.f);
};

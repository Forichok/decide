/*
 * The decide launch film: every cut, in-shot event and sound cue, in beats of the music.
 * Plain TypeScript with erasable types only: Node runs this file directly (audio/synth.mts).
 *
 * Music: music-suno-v2-4.wav (the Agent Notch track, owner's pick at gate 0). Its grid was measured for Agent Notch
 * (promo/src/timeline.ts and src/v7/timeline7.ts there): 123.05 BPM, the drop's attack at 3.968 s, the final hit at
 * 55.07565 s. Film beat 10 (the drop) lands at exactly 5.0 s. The track plays its intro under beats 0-8, stops dead for
 * "Your answers are." (8-10) and then runs straight from the drop to its own ending: no loops, no joins.
 */
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
export const MUSIC: MusicSeg[] = [
  {from: 0, to: 8, src: -8.081064603175, rate: 1.01181420068},
  // 8-10: dead stop
  {from: 10, to: 122, src: 0.013449002268, rate: 1.007907851474},
];
/** The track's own final hit (55.07565 s) in film beats: 10 + (track beat 104.81 - 0.0134) / 1.0079. */
export const HIT_BEAT = 10 + ((55.07565 - TRACK_DROP_S) / (60 / TRACK_BPM) - 0.013449002268) / 1.007907851474;

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
  {id: 'swipe', beats: 26}, // the last, biggest groove
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
  // swipe: 23 answers from beat 1, one per beat at first, then faster; the own answer is card 11
  swipe: {first: 1, ownAt: 10, ownType: 10.5, ownSend: 13.5},
  build: {stop: 0.5, brief: 1.5, files: 4, caption: 6},
  end: {mark: 0, line: 1, install: 2, url: 2.5},
} as const;

/* ---------- swipe schedule (shared by the shot and the sound) ---------- */
/** In-shot beat at which deck card k (1-based) is answered: one per beat, the own answer, then faster. */
export const swipeBeat = (k: number) => {
  const ev = EV.swipe;
  if (k <= 10) return ev.first + (k - 1) * 0.95;
  if (k === 11) return ev.ownSend;
  return ev.ownSend + 0.5 + (k - 12) * 0.75;
};
/** Answers after which the agent pushed a rewritten brief (capture/swipe.mjs: every 4, and the last). */
export const SWIPE_PUSHED = [4, 8, 12, 16, 20, 23];
/** Side of each answer, in deck order ('own' for the typed one); mirrors capture/swipe.mjs. */
export const SWIPE_SIDES: ('left' | 'right' | 'own')[] = [
  'right', 'left', 'right', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'own', 'left',
  'left', 'left', 'left', 'right', 'left', 'left', 'left', 'left', 'left', 'right', 'right',
];
/** Typed strings: their per-character timing drives both the picture and the key sounds. */
export const TYPED = {
  wall: '1b 2 yes 3 idk',
  ask: "what's a feature flag?",
  turn: '/decide:swipe',
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
  for (let k = 1; k <= 23; k++) {
    const side = SWIPE_SIDES[k - 1];
    sw.push({b: swipeBeat(k), s: side === 'own' ? 'key' : 'whoosh', d: 7, v: side === 'own' ? 0.9 : 0.4, p: side === 'left' ? 0.9 : 1.1});
    sw.push({b: swipeBeat(k), s: 'tick', v: 0.45, p: 0.8 + (k / 23) * 0.7});
    if (SWIPE_PUSHED.includes(k)) sw.push({b: swipeBeat(k) + 0.5, s: 'pop', v: 0.6, p: 1.2});
  }
  sw.push({b: EV.swipe.ownAt, s: 'key', v: 0.8});
  sw.push(...typing(EV.swipe.ownType, EV.swipe.ownSend - 0.4, TYPED.own, 0.55));
  at('swipe', sw);
  at('build', [{b: EV.build.stop, s: 'key'}, {b: EV.build.brief, s: 'chime', v: 0.7},
    ...BUILD_FILES.map((_, i) => ({b: EV.build.files + i * 0.5, s: 'tick' as Sfx, v: 0.5, p: 1 + i * 0.05}))]);
  // a soft bell under the URL, so the card does not sit in the track's fade-out alone
  at('end', [{b: EV.end.url, s: 'chime', v: 0.45, p: 0.75}]);
  return out.sort((a, b) => a.f - b.f);
};

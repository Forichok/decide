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
  drop: {bloom: 0, rise: 0.5, caption: 1.5},
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
  end: {mark: 0, line: 1.5, install: 3, url: 4.5},
} as const;

/* ---------- sound ---------- */
export type Sfx = 'click' | 'key' | 'keyclick' | 'tick' | 'whoosh' | 'impact' | 'boom' | 'sub' | 'chime' | 'type' | 'approve' | 'pop' | 'swish';
export type Cue = {b: number; s: Sfx; d?: number; v?: number; p?: number};
export type AbsCue = {f: number; s: Sfx; d: number; v: number; p: number};

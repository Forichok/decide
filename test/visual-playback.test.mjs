import test from "node:test";
import assert from "node:assert/strict";
globalThis.location = { search: "" };
const { sharedInterval } = await import("../ui/js/visual/playback.js");

test("aligned playback ends with the shorter clip and includes their common lead-in", () => {
  assert.deepEqual(sharedInterval([{ duration: 3, cue: 0.5 }, { duration: 5, cue: 2 }]), { start: -0.5, end: 2.5 });
});

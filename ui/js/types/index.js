// types/index.js — the question types of the page, one module each, in the
// engine's order (lib/registry/index.mjs). A module exports
//   emptyAnswer(q)       the fields of a blank answer the type owns (logic.js adds the common ones)
//   isAnswered(q, a)     whether the answer counts
//   describe(q, r, w)    the type's part of the digest line, "" when there is none
//   render(q, ctx)       the answer control; ctx.t and ctx.renderMedia are the page's
//   sync(card, q, a)?    paints the answer onto the control
//   keys?                { pick(q, n, ctx) }: what the number keys do
//   badge?(q, t)         a small label under the title
//   compact(q, a)?       what the answers file keeps of the answer, beyond the common fields
//   check(q, raw, kit)?  the same, read back from an answers file: kit is {ids, str, warn}; lib/answers.mjs
//   recommend(q, a, rec)? the answer once the recommendation (the ids in rec) is taken for the user
// A type without compact/check keeps nothing of its own; one without recommend takes none.
// Nothing here touches the DOM when imported. To add a type: write the module, list it below.

import * as buckets from "./buckets.js";
import * as spot from "./spot.js";
import * as tradeoff from "./tradeoff.js";
import * as versus from "./versus.js";
import * as confirm from "./confirm.js";
import * as multi from "./multi.js";
import * as rank from "./rank.js";
import * as scale from "./scale.js";
import * as single from "./single.js";
import * as text from "./text.js";
import * as tune from "./tune.js";

export const TYPES = new Map(Object.entries({ single, multi, rank, scale, text, confirm, buckets, tradeoff, spot, versus, tune }));

// A question of a type the page does not know behaves like single, as it always did.
export const typeOf = (q) => TYPES.get(q.type) ?? single;

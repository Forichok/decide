// multi — pick several options, at least min and at most max. Engine side: lib/registry/types/multi.mjs.

import { describeChoice, emptyChoice, keys, renderChoice, sync } from "./choice.js";
import { checkChoice, compactChoice, recommendChoice } from "./shared.js";

export const emptyAnswer = emptyChoice;
// An own option counts as one pick.
export const isAnswered = (q, a) => a.selected.length + (a.other.trim() ? 1 : 0) >= Math.max(1, q.min);
export const describe = describeChoice;
export const render = renderChoice;
export const compact = compactChoice;
export const check = checkChoice(true);
export const recommend = recommendChoice(true);
export const badge = (q, t) => t("badge.multi", q.max);
export { keys, sync };

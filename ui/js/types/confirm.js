// confirm — yes, no, or yes with changes (which opens the note). Engine side: lib/registry/types/confirm.mjs.

import { describeChoice, emptyChoice, keys, renderChoice, sync } from "./choice.js";
import { checkChoice, compactChoice, recommendChoice } from "./shared.js";

export const emptyAnswer = emptyChoice;
export const isAnswered = (q, a) => a.selected.length > 0 || a.other.trim().length > 0;
export const describe = describeChoice;
export const render = renderChoice;
export const compact = compactChoice;
export const check = checkChoice(false);
export const recommend = recommendChoice(false);
export { keys, sync };

// inputs.js — the answer control of a question: the page's strings and media
// renderer handed to the question's type module (ui/js/types), and its in-place sync.

import { typeOf } from "./types/index.js";

export { autosize } from "./types/text.js";

// The type modules import neither i18n.js nor media.js (they must load under Node):
// the page's own t and renderMedia reach them on the round's ctx (round.js).
export const renderInput = (q, ctx) => typeOf(q).render(q, ctx);

export function syncInput(card, q, a) {
  typeOf(q).sync?.(card, q, a);
}

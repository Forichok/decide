// actions.js — buttons that need no agent: export this round, save it as an ADR, "I have 5 minutes".

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";
import { exportRoundFile, fitRound, saveRoundAdr } from "./net.js";
import { toast } from "./overlays.js";

const FIT_MINUTES = 5;

async function run(button, fn, done) {
  button.disabled = true;
  try {
    done(await fn());
  } catch (e) {
    toast(e?.message || t("actions.failed"));
  } finally {
    button.disabled = false;
  }
}

// On a round that waits for answers.
export function roundActions(id) {
  const exportBtn = h("button.btn.sm", { type: "button", html: `${icon("download")}${t("actions.export")}` });
  exportBtn.onclick = () => run(exportBtn, () => exportRoundFile(id), (r) => toast(t("actions.exported", r.file)));
  const fitBtn = h("button.btn.sm", { type: "button" }, t("actions.fit", FIT_MINUTES));
  fitBtn.onclick = () =>
    run(
      fitBtn,
      () => fitRound(id, FIT_MINUTES),
      () => location.reload(),
    );
  return h("div.actions-row", {}, fitBtn, exportBtn);
}

// On an answered round.
export function doneActions(id) {
  const adrBtn = h("button.btn.sm", { type: "button" }, t("actions.adr"));
  adrBtn.onclick = () => run(adrBtn, () => saveRoundAdr(id), (r) => toast(t(r.created ? "actions.adrWrote" : "actions.adrUpdated", r.file)));
  return h("div.actions-row", {}, adrBtn);
}

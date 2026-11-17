// The overview and the marks in the diff share one set of owner answers.
import { h } from "../dom.js";
import { t } from "../i18n.js";

const TYPES = ["fixed", "declined", "answered", "unaddressed"];
export const resolutionsOf = (s) => s.rv.resolved ?? [];
export const markOf = (s, ref) => Object.hasOwn(s.rv.resolutionOwners ?? {}, ref) ? s.rv.resolutionOwners[ref] : null;

export async function saveResolution(id, { ref, owner }) {
  const res = await fetch(`/api/rounds/${id}/resolution`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, owner }),
  });
  if (!res.ok) throw Object.assign(new Error("Resolution mark was not saved"), { status: res.status });
  return res.json();
}

function buttons(s, row) {
  return h("div.cr-resolution-actions", { role: "group", "aria-label": row.original.text },
    ["accepted", "notFixed"].map(owner => h("button.chip", {
      type: "button",
      dataset: { resolutionRef: row.ref, owner },
      "aria-pressed": String(markOf(s, row.ref) === owner),
      disabled: s.isResolutionSaving(row.ref),
      onclick: () => s.saveResolution(row.ref, owner),
    }, t(`cr.followup.${owner}`))));
}

export function paintResolutions(s) {
  for (const b of document.querySelectorAll("[data-resolution-ref]")) {
    const { resolutionRef, owner } = b.dataset;
    b.setAttribute("aria-pressed", String(markOf(s, resolutionRef) === owner));
    b.disabled = s.isResolutionSaving(resolutionRef);
  }
}

export function renderResolutions(s) {
  return h("section.cr-overview-section.cr-resolutions", { id: "cr-resolutions", "aria-labelledby": "cr-resolutions-title", tabindex: "-1", dataset: { section: "resolved" } },
    h("h3.cr-sub", { id: "cr-resolutions-title" }, t("cr.followup.title")),
    !resolutionsOf(s).length && h("p.cr-none", {}, t("cr.followup.empty")),
    TYPES.map(how => {
      const rows = resolutionsOf(s).filter(row => (row.how ?? "unaddressed") === how);
      if (!rows.length) return null;
      return h("div.cr-resolution-group", {},
        h("h4", {}, t(`cr.followup.${how}`)),
        h("ul.cr-resolution-list", {}, rows.map(row => {
          const { ref, original, kind, at, note } = row;
          const location = original.line ? `${original.file}:${original.line}` : original.file;
          return h("li.cr-resolution", { dataset: { resolution: ref } },
            h("div.cr-resolution-meta", {}, t(kind === "finding" || kind === "decision" ? `cr.followup.${kind}` : `cr.kind.${kind}`), ` [${ref}]`, location && h("code", {}, location)),
            h("p.cr-resolution-original", {}, original.text),
            original.answer && h("p.cr-resolution-note", {}, t("cr.followup.youAnswered", original.answer)),
            note && h("p.cr-resolution-note", {}, note),
            h("div.cr-resolution-foot", {}, buttons(s, row),
              row.anchor && h("button.link-btn", { type: "button", title: at, onclick: () => s.goResolution(row) }, t("cr.followup.jump"))));
        })));
    }));
}

export function resolutionMark(s, row) {
  const { kind, original: { answer, text } } = row;
  let label;
  if (kind === "finding") label = t("cr.followup.fixesFinding", row.ref, text);
  else if (answer) label = t("cr.followup.actsOnAnswer", answer, text);
  else if (kind === "decision") label = `${t("cr.followup.decision")}: «${text}»`;
  else label = t("cr.followup.fixesComment", text);
  return h("tr.cr-place.cr-resolution-mark", {},
    h("td", { colspan: 4 }, h("div.cr-place-in", { dataset: { resolution: row.ref } },
      h("span.cr-place-note", {}, label), buttons(s, row))));
}

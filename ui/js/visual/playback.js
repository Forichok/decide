import { h } from "../dom.js";
import { t } from "../i18n.js";

export function sharedInterval(clips) {
  return {
    start: Math.max(...clips.map(c => -c.cue)),
    end: Math.min(...clips.map(c => c.duration - c.cue))
  };
}

export const seconds = time => t("va.seconds", Number(time).toFixed(2));

// The slider counts seconds relative to the shared action. Pins keep native clip time.
export function playback(clips) {
  let aligned = true;
  let running = false;
  let frame = 0;
  let ready = false;
  const absolute = c => aligned ? c.cue : 0;
  const interval = () => sharedInterval(clips.map(c => ({ cue: absolute(c), duration: c.video.duration })));
  const track = h("input.va-seek", { type: "range", step: "any", "aria-label": t("va.timeline"), disabled: true });
  const output = h("output");
  const button = h("button.btn.sm", { type: "button", onclick: toggle, disabled: true });
  const error = h("span.va-error", { role: "alert" });
  const align = h("input", { type: "checkbox", checked: true, onchange: () => { aligned = align.checked; setup(); } });
  const name = () => { button.textContent = t(running ? (clips.length > 1 ? "va.pause" : "va.pauseOne") : (clips.length > 1 ? "va.play" : "va.playOne")); };
  function pause() {
    running = false;
    cancelAnimationFrame(frame);
    for (const c of clips) c.video.pause();
    name();
  }
  function seek(time) {
    if (!ready) return;
    time = Math.max(Number(track.min), Math.min(Number(track.max), time));
    for (const c of clips) c.video.currentTime = time + absolute(c);
    position(time);
  }
  // The reader sees time from the start of what both clips share; the slider keeps time around the action.
  function position(time) {
    track.value = String(time);
    output.textContent = seconds(Math.max(0, time - Number(track.min)));
    track.setAttribute("aria-valuetext", output.textContent);
  }
  function tick() {
    if (!running) return;
    const first = clips[0];
    if (!first.video.isConnected) return pause();
    const time = first.video.currentTime - absolute(first);
    if (time >= Number(track.max) - 0.015 || first.video.ended) {
      pause(); seek(Number(track.max)); return;
    }
    position(time);
    for (const c of clips.slice(1)) {
      if (Math.abs(c.video.currentTime - absolute(c) - time) > .12) c.video.currentTime = time + absolute(c);
    }
    frame = requestAnimationFrame(tick);
  }
  async function toggle() {
    if (running) return pause();
    if (!ready) return;
    if (Number(track.value) >= Number(track.max) - 0.02) seek(Number(track.min));
    running = true; name();
    try {
      await Promise.all(clips.map(c => c.video.play()));
      if (running) tick();
    } catch {
      if (running) { pause(); error.textContent = t("va.playFailed"); }
    }
  }
  function setup() {
    const previousTime = ready ? clips[0].video.currentTime - absolute(clips[0]) : null;
    if (!clips.every(c => Number.isFinite(c.video.duration) && c.video.duration > 0)) return;
    pause();
    const { start, end } = interval();
    ready = end > start;
    button.disabled = track.disabled = !ready;
    track.min = String(start); track.max = String(end);
    seek(previousTime == null ? start : Math.max(start, Math.min(end, previousTime)));
  }
  track.oninput = () => { pause(); seek(Number(track.value)); };
  for (const c of clips) {
    c.video.addEventListener("durationchange", setup);
    c.video.addEventListener("loadedmetadata", setup);
    c.video.addEventListener("ended", () => { if (running) { pause(); seek(Number(track.max)); } });
    c.video.addEventListener("error", () => { pause(); ready = false; button.disabled = track.disabled = true; error.textContent = t("va.loadFailed"); });
  }
  name();
  setup();
  return {
    el: h("div.va-player", {}, button, track, output,
      clips.length > 1 && h("label.va-check", {}, align, t("va.align")), error),
    pause,
    go(side, time) {
      const c = clips.find(c => c.side === side);
      if (!c) return;
      pause();
      if (!ready) return;
      const local = time - absolute(c);
      // A remark can be outside the shared interval when the clips have unmatched ends.
      if (local < Number(track.min) || local > Number(track.max)) {
        c.video.currentTime = Math.max(0, Math.min(c.video.duration, time));
      } else seek(local);
    }
  };
}

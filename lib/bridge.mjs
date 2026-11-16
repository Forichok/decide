// bridge.mjs — the knobs bridge: a small script the server puts into a mockup that belongs to a `tune`
// question, so the knob values the page sends reach the mockup with no script of the mockup's own.
//
// How a mockup gets it: the tune question's preview is published with a bridge flag (assets.mjs: publishNode
// of a node with type "tune", or publishDir(abs, { bridge: true })). The URL stays the same; the server
// injects the bridge when it serves that one html file under /r/. Any other mockup is served byte for byte.
//
// The bridge goes in inline, as the first thing in <head>, so it listens before the mockup's own scripts run.
// The served file keeps ASSET_CSP unchanged: a sandbox without allow-same-origin (an opaque origin) and no
// source but the server's own files, data: and blob:. Nothing is added to the policy for the bridge.
//
// In the frame it:
// - takes only messages from its parent (event.source === parent) shaped {type: "decide:knobs", values, theme};
// - sets --knob-<id> on the root: a number as is, {value, unit} as value+unit, a string as is
//   (a data:/blob: image as url("…"));
// - fills [data-knob="<id>"]: src for img/video/audio/source, textContent for anything else;
// - sets data-theme and color-scheme on the root when theme is "light" or "dark";
// - dispatches a bubbling `decide:knobs` CustomEvent on document with detail {values, theme};
// - tells the parent it is ready with {type: "decide:knobs-ready"}, so the page sends the values it holds.
// Ids are letters, digits, "_" and "-" only; any other id is skipped.

export const BRIDGE = `(()=>{if(window.parent===window)return;const root=document.documentElement,ID=/^[A-Za-z0-9_-]{1,64}$/,MEDIA=/^(IMG|VIDEO|AUDIO|SOURCE)$/;let last=null;
const css=(v)=>{if(v&&typeof v==="object"&&"value" in v)return String(v.value)+(v.unit?String(v.unit):"");if(typeof v==="string"&&/^(data:image\\/|blob:)/.test(v))return 'url("'+v.replace(/["\\\\\\n]/g,"")+'")';return String(v)};
const text=(v)=>v&&typeof v==="object"&&"value" in v?String(v.value):String(v);
function apply(){if(!last)return;const{values,theme}=last;for(const[id,v]of Object.entries(values)){if(!ID.test(id)||v==null)continue;root.style.setProperty("--knob-"+id,css(v));for(const el of document.querySelectorAll('[data-knob="'+id+'"]')){if(MEDIA.test(el.tagName))el.setAttribute("src",text(v));else el.textContent=text(v)}}
if(theme==="light"||theme==="dark"){root.setAttribute("data-theme",theme);root.style.colorScheme=theme}
document.dispatchEvent(new CustomEvent("decide:knobs",{bubbles:true,detail:{values,theme}}))}
addEventListener("message",(e)=>{if(e.source!==window.parent)return;const d=e.data;if(!d||d.type!=="decide:knobs"||!d.values||typeof d.values!=="object")return;last={values:d.values,theme:d.theme};if(document.readyState==="loading")return;apply()});
document.addEventListener("DOMContentLoaded",apply);
const ready=()=>window.parent.postMessage({type:"decide:knobs-ready"},"*");if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready);else ready()})()`;

const TAG = `<script data-decide-bridge>${BRIDGE}</script>`;

// The html with the bridge as the first thing in <head>; a document with no <head> gets it after <html>,
// then after the doctype, then at the very start. Never before the doctype: that would drop to quirks mode.
export function injectBridge(html) {
  const source = String(html);
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(source);
    if (m) return source.slice(0, m.index + m[0].length) + TAG + source.slice(m.index + m[0].length);
  }
  return TAG + source;
}

export const hasBridge = (html) => String(html).includes("<script data-decide-bridge>");

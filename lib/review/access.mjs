import { createHmac } from "node:crypto";

// The browser receives a read-only capability. A review link grants its round;
// opening the local app grants access across the rounds in its inbox.
export const reviewFileKey = (token, scope) =>
  createHmac("sha256", token).update(`review-files:${scope}`).digest("hex");

export function pageUrl(port, id, token, scope) {
  const hash = [];
  if (id) hash.push(`r=${encodeURIComponent(id)}`);
  if (scope) hash.push(`${scope === "*" ? "homeFiles" : "files"}=${reviewFileKey(token, scope)}`);
  return `http://127.0.0.1:${port}/${hash.length ? "#" + hash.join("&") : ""}`;
}

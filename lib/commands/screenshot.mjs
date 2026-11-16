// screenshot — capture a running page (or a simulator screen) to put real screens into a spec.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SIMULATORS, VIEWPORTS, capture, captureSim, viewportsOf } from "../shot.mjs";
import { PROJECT, UserError } from "./shared.mjs";

export default {
  name: "screenshot",
  summary: "capture a running page or a simulator screen",
  description:
    "Capture a running web page with the local headless Chrome, or the screen of a booted iOS simulator / running Android emulator. Returns PNG paths (and the images) to use in a spec.",
  mcp: true,
  cli: true,
  legacyFlag: "--shot",
  legacyValue: "url",
  params: {
    project: PROJECT,
    url: { kind: "string", positional: 0, schema: { type: "string", description: "http(s) URL, e.g. http://localhost:5173/settings" } },
    simulator: { kind: "string", flags: ["--sim"], selects: true, schema: { type: "string", enum: ["ios", "android"], description: "Instead of url: capture the booted iOS simulator (xcrun simctl) or the Android emulator (adb)." } },
    device: { kind: "string", schema: { type: "string", description: "With simulator: a simulator UDID or name, or an adb serial. Default: the booted one." } },
    viewport: { kind: "string", schema: { type: "string", enum: ["desktop", "mobile", "both"], description: "desktop 1440×900, mobile 390×844; default desktop." } },
    name: { kind: "string", schema: { type: "string", description: "File name hint." } },
    waitMs: { kind: "number", schema: { type: "number", description: "Let the page settle this long before capturing, default 1500." } },
    show: { kind: "boolean", only: "mcp", schema: { type: "boolean", description: "Return the images to you as well (default true)." } },
  },
  async run(args, ctx) {
    if (!args.url && !args.simulator) throw new UserError("Pass url (http or https), or simulator: ios | android.");
    // Everything that can be wrong with the call is said before the project's data directory is touched.
    if (args.simulator && !SIMULATORS.includes(String(args.simulator))) throw new UserError(`unknown simulator "${args.simulator}" (use ${SIMULATORS.join(" or ")})`);
    if (!args.simulator) {
      if (!/^https?:\/\//i.test(String(args.url))) throw new UserError(`only http(s) pages can be captured: ${args.url}`);
      for (const viewport of viewportsOf(args.viewport)) if (!VIEWPORTS[viewport]) throw new UserError(`unknown viewport "${viewport}" (use ${Object.keys(VIEWPORTS).join(", ")}, both)`);
    }
    const dir = resolve(ctx.project.dataDir, "shots");
    const shots = [];
    if (args.simulator) {
      const path = await captureSim({ simulator: String(args.simulator), dir, name: args.name, device: args.device }).catch((e) => {
        throw ctx.cli ? e : new UserError(e.message);
      });
      shots.push({ viewport: args.simulator, path });
    } else {
      for (const viewport of viewportsOf(args.viewport)) shots.push({ viewport, path: await capture({ url: args.url, dir, name: args.name, viewport, waitMs: args.waitMs || undefined }) });
    }
    if (ctx.cli) return { text: shots.map((s) => `DECIDE shot ${s.viewport}: ${s.path}`).join("\n") };
    const text = `${shots.map((s) => `${s.viewport}: ${s.path}`).join("\n")}\nUse these paths in a spec's images.`;
    const content = [{ type: "text", text }];
    if (args.show !== false) for (const s of shots) content.push({ type: "image", data: readFileSync(s.path).toString("base64"), mimeType: "image/png" });
    return { text, content };
  },
};

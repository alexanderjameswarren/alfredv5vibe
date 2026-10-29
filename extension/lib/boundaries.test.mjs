// The extension's two halves (switchboard2-h8r 0.7): the Switchboard bridge and
// the clipper. Phase 3 moves the bridge out, so neither half may import the
// other, except service-worker.js's one `import "./bridge.js"` that starts it.
//
//   node --test extension/lib/boundaries.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BRIDGE = ["bridge.js", "claude-watch.js", "lib/bridge-core.js"];
export const CLIPPER = [
  "service-worker.js", "popup.js", "options.js",
  "lib/api.js", "lib/config.js", "lib/page.js", "lib/plan.js", "lib/verify.js", "lib/visible.js",
];
const SEAM = { from: "service-worker.js", to: "bridge.js" };

/** Relative imports of one file, resolved to extension-relative paths. */
function importsOf(rel, text) {
  const out = [];
  for (const m of text.matchAll(/^\s*import\s+(?:[^"';]*?\sfrom\s+)?["'](\.[^"']+)["']/gm))
    out.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  return out;
}

/** Imports that cross the boundary, as "from -> to". `files`: { rel: text }. */
export function violations(files) {
  const half = (rel) => (BRIDGE.includes(rel) ? "bridge" : CLIPPER.includes(rel) ? "clipper" : null);
  const out = [];
  for (const [rel, text] of Object.entries(files)) {
    if (!half(rel)) out.push(`${rel} is in neither half`);
    for (const to of importsOf(rel, text)) {
      if (half(to) === half(rel)) continue;
      if (rel === SEAM.from && to === SEAM.to) continue;
      out.push(`${rel} -> ${to}`);
    }
  }
  return out;
}

function extensionFiles() {
  const files = {};
  for (const dir of ["", "lib"])
    for (const name of readdirSync(path.join(ROOT, dir)))
      if (name.endsWith(".js")) files[path.posix.join(dir, name)] = readFileSync(path.join(ROOT, dir, name), "utf8");
  return files;
}

test("the checker catches a crossing, a new file and allows the seam", () => {
  assert.deepEqual(
    violations({
      "service-worker.js": 'import "./bridge.js";\nimport { x } from "./lib/bridge-core.js";',
      "bridge.js": 'import { getConfig } from "./lib/config.js";',
      "lib/new.js": "",
    }),
    ["service-worker.js -> lib/bridge-core.js", "bridge.js -> lib/config.js", "lib/new.js is in neither half"],
  );
});

test("the extension's files keep the two halves apart", () => {
  assert.deepEqual(violations(extensionFiles()), []);
});

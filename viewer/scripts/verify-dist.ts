// Post-build integrity check: every `_a/*.js` reference in the built page
// HTMLs (and, transitively, every local import inside those chunks) must
// resolve to a file that actually exists in dist/_a. This is the exact
// invariant the orphan-chunk pruner once broke silently (commit 85d232c:
// the pruner deleted the whole client bundle while the build exited 0).
//
// Run after `bun run build`:  bun run verify:dist
// Exits 1 listing every broken reference; exits 0 quietly-ish otherwise.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlChunkRefs, localImportRefs } from "../src/build/prune-chunks.mjs";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const assetsDir = join(distDir, "_a");

if (!existsSync(distDir)) {
  console.error(`verify-dist: ${distDir} does not exist; run \`bun run build\` first`);
  process.exit(1);
}

const htmlFiles: string[] = [];
const walk = (d: string) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".html")) htmlFiles.push(p);
  }
};
walk(distDir);

const assetFiles = new Set(
  existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => f.endsWith(".js")) : [],
);

let refCount = 0;
const broken: string[] = [];
const checked = new Set<string>();
const queue: Array<{ from: string; chunk: string }> = [];

for (const h of htmlFiles) {
  for (const chunk of htmlChunkRefs(readFileSync(h, "utf8"))) {
    queue.push({ from: h.slice(distDir.length), chunk });
  }
}

if (htmlFiles.length === 0) {
  console.error("verify-dist: no HTML pages found in dist/");
  process.exit(1);
}
if (queue.length === 0) {
  // Pages that reference zero JS mean nothing hydrates: the dead-viewer
  // failure mode. The viewer always ships islands, so this is a failure.
  console.error("verify-dist: no _a/*.js references found in any page HTML (dead viewer?)");
  process.exit(1);
}

while (queue.length) {
  const { from, chunk } = queue.shift()!;
  refCount++;
  if (!assetFiles.has(chunk)) {
    broken.push(`${from} -> _a/${chunk} (missing)`);
    continue;
  }
  if (checked.has(chunk)) continue;
  checked.add(chunk);
  for (const dep of localImportRefs(readFileSync(join(assetsDir, chunk), "utf8"))) {
    queue.push({ from: `_a/${chunk}`, chunk: dep });
  }
}

if (broken.length > 0) {
  console.error(`verify-dist: ${broken.length} broken chunk reference(s):`);
  for (const b of broken) console.error(`  ${b}`);
  process.exit(1);
}

console.log(
  `verify-dist: OK: ${htmlFiles.length} pages, ${refCount} chunk refs, ` +
    `${checked.size}/${assetFiles.size} chunks reachable, 0 broken`,
);

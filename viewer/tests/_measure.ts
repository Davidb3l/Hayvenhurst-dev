// One-off helper: for each built HTML page, list the JS chunks it loads and
// sum their sizes (raw + gzip). Used to confirm bundle budgets after a
// `bun run build`.
//
// Run with: bun tests/_measure.ts

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = join(import.meta.dir, "..", "dist");

function listHtml(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (ent === "_a") continue;
      out.push(...listHtml(p));
    } else if (ent === "index.html") {
      out.push(p);
    }
  }
  return out;
}

function chunksReferenced(html: string): Set<string> {
  const re = /_a\/[A-Za-z0-9_\-]+\.js/g;
  return new Set(html.match(re) ?? []);
}

function expandWithImports(initial: Set<string>): Set<string> {
  // Walk import graph: a chunk may import other chunks dynamically.
  const seen = new Set<string>();
  const stack = [...initial];
  const importRe = /from\s*["']([^"']*\.js)["']|import\s*\(\s*["']([^"']*\.js)["']/g;
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    const p = join(DIST, c);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src))) {
      const ref = (m[1] ?? m[2])!;
      // Normalize relative paths back to "_a/<name>".
      const just = ref.replace(/^.*\//, "");
      const norm = `_a/${just}`;
      if (!seen.has(norm)) stack.push(norm);
    }
  }
  return seen;
}

function sizeOf(rel: string): number {
  const p = join(DIST, rel);
  if (!existsSync(p)) return 0;
  return statSync(p).size;
}

function gzipOf(rel: string): number {
  const p = join(DIST, rel);
  if (!existsSync(p)) return 0;
  return gzipSync(readFileSync(p)).length;
}

const pages = listHtml(DIST).sort();
console.log("page                                  | html | jsRaw | jsGz  | files");
console.log("-".repeat(85));
for (const page of pages) {
  const rel = "/" + relative(DIST, page).replace(/\\/g, "/").replace(/\/index\.html$/, "");
  const html = readFileSync(page, "utf8");
  const initial = chunksReferenced(html);
  const all = expandWithImports(initial);
  let raw = 0;
  let gz = 0;
  for (const c of all) {
    raw += sizeOf(c);
    gz += gzipOf(c);
  }
  const htmlSize = statSync(page).size;
  const label = rel.padEnd(38);
  console.log(
    `${label}| ${String(htmlSize).padStart(4)} | ${String(raw).padStart(5)} | ${String(gz).padStart(5)} | ${all.size}`,
  );
}

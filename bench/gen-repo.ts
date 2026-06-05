#!/usr/bin/env bun
/**
 * Synthetic-repo generator for Hayvenhurst PRD §16 benchmarks.
 *
 * Produces realistic-ish source across the 5 supported languages
 * (python / typescript / javascript / rust / go) — real functions, classes,
 * structs, imports, and intra-/inter-file references — so the tree-sitter
 * parser and the edge resolver actually have nodes and edges to resolve, not
 * blank lines.
 *
 * Two modes (pick whichever the §16 criterion needs):
 *
 *   bun bench/gen-repo.ts --out <dir> --lines  50000
 *       Target a total LINE count (§16(2) first-ingest: <30s on 50K lines).
 *       Files are "normal" sized (~120 lines) and split evenly across the 5
 *       languages.
 *
 *   bun bench/gen-repo.ts --out <dir> --files 30000
 *       Target a total FILE count (§16(9) watcher idle CPU on a 30K-FILE
 *       repo). Files are tiny (a handful of lines) but still valid + parseable.
 *
 * The output dir is created if missing. The generator never touches anything
 * outside --out. It does NOT run `git init` — the caller does that.
 *
 * Determinism: a fixed seed makes runs reproducible (so re-benching is stable).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Lang = "python" | "typescript" | "javascript" | "rust" | "go";
const LANGS: Lang[] = ["python", "typescript", "javascript", "rust", "go"];
const EXT: Record<Lang, string> = {
  python: "py",
  typescript: "ts",
  javascript: "js",
  rust: "rs",
  go: "go",
};

// ---- tiny deterministic PRNG (mulberry32) -------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ["compute", "resolve", "merge", "encode", "decode", "validate", "fetch", "build", "parse", "render", "hash", "sync"];
const NOUNS = ["node", "edge", "graph", "token", "claim", "trace", "peer", "segment", "leaf", "config", "buffer", "index"];

function name(rand: () => number, i: number): string {
  const v = VERBS[Math.floor(rand() * VERBS.length)];
  const n = NOUNS[Math.floor(rand() * NOUNS.length)];
  return `${v}_${n}_${i}`;
}

function pascal(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
}

// ---- per-language file emitters -----------------------------------------
// Each emitter produces `bodyFns` functions plus one class/struct, with a few
// imports and call references to neighboring files so the edge resolver works.

function emitPython(rand: () => number, idx: number, bodyFns: number, peers: number[]): string {
  const lines: string[] = [];
  lines.push("import os");
  lines.push("import sys");
  lines.push("from dataclasses import dataclass");
  for (const p of peers) lines.push(`from mod_${p} import Helper${p}`);
  lines.push("");
  lines.push("@dataclass");
  lines.push(`class Helper${idx}:`);
  lines.push("    value: int = 0");
  lines.push("");
  lines.push(`    def scale${idx}(self, factor: int) -> int:`);
  lines.push("        return self.value * factor + len(sys.argv)");
  lines.push("");
  for (let f = 0; f < bodyFns; f++) {
    const fn = name(rand, idx * 100 + f);
    lines.push(`def ${fn}(a: int, b: int) -> int:`);
    lines.push(`    total = a + b`);
    if (peers.length && f % 2 === 0) lines.push(`    total += Helper${peers[0]}().scale${peers[0]}(a)`);
    lines.push("    for i in range(b):");
    lines.push("        total += i * a");
    lines.push("    return total + os.getpid() % 7");
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function emitTs(rand: () => number, idx: number, bodyFns: number, peers: number[], js: boolean): string {
  const lines: string[] = [];
  for (const p of peers) lines.push(`import { helper${p} } from "./mod_${p}.${js ? "js" : "ts"}";`);
  lines.push("");
  const t = js ? "" : ": number";
  const ret = js ? "" : ": number";
  lines.push(`export class Service${idx} {`);
  lines.push(`  ${js ? "" : "private "}value${t} = ${idx};`);
  lines.push(`  scale${idx}(factor${t})${ret} {`);
  lines.push("    return this.value * factor;");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  for (let f = 0; f < bodyFns; f++) {
    const fn = name(rand, idx * 100 + f);
    lines.push(`export function ${fn}(a${t}, b${t})${ret} {`);
    lines.push("  let total = a + b;");
    if (peers.length && f % 2 === 0) lines.push(`  total += helper${peers[0]}(a);`);
    lines.push("  for (let i = 0; i < b; i++) {");
    lines.push("    total += i * a;");
    lines.push("  }");
    lines.push("  return total;");
    lines.push("}");
    lines.push("");
  }
  lines.push(`export function helper${idx}(x${t})${ret} { return new Service${idx}().scale${idx}(x); }`);
  return lines.join("\n") + "\n";
}

function emitRust(rand: () => number, idx: number, bodyFns: number, peers: number[]): string {
  const lines: string[] = [];
  lines.push("use std::collections::HashMap;");
  lines.push("");
  lines.push(`pub struct Service${idx} {`);
  lines.push("    pub value: i64,");
  lines.push("}");
  lines.push("");
  lines.push(`impl Service${idx} {`);
  lines.push(`    pub fn scale${idx}(&self, factor: i64) -> i64 {`);
  lines.push("        self.value * factor");
  lines.push("    }");
  lines.push("}");
  lines.push("");
  for (let f = 0; f < bodyFns; f++) {
    const fn = name(rand, idx * 100 + f);
    lines.push(`pub fn ${fn}(a: i64, b: i64) -> i64 {`);
    lines.push("    let mut total = a + b;");
    lines.push(`    let mut map: HashMap<i64, i64> = HashMap::new();`);
    lines.push("    for i in 0..b {");
    lines.push("        total += i * a;");
    lines.push("        map.insert(i, total);");
    lines.push("    }");
    lines.push(`    total + map.len() as i64`);
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function emitGo(rand: () => number, idx: number, bodyFns: number, peers: number[]): string {
  const lines: string[] = [];
  lines.push("package main");
  lines.push("");
  lines.push('import "fmt"');
  lines.push("");
  lines.push(`type Service${idx} struct {`);
  lines.push("\tValue int64");
  lines.push("}");
  lines.push("");
  lines.push(`func (s *Service${idx}) Scale${idx}(factor int64) int64 {`);
  lines.push("\treturn s.Value * factor");
  lines.push("}");
  lines.push("");
  for (let f = 0; f < bodyFns; f++) {
    const fn = pascal(name(rand, idx * 100 + f));
    lines.push(`func ${fn}(a int64, b int64) int64 {`);
    lines.push("\ttotal := a + b");
    lines.push("\tfor i := int64(0); i < b; i++ {");
    lines.push("\t\ttotal += i * a");
    lines.push("\t}");
    lines.push("\t_ = fmt.Sprintf(\"%d\", total)");
    lines.push("\treturn total");
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function emit(lang: Lang, rand: () => number, idx: number, bodyFns: number, peers: number[]): string {
  switch (lang) {
    case "python": return emitPython(rand, idx, bodyFns, peers);
    case "typescript": return emitTs(rand, idx, bodyFns, peers, false);
    case "javascript": return emitTs(rand, idx, bodyFns, peers, true);
    case "rust": return emitRust(rand, idx, bodyFns, peers);
    case "go": return emitGo(rand, idx, bodyFns, peers);
  }
}

// ---- driver --------------------------------------------------------------
function parseArgs(): { out: string; lines?: number; files?: number; seed: number } {
  const a = process.argv.slice(2);
  let out = "", lines: number | undefined, files: number | undefined, seed = 42;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--out") out = a[++i];
    else if (a[i] === "--lines") lines = parseInt(a[++i], 10);
    else if (a[i] === "--files") files = parseInt(a[++i], 10);
    else if (a[i] === "--seed") seed = parseInt(a[++i], 10);
  }
  if (!out) { console.error("error: --out <dir> required"); process.exit(2); }
  if (!lines && !files) { console.error("error: one of --lines / --files required"); process.exit(2); }
  return { out, lines, files, seed };
}

function main() {
  const { out, lines, files, seed } = parseArgs();
  const rand = rng(seed);
  mkdirSync(out, { recursive: true });

  // Spread files across language subdirs so the on-disk layout looks like a
  // polyglot monorepo.
  const dirs: Record<Lang, string> = {} as Record<Lang, string>;
  for (const l of LANGS) {
    dirs[l] = join(out, l);
    mkdirSync(dirs[l], { recursive: true });
  }

  let totalLines = 0;
  let totalFiles = 0;
  // Per-file function body count. LINE mode → fat files; FILE mode → tiny.
  const bodyFns = files ? 1 : 6;

  const targetFiles = files ?? Infinity;
  const targetLines = lines ?? Infinity;

  let idx = 0;
  while (totalFiles < targetFiles && totalLines < targetLines) {
    const lang = LANGS[idx % LANGS.length];
    // A couple of peer references for the edge resolver (only when we already
    // have prior files of the same language to import).
    const peers: number[] = [];
    if (idx >= LANGS.length && bodyFns > 1) {
      const prior = idx - LANGS.length;
      if (prior >= 0) peers.push(prior);
    }
    const content = emit(lang, rand, idx, bodyFns, peers);
    const fname = join(dirs[lang], `mod_${idx}.${EXT[lang]}`);
    writeFileSync(fname, content);
    totalLines += content.split("\n").length - 1;
    totalFiles += 1;
    idx += 1;
  }

  // Go needs a go.mod to look like a module (optional, but cheap + realistic).
  writeFileSync(join(dirs.go, "go.mod"), "module bench\n\ngo 1.21\n");

  console.log(JSON.stringify({ out, files: totalFiles, lines: totalLines, seed }, null, 0));
}

main();

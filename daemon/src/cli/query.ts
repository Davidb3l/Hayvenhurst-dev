/**
 * `hayven query <terms...> [--json] [--limit N] [--path <prefix>] [--semantic] [--refresh]` — FTS5 search.
 */
import { resolveSemanticInfer, searchFts, searchFtsSemantic } from "../db/fts.ts";
import { refreshIfRequested, warnIfStale } from "../db/freshness.ts";
import type { ParsedArgs } from "../cli.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

export async function runQuery(args: ParsedArgs): Promise<number> {
  if (args.positionals.length === 0) {
    process.stderr.write(
      "usage: hayven query <terms...> [--json] [--limit N] [--path <prefix>] [--semantic] [--refresh]\n",
    );
    return 2;
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write((err as Error).message + "\n");
    return 1;
  }

  // Opt-in `--refresh`: BEFORE the read, run a FULL reindex (whole-repo
  // drop+re-parse — the CLI has no incremental mode; only the daemon watcher
  // does) IFF the index looks stale AND no daemon/watcher owns the project (the
  // daemon keeps it fresh — never race its writes). A no-op when fresh or
  // daemon-owned, and entirely skipped without the flag (the read path is then
  // byte-identical to today: no reindex, no writes). Done before we open the
  // read handle so the ingest's writer connection doesn't contend with our
  // readonly one.
  if (isTrue(args.flags["refresh"])) {
    await refreshIfRequested(args, ctx);
  }

  const db = openProjectDb(ctx, { readonly: true });
  try {
    // Surface (on stderr only) if the index looks stale and no watcher owns it.
    // Never touches stdout, so `--json` stays byte-identical and pipeable.
    warnIfStale(db, ctx.paths);
    const q = args.positionals.join(" ");
    const limit = Math.min(100, Math.max(1, Number(args.flags["limit"]) || 20));
    // Optional `--path <prefix>` (or `--path=<prefix>`) scopes results to nodes
    // whose repo-relative file path begins with <prefix>. A boolean `--path`
    // (no value) or empty string is treated as "no filter".
    const pathFlag = args.flags["path"];
    const path = typeof pathFlag === "string" ? pathFlag : undefined;
    // `--semantic`: opt into the model-gated query-expansion path
    // (`searchFtsSemantic`). With NO model present, `resolveSemanticInfer`
    // returns `undefined` and `searchFtsSemantic` degrades to the model-free
    // base — i.e. AT LEAST the `searchFts` results, never an error. The semantic
    // path honors `--path` too: model expansion applies WITHIN the scoped
    // prefix, so the echoed `path` in `--json` is truthful.
    const hits = isTrue(args.flags["semantic"])
      ? await searchFtsSemantic(
          db.handle,
          q,
          resolveSemanticInfer({
            hayvenDir: ctx.paths.hayvenDir,
            modelId: ctx.config.models.tier3.model,
            repoRoot: ctx.paths.repoRoot,
          }),
          limit,
          { path },
        )
      : searchFts(db.handle, q, limit, { path });
    if (isJson(args.flags)) {
      const payload: Record<string, unknown> = { query: q, count: hits.length, hits };
      if (path != null && path.trim().length > 0) payload.path = path;
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return 0;
    }
    if (hits.length === 0) {
      process.stdout.write(`No matches for: ${q}\n`);
      return 0;
    }
    const lines: string[] = [`# Search: ${q}`, "", `${hits.length} match${hits.length === 1 ? "" : "es"}`, ""];
    for (const h of hits) {
      lines.push(`## \`${h.name}\``);
      lines.push(`- id: \`${h.id}\``);
      lines.push(`- qualified: \`${h.qualified_name}\``);
      if (h.summary && h.summary.trim().length > 0) {
        lines.push("");
        lines.push(h.summary.trim().slice(0, 280));
      }
      lines.push("");
    }
    process.stdout.write(lines.join("\n"));
    return 0;
  } finally {
    db.close();
  }
}

/** A boolean flag present as either the parser's `true` or the string "true". */
function isTrue(flag: string | boolean | undefined): boolean {
  return flag === true || flag === "true";
}

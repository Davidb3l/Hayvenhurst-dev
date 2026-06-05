/**
 * `hayven context <symbol> [--json] [--no-neighbors] [--max-neighbors N]` —
 * the context-cost PACKER (Phase 0.0.4.5 pivot; see `docs/PHASE_0.0.4.5_PIVOT.md`).
 *
 * Returns the minimal precise slice pack for a symbol — the target file's
 * import header + the target entity body + its 1-hop callee dependencies, all
 * line-exact — so a BUILDER (Agent-SDK app / multi-agent harness) can feed an
 * agent the 3 functions that matter instead of the 800-line file. Markdown by
 * default (fenced, line-labeled, paste-ready); `--json` for programmatic use.
 *
 * It ALSO accepts a NATURAL-LANGUAGE TASK via `--task` (the `<symbol|task>` half
 * the pivot doc named): the positionals are treated as a task description,
 * resolved to candidate symbols via the embedding-free FTS path
 * (`resolveTaskToSymbols`), and a pack is built + concatenated per symbol.
 *
 *   hayven context <text...> --task [--top N] [--json] [--no-neighbors] [--max-neighbors N]
 *
 * (The hand-rolled arg parser eats the token after a value-flag, so put the task
 * text BEFORE the flags — `hayven context fix auth bug --task --top 2`.)
 *
 * Read-only: this never spawns an ingest or mutates the index.
 */
import type { ParsedArgs } from "../cli.ts";
import {
  buildContextPack,
  type ContextPack,
  type ContextSlice,
} from "../db/context_pack.ts";
import { resolveTaskToSymbols } from "../db/task_resolve.ts";
import { warnIfStale } from "../db/freshness.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

/** Map a file path to a Markdown code-fence language hint (best-effort). */
function fenceLang(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "astro":
      return "astro";
    default:
      return "";
  }
}

/** One-line label for a slice, e.g. `target  src/x.ts:10-42  (function)`. */
function sliceLabel(s: ContextSlice): string {
  const loc = `${s.file}:${s.startLine}-${s.endLine}`;
  const extra =
    s.role === "neighbor"
      ? s.via === "ref"
        ? ", referenced by target"
        : s.weight !== undefined
          ? `, ${s.weight} call${s.weight === 1 ? "" : "s"} from target`
          : ""
      : "";
  return `${s.role}  ${loc}  (${s.kind}${extra})`;
}

/**
 * Render ONE context pack to its Markdown lines (heading + summary + fenced,
 * line-labeled slices + notes). Shared by the single-symbol path and `--task`
 * mode so both render identically. `slices` is passed explicitly so task mode
 * can hand in the cross-pack-deduped subset; `pack` still carries the summary
 * counts/notes. Returns the lines (no trailing blank-line normalization).
 */
function renderPack(pack: ContextPack, slices: ContextSlice[]): string[] {
  const neighborCount = slices.filter((s) => s.role === "neighbor").length;
  const lines = [
    `# Context pack for \`${pack.symbol}\``,
    "",
    `${slices.length} slice(s), ${pack.lineCount} line(s), ~${pack.estTokens} tokens ` +
      `(header + target + ${neighborCount} callee neighbor(s)).`,
    "",
  ];
  for (const s of slices) {
    lines.push(`## ${sliceLabel(s)}`);
    lines.push("```" + fenceLang(s.file));
    lines.push(s.text);
    lines.push("```");
    lines.push("");
  }
  if (pack.notes.length > 0) {
    lines.push("> notes: " + pack.notes.join("; "));
  }
  return lines;
}

/** Stable per-slice key for cross-pack dedup: a slice is "the same context" when
 *  it covers the same file lines, regardless of which pack surfaced it. */
function sliceKey(s: ContextSlice): string {
  return `${s.file}:${s.startLine}-${s.endLine}`;
}

export async function runContext(args: ParsedArgs): Promise<number> {
  const isTask = args.flags["task"] === true || args.flags["task"] === "true";
  return isTask ? runTaskMode(args) : runSymbolMode(args);
}

/** The EXISTING single-symbol path — behavior unchanged. */
async function runSymbolMode(args: ParsedArgs): Promise<number> {
  const rawId = args.positionals[0];
  if (!rawId) {
    process.stderr.write(
      "usage: hayven context <symbol> [--json] [--no-neighbors] [--max-neighbors N]\n",
    );
    return 2;
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const neighbors = !(
    args.flags["no-neighbors"] === true || args.flags["no-neighbors"] === "true"
  );
  const maxFlag = args.flags["max-neighbors"];
  const maxNeighbors =
    maxFlag === undefined || maxFlag === true ? undefined : Number(maxFlag);

  const db = openProjectDb(ctx, { readonly: true });
  try {
    warnIfStale(db, ctx.paths);
    const pack = buildContextPack(db, ctx.paths.repoRoot, rawId, {
      neighbors,
      maxNeighbors:
        maxNeighbors !== undefined && !Number.isNaN(maxNeighbors)
          ? maxNeighbors
          : undefined,
    });
    if (!pack) {
      process.stderr.write(
        `No node with id \`${rawId}\` — try \`hayven query ${rawId}\` to fuzzy-find it.\n`,
      );
      return 1;
    }
    if (pack.resolved) {
      process.stderr.write(
        `note: \`${rawId}\` not found exactly; using \`${pack.symbol}\` (top search hit).\n`,
      );
    }

    if (isJson(args.flags)) {
      process.stdout.write(JSON.stringify(pack, null, 2) + "\n");
      return 0;
    }

    process.stdout.write(renderPack(pack, pack.slices).join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

/**
 * The `--task` path: resolve the positionals (a natural-language task) to
 * candidate symbols via the embedding-free FTS resolver, build a pack per
 * symbol, dedup slices ACROSS packs, and emit them concatenated.
 */
async function runTaskMode(args: ParsedArgs): Promise<number> {
  const taskText = args.positionals.join(" ").trim();
  if (!taskText) {
    process.stderr.write(
      "usage: hayven context <text...> --task [--top N] [--json] [--no-neighbors] [--max-neighbors N]\n",
    );
    return 2;
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const topFlag = args.flags["top"];
  const top =
    topFlag === undefined || topFlag === true ? undefined : Number(topFlag);
  const limit = top !== undefined && !Number.isNaN(top) ? top : 3;

  const neighbors = !(
    args.flags["no-neighbors"] === true || args.flags["no-neighbors"] === "true"
  );
  const maxFlag = args.flags["max-neighbors"];
  const maxNeighbors =
    maxFlag === undefined || maxFlag === true ? undefined : Number(maxFlag);

  const db = openProjectDb(ctx, { readonly: true });
  try {
    warnIfStale(db, ctx.paths);

    const resolved = resolveTaskToSymbols(db, taskText, limit);
    if (resolved.length === 0) {
      process.stderr.write(
        `No symbols matched task \`${taskText}\` — try \`hayven query "${taskText}"\` to explore, or pass an exact symbol.\n`,
      );
      return 1;
    }

    const packOpts = {
      neighbors,
      maxNeighbors:
        maxNeighbors !== undefined && !Number.isNaN(maxNeighbors)
          ? maxNeighbors
          : undefined,
    };

    // Build one pack per resolved symbol. Each pack keeps its FULL slice list
    // (for --json fidelity); the markdown path renders a cross-pack-deduped view.
    const packs: ContextPack[] = [];
    for (const id of resolved) {
      const pack = buildContextPack(db, ctx.paths.repoRoot, id, packOpts);
      if (pack) packs.push(pack);
    }

    if (packs.length === 0) {
      process.stderr.write(
        `Resolved task \`${taskText}\` to ${resolved.length} symbol(s) but none could be packed.\n`,
      );
      return 1;
    }

    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify(
          { task: taskText, resolved: packs.map((p) => p.symbol), packs },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    const lines: string[] = [
      `# Context for task: ${taskText}`,
      "",
      `Resolved ${packs.length} symbol(s): ${packs.map((p) => `\`${p.symbol}\``).join(", ")}.`,
      "",
    ];
    // Dedup slices ACROSS packs by (file,startLine,endLine) so overlapping
    // symbols don't repeat the same context.
    const seen = new Set<string>();
    for (const pack of packs) {
      const slices = pack.slices.filter((s) => {
        const key = sliceKey(s);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      lines.push(...renderPack(pack, slices));
      lines.push("");
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

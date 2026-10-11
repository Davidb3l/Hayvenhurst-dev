/**
 * The LAZY REFRESH half of per-worktree overlays (HAYV-13), run by
 * `cli.ts#main` before dispatching a graph-reading command.
 *
 * Why here and not inside `openProjectDb`: refreshing means running the native
 * parser, which is async, and `requireProject`/`openProjectDb` are synchronous
 * and called from ~20 sites. Making them async would ripple through every
 * command for a step that only ever matters inside a registered worktree. One
 * awaited call at the dispatch chokepoint gives every graph read the same
 * guarantee with no per-command code: by the time the command opens its index,
 * the overlay matches the worktree (or a loud warning has said it does not).
 *
 * Kept out of `_shared.ts` on purpose: it pulls in the ingest machinery, and
 * `_shared.ts` is imported by that machinery's own callers.
 */
import { refreshOverlay } from "../worktree/overlay.ts";
import { requireProject } from "./_shared.ts";

/**
 * Refresh the overlay for the current project location, when there is one.
 * Silent when nothing needed doing or succeeded; never throws. A project that
 * does not resolve at all is left for the command itself to report.
 */
export async function prepareOverlayForRead(): Promise<void> {
  let ctx;
  try {
    ctx = requireProject();
  } catch {
    return;
  }
  const overlay = ctx.overlay;
  if (overlay === undefined) return;
  try {
    await refreshOverlay({ paths: ctx.paths, config: ctx.config, entry: overlay.entry });
  } catch (err) {
    process.stderr.write(
      `WARNING: could not refresh the overlay index for worktree ${overlay.worktreeRoot}: ` +
        `${(err as Error).message}\n` +
        "Results may not reflect the worktree's latest changes. Retry, or run `hayven ingest --full` from the worktree.\n",
    );
  }
}

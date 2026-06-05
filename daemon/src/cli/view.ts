/**
 * `hayven view` — open the Astro viewer at http://localhost:<port>.
 */
import type { ParsedArgs } from "../cli.ts";
import { requireProject } from "./_shared.ts";

export async function runView(_args: ParsedArgs): Promise<number> {
  const ctx = requireProject();
  const url = `http://${ctx.config.daemon_host}:${ctx.config.daemon_port}/`;
  process.stdout.write(`Opening ${url}\n`);
  await openUrl(url);
  return 0;
}

/** Best-effort cross-platform `open` of a URL. */
async function openUrl(url: string): Promise<void> {
  const cmd = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  try {
    const child = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
    await child.exited;
  } catch {
    // Don't fail the command if no opener is available — the URL was already printed.
  }
}

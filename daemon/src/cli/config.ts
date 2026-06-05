/**
 * `hayven config [key] [value]` — read/write config values.
 *
 *   hayven config                  prints the merged effective config (JSON).
 *   hayven config daemon_port      prints a single value.
 *   hayven config daemon_port 8080 sets the value in the project's local config.
 */
import { existsSync, readFileSync } from "node:fs";

import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { ConfigError, loadConfig, validateConfig, writeConfig } from "../config/load.ts";
import { detectRepoRoot, hayvenPathsFor } from "../util/paths.ts";
import type { ParsedArgs } from "../cli.ts";

export async function runConfig(args: ParsedArgs): Promise<number> {
  const { root, reason } = detectRepoRoot();
  const paths = hayvenPathsFor(root);
  const loaded = loadConfig(root);

  const [key, value] = args.positionals;

  // A read against an uninitialized/mis-resolved tree silently omits the project
  // config layer — warn so the effective config isn't mistaken for the project's
  // (audit M1). The write path below is already guarded by an existsSync check.
  if (value === undefined && !existsSync(paths.hayvenDir)) {
    process.stderr.write(
      `note: no project .hayven found (root resolved to ${root} via ${reason}); ` +
        "showing global + default config only — run `hayven init` for a project layer.\n",
    );
  }

  if (!key) {
    process.stdout.write(JSON.stringify(loaded.config, null, 2) + "\n");
    process.stdout.write(`# sources: ${loaded.sources.join(", ")}\n`);
    return 0;
  }

  if (value === undefined) {
    const current = getByPath(loaded.config as unknown as Record<string, unknown>, key);
    if (current === undefined) {
      process.stderr.write(`unknown config key: ${key}\n`);
      return 1;
    }
    process.stdout.write(JSON.stringify(current, null, 2) + "\n");
    return 0;
  }

  // Set a value: read local config (if any), patch, validate, write back.
  if (!existsSync(paths.hayvenDir)) {
    process.stderr.write("error: no .hayven/ directory — run `hayven init` first.\n");
    return 1;
  }

  let existing: Record<string, unknown>;
  try {
    existing = existsSync(paths.configFile)
      ? (JSON.parse(readFileSync(paths.configFile, "utf8")) as Record<string, unknown>)
      : { ...DEFAULT_CONFIG };
  } catch (err) {
    process.stderr.write(`error: could not read existing config ${paths.configFile}: ${(err as Error).message}\n`);
    return 1;
  }
  setByPath(existing, key, parseValue(value));

  // Validation is correct — it just throws ConfigError, which previously dumped
  // a raw stack trace. Surface it as a clean `error:` line + exit 1.
  let validated;
  try {
    validated = validateConfig(existing);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`error: invalid value for ${key}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  writeConfig(paths.configFile, validated);
  process.stdout.write(`wrote ${key} = ${value} to ${paths.configFile}\n`);
  return 0;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function getByPath(obj: Record<string, unknown>, dottedKey: string): unknown {
  const parts = dottedKey.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const next = cur[p];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

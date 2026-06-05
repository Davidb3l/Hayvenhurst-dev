/**
 * Config loader and validator.
 *
 * Load order (later overrides earlier, deep-merged):
 *   1. {@link DEFAULT_CONFIG}
 *   2. `~/.hayven/config.json`
 *   3. `<repo>/.hayven/config.json`
 *   4. Environment variable overrides (`HAYVEN_PORT`, `HAYVEN_HOST`, ...).
 *
 * Validation is hand-rolled to avoid pulling in Zod. The validator returns the
 * narrowed config or throws a `ConfigError` with a readable message.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_CONFIG, type HayvenConfig, type ModelConfig } from "./defaults.ts";
import { globalConfigFile, hayvenPathsFor } from "../util/paths.ts";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge `source` into `target`. Arrays are replaced, not concatenated. */
export function deepMerge<T>(target: T, source: unknown): T {
  if (!isPlainObject(source)) return target;
  if (!isPlainObject(target)) return source as T;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, val] of Object.entries(source)) {
    const existing = out[key];
    if (isPlainObject(val) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, val);
    } else {
      out[key] = val;
    }
  }
  return out as T;
}

function readJsonIfExists(path: string): Json | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text) as Json;
  } catch (err) {
    throw new ConfigError(`Failed to parse ${path}: ${(err as Error).message}`);
  }
}

function validateModel(label: string, value: unknown): ModelConfig {
  if (!isPlainObject(value)) {
    throw new ConfigError(`config.models.${label} must be an object`);
  }
  const provider = value["provider"];
  const model = value["model"];
  if (typeof provider !== "string" || provider.length === 0) {
    throw new ConfigError(`config.models.${label}.provider must be a non-empty string`);
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new ConfigError(`config.models.${label}.model must be a non-empty string`);
  }
  return { provider, model };
}

/** Validate (and normalize) a partial config blob. */
export function validateConfig(raw: unknown): HayvenConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("config must be a JSON object");
  }
  const merged = deepMerge(DEFAULT_CONFIG, raw);

  const models = merged.models;
  const validated: HayvenConfig = {
    ...merged,
    models: {
      tier1: validateModel("tier1", models.tier1),
      tier2: validateModel("tier2", models.tier2),
      tier3: validateModel("tier3", models.tier3),
      fallback: validateModel("fallback", models.fallback),
    },
  };

  if (!Number.isInteger(validated.daemon_port) || validated.daemon_port <= 0 || validated.daemon_port > 65535) {
    throw new ConfigError("config.daemon_port must be an integer in 1..65535");
  }
  if (typeof validated.daemon_host !== "string" || validated.daemon_host.length === 0) {
    throw new ConfigError("config.daemon_host must be a non-empty string");
  }
  if (!Number.isInteger(validated.trace_sample_rate) || validated.trace_sample_rate < 1) {
    throw new ConfigError("config.trace_sample_rate must be a positive integer");
  }
  if (!Array.isArray(validated.sync_peers) || validated.sync_peers.some((p) => typeof p !== "string")) {
    throw new ConfigError("config.sync_peers must be an array of strings");
  }
  if (!Array.isArray(validated.parse_languages) || validated.parse_languages.some((l) => typeof l !== "string")) {
    throw new ConfigError("config.parse_languages must be an array of strings");
  }
  if (!Number.isInteger(validated.parse_jobs) || validated.parse_jobs < 0) {
    throw new ConfigError("config.parse_jobs must be a non-negative integer (0 = auto)");
  }
  if (!Number.isInteger(validated.ingest_timeout_seconds) || validated.ingest_timeout_seconds < 1) {
    throw new ConfigError("config.ingest_timeout_seconds must be a positive integer");
  }
  return validated;
}

function envOverrides(): Partial<HayvenConfig> {
  const out: Record<string, unknown> = {};
  const port = process.env["HAYVEN_PORT"];
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n)) {
      throw new ConfigError(`HAYVEN_PORT is not an integer: ${port}`);
    }
    out["daemon_port"] = n;
  }
  const host = process.env["HAYVEN_HOST"];
  if (host !== undefined && host.length > 0) {
    out["daemon_host"] = host;
  }
  return out as Partial<HayvenConfig>;
}

export interface LoadedConfig {
  config: HayvenConfig;
  sources: string[];
}

export function loadConfig(repoRoot?: string): LoadedConfig {
  const sources: string[] = ["<defaults>"];
  let merged: HayvenConfig = DEFAULT_CONFIG;

  const global = readJsonIfExists(globalConfigFile());
  if (global !== null) {
    merged = deepMerge(merged, global);
    sources.push(globalConfigFile());
  }

  if (repoRoot) {
    const local = readJsonIfExists(hayvenPathsFor(repoRoot).configFile);
    if (local !== null) {
      merged = deepMerge(merged, local);
      sources.push(hayvenPathsFor(repoRoot).configFile);
    }
  }

  merged = deepMerge(merged, envOverrides());
  if (Object.keys(envOverrides()).length > 0) sources.push("<env>");

  return { config: validateConfig(merged), sources };
}

export function writeConfig(path: string, config: HayvenConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

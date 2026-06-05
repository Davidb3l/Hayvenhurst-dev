/**
 * Static file serving for the built Astro viewer plus an SPA-style fallback
 * for client-rendered routes.
 *
 * The viewer at `viewer/dist/` is built once (`bun run build:viewer` at the
 * repo root). The daemon serves those files directly so `hayven view` opens
 * a single, daemon-served URL with no separate dev server.
 *
 * The viewer's `/node/<id>` page is a single client-fetch shell — at build
 * time only `viewer/dist/node/index.html` exists. We rewrite any unmatched
 * `/node/*` path to that shell so deep-links work.
 */
import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { Elysia } from "elysia";

import type { ServerDependencies } from "../server.ts";

/**
 * MIME type lookup for the extensions Astro produces. Intentionally tiny —
 * we don't need a full DB. Anything not matched falls back to
 * `application/octet-stream`, which browsers handle gracefully.
 */
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  woff: "font/woff",
  woff2: "font/woff2",
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * Resolve a request path under a root, defending against directory traversal.
 * Returns null when the resolved path escapes the root or doesn't exist as a
 * regular file. Directories become `<dir>/index.html`.
 */
function resolveStatic(root: string, requestPath: string): string | null {
  const stripped = requestPath.replace(/^\/+/, "");
  const candidate = resolve(root, stripped);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || rel.startsWith(`..${"/"}`)) return null;

  if (!existsSync(candidate)) return null;

  const st = statSync(candidate);
  if (st.isDirectory()) {
    const indexPath = join(candidate, "index.html");
    return existsSync(indexPath) ? indexPath : null;
  }
  return st.isFile() ? candidate : null;
}

export function viewerRoutes(deps: ServerDependencies) {
  const root = resolve(deps.paths.viewerDist);
  const hasBuild = existsSync(root);

  if (!hasBuild) {
    deps.logger.warn(
      "viewer build not found — `hayven view` and the in-browser UI " +
        "will be unavailable until you run `bun run build:viewer` at the " +
        "repo root.",
      { searched: root },
    );
  }

  return new Elysia()
    .get("/__viewer/status", () => ({
      built: hasBuild,
      root,
    }))
    .get("/node/*", async ({ request, set }) => {
      // SPA-style fallback. The Astro build emits one HTML shell at
      // `viewer/dist/node/index.html`; the client reads the id off
      // `window.location.pathname` and fetches from `/api/nodes/:id`.
      if (!hasBuild) {
        set.status = 503;
        return { error: "viewer not built" };
      }
      const url = new URL(request.url);
      const direct = resolveStatic(root, url.pathname);
      const shellPath = join(root, "node", "index.html");
      const target = direct ?? (existsSync(shellPath) ? shellPath : null);
      if (!target) {
        set.status = 404;
        return { error: "viewer node shell not found" };
      }
      set.headers["content-type"] = mimeFor(target);
      // No long-term cache on HTML — viewer rebuilds need to be visible.
      set.headers["cache-control"] = "no-cache";
      return Bun.file(target);
    })
    .get("/*", async ({ request, set }) => {
      // General static fallthrough — must run AFTER all /api/* and /__viewer
      // routes have had a chance to match.
      const url = new URL(request.url);

      // A request that fell through to here under `/api/*` is an unknown API
      // route, NOT a viewer asset. Return the SAME JSON 404 shape Elysia's
      // onError emits for a matched-route NOT_FOUND (`{error, code}`) so every
      // /api/* 404 is uniform. Never serve the HTML SPA shell for /api/*.
      if (url.pathname.startsWith("/api/")) {
        set.status = 404;
        return { error: "NOT_FOUND", code: "NOT_FOUND" };
      }

      if (!hasBuild) {
        set.status = 404;
        return { error: "viewer not built" };
      }
      const target = resolveStatic(root, url.pathname);
      if (!target) {
        // Try the index.html as a last-resort root fallback.
        const indexPath = join(root, "index.html");
        if (url.pathname === "/" && existsSync(indexPath)) {
          set.headers["content-type"] = "text/html; charset=utf-8";
          set.headers["cache-control"] = "no-cache";
          return Bun.file(indexPath);
        }
        set.status = 404;
        return { error: "not found" };
      }
      set.headers["content-type"] = mimeFor(target);
      // HTML stays uncached (rebuilds), everything else gets a long cache
      // header because Astro builds emit content-hashed asset filenames.
      if (target.endsWith(".html")) {
        set.headers["cache-control"] = "no-cache";
      } else {
        set.headers["cache-control"] = "public, max-age=31536000, immutable";
      }
      return Bun.file(target);
    });
}

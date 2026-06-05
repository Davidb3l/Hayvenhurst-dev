import type { ComponentChildren } from "preact";
import { useState, useEffect } from "preact/hooks";
import { api, qk } from "~/api/client";
import { useQuery } from "./useQuery";

// Reads the live `?q=` from the URL at hydration time so the page renders
// results for any runtime query, independent of the build-time query. The
// island is mounted with `client:only` (see search.astro), so this only ever
// runs in the browser. `initial` seeds the first paint to avoid a flash when
// the prop is already known. (BL-17 #3.)
function readQuery(initial: string): string {
  if (typeof window === "undefined") return initial;
  return new URLSearchParams(window.location.search).get("q") ?? initial;
}

// Split an entity id ("conflict/oracle/HeuristicOracle") into a dimmed path
// prefix and the bright trailing symbol, for readable scanning.
function splitId(id: string): { path: string; sym: string } {
  const slash = id.lastIndexOf("/");
  return slash < 0
    ? { path: "", sym: id }
    : { path: id.slice(0, slash + 1), sym: id.slice(slash + 1) };
}

// A subtle accent hint derived from the trailing symbol's shape. NOT an
// asserted kind (the search wire carries no kind) — just a grouping cue that
// mirrors the graph's node-kind palette, so it reads as decoration not fact.
function kindVar(sym: string): string {
  if (/^[A-Z]/.test(sym)) return "var(--node-cls)"; // PascalCase → class/type
  if (sym.includes(".")) return "var(--node-fn)"; // Type.method → callable
  if (/[a-z][A-Z]|_/.test(sym) || /^[a-z]/.test(sym)) return "var(--node-fn)";
  return "var(--node-mod)";
}

// Turn a raw fetch/daemon error into a readable, non-leaky message. A bare
// `fetch()` rejection surfaces as "Failed to fetch" / "Load failed" / a
// "NetworkError…" string — meaningless to a user — so we map the network-down
// family to a clear "daemon unreachable" line and pass through our own
// HTTP-status messages (`/api/search → HTTP 500`) as-is.
function readableError(err: Error): string {
  const m = err.message ?? "";
  if (/failed to fetch|load failed|networkerror|fetch failed/i.test(m)) {
    return "Could not reach the Hayvenhurst daemon. Is it running on :7777?";
  }
  return m || "Search failed.";
}

// Highlight query tokens in a string as <mark>, without dangerouslySetInnerHTML.
function highlight(text: string, terms: string[]): ComponentChildren {
  if (terms.length === 0) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "ig");
  const parts = text.split(re);
  return parts.map((p, i) => (i % 2 === 1 ? <mark>{p}</mark> : p));
}

export default function SearchResults({ q: initial = "" }: { q?: string }) {
  const [q, setQ] = useState(() => readQuery(initial));

  // Keep results in sync if the URL changes without a full reload
  // (e.g. back/forward navigation).
  useEffect(() => {
    const onNav = () => setQ(readQuery(initial));
    window.addEventListener("popstate", onNav);
    return () => window.removeEventListener("popstate", onNav);
  }, [initial]);

  // Treat empty/blank `q` uniformly as the "enter a query" state — never as a
  // search that returned zero hits. `/search` (no `?q=`) and `/search?q=`
  // (empty string, daemon answers 200 {hits:[]}) must read identically. We key
  // and fetch off the trimmed query and skip the request entirely when blank,
  // so a blank `q` can never reach the "No matches" branch below.
  const trimmed = q.trim();
  const query = useQuery({
    queryKey: qk.search(trimmed),
    queryFn: () => (trimmed ? api.search(trimmed) : Promise.resolve({ hits: [] })),
    staleTime: 30_000,
  });

  // aria-live so screen-reader users hear new results after re-searching.
  const live = (body: ComponentChildren) => (
    <section role="region" aria-label="Search results" aria-live="polite">
      {body}
    </section>
  );

  if (!trimmed) return live(<p class="faint">Enter a query above.</p>);
  if (query.error) return live(<p class="error" role="alert">{readableError(query.error)}</p>);
  if (!query.data) return live(<p class="faint" aria-busy="true">Searching…</p>);

  const hits = query.data.hits;
  if (hits.length === 0) return live(<p class="faint">No matches for “{trimmed}”.</p>);

  // Relevance meter: FTS5 BM25 scores are negative + relative (more negative =
  // better). Normalize within this result set so the best hit reads 100% — far
  // clearer than exposing a raw "-6.80".
  const scores = hits.map((h) => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const rel = (s: number) => (max === min ? 1 : (max - s) / (max - min));
  const terms = trimmed.split(/\s+/).filter(Boolean);

  return live(
    <>
      <p class="hv-results-meta">
        {hits.length} {hits.length === 1 ? "match" : "matches"} for “{trimmed}”
      </p>
      <ul class="hv-results">
        {hits.map((h) => {
          const { path, sym } = splitId(h.id);
          const pct = Math.round(rel(h.score) * 100);
          return (
            <li class="card hv-result" style={{ "--k": kindVar(sym) }}>
              <span class="kindbar" aria-hidden="true"></span>
              <a href={`/node/${encodeURIComponent(h.id)}`} class="hit-id">
                <span class="path">{path}</span>
                <span class="sym">{highlight(sym, terms)}</span>
              </a>
              <span class="hv-rel" title={`relevance ${pct}%`}>
                <span class="bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                <span class="pct">{pct}%</span>
              </span>
              {h.snippet && <p class="hit-snippet">{highlight(h.snippet, terms)}</p>}
            </li>
          );
        })}
      </ul>
    </>,
  );
}

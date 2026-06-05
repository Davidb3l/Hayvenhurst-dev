// Graceful-degradation panel for /graph (PRD §12.3).
//
// Shown instead of the renderer when a query would require rendering >2k
// visible nodes (i.e. clustering disabled on a huge codebase). The panel is
// deliberately styled to look like a designed UI moment, not an error: same
// card/tag visual language as the rest of the viewer.
//
// Action buttons mirror the PRD copy:
//   - Re-enable clustering        → callback flips cluster mode to "auto"
//   - Filter by language or module → callback opens a scope text input
//   - Reduce depth                 → callback decrements the depth control
//   - Search for a specific fn     → navigation to /search

import { useState } from "preact/hooks";

export interface GraphDegradationProps {
  totalNodes: number;
  /** Called when the user wants clustering back on. */
  onReenableCluster: () => void;
  /** Called with a non-empty path prefix to scope the query. */
  onApplyScope: (scope: string) => void;
  /** Whether depth can still be reduced (>1). */
  canReduceDepth: boolean;
  onReduceDepth: () => void;
}

export default function GraphDegradation(props: GraphDegradationProps) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scope, setScope] = useState("");

  const submitScope = (e: Event) => {
    e.preventDefault();
    const v = scope.trim();
    if (v) props.onApplyScope(v);
  };

  return (
    <section class="hv-degrade card" role="status" aria-live="polite">
      <h2 class="hv-degrade-title">
        This view contains {props.totalNodes.toLocaleString()} nodes.
      </h2>
      <p class="muted hv-degrade-body">
        Rendering this many at once isn't useful — most would be unreadable dots.
        Pick how you'd like to narrow it down.
      </p>
      <div class="hv-degrade-actions">
        <button type="button" class="hv-btn primary" onClick={props.onReenableCluster}>
          Re-enable clustering
        </button>
        <button
          type="button"
          class="hv-btn"
          aria-expanded={scopeOpen ? "true" : "false"}
          onClick={() => setScopeOpen((v) => !v)}
        >
          Filter by language or module
        </button>
        <button
          type="button"
          class="hv-btn"
          onClick={props.onReduceDepth}
          disabled={!props.canReduceDepth}
        >
          Reduce depth
        </button>
        <a class="hv-btn" href="/search">Search for a specific function</a>
      </div>
      {scopeOpen && (
        <form onSubmit={submitScope} class="hv-degrade-scope">
          <label class="muted" for="hv-scope-input">
            Restrict to path prefix (e.g. <code>auth</code> or <code>src/db</code>):
          </label>
          <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
            <input
              id="hv-scope-input"
              class="search-input"
              type="text"
              value={scope}
              onInput={(e) => setScope((e.currentTarget as HTMLInputElement).value)}
              placeholder="auth"
              autoFocus
            />
            <button type="submit" class="hv-btn primary">Apply</button>
          </div>
        </form>
      )}
      <style>{`
        .hv-degrade { max-width: 640px; margin: 24px auto; }
        .hv-degrade-title { margin: 0 0 6px; font-size: 1.15rem; }
        .hv-degrade-body { margin: 0 0 16px; }
        .hv-degrade-actions {
          display: flex; flex-wrap: wrap; gap: 8px;
        }
        .hv-degrade-scope { margin-top: 14px; }
        .hv-btn {
          display: inline-block;
          background: var(--bg-elev-2);
          color: var(--fg);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 7px 12px;
          font: inherit; font-size: 0.92em;
          cursor: pointer;
          text-decoration: none;
        }
        .hv-btn:hover:not(:disabled) { border-color: var(--fg-faint); }
        .hv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .hv-btn.primary {
          background: var(--accent);
          color: var(--bg);
          border-color: var(--accent);
        }
        .hv-btn.primary:hover { filter: brightness(1.05); }
      `}</style>
    </section>
  );
}

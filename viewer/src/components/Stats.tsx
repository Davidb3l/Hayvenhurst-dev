// Live stats island for the overview page.
//
// On the server this renders nothing (SSG-only initial state below).
// On the client it fetches /api/stats and refreshes every 10s.

import { api, qk } from "~/api/client";
import { useQuery } from "./useQuery";

// Map a raw fetch/daemon error to a readable line. A bare `fetch()` rejection
// surfaces as "Failed to fetch" / "Load failed" / "NetworkError…", which is
// meaningless to a user — collapse that family to a clear daemon-down message
// and pass our own `… → HTTP <status>` messages through.
function statsError(err: Error): string {
  const m = err.message ?? "";
  if (/failed to fetch|load failed|networkerror|fetch failed/i.test(m)) {
    return "Daemon unreachable on :7777.";
  }
  return m || "Could not load stats.";
}

export default function Stats() {
  const q = useQuery({
    queryKey: qk.stats(),
    queryFn: api.stats,
    refetchInterval: 10_000,
  });
  if (q.error)
    return (
      <p class="error" role="alert">
        Failed to reach daemon: {statsError(q.error)}
      </p>
    );
  if (!q.data) return <p class="faint">Loading stats…</p>;
  const s = q.data;
  return (
    <div>
      <div class="grid">
        <div class="card stat">
          <div class="label">Nodes</div>
          <div class="value">{s.nodes.toLocaleString()}</div>
        </div>
        <div class="card stat">
          <div class="label">Edges</div>
          <div class="value">{s.edges.toLocaleString()}</div>
        </div>
        <div class="card stat">
          <div class="label">Trace observations</div>
          <div class="value">{s.traces.toLocaleString()}</div>
        </div>
        <div class="card stat">
          <div class="label">Last ingest</div>
          <div class="value" style={{ fontSize: "1rem" }}>
            {s.last_ingest ? new Date(s.last_ingest).toLocaleString() : "never"}
          </div>
        </div>
      </div>
      {s.recent_activity && s.recent_activity.length > 0 && (
        <>
          <h2>Recent activity</h2>
          <ul style={{ paddingLeft: "1.1em" }}>
            {s.recent_activity.map((a) => (
              <li>
                <span class="tag">{a.kind}</span>{" "}
                <span class="muted">{new Date(a.ts).toLocaleTimeString()}</span> — {a.summary}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Single client-rendered detail view for /node/<id>/.
//
// Replaces the previous seed-pre-rendered NodeDetail + node-shell pair. The
// id comes from `window.location.pathname` (the daemon serves the same
// shell HTML for every `/node/*` URL). Everything renders from the live
// daemon API, with mocks as the offline fallback per `~/api/client.ts`.

import { useEffect, useState } from "preact/hooks";
import { api, qk } from "~/api/client";
import { useQuery } from "./useQuery";
import { renderMarkdown } from "~/util/md";
import type { NodeRef } from "~/api/types";

export default function NodeShell() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    // URL pattern: /node/<id>/  (id may contain unencoded '/' for legibility).
    const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
    const m = /^node\/(.+?)\/?$/.exec(path);
    if (m && m[1]) {
      setId(decodeURIComponent(m[1]));
      return;
    }
    // Fall back to ?id= for direct links / curl-testing the shell.
    const qsId = new URL(window.location.href).searchParams.get("id");
    if (qsId) setId(qsId);
  }, []);
  if (!id) return <p class="faint">Loading…</p>;
  return <NodeBody id={id} />;
}

function NodeBody({ id }: { id: string }) {
  const q = useQuery({ queryKey: qk.node(id), queryFn: () => api.node(id) });
  if (q.error) return <p class="error">Failed to load: {q.error.message}</p>;
  if (!q.data) return <p class="faint">Loading {id}…</p>;
  const n = q.data;
  const html = renderMarkdown(n.body_md);
  const slash = n.id.lastIndexOf("/");
  const path = slash < 0 ? "" : n.id.slice(0, slash + 1);
  const sym = slash < 0 ? n.id : n.id.slice(slash + 1);
  return (
    <>
      <header class="hv-node-head">
        <h1 class="mono"><span class="path">{path}</span><span class="sym">{sym}</span></h1>
        <div class="hv-node-meta">
          <span class="tag">{n.kind}</span>
          <span class="tag">{n.language}</span>
          <span class="file">{n.file}</span>
          <span class="range">L{n.range.start}–L{n.range.end}</span>
        </div>
      </header>
      <div class="card hv-summary" dangerouslySetInnerHTML={{ __html: html }} />
      <div class="hv-twoup">
        <RefSection title="Callers" refs={n.callers} empty="No observed callers." />
        <RefSection title="Callees" refs={n.callees} empty="No observed callees." />
      </div>
      <h2>Trace history</h2>
      <p class="faint">Per-node trace timeline arrives in Week 3 with the Python trace collector.</p>
    </>
  );
}

function RefSection({ title, refs, empty }: { title: string; refs: NodeRef[]; empty: string }) {
  return (
    <section>
      <h2>{title}</h2>
      {refs.length === 0 ? (
        <p class="faint">{empty}</p>
      ) : (
        <ul class="hv-reflist">
          {refs.map((r) => {
            // Unresolved edge targets (daemon "?:path") have no node page.
            const unresolved = r.id.startsWith("?");
            const label = unresolved ? r.id.replace(/^\?:?/, "").replace(/^(\.\.\/)+/, "") : r.id;
            return (
              <li>
                {unresolved ? (
                  <span
                    class="mono hv-unresolved"
                    title="Unresolved reference — target file not indexed in this repo"
                  >
                    {label}
                  </span>
                ) : (
                  <a href={`/node/${encodeURIComponent(r.id)}`} class="mono">{label}</a>
                )}
                {r.weight !== undefined && (
                  <span class="w">{r.weight} {r.weight === 1 ? "call" : "calls"}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

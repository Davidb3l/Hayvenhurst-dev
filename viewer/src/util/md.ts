// Tiny markdown renderer — runs in Astro at build time on node-summary
// markdown coming back from the daemon. We deliberately avoid `marked`,
// `markdown-it`, etc.: every byte ships in our pages.
//
// Supported subset (matches what node summaries actually contain):
//   - ATX headings (#, ##, ###)
//   - paragraphs separated by blank lines
//   - unordered lists (- item)
//   - inline `code`
//   - inline [[wiki-links]] → /node/<id>
//   - fenced ``` blocks (no syntax highlighting)
//
// Output is escaped HTML.

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

function inline(s: string): string {
  let out = esc(s);
  // wiki links first (operate on escaped text — brackets are safe)
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_m, id: string) => {
    const safe = id.trim();
    // The daemon emits "?:<path>" wiki-links for edge targets it could not
    // resolve to an indexed entity. Those have no node page — render a clean,
    // de-emphasized label instead of a broken link exposing the "?:" scheme.
    if (safe.startsWith("?")) {
      const label = safe.replace(/^\?:?/, "").replace(/^(\.\.\/)+/, "");
      return `<span class="hv-unresolved" title="Unresolved reference — target file not indexed in this repo">${label}</span>`;
    }
    return `<a href="/node/${encodeURIComponent(safe)}">${safe}</a>`;
  });
  // emphasis — **strong**, then _em_ / *em*. The underscore form requires a
  // non-word char on both sides so snake_case identifiers (my_var) stay literal.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, b: string) => `<strong>${b}</strong>`);
  out = out.replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, (_m, pre: string, b: string) => `${pre}<em>${b}</em>`);
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![\w])/g, (_m, pre: string, b: string) => `${pre}<em>${b}</em>`);
  // inline code (last, so emphasis markers inside code aren't consumed first)
  out = out.replace(/`([^`]+)`/g, (_m, body: string) => `<code>${body}</code>`);
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // fenced code
    if (line.startsWith("```")) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // headings
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }

    // list
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // blank line
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // paragraph — gobble until blank line
    closeList();
    const buf: string[] = [line];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !/^(#{1,3})\s|^[-*]\s|^```/.test(lines[i] ?? "")) {
      buf.push(lines[i] ?? "");
      i++;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  closeList();
  return out.join("\n");
}

// Search box for the overview page (also reused on /search).

import { useEffect, useState } from "preact/hooks";

// Seed the input from the live `?q=` when present, falling back to the
// build-time `initial` prop. On `/search` the box is `client:load`, so it is
// server-rendered with the build-time query of "" — and Preact's hydrate()
// ADOPTS that server `value=""` rather than patching it from a useState
// initializer, so seeding in useState alone leaves the box empty at
// `/search?q=foo`. We seed in a useEffect instead: it runs after hydration and
// re-renders, which patches the DOM value to match the results island. (BL-17 #3.)
export default function SearchBox({ initial = "" }: { initial?: string }) {
  const [q, setQ] = useState(initial);
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("q");
    if (fromUrl != null && fromUrl !== q) setQ(fromUrl);
    // Run once on mount; intentionally not depending on `q`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onSubmit = (e: Event) => {
    e.preventDefault();
    const u = "/search?q=" + encodeURIComponent(q.trim());
    window.location.assign(u);
  };
  return (
    <form onSubmit={onSubmit} role="search">
      <input
        class="search-input"
        type="search"
        name="q"
        placeholder="Search nodes by name, behavior, or trace"
        value={q}
        onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
        autoFocus
      />
    </form>
  );
}

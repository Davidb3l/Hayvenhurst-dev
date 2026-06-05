// Tiny in-house query hook.
//
// Originally we wired up @tanstack/query-core (~37KB raw). For the viewer's
// read-only GETs that's overkill — we don't need mutations, infinite queries,
// suspense integration, or the full QueryClient surface. ~80 lines of code
// gives us: per-key dedup, stale-while-revalidate, focus refetch off,
// optional polling, and a shared in-memory cache. We come in around 1KB.
//
// This matches the project discipline: "no dependencies you can write in 30
// lines yourself." (We needed 80. Close enough.)

import { useEffect, useState } from "preact/hooks";

export interface UseQueryArgs<T> {
  queryKey: ReadonlyArray<unknown>;
  // queryFn receives an AbortSignal so it can wire cancellation into the
  // underlying fetch. It is optional to honor — runFetch ignores the result of
  // any aborted fetch regardless, so a queryFn that ignores the signal still
  // gets correct stale-response suppression (it just can't cancel the network
  // I/O early).
  queryFn: (signal?: AbortSignal) => Promise<T>;
  staleTime?: number;
  refetchInterval?: number;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: Error | undefined;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => Promise<void>;
}

interface CacheEntry<T> {
  data?: T;
  error?: Error;
  ts: number; // last successful fetch
  inFlight?: Promise<void>;
  // AbortController for the currently in-flight fetch. Starting a new fetch
  // for this key aborts the prior one; the prior fetch's resolution is then
  // ignored (it can't clobber the cache with a stale response). Cleared in the
  // fetch's finally only if it's still the active controller.
  controller?: AbortController;
  // Subscribers are bare re-render notifications — the hook re-reads the
  // entry from CACHE after being notified, so the callback doesn't need to
  // carry T. Keeping the type T-free lets a single global cache hold
  // entries for many distinct T's without invariance issues.
  subscribers: Set<() => void>;
}

const CACHE = new Map<string, CacheEntry<unknown>>();

function keyOf(k: ReadonlyArray<unknown>): string {
  return JSON.stringify(k);
}

function getEntry<T>(key: string): CacheEntry<T> {
  let e = CACHE.get(key) as CacheEntry<T> | undefined;
  if (!e) {
    e = { ts: 0, subscribers: new Set() };
    CACHE.set(key, e as CacheEntry<unknown>);
  }
  return e;
}

function notify<T>(e: CacheEntry<T>): void {
  for (const fn of e.subscribers) fn();
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

async function runFetch<T>(
  key: string,
  fn: (signal?: AbortSignal) => Promise<T>,
  // When true (the default, used by the mount-effect path), coalesce with an
  // already in-flight fetch for this key instead of aborting+restarting it —
  // N subscribers mounting the same key share one request. Explicit refetch()
  // and the polling interval pass false so they always get fresh data.
  dedup = true,
): Promise<void> {
  const e = getEntry<T>(key);
  if (dedup && e.inFlight) return e.inFlight;
  // Abort any prior in-flight fetch for this key. Its resolution is ignored
  // below (we compare the captured controller against the entry's current
  // one), so a slow earlier response can never clobber a newer one.
  if (e.controller) e.controller.abort();
  const ctl = new AbortController();
  e.controller = ctl;
  e.inFlight = (async () => {
    try {
      const v = await fn(ctl.signal);
      // A newer fetch superseded us while we were awaiting — drop this result.
      if (ctl.signal.aborted || e.controller !== ctl) return;
      e.data = v;
      e.error = undefined;
      e.ts = Date.now();
    } catch (err) {
      // Aborted/superseded fetch: swallow silently, never surface AbortError
      // to the user and never overwrite the entry the newer fetch will fill.
      if (ctl.signal.aborted || e.controller !== ctl || isAbortError(err)) return;
      e.error = err instanceof Error ? err : new Error(String(err));
    } finally {
      // Only clear shared state if we're still the active fetch; a superseding
      // fetch owns `controller`/`inFlight` now and must not be cleared by us.
      if (e.controller === ctl) {
        e.inFlight = undefined;
        e.controller = undefined;
        notify(e);
      }
    }
  })();
  notify(e); // notify isFetching=true
  return e.inFlight;
}

// Internal surface for unit tests only — NOT part of the public hook API.
// Lets tests drive the cache/cancellation machinery without a DOM/renderer.
export const __test = {
  runFetch,
  keyOf,
  readEntry: <T>(key: string): Readonly<CacheEntry<T>> | undefined =>
    CACHE.get(key) as CacheEntry<T> | undefined,
  reset: (): void => CACHE.clear(),
};

export function useQuery<T>(args: UseQueryArgs<T>): QueryResult<T> {
  const key = keyOf(args.queryKey);
  const staleTime = args.staleTime ?? 5_000;

  // Snapshot synchronously so SSR returns sensible defaults.
  const initial = (CACHE.get(key) as CacheEntry<T> | undefined) ?? null;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const e = getEntry<T>(key);
    const sub = () => setTick((t) => t + 1);
    e.subscribers.add(sub);
    // Fetch if no data or stale.
    if (!e.data || Date.now() - e.ts > staleTime) {
      void runFetch<T>(key, args.queryFn);
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    if (args.refetchInterval && args.refetchInterval > 0) {
      timer = setInterval(() => {
        // Polling wants fresh data each tick — abort any in-flight stale fetch.
        void runFetch<T>(key, args.queryFn, false);
      }, args.refetchInterval);
    }
    return () => {
      e.subscribers.delete(sub);
      if (timer) clearInterval(timer);
      // If this was the last subscriber for the key, cancel any in-flight
      // fetch so an unmounted/navigated-away query can't resolve and notify a
      // dead component (or leave a dangling request).
      if (e.subscribers.size === 0 && e.controller) {
        e.controller.abort();
        e.controller = undefined;
        e.inFlight = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, staleTime, args.refetchInterval]);

  void tick; // re-render trigger
  const entry = (CACHE.get(key) as CacheEntry<T> | undefined) ?? initial;
  return {
    data: entry?.data,
    error: entry?.error,
    isLoading: !entry?.data && !entry?.error,
    isFetching: !!entry?.inFlight,
    // Explicit refetch always supersedes any in-flight fetch for fresh data.
    refetch: () => runFetch<T>(key, args.queryFn, false),
  };
}

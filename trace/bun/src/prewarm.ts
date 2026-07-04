/**
 * Pre-warm OpenSSL's global lock-guarded caches BEFORE the CPU profiler starts.
 *
 * ## The deadlock this prevents (the vitest parallel-forks wedge, ROOT-CAUSED)
 *
 * Reproduced on Node v25.8.0 / macOS with hono's suite under `HAYVEN_TRACE=1`
 * and vitest's DEFAULT parallel forks pool: ~1 in 3 runs, a fork wedged
 * FOREVER at startup (0 files completed; the worker sat at ~9% CPU with
 * `v8::sampler::SignalHandler::HandleProfilerSignal` firing). `sample <pid>`
 * showed the two-thread deadlock precisely:
 *
 *   - MAIN thread: first crypto use inside a lazily-imported test module
 *     (`node:crypto` `Hash::GetHashes` → OpenSSL `ossl_namemap_add_names` →
 *     `CRYPTO_THREAD_write_lock`) — blocked acquiring the namemap WRITE lock.
 *   - BACKGROUND thread: Node 25's lazy CA-certificate loader
 *     (`node::crypto::LoadCACertificates` → … → `EVP_PKEY_set_type_by_keymgmt`
 *     → `ossl_namemap_doall_names` → `CRYPTO_THREAD_read_lock`) — blocked
 *     acquiring a RECURSIVE read of the same rwlock while already holding an
 *     outer read, queued BEHIND the writer (pthread writer preference).
 *
 *   Writer waits for the outer read to release; the reader's recursive read
 *   waits for the queued writer → deadlock. The trigger chain is ours twice
 *   over: the collector's first `fetch` to the daemon initializes `node:tls`,
 *   which kicks off the background CA load, and the 10 kHz SIGPROF storm from
 *   the 100 µs profiler stretches the main thread's first-use OpenSSL fetch
 *   wide enough for the two first-uses to overlap.
 *
 * The race exists in Node/OpenSSL without profiling; the profiler only makes
 * it probable. The collector-side fix is to make sure the ONE-TIME namemap
 * WRITES (algorithm-fetch cache population) and the CA-certificate load happen
 * BEFORE `Profiler.start`, on the caller's thread, with no profiler running —
 * after that, test-time crypto use only takes uncontended READ locks and the
 * deadlock's write side never exists during profiling.
 *
 * Verified empirically: with this pre-warm, hono's full 121-file suite under
 * default parallelism completed repeatedly with zero wedges (see
 * bench/affected-tests-typescript follow-up in the lane RESULTS); without it,
 * the wedge reproduced within a few runs.
 */

/** Once-per-process latch — the caches are process-global, so is the warm-up. */
let prewarmed = false;

/**
 * Populate OpenSSL's namemap / fetch caches and the CA-certificate cache.
 * Call BEFORE starting the CPU profiler. Idempotent, best-effort, and silent:
 * every probe is individually guarded, because none of them are load-bearing
 * for tracing itself — a runtime without one of these APIs (e.g. Bun's
 * partial `node:crypto`) simply skips it.
 */
export function prewarmCryptoLocks(): void {
  if (prewarmed) return;
  prewarmed = true;

  // Dynamic require via process.getBuiltinModule (Node 22+/Bun) or eval'd
  // require fallback keeps this module importable in exotic bundlers even if
  // the builtins are unavailable.
  const builtin = (name: string): unknown => {
    try {
      const getBuiltin = (process as { getBuiltinModule?: (n: string) => unknown })
        .getBuiltinModule;
      if (typeof getBuiltin === "function") return getBuiltin.call(process, name);
    } catch {
      /* fall through */
    }
    return undefined;
  };

  // 1. The namemap WRITE side: getHashes()/getCiphers()/getCurves() walk and
  //    cache every algorithm (exactly the `Hash::GetHashes` path the wedge
  //    died in), and a digest round-trip warms the common fetch.
  try {
    const crypto = builtin("node:crypto") as
      | {
          getHashes?: () => string[];
          getCiphers?: () => string[];
          getCurves?: () => string[];
          createHash?: (a: string) => { update(d: string): { digest(e: string): unknown } };
        }
      | undefined;
    try {
      crypto?.getHashes?.();
    } catch { /* skip */ }
    try {
      crypto?.getCiphers?.();
    } catch { /* skip */ }
    try {
      crypto?.getCurves?.();
    } catch { /* skip */ }
    try {
      crypto?.createHash?.("sha256").update("hayven").digest("hex");
    } catch { /* skip */ }
  } catch {
    /* no crypto builtin — nothing to warm */
  }

  // 2. The CA-load READ side: force the certificate cache to populate NOW (on
  //    this thread, unprofiled) so Node's background `LoadCACertificates`
  //    thread finds it filled and never contends mid-run.
  try {
    const tls = builtin("node:tls") as
      | { getCACertificates?: (type?: string) => unknown; rootCertificates?: unknown }
      | undefined;
    try {
      tls?.getCACertificates?.();
    } catch { /* skip */ }
    try {
      void tls?.rootCertificates; // lazy accessor on older Nodes
    } catch { /* skip */ }
  } catch {
    /* no tls builtin — nothing to warm */
  }
}

/** Test seam: reset the once-latch (the caches themselves stay warm). */
export function resetPrewarmForTests(): void {
  prewarmed = false;
}

/**
 * GAP S3 + S4 — the two unbounded shapes left in the stdio transport.
 *
 * S3 (OUTPUT). `runStdioLoop` handed every response to a fire-and-forget
 * `write` and immediately pulled the next input chunk. With an MCP host that has
 * stopped reading its end of the pipe, responses pile up INSIDE the process with
 * nothing bounding them. MEASURED with pipelined `ping`s carrying a ~64 KiB
 * payload, stdout piped to a parent that never reads:
 *
 *      requests   fire-and-forget      drain-aware writer
 *         8 000        207 MB               171 MB
 *        30 000      1 445 MB               198 MB
 *        60 000      2 686 MB               180 MB
 *
 * Linear and unbounded, versus flat. Note Bun's other backpressure signals lie
 * on a stalled pipe (`write()` returned `true` MORE often stalled than not;
 * `writableLength`/`writableNeedDrain` read 0/false after 13 MB) — the per-chunk
 * completion CALLBACK is the only honest one, which is what
 * `createDrainAwareWriter` uses.
 *
 * S4 (INPUT). The line scanner did `buf += chunk` then `buf.indexOf("\n")` on
 * the whole accumulation every chunk — quadratic. Feeding a newline-less line in
 * 64 KiB pipe-sized chunks measured 4 MiB → 85 MB RSS / 10 ms, 16 MiB → 214 MB /
 * 79 ms, 32 MiB → 397 MB / 303 ms, so the 64 MiB in `MAX_PENDING_LINE_CHARS`
 * actually cost the better part of a gigabyte. Scanning only the NEW chunk makes
 * it linear (measured after: 32 MiB → 109 MB / 23 ms, 64 MiB → 179 MB / 45 ms).
 */
import { describe, expect, it } from "bun:test";

import {
  createDrainAwareWriter,
  FLUSH_WAIT_MS,
  MAX_PENDING_LINE_CHARS,
  MAX_UNFLUSHED_RESPONSE_BYTES,
  runStdioLoop,
  type ContextMcpServer,
  type WritableLike,
} from "../src/mcp/context_server.ts";

/** A server that answers every request with a fixed-size payload. */
function padServer(padChars: number): ContextMcpServer {
  const pad = "x".repeat(padChars);
  return {
    handle: (req) => (req.id === undefined ? null : { jsonrpc: "2.0", id: req.id, result: { pad } }),
    close: () => {},
  };
}

/** A writable that only completes a write when `flushNext()` is called — a host
 *  whose pipe is full. `pending` is what a real stream would be holding. */
function stalledStream(): WritableLike & {
  pendingChars: () => number;
  flushAll: () => void;
} {
  const cbs: Array<{ chars: number; cb: () => void }> = [];
  let pending = 0;
  return {
    write(chunk: string, cb?: (err?: Error | null) => void) {
      pending += chunk.length;
      const chars = chunk.length;
      cbs.push({
        chars,
        cb: () => {
          pending -= chars;
          cb?.();
        },
      });
      return true; // Bun says "true" even when stalled — deliberately mimicked.
    },
    pendingChars: () => pending,
    flushAll: () => {
      const all = cbs.splice(0, cbs.length);
      for (const c of all) c.cb();
    },
  };
}

describe("S3 — output backpressure bounds what the loop will buffer", () => {
  it("stops consuming input while the writer has not flushed", async () => {
    // Each response is ~1 MiB, so the 16 MiB cap is crossed after ~16 of them.
    const server = padServer(1024 * 1024);
    const stream = stalledStream();
    const writer = createDrainAwareWriter(stream);

    let requestsPulled = 0;
    const REQUESTS = 200;
    async function* feed(): AsyncGenerator<string> {
      for (let i = 0; i < REQUESTS; i++) {
        requestsPulled++;
        yield JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }) + "\n";
      }
    }

    const loop = runStdioLoop(server, feed(), writer);
    // Let the loop run as far as it can with nothing flushing.
    await Promise.race([loop, new Promise((r) => setTimeout(r, 150))]);

    // It must have PAUSED: not every request was pulled, and what is held is
    // bounded by the cap plus the single response that crossed it.
    expect(requestsPulled).toBeLessThan(REQUESTS);
    expect(stream.pendingChars()).toBeLessThanOrEqual(
      MAX_UNFLUSHED_RESPONSE_BYTES + 2 * 1024 * 1024,
    );

    // Once the host reads, the loop resumes and finishes.
    const drain = setInterval(() => stream.flushAll(), 1);
    await loop;
    clearInterval(drain);
    expect(requestsPulled).toBe(REQUESTS);
  });

  it("CONTROL: a writer that returns nothing keeps the old unpaused behaviour", async () => {
    // A CONTROL, not evidence for S3 — it passes identically before and after.
    // The contract is opt-in: a plain `(line) => void` writer must not change
    // shape, which is what makes `createDrainAwareWriter` (not the loop) the
    // thing supplying the bound.
    const server = padServer(1024);
    let requestsPulled = 0;
    async function* feed(): AsyncGenerator<string> {
      for (let i = 0; i < 50; i++) {
        requestsPulled++;
        yield JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }) + "\n";
      }
    }
    const lines: string[] = [];
    await runStdioLoop(server, feed(), (l) => lines.push(l));
    expect(requestsPulled).toBe(50);
    expect(lines).toHaveLength(50);
  });

  it("createDrainAwareWriter only asks the loop to wait past the cap", () => {
    const stream = stalledStream();
    const writer = createDrainAwareWriter(stream);
    // Well under the cap → no promise, so a healthy session pays no round-trip.
    expect(writer("a".repeat(1024))).toBeUndefined();
    // Push past it → a promise the loop will await.
    const big = "b".repeat(MAX_UNFLUSHED_RESPONSE_BYTES);
    const r = writer(big);
    expect(typeof (r as PromiseLike<unknown>)?.then).toBe("function");
    // …and it settles once the stream completes the write.
    stream.flushAll();
    expect(writer("c".repeat(1024))).toBeUndefined();
  });
});

// NOTE ON WHAT PINS WHAT: the framing tests below are REGRESSION GUARDS — they
// pass with the old quadratic scanner too, by design, since framing is meant to
// be byte-identical. The single assertion that pins the S4 rewrite itself is the
// timing ratio in the first test. The boundary-shape tests exist because the
// rewrite moved from "always rescan everything" to "scan only the new chunk",
// so they cover the shapes the old code could not get wrong.
describe("S4 — the line scan is linear, and framing is unchanged", () => {
  /** Feed `text` in 64 KiB chunks (a pipe's real chunk size). */
  async function* chunked(text: string): AsyncGenerator<string> {
    const CHUNK = 64 * 1024;
    for (let i = 0; i < text.length; i += CHUNK) yield text.slice(i, i + CHUNK);
  }

  const echo: ContextMcpServer = {
    handle: (req) => (req.id === undefined ? null : { jsonrpc: "2.0", id: req.id, result: {} }),
    close: () => {},
  };

  it("scales linearly, not quadratically, on a newline-less line", async () => {
    const time = async (mib: number): Promise<number> => {
      const text = "a".repeat(mib * 1024 * 1024) + "\n";
      const t0 = performance.now();
      await runStdioLoop(echo, chunked(text), () => {});
      return performance.now() - t0;
    };
    await time(2); // warm up the JIT so the ratio measures the algorithm
    const small = await time(4);
    const large = await time(32);
    // 8x the input. Linear predicts ~8x; the old quadratic scan measured ~30x
    // (10 ms → 303 ms). A generous 16x ceiling fails the quadratic version
    // without being flaky about scheduling noise.
    expect(large).toBeLessThan(Math.max(small, 1) * 16);
  });

  it("an over-long line is still refused and the NEXT line still parses", async () => {
    const over = "a".repeat(MAX_PENDING_LINE_CHARS + 10) + "\n";
    const good = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n";
    const lines: string[] = [];
    await runStdioLoop(echo, chunked(over + good), (l) => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("line exceeds");
    expect(JSON.parse(lines[1]!).id).toBe(7);
  });

  it("an over-long line with NO terminator is refused, and resync works", async () => {
    const over = "a".repeat(MAX_PENDING_LINE_CHARS + 10);
    const good = "\n" + JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) + "\n";
    const lines: string[] = [];
    await runStdioLoop(echo, chunked(over + good), (l) => lines.push(l));
    expect(lines[0]).toContain("line exceeds");
    expect(JSON.parse(lines[lines.length - 1]!).id).toBe(9);
  });

  it("a line split across many chunks is reassembled exactly once", async () => {
    const big = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "ping",
      params: { pad: "z".repeat(300 * 1024) },
    });
    const lines: string[] = [];
    await runStdioLoop(echo, chunked(big + "\n"), (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe(3);
  });

  it("a trailing line with no newline is still processed", async () => {
    const lines: string[] = [];
    await runStdioLoop(
      echo,
      chunked(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" })),
      (l) => lines.push(l),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe(11);
  });

  it("the chunk-local scan handles every boundary shape the rewrite touches", async () => {
    // The rewrite moved from "rescan the whole accumulation" to "scan only the
    // new chunk", which is exactly where framing bugs live. These are the shapes
    // the old code could not get wrong because it always rescanned: an EMPTY
    // chunk, a chunk that STARTS with the terminator, several terminators in one
    // chunk, and a line whose pieces span many chunks with the terminator last.
    const req = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
    /** Feed exactly these chunks, verbatim. */
    async function* exact(chunks: string[]): AsyncGenerator<string> {
      for (const c of chunks) yield c;
    }
    const ids = async (chunks: string[]): Promise<Array<number | null>> => {
      const lines: string[] = [];
      await runStdioLoop(echo, exact(chunks), (l) => lines.push(l));
      return lines.map((l) => JSON.parse(l).id);
    };

    // Empty chunks interleaved everywhere.
    expect(await ids(["", req(1), "", "\n", "", req(2) + "\n", ""])).toEqual([1, 2]);
    // A chunk that begins with the terminator of the previous line.
    expect(await ids([req(3), "\n" + req(4), "\n"])).toEqual([3, 4]);
    // Several complete lines in ONE chunk.
    expect(await ids([`${req(5)}\n${req(6)}\n${req(7)}\n`])).toEqual([5, 6, 7]);
    // Blank lines between real ones are ignored, not answered.
    expect(await ids([`\n\n${req(8)}\n\n\n${req(9)}\n`])).toEqual([8, 9]);
    // One line split one character per chunk, terminator last.
    expect(await ids([...req(10).split(""), "\n"])).toEqual([10]);
  });

  it("resync: an over-long line whose terminator is the LAST char of a chunk", async () => {
    // The `skipping` path slices the resync chunk at the newline and must then
    // handle a remainder of length ZERO without losing the following line.
    const over = "a".repeat(MAX_PENDING_LINE_CHARS + 10);
    const req = JSON.stringify({ jsonrpc: "2.0", id: 21, method: "ping" });
    async function* exact(chunks: string[]): AsyncGenerator<string> {
      for (const c of chunks) yield c;
    }
    const lines: string[] = [];
    // chunk 1 overflows (no newline) → skipping; chunk 2 ENDS with the newline;
    // chunk 3 carries the next real line.
    await runStdioLoop(echo, exact([over, "tail\n", req + "\n"]), (l) => lines.push(l));
    expect(lines[0]).toContain("line exceeds");
    expect(JSON.parse(lines[lines.length - 1]!).id).toBe(21);
  });

  it("an over-long line that overflows while PENDING already holds pieces", async () => {
    // The cap must be measured against pending + this chunk's segment, not just
    // the chunk — otherwise a line assembled from many under-cap chunks slips
    // past it.
    const req = JSON.stringify({ jsonrpc: "2.0", id: 31, method: "ping" });
    const piece = "a".repeat(1024 * 1024);
    const chunks: string[] = [];
    for (let i = 0; i < MAX_PENDING_LINE_CHARS / piece.length + 2; i++) chunks.push(piece);
    chunks.push("\n" + req + "\n");
    async function* exact(cs: string[]): AsyncGenerator<string> {
      for (const c of cs) yield c;
    }
    const lines: string[] = [];
    await runStdioLoop(echo, exact(chunks), (l) => lines.push(l));
    expect(lines[0]).toContain("line exceeds");
    expect(JSON.parse(lines[lines.length - 1]!).id).toBe(31);
  });

  it("a multi-byte character split across a chunk boundary survives", async () => {
    const req = JSON.stringify({ jsonrpc: "2.0", id: 13, method: "ping", params: { s: "héllo→" } }) + "\n";
    const bytes = new TextEncoder().encode(req);
    async function* byteChunks(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3);
    }
    const lines: string[] = [];
    await runStdioLoop(echo, byteChunks(), (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe(13);
  });
});

describe("S3 — the writer cannot become the wedge it prevents", () => {
  /** A stream whose completion callback behaves badly in a chosen way. */
  function badStream(mode: "never" | "twice" | "throws" | "error"): WritableLike {
    return {
      write(chunk: string, cb?: (err?: Error | null) => void) {
        if (mode === "throws") throw new Error("EPIPE");
        if (mode === "never") return true; // destroyed stream: callback dropped
        cb?.(mode === "error" ? new Error("EPIPE") : null);
        if (mode === "twice") cb?.(null);
        return true;
      },
    };
  }

  const big = () => "b".repeat(MAX_UNFLUSHED_RESPONSE_BYTES + 1);

  it("a DROPPED completion callback times out instead of latching forever", async () => {
    // The stalled-host case this feature exists for is also the case where the
    // stream gets destroyed and never calls back. Waiting must be a throttle,
    // never a latch: a permanent wait means runStdioLoop never returns, the
    // caller's `finally` never runs, and the process wedges holding the read DB
    // — the exact failure the round is about, reintroduced by its own fix.
    // A 25 ms ceiling instead of the 30 s default, so "bounded" is observable
    // in a test rather than merely asserted about a constant.
    const writer = createDrainAwareWriter(badStream("never"), 25);
    const r = writer(big());
    expect(typeof (r as PromiseLike<unknown>)?.then).toBe("function");

    // It must NOT settle immediately — that would be no backpressure at all.
    const early = await Promise.race([
      Promise.resolve(r).then(() => "settled"),
      new Promise((res) => setTimeout(() => res("waiting"), 5)),
    ]);
    expect(early).toBe("waiting");

    // …and it MUST settle on its own, with the callback never arriving. Without
    // the ceiling this races forever and the loop is latched shut.
    const eventually = await Promise.race([
      Promise.resolve(r).then(() => "settled"),
      new Promise((res) => setTimeout(() => res("LATCHED"), 2000)),
    ]);
    expect(eventually).toBe("settled");
    // The shipped default is a real, finite ceiling too.
    expect(FLUSH_WAIT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(FLUSH_WAIT_MS)).toBe(true);
  });

  it("a DOUBLE completion callback does not disable backpressure", () => {
    // Crediting the same chunk twice drove `outstanding` negative, after which
    // no response — however large — ever asked the loop to wait again. The
    // callbacks must be DEFERRED for this to bite: a synchronous completion
    // legitimately returns the counter to zero, so the drift only shows once a
    // real flush happens and is then double-counted.
    const cbs: Array<() => void> = [];
    const doubleCalling: WritableLike = {
      write(_chunk: string, cb?: (err?: Error | null) => void) {
        cbs.push(() => {
          cb?.(null);
          cb?.(null); // the same chunk, credited twice
        });
        return true;
      },
    };
    const writer = createDrainAwareWriter(doubleCalling);
    // Queue and flush a batch, double-crediting every chunk.
    for (let i = 0; i < 20; i++) writer("a".repeat(100_000));
    for (const flush of cbs.splice(0, cbs.length)) flush();
    // The counter must be back at exactly zero, not 2 MB below it — so a write
    // that genuinely exceeds the cap still asks the loop to wait.
    const r = writer(big());
    expect(typeof (r as PromiseLike<unknown>)?.then).toBe("function");
  });

  it("a SYNCHRONOUS write throw neither escapes nor drifts the counter", () => {
    const writer = createDrainAwareWriter(badStream("throws"));
    // No exception may reach `emit` → `processLine` → the loop.
    expect(() => writer("a".repeat(1000))).not.toThrow();
    // And the failed chunk must be released, not left pinning the counter: a
    // later small write stays under the cap.
    for (let i = 0; i < 50; i++) expect(writer("a".repeat(1000))).toBeUndefined();
  });

  it("an ERROR completion callback still releases the chunk", () => {
    const writer = createDrainAwareWriter(badStream("error"));
    for (let i = 0; i < 100; i++) expect(writer("a".repeat(100000))).toBeUndefined();
  });
});

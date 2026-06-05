// Unit tests for the daemon-side watcher supervisor. Uses a mock spawn
// so we don't actually exec hayven-native — the Rust side is exercised
// separately in native/tests/stubs.rs.
import { describe, expect, test } from "bun:test";

import { startWatch, type WatchEvent } from "../src/native/watcher.ts";

interface FakeChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

function makeFakeChild(lines: string[], opts: { keepOpen?: boolean } = {}): FakeChild {
  const encoder = new TextEncoder();
  let exitResolve!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      if (!opts.keepOpen) {
        controller.close();
        exitResolve(0);
      }
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return {
    stdout,
    stderr,
    exited,
    kill() {
      exitResolve(143);
    },
  };
}

function versionLine(): string {
  return JSON.stringify({ type: "version", major: 0, minor: 0, patch: 1, protocol: 2 });
}

function readyLine(): string {
  return JSON.stringify({ type: "ready", platform: "darwin", backend: "fsevents" });
}

function changeLine(file: string, kind: "create" | "modify" | "delete" = "modify"): string {
  return JSON.stringify({ type: "change", file, kind, ts_ms: Date.now() });
}

describe("watcher supervisor", () => {
  test("emits a single coalesced batch for multiple changes to the same file within the debounce window", async () => {
    const batches: WatchEvent[][] = [];
    const fake = makeFakeChild(
      [versionLine(), readyLine(), changeLine("src/a.ts"), changeLine("src/a.ts"), changeLine("src/a.ts")],
      { keepOpen: true },
    );
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 30,
      onBatch: (b) => {
        batches.push(b);
      },
      onOverflow: () => {},
      spawn: () => fake,
      // Stop the supervisor's restart loop from kicking in by killing the
      // process; the test asserts before that.
      maxRestartBackoffMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 80));
    await sup.stop();
    expect(batches.length).toBe(1);
    expect(batches[0]?.length).toBe(1);
    expect(batches[0]?.[0]?.file).toBe("src/a.ts");
  });

  test("batches distinct files together", async () => {
    const batches: WatchEvent[][] = [];
    const fake = makeFakeChild(
      [versionLine(), readyLine(), changeLine("src/a.ts"), changeLine("src/b.ts", "create"), changeLine("src/c.ts", "delete")],
      { keepOpen: true },
    );
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 30,
      onBatch: (b) => {
        batches.push(b);
      },
      onOverflow: () => {},
      spawn: () => fake,
    });
    await new Promise((r) => setTimeout(r, 80));
    await sup.stop();
    expect(batches.length).toBe(1);
    expect(batches[0]?.length).toBe(3);
    const files = batches[0]?.map((e) => e.file).sort();
    expect(files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("overflow record drops pending batch and fires onOverflow", async () => {
    const batches: WatchEvent[][] = [];
    const overflows: { dropped: number; sinceMs: number }[] = [];
    const fake = makeFakeChild(
      [
        versionLine(),
        readyLine(),
        changeLine("src/a.ts"),
        JSON.stringify({ type: "overflow", dropped: 42, since_ms: 1700000000000 }),
      ],
      { keepOpen: true },
    );
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 30,
      onBatch: (b) => {
        batches.push(b);
      },
      onOverflow: (info) => {
        overflows.push(info);
      },
      spawn: () => fake,
    });
    await new Promise((r) => setTimeout(r, 80));
    await sup.stop();
    expect(overflows).toEqual([{ dropped: 42, sinceMs: 1700000000000 }]);
    // The pending a.ts change was dropped by the overflow handler before
    // the debounce window elapsed — no batch should fire for it.
    expect(batches.length).toBe(0);
  });

  test("heartbeat updates stats.lastHeartbeatMs", async () => {
    const fake = makeFakeChild(
      [
        versionLine(),
        readyLine(),
        JSON.stringify({ type: "heartbeat", ts_ms: 1700000099999 }),
      ],
      { keepOpen: true },
    );
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 30,
      onBatch: () => {},
      onOverflow: () => {},
      spawn: () => fake,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sup.stats().lastHeartbeatMs).toBe(1700000099999);
    await sup.stop();
  });

  test("rename event carries `from` path through to the batch", async () => {
    const batches: WatchEvent[][] = [];
    const fake = makeFakeChild(
      [
        versionLine(),
        readyLine(),
        JSON.stringify({
          type: "change",
          file: "src/new.ts",
          kind: "rename",
          ts_ms: 1700000000000,
          from: "src/old.ts",
        }),
      ],
      { keepOpen: true },
    );
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 20,
      onBatch: (b) => {
        batches.push(b);
      },
      onOverflow: () => {},
      spawn: () => fake,
    });
    await new Promise((r) => setTimeout(r, 60));
    await sup.stop();
    expect(batches.length).toBe(1);
    expect(batches[0]?.[0]?.kind).toBe("rename");
    expect(batches[0]?.[0]?.from).toBe("src/old.ts");
    expect(batches[0]?.[0]?.file).toBe("src/new.ts");
  });

  test("version skew on the major aborts the supervisor with no restart", async () => {
    // Stronger than "no batches": the supervisor must stop running and must
    // NOT restart-loop (a restart would just re-fetch the same bad binary).
    const batches: WatchEvent[][] = [];
    let spawnCount = 0;
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 30,
      onBatch: (b) => {
        batches.push(b);
      },
      onOverflow: () => {},
      spawn: () => {
        spawnCount += 1;
        return makeFakeChild(
          [
            JSON.stringify({ type: "version", major: 99, minor: 0, patch: 0, protocol: 2 }),
            readyLine(),
            changeLine("src/a.ts"),
          ],
          { keepOpen: true },
        ) as never;
      },
      maxRestartBackoffMs: 50,
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(batches.length).toBe(0);
    expect(sup.isRunning()).toBe(false);
    expect(sup.stats().restarts).toBe(0); // no restart loop on skew
    expect(spawnCount).toBe(1); // spawned exactly once, then gave up
    await sup.stop();
  });
});

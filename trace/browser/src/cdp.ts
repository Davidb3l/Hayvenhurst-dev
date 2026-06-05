/**
 * Minimal Chrome DevTools Protocol client over a WebSocket.
 *
 * No third-party CDP library — CDP is plain JSON-RPC over a websocket:
 * requests are `{ id, method, params }`, responses are `{ id, result }` or
 * `{ id, error }`, and unsolicited events are `{ method, params }`. We speak it
 * directly with Bun's built-in `WebSocket` + `fetch` (DEPS: built-ins only).
 *
 * The transport is defined behind the `CdpConnection` interface so the
 * collector can be tested with a mock connection — no live Chrome needed. The
 * real connection is opened by `connectCdp`, which is the single seam that
 * touches the network.
 */

/** A live CDP session: send a command, await its typed result; close it. */
export interface CdpConnection {
  /** Send a CDP command and resolve with its `result` (rejects on `error`). */
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Close the underlying websocket. */
  close(): void;
}

/** One discoverable CDP target (a tab/page/worker), from `GET /json`. */
export interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Discover the inspectable targets exposed by a Chrome started with
 * `--remote-debugging-port=9222`. `base` is e.g. `http://localhost:9222`.
 *
 * Returns [] if Chrome is unreachable (so the caller can SKIP cleanly rather
 * than crash) — network/parse errors are swallowed into an empty list.
 */
export async function discoverTargets(
  base: string,
  timeoutMs = 2_000,
): Promise<CdpTarget[]> {
  const url = base.replace(/\/+$/, "") + "/json";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return [];
    const data = (await resp.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(
      (x): x is CdpTarget =>
        typeof x === "object" && x !== null && typeof (x as CdpTarget).id === "string",
    );
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pick the best target to profile: the first `page` with a websocket URL,
 * else the first target with a websocket URL. Returns null if none.
 */
export function pickTarget(targets: CdpTarget[]): CdpTarget | null {
  const withWs = targets.filter((t) => typeof t.webSocketDebuggerUrl === "string");
  return withWs.find((t) => t.type === "page") ?? withWs[0] ?? null;
}

/**
 * Open a real CDP connection to a target's `webSocketDebuggerUrl`.
 *
 * This is the ONLY function that touches a live browser. The collector accepts
 * a `connect` factory so tests inject a mock and never reach here.
 */
export function connectCdp(wsUrl: string, openTimeoutMs = 5_000): Promise<CdpConnection> {
  return new Promise<CdpConnection>((resolve, reject) => {
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const ws = new WebSocket(wsUrl);

    const openTimer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`CDP websocket open timed out after ${openTimeoutMs}ms`));
    }, openTimeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve(connection);
    });

    ws.addEventListener("error", () => {
      clearTimeout(openTimer);
      const err = new Error(`CDP websocket error connecting to ${wsUrl}`);
      reject(err);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });

    ws.addEventListener("close", () => {
      const err = new Error("CDP websocket closed");
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return; // unsolicited event
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "CDP error"));
      else waiter.resolve(msg.result);
    });

    const connection: CdpConnection = {
      send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = nextId++;
        return new Promise<T>((res, rej) => {
          pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
          try {
            ws.send(JSON.stringify({ id, method, params }));
          } catch (e) {
            pending.delete(id);
            rej(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
      close(): void {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
  });
}

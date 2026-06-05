import { describe, expect, it } from "bun:test";

import {
  HeuristicOracle,
  selectOracle,
  tokenize,
  type ClaimContext,
} from "../src/conflict/oracle.ts";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops short/stop tokens", () => {
    const t = tokenize("Adding rate limiting to auth/login_handler");
    // "to" too short; "adding" is a stopword; identifiers survive.
    expect([...t].sort()).toEqual(["auth", "handler", "limiting", "login", "rate"]);
  });
});

describe("HeuristicOracle", () => {
  const oracle = new HeuristicOracle();

  it('has the locked id "heuristic-v1"', () => {
    expect(oracle.id).toBe("heuristic-v1");
  });

  it("flags a conflict when scopes share a neighbor AND overlapping intent surface", async () => {
    const incoming: ClaimContext = {
      scope: ["auth/login/handler"],
      intent: "Refactor the session token validation in login",
      neighbors: ["auth/session/token"],
    };
    const adjacent: ClaimContext = {
      scope: ["auth/session/token"],
      intent: "Change the token validation contract",
      neighbors: ["auth/login/handler"],
    };
    const v = await oracle.assess(incoming, adjacent);
    expect(v.conflict).toBe(true);
    expect(v.oracle).toBe("heuristic-v1");
    expect(v.confidence).toBe(0.8); // 2+ shared tokens (token, validation)
  });

  it("returns weak band (0.5) for exactly one shared token", async () => {
    const incoming: ClaimContext = {
      scope: ["auth/login/handler"],
      intent: "Adjust pagination cursor",
      neighbors: ["shared/widget/render"],
    };
    const adjacent: ClaimContext = {
      scope: ["shared/widget/render"], // shared neighbor of incoming
      intent: "Tweak pagination defaults elsewhere",
      neighbors: [],
    };
    const v = await oracle.assess(incoming, adjacent);
    expect(v.conflict).toBe(true);
    expect(v.confidence).toBe(0.5); // only "pagination" overlaps
  });

  it("no conflict when adjacency is module-prefix only (no shared neighbor)", async () => {
    const incoming: ClaimContext = {
      scope: ["auth/login/handler"],
      intent: "Token validation",
      neighbors: [],
    };
    const adjacent: ClaimContext = {
      scope: ["auth/login/validate"],
      intent: "Token validation",
      neighbors: [],
    };
    const v = await oracle.assess(incoming, adjacent);
    expect(v.conflict).toBe(false);
    expect(v.confidence).toBe(0);
  });

  it("no conflict when scopes share a neighbor but intents/scopes use no common identifiers", async () => {
    const incoming: ClaimContext = {
      scope: ["alpha/one/aaa"],
      intent: "Rename internal helper",
      neighbors: ["common/shared/node"],
    };
    const adjacent: ClaimContext = {
      scope: ["common/shared/node"],
      intent: "Bump dependency",
      neighbors: [],
    };
    const v = await oracle.assess(incoming, adjacent);
    expect(v.conflict).toBe(false);
    expect(v.confidence).toBe(0);
  });

  it("is deterministic — identical inputs produce identical verdicts", async () => {
    const a: ClaimContext = {
      scope: ["auth/login/handler"],
      intent: "session token validation",
      neighbors: ["auth/session/token"],
    };
    const b: ClaimContext = {
      scope: ["auth/session/token"],
      intent: "token validation contract",
      neighbors: ["auth/login/handler"],
    };
    const v1 = await oracle.assess(a, b);
    const v2 = await oracle.assess(a, b);
    expect(v1).toEqual(v2);
  });
});

describe("selectOracle", () => {
  it("defaults to HeuristicOracle when no config", () => {
    expect(selectOracle().id).toBe("heuristic-v1");
  });
  it("defaults to HeuristicOracle for an unknown oracle key", () => {
    expect(selectOracle({ conflict: { oracle: "not-built-yet" } }).id).toBe("heuristic-v1");
  });
  it("selects heuristic-v1 explicitly", () => {
    expect(selectOracle({ conflict: { oracle: "heuristic-v1" } }).id).toBe("heuristic-v1");
  });
});

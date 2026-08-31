// Tests for the amicode_session spawn policy (opencode-plugin/session_spawn.ts).
// The plugin module itself (amicode_tools.ts) is NOT imported here — same
// convention as amicode_tools.test.ts: the plugin file is outside the vitest
// graph on purpose; its pure logic is what carries the tests.

import { describe, it, expect } from "vitest";
import {
  SPAWN_MAX_COUNT,
  SPAWN_MAX_DEPTH,
  parseSpawnArgs,
  computeDepth,
  depthRefusal,
  defaultTitle,
  childTitle,
  unwrap,
  summarizeSpawned,
} from "../opencode-plugin/session_spawn";

describe("parseSpawnArgs", () => {
  it("defaults count=1, mode=fresh, force=false and trims the prompt", () => {
    const r = parseSpawnArgs({ prompt: "  sweep the lattice  " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args).toEqual({
      prompt: "sweep the lattice",
      count: 1,
      title: null,
      agent: null,
      model: null,
      mode: "fresh",
      force: false,
    });
  });

  it("rejects an empty prompt", () => {
    expect(parseSpawnArgs({ prompt: "" }).ok).toBe(false);
    expect(parseSpawnArgs({ prompt: "   " }).ok).toBe(false);
    expect(parseSpawnArgs({ prompt: undefined as unknown as string }).ok).toBe(false);
  });

  it("clamps count into [1, SPAWN_MAX_COUNT]", () => {
    const low = parseSpawnArgs({ prompt: "x", count: 0 });
    const high = parseSpawnArgs({ prompt: "x", count: 99 });
    const neg = parseSpawnArgs({ prompt: "x", count: -3 });
    expect(low.ok && high.ok && neg.ok).toBe(true);
    if (low.ok && high.ok && neg.ok) {
      expect(low.args.count).toBe(1);
      expect(high.args.count).toBe(SPAWN_MAX_COUNT);
      expect(neg.args.count).toBe(1);
    }
  });

  it("floors fractional counts", () => {
    const r = parseSpawnArgs({ prompt: "x", count: 2.9 });
    expect(r.ok && r.args.count === 2).toBe(true);
  });

  it("parses providerID/modelID", () => {
    const r = parseSpawnArgs({ prompt: "x", model: "opencode-go/kimi-k3" });
    expect(r.ok && r.args.model?.providerID === "opencode-go" && r.args.model?.modelID === "kimi-k3").toBe(true);
  });

  it("rejects malformed model strings", () => {
    expect(parseSpawnArgs({ prompt: "x", model: "noslash" }).ok).toBe(false);
    expect(parseSpawnArgs({ prompt: "x", model: "/leading" }).ok).toBe(false);
    expect(parseSpawnArgs({ prompt: "x", model: "trailing/" }).ok).toBe(false);
  });

  it("only accepts mode=fork as fork; everything else is fresh", () => {
    const fork = parseSpawnArgs({ prompt: "x", mode: "fork" });
    const typo = parseSpawnArgs({ prompt: "x", mode: "Fork" });
    const junk = parseSpawnArgs({ prompt: "x", mode: "branch" });
    expect(fork.ok && fork.args.mode).toBe("fork");
    expect(typo.ok && typo.args.mode).toBe("fresh");
    expect(junk.ok && junk.args.mode).toBe("fresh");
  });

  it("force only fires on the exact boolean true", () => {
    const yes = parseSpawnArgs({ prompt: "x", force: true });
    const no = parseSpawnArgs({ prompt: "x", force: null });
    const weird = parseSpawnArgs({ prompt: "x", force: "yes" as unknown as boolean });
    expect(yes.ok && yes.args.force).toBe(true);
    expect(no.ok && no.args.force).toBe(false);
    expect(weird.ok && weird.args.force).toBe(false);
  });

  it("trims title and agent, nulling empties", () => {
    const r = parseSpawnArgs({ prompt: "x", title: "  CZ sweep  ", agent: "  " });
    expect(r.ok && r.args.title === "CZ sweep" && r.args.agent === null).toBe(true);
  });
});

describe("computeDepth", () => {
  it("treats absent/never-spawned metadata as depth 0", () => {
    expect(computeDepth(undefined)).toBe(0);
    expect(computeDepth(null)).toBe(0);
    expect(computeDepth({})).toBe(0);
  });

  it("reads spawned_depth from the stamp", () => {
    expect(computeDepth({ spawned_depth: 1 })).toBe(1);
    expect(computeDepth({ spawned_depth: 2 })).toBe(2);
  });

  it("defends against junk stamps", () => {
    expect(computeDepth({ spawned_depth: "2" })).toBe(0);
    expect(computeDepth({ spawned_depth: -1 })).toBe(0);
    expect(computeDepth({ spawned_depth: Number.NaN })).toBe(0);
    expect(computeDepth({ spawned_depth: 1.9 })).toBe(1);
  });
});

describe("the soft depth cap", () => {
  it("refuses at SPAWN_MAX_DEPTH and the refusal names the overrule", () => {
    const text = depthRefusal(SPAWN_MAX_DEPTH);
    expect(text).toContain(`spawned_depth=${SPAWN_MAX_DEPTH}`);
    expect(text).toContain("force=true");
  });
});

describe("titles", () => {
  it("derives a flattened, truncated default title", () => {
    expect(defaultTitle("run\n  the   sweep")).toBe("run the sweep");
    const long = defaultTitle("x".repeat(80));
    expect(long.length).toBe(43); // 42 chars + ellipsis
    expect(long.endsWith("…")).toBe(true);
  });

  it("suffixes only when fanning out", () => {
    expect(childTitle("CZ sweep", 0, 1)).toBe("CZ sweep");
    expect(childTitle("CZ sweep", 0, 3)).toBe("CZ sweep (1/3)");
    expect(childTitle("CZ sweep", 2, 3)).toBe("CZ sweep (3/3)");
  });
});

describe("unwrap", () => {
  it("unwraps hey-api {data} envelopes", () => {
    expect(unwrap<{ id: string }>({ data: { id: "ses_1" } })?.id).toBe("ses_1");
    expect(unwrap({ data: undefined })).toBeUndefined();
  });

  it("passes bare payloads through", () => {
    expect(unwrap<{ id: string }>({ id: "ses_2" })?.id).toBe("ses_2");
    expect(unwrap(null)).toBeUndefined();
  });
});

describe("summarizeSpawned", () => {
  it("returns the empty line when nothing spawned", () => {
    expect(summarizeSpawned([], "fresh")).toBe("No sessions were spawned.");
  });

  it("lists ids and says the tabs are background", () => {
    const text = summarizeSpawned(
      [
        { id: "ses_a", title: "CZ sweep (1/2)" },
        { id: "ses_b", title: "CZ sweep (2/2)" },
      ],
      "fresh",
    );
    expect(text).toContain("Spawned 2");
    expect(text).toContain("ses_a");
    expect(text).toContain("ses_b");
    expect(text).toContain("background tab");
    expect(text).toContain("no focus change");
  });

  it("says 'forked' for fork mode", () => {
    const text = summarizeSpawned([{ id: "ses_c", title: "" }], "fork");
    expect(text).toContain("forked from this session's history");
  });
});

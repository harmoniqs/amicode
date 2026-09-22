// fleet_projection_verb.test.ts — `amico fleet status --projection` (#1068,
// fleet rearchitect P3b-1): the fleet-authority half of the `amico fleet`
// surface. The session-registry `status --session <id>` keeps its pinned
// behavior; `--projection` routes to the entitlement-gated projection status.
//
// The three properties this suite exists to defend:
//   1. THE INVOCATION SEAM IS EXPLICIT AND INJECTABLE. The publisher is a
//      subprocess boundary — `python3 -m fleet_authority publish --out <p>`
//      with cwd = the amicissimo checkout (amicissimo#414, the companion
//      entry point, possibly unmerged). The seam is a typed interface the
//      tests mock; the default impl spawns exactly the pinned command line.
//   2. THE BOOTSTRAP EXCEPTION IS HONEST AND DISTINCT. Absent entitlement or
//      absent checkout states base-standalone with a pointer to the grant
//      path and exits with FLEET_BOOTSTRAP_EXIT (75) — never a stack trace,
//      never exit 0 (a silent no), never 64 (a usage error the user made).
//   3. THE OUTPUT COMES FROM THE READER, NEVER A SECOND PARSER. The
//      projection is validated + rendered by @amicode/schema's
//      fleet_projection reader; a stale contract version from the publisher
//      surfaces the reader's LOUD rejection verbatim (both versions named).
//
// Run: pnpm --filter @amicode/amico-run test fleet_projection_verb
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetVerb } from "../src/fleet_verb.js";
import { fleetProjectionStatus, FLEET_BOOTSTRAP_EXIT, type FleetProjectionDeps } from "../src/fleet_projection_verb.js";
import { fleetProjectionCachePath, fleetTopologyPath } from "@amicode/schema";

const E1 = "44444444-4444-4444-8444-444444444444";

// The committed fixture projection — a full document shaped on amicissimo's
// Python publisher fixtures (client role → fleet mode, health + locks present).
const FIXTURE = new URL("./fixtures/fleet_authority/projection.json", import.meta.url);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fleet-proj-verb-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A hermetic world: an entitlements file carrying the `amicissimo` code, a
 *  checkout dir, and a runPublisher that copies the fixture projection to the
 *  outPath the verb handed it — the real publisher's #414 contract, faked.
 *  The #1106 cache defaults INTO THE TMP DIR — a suite run never touches the
 *  machine's real ~/.amico/ops/fleet/projection.json. */
function grantedWorld(over: Partial<FleetProjectionDeps> = {}, fixture: string = FIXTURE.pathname) {
  const entitlements = join(tmp, "entitlements.toml");
  writeFileSync(entitlements, 'codes = ["amicissimo"]\n');
  const checkout = join(tmp, "amicissimo");
  const calls: Array<{ program: string; args: string[]; cwd: string; outPath: string }> = [];
  const deps: FleetProjectionDeps = {
    readFile: (p) => (p === entitlements ? 'codes = ["amicissimo"]' : fixtureFileSafe(p, fixture)),
    checkDir: (p) => p === checkout,
    // Hermetic #1194: the machine's real ~/.amico/ops/fleet/fleet.json must
    // never leak a --topology flag into suite runs — the default world has
    // NO topology file; the present-topology tests inject one explicitly.
    checkFile: () => false,
    topologyPath: join(tmp, "fleet.json"),
    cachePath: join(tmp, "hermetic-cache.json"),
    runPublisher: (inv) => {
      calls.push(inv);
      writeFileSync(inv.outPath, readFileSync(fixture, "utf8"));
      return { code: 0, stdout: "", stderr: "" };
    },
    ...over,
  };
  return { entitlements, checkout, calls, deps };
}

/** Only the fixture + the entitlements file exist on disk in these tests. */
function fixtureFileSafe(p: string, _fixture: string): string | null {
  return null;
}

function run(argv: string[], deps: FleetProjectionDeps): { json: Record<string, unknown>; code: number } {
  return fleetProjectionStatus(["--projection", ...argv], deps) as unknown as { json: Record<string, unknown>; code: number };
}

// ── the invocation seam: a subprocess boundary, pinned ─────────────────────────

describe("the publisher invocation seam (python3 -m fleet_authority)", () => {
  it("invokes exactly `python3 -m fleet_authority publish --out <p>` with cwd = the resolved checkout", () => {
    const w = grantedWorld();
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], w.deps);
    expect(r.code).toBe(0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].program).toBe("python3");
    expect(w.calls[0].args.slice(0, 3)).toEqual(["-m", "fleet_authority", "publish"]);
    expect(w.calls[0].args[3]).toBe("--out");
    expect(w.calls[0].outPath.endsWith(".json")).toBe(true);
    expect(w.calls[0].cwd).toBe(w.checkout);
  });

  // #1194: a publish WITHOUT the topology source renders mode from the base
  // default (standalone) and clobbers enrolled machines' cached projections.
  it("passes --topology <fleet.json> when the machine's topology file exists (#1194)", () => {
    const topologyPath = join(tmp, "enrolled", "fleet.json");
    const w = grantedWorld({
      checkFile: (p) => p === topologyPath,
      topologyPath,
    });
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], w.deps);
    expect(r.code).toBe(0);
    expect(w.calls).toHaveLength(1);
    const args = w.calls[0].args;
    const i = args.indexOf("--topology");
    expect(i).toBeGreaterThan(0);
    expect(args[i + 1]).toBe(topologyPath);
  });

  it("omits --topology when no topology file exists — the honest base-default standalone, unchanged (#1194)", () => {
    const w = grantedWorld(); // default world: checkFile → false, no fleet.json
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], w.deps);
    expect(r.code).toBe(0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].args).not.toContain("--topology");
  });

  it("the default topologyPath is the live-layout convention (~/.amico/ops/fleet/fleet.json), never guessed per-call (#1194)", () => {
    const w = grantedWorld();
    const seen: string[] = [];
    const { topologyPath: _omit, ...rest } = w.deps; // hermetic default stays out — assert the convention path
    const deps: FleetProjectionDeps = { ...rest, checkFile: (p) => (seen.push(p), true) };
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], deps);
    expect(r.code).toBe(0);
    expect(seen).toContain(fleetTopologyPath());
    expect(w.calls[0].args).toContain("--topology");
  });

  it("resolves the checkout through the AMICISSIMO_ROOT ladder (flag → env → org-home default)", () => {
    const w = grantedWorld();
    const seen: string[] = [];
    const deps: FleetProjectionDeps = { ...w.deps, checkDir: (p) => (seen.push(p), true) };
    const prev = process.env.AMICISSIMO_ROOT;
    process.env.AMICISSIMO_ROOT = "/env/checkout";
    try {
      run(["--config", w.entitlements], deps); // no --checkout → env ladder
      expect(seen).toContain("/env/checkout");
    } finally {
      if (prev === undefined) delete process.env.AMICISSIMO_ROOT;
      else process.env.AMICISSIMO_ROOT = prev;
    }
  });
});

// ── the status read: from the reader, one parser path ─────────────────────────

describe("amico fleet status --projection (granted world)", () => {
  it("publishes, reads through the shared reader, and prints the summary with per-section provenance", () => {
    const w = grantedWorld();
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], w.deps);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ verb: "fleet", subcommand: "status", ok: true, mode: "fleet", posture: "ok" });
    expect(r.json.checkout).toBe(w.checkout);
    expect((r.json.freshness as Record<string, unknown>).counter).toBe(4);
    const summary = r.json.summary as string;
    expect(summary).toContain("mode: fleet");
    expect(summary).toMatch(/source: fleet\.json/); // provenance renders
    expect(summary).toContain("counter 4"); // carried freshness fields render
  });

  it("a stale contract_version from the publisher surfaces the reader's LOUD rejection, both versions named", () => {
    const stale = join(tmp, "stale-projection.json");
    writeFileSync(stale, JSON.stringify({ schema_version: 1, contract_version: 0, sections: {} }));
    const w = grantedWorld({}, stale);
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], w.deps);
    expect(r.code).toBe(64);
    expect((r.json.errors as string[]).join(" ")).toContain("v0");
    expect((r.json.errors as string[]).join(" ")).toContain("v1");
  });

  it("a failed publisher invocation reports honestly (entry point may be absent — amicissimo#414), never a stack trace", () => {
    const w = grantedWorld({ runPublisher: () => ({ code: 1, stdout: "", stderr: "No module named fleet_authority" }) });
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], w.deps);
    expect(r.code).toBe(64);
    const errors = (r.json.errors as string[]).join(" ");
    expect(errors).toContain("fleet_authority");
    expect(errors).toContain("No module named fleet_authority");
    expect(errors).toMatch(/amicissimo#414|entry point/i);
  });

  it("a --previous projection yields the D1 freshness verdict, cross-epoch surfaced as unknown + force-refetch", () => {
    const w = grantedWorld();
    const previous = join(tmp, "previous.json");
    writeFileSync(previous, JSON.stringify({
      schema_version: 1,
      contract_version: 1,
      freshness: { counter: 99, hub_epoch: "99999999-9999-4999-8999-999999999999" },
      sections: {},
    }));
    const r = run(["--checkout", w.checkout, "--config", w.entitlements, "--previous", previous], w.deps);
    expect(r.code).toBe(0);
    expect((r.json.freshness as Record<string, unknown>).verdict).toBe("unknown");
    expect(r.json.summary as string).toMatch(/force refetch/i);
  });
});

// ── the bootstrap exception: honest, distinct, never a crash ───────────────────

describe("the bootstrap exception (no entitlement / no checkout)", () => {
  it("absent entitlement → base-standalone stated with the grant path, exit FLEET_BOOTSTRAP_EXIT, publisher never invoked", () => {
    let invoked = 0;
    const deps: FleetProjectionDeps = {
      readFile: () => null, // no entitlements file at all
      checkDir: () => true,
      runPublisher: () => {
        invoked += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const r = run(["--config", join(tmp, "entitlements.toml")], deps);
    expect(r.code).toBe(FLEET_BOOTSTRAP_EXIT);
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBe(64);
    expect(invoked).toBe(0); // not granted → the publisher is never spawned
    expect(r.json).toMatchObject({ ok: false, bootstrap: true, reason: "entitlement", mode: "standalone" });
    const rendered = [r.json.rendered, r.json.note].filter(Boolean).join("\n") as string;
    expect(rendered).toMatch(/base-standalone/);
    expect(rendered).toContain("entitlements.toml"); // the honest pointer
    expect(rendered).toMatch(/amicissimo/);
  });

  it("entitlement without the amicissimo code → the same honest bootstrap", () => {
    const entitlements = join(tmp, "entitlements.toml");
    writeFileSync(entitlements, 'codes = ["issimo"]\n');
    const r = run(["--config", entitlements], { readFile: (p) => (p === entitlements ? 'codes = ["issimo"]' : null), checkDir: () => true });
    expect(r.code).toBe(FLEET_BOOTSTRAP_EXIT);
    expect(r.json).toMatchObject({ bootstrap: true, reason: "entitlement" });
  });

  it("absent checkout → base-standalone stated with the clone pointer, exit FLEET_BOOTSTRAP_EXIT", () => {
    const entitlements = join(tmp, "entitlements.toml");
    writeFileSync(entitlements, 'codes = ["amicissimo"]\n');
    const r = run(["--config", entitlements, "--checkout", join(tmp, "no-such-checkout")], {
      readFile: (p) => (p === entitlements ? 'codes = ["amicissimo"]' : null),
      checkDir: () => false,
    });
    expect(r.code).toBe(FLEET_BOOTSTRAP_EXIT);
    expect(r.json).toMatchObject({ ok: false, bootstrap: true, reason: "checkout", mode: "standalone" });
    const rendered = [r.json.rendered, r.json.note].filter(Boolean).join("\n") as string;
    expect(rendered).toMatch(/base-standalone/);
    expect(rendered).toMatch(/AMICISSIMO_ROOT/); // the escape hatch, named
  });

  it("an unknown flag is a usage error (64), distinct from the bootstrap exception", () => {
    const w = grantedWorld();
    const r = run(["--checkout", w.checkout, "--config", w.entitlements, "--bogus"], w.deps);
    expect(r.code).toBe(64);
    expect((r.json.errors as string[]).join(" ")).toContain("--bogus");
  });
});

// ── the stable projection-cache convention (#1106, P3b-2) ──────────────────────

describe("the stable projection-cache convention (#1106)", () => {
  it("a successful status refreshes the cache at the known path with the published bytes", () => {
    const w = grantedWorld();
    const cachePath = join(tmp, "ops", "fleet", "projection.json");
    const writes: Array<{ p: string; content: string }> = [];
    const deps: FleetProjectionDeps = { ...w.deps, cachePath, writeCache: (p, content) => writes.push({ p, content }) };
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], deps);
    expect(r.code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].p).toBe(cachePath);
    expect(writes[0].content).toBe(readFileSync(FIXTURE.pathname, "utf8")); // the published bytes, verbatim
  });

  it("the default cachePath is the live-layout convention (~/.amico/ops/fleet/projection.json), never guessed per-call", () => {
    const w = grantedWorld();
    const writes: Array<{ p: string; content: string }> = [];
    const { cachePath: _omit, ...rest } = w.deps; // hermetic default stays out — assert the convention path
    const deps: FleetProjectionDeps = { ...rest, writeCache: (p, content) => writes.push({ p, content }) };
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], deps);
    expect(r.code).toBe(0);
    expect(writes[0].p).toBe(fleetProjectionCachePath());
  });

  it("only a projection the reader VALIDATED lands in the cache — a rejected contract version never clobbers it", () => {
    const stale = join(tmp, "stale-projection.json");
    writeFileSync(stale, JSON.stringify({ schema_version: 1, contract_version: 2, sections: {} }));
    const w = grantedWorld({}, stale);
    const writes: Array<{ p: string; content: string }> = [];
    const deps: FleetProjectionDeps = { ...w.deps, cachePath: join(tmp, "cache.json"), writeCache: (p, content) => writes.push({ p, content }) };
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], deps);
    expect(r.code).toBe(64); // the loud rejection
    expect(writes).toHaveLength(0); // and the cache was never touched
  });

  it("the bootstrap exception (75) leaves the cache untouched — base-standalone is stated, not cached", () => {
    const writes: Array<{ p: string; content: string }> = [];
    const deps: FleetProjectionDeps = {
      readFile: () => null, // no entitlements
      checkDir: () => true,
      writeCache: (p, content) => writes.push({ p, content }),
    };
    const r = run(["--config", join(tmp, "entitlements.toml")], deps);
    expect(r.code).toBe(FLEET_BOOTSTRAP_EXIT);
    expect(writes).toHaveLength(0);
  });

  it("the success JSON carries additive machine fields for script consumers: role + canonical + cache_path", () => {
    const w = grantedWorld();
    const cachePath = join(tmp, "cache.json");
    const deps: FleetProjectionDeps = { ...w.deps, cachePath, writeCache: () => {} };
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], deps);
    expect(r.code).toBe(0);
    expect(r.json.role).toBe("client");
    expect(r.json.canonical).toMatchObject({ host: "hq-hub-01.example.internal", port: 4096, sshAlias: "hq-hub-01" });
    expect(r.json.cache_path).toBe(cachePath);
  });

  it("a projection without a topology section still succeeds and caches — the machine fields render absent, never invented", () => {
    const bare = join(tmp, "bare-projection.json");
    writeFileSync(bare, JSON.stringify({
      schema_version: 1,
      contract_version: 1,
      publisher: { identity: "test", published_at: "2026-09-13T12:00:00Z" },
      freshness: { counter: 1, hub_epoch: E1 },
      sections: { mode: { value: "standalone" } },
    }));
    const w = grantedWorld({}, bare);
    const cachePath = join(tmp, "cache.json");
    const deps: FleetProjectionDeps = { ...w.deps, cachePath, writeCache: () => {} };
    const r = run(["--checkout", w.checkout, "--config", w.entitlements], deps);
    expect(r.code).toBe(0);
    expect(r.json.role).toBeUndefined();
    expect(r.json.canonical).toBeUndefined();
  });
});

// ── the router: --projection routes within `amico fleet status` ────────────────

describe("the fleet verb router", () => {
  it("`status --projection` routes to the projection status; plain `status` keeps its pinned --session contract", () => {
    const w = grantedWorld();
    const routed = fleetVerb(
      ["status", "--projection", "--checkout", w.checkout, "--config", w.entitlements],
      { projection: w.deps },
    ) as unknown as { json: Record<string, unknown>; code: number };
    expect(routed.code).toBe(0);
    expect(routed.json.ok).toBe(true);
    expect(routed.json.mode).toBe("fleet");
    expect(w.calls).toHaveLength(1); // the publisher was invoked through the seam

    // the pinned session-registry contract is untouched (fleet_verb.test.ts's
    // `--session is required` case) — asserted here from the same router.
    const plain = fleetVerb(["status"]) as unknown as { json: Record<string, unknown>; code: number };
    expect(plain.code).toBe(64);
    expect((plain.json.errors as string[]).join(" ")).toMatch(/--session <id> is required/);
  });
});

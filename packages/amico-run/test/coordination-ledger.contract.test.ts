// Contract suite for coordination ledger (spec #318) — runs against both cloud and sqlite ref
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { coordinationService, SqliteCoordinationService, workId } from "../src/coordination_ledger.js";
import { degradedStamp } from "../src/coordination_ledger.js";

const wid = (s: string) => workId({ structure_hash: s, goal: "CZ", N: 100, T: 30 });

// ── isolation bridge (#642) ─────────────────────────────────────────────────
// Claim appends made by this suite must land in a per-run tmp partition and
// NEVER in the production claims ledger (~/.amico/ledger/claims.jsonl) — the
// Prova simulated-ledger-partition pattern from docs/ledger.md, via the
// $AMICO_CLAIMS_FILE seam the service reads per append. Before the bridge, the
// suite constructed the service bare with the env unset, so every contract run
// appended fixture rows to the real ledger: 176 rows before ops archived it as
// claims.jsonl.archive-20260830-test-pollution (#642).
const PRODUCTION_CLAIMS = join(homedir(), ".amico", "ledger", "claims.jsonl");
// Snapshot at module load — before any test in this file has run.
const productionSnapshot = existsSync(PRODUCTION_CLAIMS)
  ? readFileSync(PRODUCTION_CLAIMS).toString("base64")
  : null;
const ISO_ROOT = mkdtempSync(join(tmpdir(), "amico-claims-iso-"));
const ISOLATED_CLAIMS = join(ISO_ROOT, "claims.jsonl");

const productionNow = (): string | null =>
  existsSync(PRODUCTION_CLAIMS) ? readFileSync(PRODUCTION_CLAIMS).toString("base64") : null;

// The bridge itself: route EVERY service construction in this file at the
// isolated partition. The env is the seam claimsFile() reads per append, so
// bare constructions and future ones are covered equally; production callers
// never set it and keep their default path.
const prevClaimsEnv = process.env.AMICO_CLAIMS_FILE;
beforeAll(() => {
  process.env.AMICO_CLAIMS_FILE = ISOLATED_CLAIMS;
});
afterAll(() => {
  // Suite-wide guard, order-robust: after every test has run, the production
  // ledger is still pristine (byte-identical, or still absent — CI and local).
  expect(productionNow()).toBe(productionSnapshot);
  // Never leak process state across suites (vitest reuses forked workers).
  if (prevClaimsEnv === undefined) delete process.env.AMICO_CLAIMS_FILE;
  else process.env.AMICO_CLAIMS_FILE = prevClaimsEnv;
  rmSync(ISO_ROOT, { recursive: true, force: true });
});

describe("coordination ledger — claim serialization (spec §3)", () => {
  it("simultaneous claims serialize by receipt order; loser gets holder", async () => {
    const svc = new SqliteCoordinationService();
    const a = await svc.preflight({ work_id: wid("abc"), agent_id: "a1", user: "u1", org: "o1", host: "h1" });
    const b = await svc.preflight({ work_id: wid("abc"), agent_id: "a2", user: "u2", org: "o1", host: "h2" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.holder?.agent_id).toBe("a1");
  });

  it("lapsed lease is taken by next preflight (no deadlock)", async () => {
    const svc = new SqliteCoordinationService();
    await svc.preflight({ work_id: wid("lapse"), agent_id: "a1", user: "u1", org: "o1", host: "h1", ttl_s: 0 });
    // ttl 0 → immediately lapsed
    const b = await svc.preflight({ work_id: wid("lapse"), agent_id: "a2", user: "u2", org: "o1", host: "h2" });
    expect(b.ok).toBe(true);
  });

  it("verified result dedups — second never re-solves", async () => {
    const svc = new SqliteCoordinationService();
    const w = wid("dedup");
    await svc.publish({ work_id: w, verification: { agree: true }, fidelity: 0.999, catalog_pointer: "/tmp/pulse.jld2", platform: "transmon", kind: "CZ" });
    const b = await svc.preflight({ work_id: w, agent_id: "a2", user: "u2", org: "o1", host: "h2" });
    expect(b.ok).toBe(true);
    expect(b.dedup?.verified).toBe(true);
    expect(b.dedup?.pulse_path).toBe("/tmp/pulse.jld2");
  });

  it("workIdV1 stability: same physics → same id, max_iter excluded", () => {
    const a = workId({ structure_hash: "abc", goal: "CZ", N: 100, T: 30, facet_tuple: { free_phase: true } });
    const b = workId({ structure_hash: "abc", goal: "CZ", N: 100, T: 30, facet_tuple: { free_phase: true } });
    const c = workId({ structure_hash: "abc", goal: "CZ", N: 100, T: 30, facet_tuple: { free_phase: false } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("offline degraded stamp is honest", () => {
    expect(degradedStamp()).toEqual({ coordination: "degraded" });
  });

  it("fleet list --org shows user/host/org", async () => {
    const svc = new SqliteCoordinationService();
    await svc.preflight({ work_id: wid("fleet1"), agent_id: "a1", user: "alice", org: "lab", host: "h1" });
    const list = await svc.fleetList("lab");
    expect(list.some(s => s.user === "alice" && s.host === "h1")).toBe(true);
  });
});

describe("coordination ledger — test isolation (#642)", () => {
  it("claim appends land in the per-run tmp partition, never the production claims ledger", async () => {
    const svc = new SqliteCoordinationService();
    const r = await svc.preflight({ work_id: wid("iso-guard"), agent_id: "iso", user: "iso", org: "iso", host: "iso" });
    expect(r.ok).toBe(true);
    // the durable append still works — the claim line landed in the isolated partition
    const written = existsSync(ISOLATED_CLAIMS) ? readFileSync(ISOLATED_CLAIMS, "utf8") : "";
    expect(written).toContain(wid("iso-guard"));
    // and the production ledger is byte-identical to its pre-suite snapshot (or still absent)
    expect(productionNow()).toBe(productionSnapshot);
  });
});

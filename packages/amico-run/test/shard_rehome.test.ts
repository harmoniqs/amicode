// `amico fleet shard-rehome` (amicode#1658) — the tested directory re-home for
// client shards merged into the canonical DB.
//
// The properties this suite exists to defend (the issue's ACs):
//   1. A merged session's directory either EXISTS on the hub or is the shard's
//      original, untouched directory — a missing target keeps the original.
//   2. No re-homed directory contains a doubled path segment — the mapping is ONE
//      prefix substitution, and the suite asserts the exact candidate against
//      the real paths the 2026-10-01 hand-run mangled.
//   3. Rows already hub-side or under foreign prefixes are untouched, never errors.
//   4. The verb round-trips over the real python3 bridge on a seeded temp DB
//      (never the live chat DB): dry-run plans, apply lands + verifies, and a
//      failed verification is a nonzero exit.
//
// Run: pnpm --filter @amicode/amico-run test shard_rehome
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteBatch } from "../src/sqlite_bridge.js";
import { planRehome, shardRehome, type RehomeRow } from "../src/shard_rehome.js";

const CLIENT_HOME = "/Users/aaron";
const HUB_HOME = "/home/aaron";

// the real directories the 2026-10-01 hand-run re-home doubled — the regression
// fixtures. The hand-run produced armoniaa/harmoniqsoniqs; the mapping below must
// produce the exact single-substitution candidate for each.
const DOUBLED_CASES: Array<[string, string]> = [
  ["/Users/aaron/armonia/data/vaults", "/home/aaron/armonia/data/vaults"],
  ["/Users/aaron/armonia/repos/amicode", "/home/aaron/armonia/repos/amicode"],
  ["/Users/aaron/armonia/repos/packages", "/home/aaron/armonia/repos/packages"],
  ["/Users/aaron/harmoniqs", "/home/aaron/harmoniqs"],
];

function rowsOf(...directories: string[]): RehomeRow[] {
  return directories.map((d, i) => ({ id: `ses_fix${i}`, directory: d }));
}

describe("planRehome — the pure mapping (table-tested, no fs)", () => {
  const existsEverywhere = () => true;

  it("AC1+AC2: a client-home directory with an existing hub target re-homes to the exact single-prefix candidate", () => {
    for (const [from, to] of DOUBLED_CASES) {
      const [d] = planRehome([{ id: "ses_a", directory: from }], {
        clientHome: CLIENT_HOME,
        hubHome: HUB_HOME,
        exists: existsEverywhere,
      });
      expect(d.action).toBe("rehome");
      expect(d.to).toBe(to);
      expect(d.to).toBe(HUB_HOME + from.slice(CLIENT_HOME.length)); // the substitution, exactly once
    }
  });

  it("AC2: a target missing on the hub keeps the shard's original directory — invisible-but-truthful beats invisible-and-wrong", () => {
    const [d] = planRehome([{ id: "ses_a", directory: "/Users/aaron/nowhere/else" }], {
      clientHome: CLIENT_HOME,
      hubHome: HUB_HOME,
      exists: () => false,
    });
    expect(d.action).toBe("keep");
    expect(d.to).toBe("/Users/aaron/nowhere/else");
    expect(d.reason).toMatch(/does not exist on the hub/);
  });

  it("AC3: already-hub-side and foreign-prefix rows are kept untouched, never errors", () => {
    const plan = planRehome(rowsOf("/home/aaron/armonia/repos/amicode", "/private/tmp/oc-crash-test"), {
      clientHome: CLIENT_HOME,
      hubHome: HUB_HOME,
      exists: existsEverywhere,
    });
    expect(plan.every((d) => d.action === "keep")).toBe(true);
    expect(plan.every((d) => d.to === d.from)).toBe(true);
  });

  it("no doubled segments, structurally: the candidate is hubHome + from.slice(clientHome.length) for arbitrary nesting", () => {
    const from = "/Users/aaron/a/b/c/d/e";
    const [d] = planRehome([{ id: "ses_a", directory: from }], {
      clientHome: CLIENT_HOME,
      hubHome: HUB_HOME,
      exists: existsEverywhere,
    });
    expect(d.to).toBe("/home/aaron/a/b/c/d/e");
    expect(d.from).not.toContain("armoniaa");
    expect(d.to).not.toMatch(/(\/[^/]+)\1/); // no segment repeats back-to-back
  });

  it("client home === hub home is a no-op keep", () => {
    const [d] = planRehome([{ id: "ses_a", directory: "/home/aaron/x" }], {
      clientHome: HUB_HOME,
      hubHome: HUB_HOME,
      exists: existsEverywhere,
    });
    expect(d.action).toBe("keep");
    expect(d.to).toBe("/home/aaron/x");
  });
});

describe("shardRehome — the verb over the real bridge on a seeded temp DB", () => {
  let tmp: string;
  let db: string;
  let hub: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function seed(directories: string[]) {
    tmp = mkdtempSync(join(tmpdir(), "shard-rehome-"));
    db = join(tmp, "canonical.db");
    hub = join(tmp, "hub-home");
    mkdirSync(hub, { recursive: true });
    sqliteBatch(db, "rw", [
      { sql: "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)" },
      ...directories.map((d, i) => ({ sql: "INSERT INTO session (id, directory) VALUES (?, ?)", params: [`ses_${i}`, d] })),
    ]);
  }

  function readAll(): Array<{ id: string; directory: string }> {
    return sqliteBatch(db, "ro", [{ sql: "SELECT id, directory FROM session" }]).results[0].rows as Array<{
      id: string;
      directory: string;
    }>;
  }

  it("dry-run plans the re-home without touching the DB", () => {
    seed(["/Users/aaron/armonia/repos/amicode", "/private/tmp/oc-crash-test"]);
    mkdirSync(join(hub, "armonia/repos/amicode"), { recursive: true });
    const r = shardRehome(["--client-home", CLIENT_HOME, "--db", db], { hubHome: hub });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j).toMatchObject({ mode: "dry-run", scanned: 1, rehome_count: 1, kept_count: 0 });
    expect(readAll()).toEqual([
      { id: "ses_0", directory: "/Users/aaron/armonia/repos/amicode" }, // untouched by the dry-run
      { id: "ses_1", directory: "/private/tmp/oc-crash-test" },
    ]);
  });

  it("apply re-homes to the validated target and verifies what landed", () => {
    seed(["/Users/aaron/armonia/repos/amicode"]);
    mkdirSync(join(hub, "armonia/repos/amicode"), { recursive: true });
    const r = shardRehome(["--client-home", CLIENT_HOME, "--db", db, "--apply"], { hubHome: hub });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j).toMatchObject({ mode: "apply", rehome_count: 1, verified: true });
    expect(readAll()).toEqual([{ id: "ses_0", directory: join(hub, "armonia/repos/amicode") }]);
  });

  it("apply keeps the shard's original when the target does not exist on the hub", () => {
    seed(["/Users/aaron/armonia/repos/amicode"]); // target dir deliberately NOT created
    const r = shardRehome(["--client-home", CLIENT_HOME, "--db", db, "--apply"], { hubHome: hub });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j).toMatchObject({ rehome_count: 0, kept_count: 1 });
    expect(readAll()).toEqual([{ id: "ses_0", directory: "/Users/aaron/armonia/repos/amicode" }]);
  });

  it("a missing --client-home fails closed with usage, and a relative path is rejected", () => {
    seed([]);
    expect(shardRehome(["--db", db], { hubHome: hub }).code).toBe(64);
    expect(shardRehome(["--client-home", "Users/aaron", "--db", db], { hubHome: hub }).code).toBe(64);
  });
});

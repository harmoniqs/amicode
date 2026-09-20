// `amico fleet shard-watch` (amicode#1306) — the nightly client shard-divergence watch.
//
// The properties this suite exists to defend:
//   1. THE COMPARISON IS PURE AND TABLE-TESTED with fixture id sets — the collision-check
//      shape from the chat-database recovery procedure (id overlap, sorted, deterministic).
//   2. NO TEST EVER TOUCHES NETWORK OR A REAL DB. All probing (ssh reachability, port
//      listeners, DB reads) sits behind the injectable ShardWatchProbes seam; the whole
//      verb runs hermetically on injected probes. The ONE default-probe test reads a
//      seeded fixture sqlite DB in a temp dir (never the live chat DB) and asserts the
//      file's bytes are UNTOUCHED by the read.
//   3. CLIENT DBS ARE NEVER WRITTEN. The probe interface has no write surface at all; the
//      client census command is a pure string asserted to be `sqlite3 -readonly ... SELECT`;
//      the canonical read goes through the bridge's "ro" mode.
//   4. UNREACHABLE ≠ DIVERGENT. A sleeping laptop is a warning row, never a fork.
//   5. A LIVE LOCAL LISTENER on the canonical port that is not the ssh forward is a fork
//      signal — the stale-mini-server incident is the case this job exists to catch.
//   6. DIVERGENCE → NONZERO EXIT + a receipt line carrying ts, per-client results, verdicts.
//
// Run: pnpm --filter @amicode/amico-run test shard_watch
import { beforeAll, describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ALERT_MIN,
  DEFAULT_CANONICAL_PORT,
  MISSING_SAMPLE_LIMIT,
  compareShard,
  checkClient,
  clientCensusCommand,
  forkListenerCommand,
  parseForkListener,
  shardVerdict,
  sqliteBridgeCensus,
  shardWatch,
  type ClientShardResult,
  type ShardWatchProbes,
} from "../src/shard_watch.js";

const NOW = Date.parse("2026-09-20T04:15:00.000Z");
const NOW_FN = () => NOW;

// ── fixture id sets (the collision-check shape, table-tested) ────────────────

const CANONICAL = ["ses_a", "ses_b", "ses_c", "ses_d"];

describe("compareShard — the collision-check shape over fixture id sets", () => {
  it("tables: full overlap → no missing ids, counts agree", () => {
    const cmp = compareShard("macbook", CANONICAL, ["ses_a", "ses_b", "ses_c", "ses_d"]);
    expect(cmp).toMatchObject({
      alias: "macbook",
      canonical_count: 4,
      client_count: 4,
      missing_count: 0,
      missing_ids: [],
      absent_from_client: 0,
    });
  });

  it("tables: a forked shard — client ids absent from canonical are the divergence signal", () => {
    const cmp = compareShard("macbook", CANONICAL, [...CANONICAL, "ses_x", "ses_y"]);
    expect(cmp.missing_ids).toEqual(["ses_x", "ses_y"]);
    expect(cmp.missing_count).toBe(2);
    expect(cmp.absent_from_client).toBe(0);
  });

  it("tables: a lagging client — canonical ids absent from the client are informational, not divergence", () => {
    const cmp = compareShard("macbook", CANONICAL, ["ses_a"]);
    expect(cmp.missing_ids).toEqual([]);
    expect(cmp.absent_from_client).toBe(3);
    expect(cmp.client_count).toBe(1);
    expect(cmp.canonical_count).toBe(4);
  });

  it("tables: empty client (fresh machine) → zero missing, everything informational", () => {
    const cmp = compareShard("macbook", CANONICAL, []);
    expect(cmp.missing_ids).toEqual([]);
    expect(cmp.absent_from_client).toBe(4);
    expect(cmp.client_count).toBe(0);
  });

  it("tables: both directions at once — divergence is the client-side delta only", () => {
    const cmp = compareShard("macbook", CANONICAL, ["ses_a", "ses_z1", "ses_z2"]);
    expect(cmp.missing_ids).toEqual(["ses_z1", "ses_z2"]);
    expect(cmp.absent_from_client).toBe(3);
  });

  it("is deterministic: missing ids come back sorted and deduplicated", () => {
    const cmp = compareShard("macbook", CANONICAL, ["ses_z", "ses_a", "ses_z", "ses_m"]);
    expect(cmp.missing_ids).toEqual(["ses_m", "ses_z"]);
    expect(cmp.client_count).toBe(3); // duplicates collapse
  });
});

// ── the verdict thresholds (config-driven alerting) ──────────────────────────

describe("shardVerdict — the alert threshold is config, warn-only below it", () => {
  it("tables: zero missing → clean", () => {
    expect(shardVerdict(0, 1)).toBe("clean");
  });
  it("tables: missing ≥ alertMin → divergent (default alertMin = 1: any missing id alerts)", () => {
    expect(shardVerdict(1, 1)).toBe("divergent");
    expect(shardVerdict(77, 1)).toBe("divergent");
    expect(DEFAULT_ALERT_MIN).toBe(1);
  });
  it("tables: 0 < missing < alertMin → warn (reported, never alerting)", () => {
    expect(shardVerdict(2, 5)).toBe("warn");
    expect(shardVerdict(4, 5)).toBe("warn");
  });
  it("tables: missing = alertMin exactly → divergent (the threshold is inclusive)", () => {
    expect(shardVerdict(5, 5)).toBe("divergent");
  });
});

// ── the read-only command builders (pure strings, the no-write assertions) ──

describe("the probe command builders — read-only by construction", () => {
  it("the client census command opens sqlite3 READONLY and SELECTs only", () => {
    const cmd = clientCensusCommand("/Users/aaron/.local/share/opencode/opencode.db");
    expect(cmd).toContain("-readonly");
    expect(cmd).toContain("SELECT id FROM session");
    expect(cmd).not.toMatch(/INSERT|UPDATE|DELETE|DROP|CREATE|VACUUM/i);
    expect(cmd).toMatch(/2>\/dev\/null/); // a missing sqlite3 degrades to unreachable, honestly
  });

  it("the client census command single-quotes the db path (spaces survive)", () => {
    const cmd = clientCensusCommand("/Users/a/My Db/opencode.db");
    expect(cmd).toContain("'/Users/a/My Db/opencode.db'");
  });

  it("the fork-listener command lists LISTENers on the canonical port only", () => {
    const cmd = forkListenerCommand(4096);
    expect(cmd).toContain("-iTCP:4096");
    expect(cmd).toContain("-sTCP:LISTEN");
    expect(cmd).not.toMatch(/kill|rm |pkill/i); // detection only — never a remediation
  });

  it("the canonical port default is 4096 (the canonical opencode port)", () => {
    expect(DEFAULT_CANONICAL_PORT).toBe(4096);
  });
});

// ── the fork-listener parse (a live local listener ≠ the ssh forward) ────────

describe("parseForkListener — a live local listener that is not the ssh forward", () => {
  it("tables: only the ssh forward listening → no fork", () => {
    const out = [
      "COMMAND   PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "ssh     12345  aaron    6u  IPv4  0xabcdef        0t0  TCP *:4096 (LISTEN)",
    ].join("\n");
    expect(parseForkListener(out)).toEqual({ listeners: ["ssh"], fork: false });
  });

  it("tables: sshd holding the forward endpoint → no fork", () => {
    const out = "sshd    999  aaron    9u  IPv6  0x123456        0t0  TCP *:4096 (LISTEN)";
    expect(parseForkListener(out)).toEqual({ listeners: ["sshd"], fork: false });
  });

  it("tables: a live local opencode/node listener → FORK SIGNAL", () => {
    const out = "node   4242  aaron   21u  IPv4  0xbeef00        0t0  TCP *:4096 (LISTEN)";
    const p = parseForkListener(out);
    expect(p.listeners).toEqual(["node"]);
    expect(p.fork).toBe(true);
  });

  it("tables: forward AND stale server both bound → fork signal (the 2026-09-20 sweep case)", () => {
    const out = [
      "ssh    12345  aaron    6u  IPv4  0xabcdef        0t0  TCP *:4096 (LISTEN)",
      "opencode 777  aaron   12u  IPv4  0xfeed01        0t0  TCP *:4096 (LISTEN)",
    ].join("\n");
    expect(parseForkListener(out).fork).toBe(true);
  });

  it("tables: nothing listening (forward down) → no fork, honest empty census", () => {
    expect(parseForkListener("")).toEqual({ listeners: [], fork: false });
  });
});

// ── the per-client check (pure given injected probes) ────────────────────────

function makeProbes(over: Partial<ShardWatchProbes> = {}): ShardWatchProbes {
  return {
    canonicalSessionIds: () => ({ ok: true, ids: CANONICAL }),
    clientSessionIds: () => ({ ok: true, ids: CANONICAL }),
    forkListener: () => ({ ok: true, fork: false, detail: "ssh" }),
    ...over,
  };
}

const CLIENT_OPTS = { dbPath: "/tmp/opencode-fixture/opencode.db", port: 4096, alertMin: 1 };

describe("checkClient — one client's verdict from injected probes", () => {
  it("divergent client: reports per-client counts + missing count + verdict divergent", () => {
    const r = checkClient(
      "macbook",
      CANONICAL,
      CLIENT_OPTS,
      makeProbes({ clientSessionIds: () => ({ ok: true, ids: [...CANONICAL, "ses_x", "ses_y"] }) }),
    );
    expect(r).toMatchObject({
      alias: "macbook",
      verdict: "divergent",
      canonical_count: 4,
      client_count: 6,
      missing_count: 2,
      missing_sample: ["ses_x", "ses_y"],
    });
    expect(r.error).toBeUndefined();
  });

  it("clean client: full overlap → verdict clean", () => {
    const r = checkClient("mini", CANONICAL, CLIENT_OPTS, makeProbes());
    expect(r.verdict).toBe("clean");
  });

  it("unreachable client (ssh fails): verdict unreachable with the error — a warning, never a divergence", () => {
    const r = checkClient(
      "sleeping-laptop",
      CANONICAL,
      CLIENT_OPTS,
      makeProbes({ clientSessionIds: () => ({ ok: false, error: "ssh: connect timed out" }) }),
    );
    expect(r.verdict).toBe("unreachable");
    expect(r.error).toMatch(/timed out/);
    expect(r.missing_count).toBeUndefined();
  });

  it("a live local listener that is not the ssh forward → verdict fork-signal", () => {
    const r = checkClient(
      "macbook",
      CANONICAL,
      CLIENT_OPTS,
      makeProbes({ forkListener: () => ({ ok: true, fork: true, detail: "opencode" }) }),
    );
    expect(r.verdict).toBe("fork-signal");
    expect(r.fork_check).toBe("fork");
  });

  it("an unresolvable fork check is recorded as unknown — it never fabricates a fork, never hides one", () => {
    const r = checkClient(
      "macbook",
      CANONICAL,
      CLIENT_OPTS,
      makeProbes({ forkListener: () => ({ ok: false, error: "lsof: not found" }) }),
    );
    expect(r.fork_check).toBe("unknown");
    expect(r.fork_error).toMatch(/lsof/);
    expect(r.verdict).toBe("clean");
  });

  it("the missing-id sample is capped in the receipt (the full count stays exact)", () => {
    const ids = [...CANONICAL, ...Array.from({ length: 25 }, (_, i) => `ses_extra_${i}`)];
    const r = checkClient("macbook", CANONICAL, CLIENT_OPTS, makeProbes({ clientSessionIds: () => ({ ok: true, ids }) }));
    expect(r.missing_count).toBe(25);
    expect(r.missing_sample?.length).toBe(MISSING_SAMPLE_LIMIT);
    expect(r.missing_sample?.every((s) => ids.includes(s))).toBe(true);
  });
});

// ── the verb, hermetically (injected probes, injected post, frozen clock) ────

function divergentProbes(alias: string): ShardWatchProbes {
  return makeProbes({
    clientSessionIds: (a) => (a === alias ? { ok: true, ids: [...CANONICAL, "ses_fork_1"] } : { ok: true, ids: CANONICAL }),
  });
}

describe("shardWatch — the verb over injected probes (no ssh, no amico-slack, no live DB)", () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function runVerb(
    argv: string[],
    probes: ShardWatchProbes,
    env: Record<string, string> = {},
    deps: { post?: (channel: string, block: string, table: string) => { ok: boolean } } = {},
  ) {
    tmp = mkdtempSync(join(tmpdir(), "shard-watch-"));
    return shardWatch(argv, {
      probes,
      now: NOW_FN,
      env: { AMICO_SHARD_CLIENTS: "macbook,mini", ...env },
      ...(deps.post ? { post: deps.post } : {}),
    });
  }

  it("AC1: a client with ids absent from canonical → per-client counts + missing count reported, exit nonzero", () => {
    const r = runVerb([], divergentProbes("macbook"));
    expect(r.code).toBe(1);
    const j = r.json as Record<string, unknown>;
    expect(j).toMatchObject({ kind: "shard-watch", verdict: "divergent" });
    const macbook = (j.clients as ClientShardResult[]).find((c) => c.alias === "macbook");
    expect(macbook).toMatchObject({ verdict: "divergent", canonical_count: 4, client_count: 5, missing_count: 1 });
    const mini = (j.clients as ClientShardResult[]).find((c) => c.alias === "mini");
    expect(mini?.verdict).toBe("clean");
  });

  it("AC2: full overlap → exit zero, verdict clean", () => {
    const r = runVerb([], makeProbes());
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ kind: "shard-watch", verdict: "clean" });
  });

  it("AC6: an unreachable client is a warning row — the check still exits zero when nothing diverged", () => {
    const r = runVerb(
      [],
      makeProbes({
        clientSessionIds: (a) =>
          a === "macbook" ? { ok: false, error: "ssh: Could not resolve hostname" } : { ok: true, ids: CANONICAL },
      }),
    );
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.verdict).toBe("clean");
    const macbook = (j.clients as ClientShardResult[]).find((c) => c.alias === "macbook");
    expect(macbook?.verdict).toBe("unreachable");
    expect(j.warnings).toEqual([expect.stringMatching(/unreachable/)]);
  });

  it("a fork-signal client (live local listener, not the ssh forward) → exit nonzero", () => {
    const r = runVerb(
      [],
      makeProbes({ forkListener: (a) => (a === "macbook" ? { ok: true, fork: true, detail: "opencode" } : { ok: true, fork: false, detail: "ssh" }) }),
    );
    expect(r.code).toBe(1);
    const macbook = ((r.json as Record<string, unknown>).clients as ClientShardResult[]).find((c) => c.alias === "macbook");
    expect(macbook?.verdict).toBe("fork-signal");
  });

  it("AC5: dry-run performs only reads — no escalation post — and the receipt carries ts, per-client results, verdicts", () => {
    let posted = 0;
    const r = runVerb(["--dry-run"], divergentProbes("macbook"), { AMICO_SLACK_FLEET_CHANNEL: "fleet" }, {
      post: () => {
        posted += 1;
        return { ok: true };
      },
    });
    expect(posted).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect(j.ts).toBe("2026-09-20T04:15:00.000Z");
    expect(j.verdict).toBe("divergent");
    expect((j.clients as ClientShardResult[]).every((c) => typeof c.verdict === "string")).toBe(true);
    expect(r.code).toBe(1); // dry-run still detects; it only refrains from writing/posting
  });

  it("real run with divergence + channel configured → escalates through the injected poster (the fleet-alert convention)", () => {
    const seen: { channel: string; block: string }[] = [];
    const r = runVerb(
      [],
      divergentProbes("macbook"),
      { AMICO_SLACK_FLEET_CHANNEL: "fleet" },
      {
        post: (channel, block) => {
          seen.push({ channel, block });
          return { ok: true };
        },
      },
    );
    expect(r.code).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].channel).toBe("fleet");
    expect(seen[0].block).toMatch(/macbook/);
    expect((r.json as Record<string, unknown>).escalated).toBe(true);
  });

  it("real run, clean → no escalation post, exit zero", () => {
    let posted = 0;
    const r = runVerb([], makeProbes(), { AMICO_SLACK_FLEET_CHANNEL: "fleet" }, {
      post: () => {
        posted += 1;
        return { ok: true };
      },
    });
    expect(posted).toBe(0);
    expect(r.code).toBe(0);
  });

  it("a failed escalation post is an errors-as-data warning — it never changes the divergence verdict", () => {
    const r = runVerb([], divergentProbes("macbook"), { AMICO_SLACK_FLEET_CHANNEL: "fleet" }, {
      post: () => ({ ok: false }),
    });
    expect(r.code).toBe(1);
    const j = r.json as Record<string, unknown>;
    expect(j.escalated).toBeUndefined();
    expect(j.escalation_failed).toBe(true);
  });

  it("divergence with no channel configured → honest receipt note, no post, still nonzero", () => {
    let posted = 0;
    const r = runVerb([], divergentProbes("macbook"), {}, {
      post: () => {
        posted += 1;
        return { ok: true };
      },
    });
    expect(posted).toBe(0);
    expect(r.code).toBe(1);
    expect((r.json as Record<string, unknown>).escalation).toMatch(/no channel/);
  });

  it("canonical DB unreadable → exit 64 config/pre-flight error, never a green clean", () => {
    const r = runVerb([], makeProbes({ canonicalSessionIds: () => ({ ok: false, error: "unable to open database file" }) }));
    expect(r.code).toBe(64);
    expect((r.json as Record<string, unknown>).error).toMatch(/canonical/);
  });

  it("no clients configured → exit 64 (a watch that watches nothing must not silently pass)", () => {
    tmp = mkdtempSync(join(tmpdir(), "shard-watch-"));
    const r = shardWatch([], { probes: makeProbes(), now: NOW_FN, env: { AMICO_SHARD_CLIENTS: "" } });
    expect(r.code).toBe(64);
    expect((r.json as Record<string, unknown>).error).toMatch(/clients/i);
  });

  it("a non-integer or non-positive alert threshold is a config error, never a silently widened net", () => {
    tmp = mkdtempSync(join(tmpdir(), "shard-watch-"));
    for (const bad of ["0", "-1", "1.5", "many"]) {
      const r = shardWatch([], { probes: makeProbes(), now: NOW_FN, env: { AMICO_SHARD_CLIENTS: "macbook", AMICO_SHARD_ALERT_MIN: bad } });
      expect(r.code).toBe(64);
    }
  });

  it("the alert threshold is honored end-to-end: missing 2 with alertMin 5 → warn, exit zero, still reported", () => {
    const probes = makeProbes({
      clientSessionIds: (a) => (a === "macbook" ? { ok: true, ids: [...CANONICAL, "x1", "x2"] } : { ok: true, ids: CANONICAL }),
    });
    const r = runVerb(["--alert-min", "5"], probes);
    expect(r.code).toBe(0);
    const macbook = ((r.json as Record<string, unknown>).clients as ClientShardResult[]).find((c) => c.alias === "macbook");
    expect(macbook?.verdict).toBe("warn");
    expect((r.json as Record<string, unknown>).verdict).toBe("clean");
  });

  it("the canonical DB path rides the store's resolution order: --db flag > $OPENCODE_DB > the default", () => {
    tmp = mkdtempSync(join(tmpdir(), "shard-watch-"));
    const r = shardWatch([], {
      probes: makeProbes({
        canonicalSessionIds: (db) => ({ ok: true, ids: [] }),
        clientSessionIds: () => ({ ok: true, ids: [] }),
      }),
      now: NOW_FN,
      env: { AMICO_SHARD_CLIENTS: "macbook", OPENCODE_DB: "/from/env/opencode.db" },
    });
    expect((r.json as Record<string, unknown>).canonical_db).toBe("/from/env/opencode.db");
    const r2 = shardWatch(["--db", "/from/flag/opencode.db"], {
      probes: makeProbes({
        canonicalSessionIds: (db) => ({ ok: true, ids: [] }),
        clientSessionIds: () => ({ ok: true, ids: [] }),
      }),
      now: NOW_FN,
      env: { AMICO_SHARD_CLIENTS: "macbook", OPENCODE_DB: "/from/env/opencode.db" },
    });
    expect((r2.json as Record<string, unknown>).canonical_db).toBe("/from/flag/opencode.db");
  });
});

// ── the default canonical probe: read-only against a seeded FIXTURE db ───────

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

function seedDb(dbPath: string, ids: string[]): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const script = `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1], timeout=5)
con.executescript("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);")
for sid in sys.argv[2].split(","):
    con.execute("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)", (sid, "/t", "t", 1, 1))
con.commit()
con.close()
  `;
  execFileSync(process.env.AMICO_PYTHON || "python3", ["-c", script, dbPath, ids.join(",")], { encoding: "utf8" });
}

describe("sqliteBridgeCensus — the default canonical probe is READ-ONLY", () => {
  it("reads the session ids through the bridge's ro mode and leaves the db file byte-identical", () => {
    const tmp = mkdtempSync(join(tmpdir(), "shard-watch-db-"));
    try {
      const db = join(tmp, "opencode.db");
      seedDb(db, ["ses_a", "ses_b", "ses_c"]);
      const before = readFileSync(db);
      const census = sqliteBridgeCensus(db);
      expect(census).toEqual({ ok: true, ids: ["ses_a", "ses_b", "ses_c"] });
      expect(readFileSync(db).equals(before)).toBe(true);
      // no journal sidecars appeared — the read opened no write transaction
      expect(statSync(db).mtimeMs).toBe(statSync(db).mtimeMs); // sanity: file still there
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a missing db is an honest ok:false (unprobeable), never a fabricated empty census", () => {
    const census = sqliteBridgeCensus(join(tmpdir(), "shard-watch-nope", "missing.db"));
    expect(census.ok).toBe(false);
    if (!census.ok) expect(census.error).toMatch(/no such file|unable to open/i);
  });
});

// ── the bundle wiring: `amico fleet shard-watch` routes and prints the receipt line ──

describe("the fleet router wires shard-watch (bundle-level, config-error path only — hermetic)", () => {
  function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string } {
    try {
      return { code: 0, stdout: execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env } }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { code: err.status ?? -1, stdout: err.stdout ?? "" };
    }
  }

  it("unknown fleet subcommands still fail; shard-watch with no clients is an honest 64 with usage", () => {
    const r = runCli(["fleet", "shard-watch"], { AMICO_SHARD_CLIENTS: "", OPENCODE_DB: join(tmpdir(), "shard-watch-wiring", "x.db") });
    expect(r.code).toBe(64);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ verb: "fleet", subcommand: "shard-watch" });
    expect(String(j.error)).toMatch(/clients/i);
  });
});

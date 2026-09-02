// `amico fleet digest` (unified-fleet spec slice 1, amicode#428) — the fourth rendering.
//
// The three properties this suite exists to defend:
//   1. THE DIGEST ALWAYS RENDERS. A down machine is a row ("✗"), an unconfigured machine
//      list is an honest "n/a" line, an empty registry is "0 live" — none of it is ever a
//      failed digest. A digest that dies when one machine sleeps is worse than no digest.
//   2. IT IS A PROJECTION. Sessions come from the registry via readAllRecords; the module
//      never recomputes state and never writes anything.
//   3. POSTING IS A SUBPROCESS CONTRACT. The amico-slack CLI does the posting; absent
//      from PATH → errors-as-data, never a crash; block posted + table failed → ok:true
//      with a warning (the block going out outranks the thread reply).
//
// HERMETIC BY CONSTRUCTION: every behavior test calls fleetDigest DIRECTLY with injected
// probe/post/now deps — never through the fleetVerb router (which takes no deps), so no
// test can ever reach a real ssh probe or the real amico-slack CLI. The router is covered
// by exactly one dry-run smoke.
// Run: pnpm --filter @amicode/amico-run test fleet_digest
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetVerb } from "../src/fleet_verb.js";
import {
  MIGRATION_DEBT,
  fleetDigest,
  formatAge,
  formatDigestBlock,
  formatDigestTable,
  parseVaultHealth,
  summarizeSessions,
  type DigestDeps,
  type DigestPoster,
  type DigestView,
  type MachineProbe,
  type MigrationDebtItem,
  type VaultHealth,
} from "../src/fleet_digest.js";
import { normalizeRecord, writeRecord, type FleetRecord, type FleetState } from "../src/fleet_registry.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-digest-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function record(session_id: string, state: FleetState, over: Partial<FleetRecord> = {}): FleetRecord {
  return normalizeRecord({
    session_id,
    state,
    started: "2026-08-18T08:00:00.000Z", // 4h before NOW
    pid: process.pid,
    host: "test-host",
    tokens: 1200,
    runtime: 90,
    current_step: "s1",
    profile: {
      name: "researcher",
      base: "executor",
      model: "anthropic/claude-opus-5",
      variant: "high",
      task_type: "plan",
      skills: ["amico-vault"],
      gates: ["schema-validate"],
      permissions: { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "none", task: "deny" },
    },
    ...over,
  });
}

function put(session_id: string, state: FleetState, over: Partial<FleetRecord> = {}): FleetRecord {
  const rec = record(session_id, state, over);
  writeRecord(root, rec);
  return rec;
}

/** Hermetic deps: no ssh, no amico-slack, frozen clock — the whole verb runs in-process.
 *  The vault probe defaults COHERENTLY with the machine probe: a machine the ssh probe
 *  saw as down is unprobeable (parked), everything else aligned — so existing fixtures
 *  keep their meaning and no test can ever reach a real `ssh` or `armonia-vault-status`. */
function hermetic(
  machines: Record<string, MachineProbe>,
  post?: DigestPoster,
  vaults?: Record<string, VaultHealth>,
  debt?: MigrationDebtItem[],
): DigestDeps {
  return {
    probe: (alias) => machines[alias] ?? { alias, ok: false, detail: "unknown alias" },
    vaultProbe: (alias) =>
      vaults?.[alias] ??
      (machines[alias] && !machines[alias].ok
        ? { alias, layout: "unprobeable", sync_state: "unknown", scheduler: "unknown", config: "unknown" }
        : { alias, layout: "aligned", sync_state: "no-sidecar", scheduler: "unknown", config: "unknown" }),
    ...(debt !== undefined ? { debt } : {}),
    post,
    now: () => NOW,
  };
}

function run(args: string[], deps: DigestDeps): { json: Record<string, any>; code: number } {
  return fleetDigest([...args, "--root", root], deps) as { json: Record<string, any>; code: number };
}

// ── the pure formatters ──────────────────────────────────────────────────────────

describe("formatAge", () => {
  it("renders sub-minute as now, minutes, hours+minutes, days+hours", () => {
    expect(formatAge(30_000)).toBe("now");
    expect(formatAge(12 * 60_000)).toBe("12m");
    expect(formatAge((4 * 60 + 12) * 60_000)).toBe("4h12m");
    expect(formatAge((50 * 60 + 2) * 60_000)).toBe("2d2h");
  });
});

describe("summarizeSessions", () => {
  it("counts by state, keeps live rows non-terminal, ages from started", () => {
    const s = summarizeSessions([record("s1", "running"), record("s2", "settled"), record("s3", "killed")], 0, NOW);
    expect(s.total).toBe(3);
    expect(s.byState.running).toBe(1);
    expect(s.byState.settled).toBe(1);
    expect(s.byState.killed).toBe(1);
    expect(s.live.map((r) => r.session_id)).toEqual(["s1", "s2"]); // killed is terminal
    expect(s.live[0].age).toBe("4h0m");
    expect(s.terminal).toBe(1);
  });
});

// ── the block (≤6 lines, distilled) ──────────────────────────────────────────────

describe("formatDigestBlock", () => {
  it("renders machines, sessions, and an optional jobs line in ≤6 lines", () => {
    const block = formatDigestBlock({
      date: "2026-08-18",
      machines: [
        { alias: "alpha", ok: true, detail: "host-a" },
        { alias: "beta", ok: false, detail: "ssh: timeout" },
      ],
      sessions: {
        total: 2,
        byState: { running: 1, settled: 1 },
        live: [
          { session_id: "s1", state: "running", host: "host-a", age: "1h" },
          { session_id: "s2", state: "settled", host: "host-a", age: "2h" },
        ],
        terminal: 0,
        unreadable: 0,
      },
      jobsLine: "all green (11/11)",
    });
    const lines = block.split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toBe("*Fleet — 2026-08-18*");
    expect(lines[1]).toBe("machines: alpha ✓ · beta ✗");
    expect(lines[2]).toBe("sessions: 2 live of 2 (running 1 · settled 1)");
    expect(lines[3]).toBe("jobs: all green (11/11)");
  });

  it("is honest when nothing is configured or populated", () => {
    const block = formatDigestBlock({
      date: "2026-08-18",
      machines: null,
      sessions: { total: 0, byState: {}, live: [], terminal: 0, unreadable: 0 },
    });
    expect(block).toContain("machines: n/a (not configured)");
    expect(block).toContain("sessions: 0 live (registry empty)");
  });
});

describe("formatDigestTable", () => {
  it("flags unreadable records — corruption is surfaced, never swallowed", () => {
    const table = formatDigestTable(
      {
        date: "2026-08-18",
        machines: null,
        sessions: { total: 0, byState: {}, live: [], terminal: 0, unreadable: 2 },
      },
      "/registry/root",
    );
    expect(table).toContain("⚠️ 2 unreadable record(s)");
  });
});

// ── the verb end-to-end (hermetic) ───────────────────────────────────────────────

describe("amico fleet digest — dry-run default", () => {
  it("defaults to dry-run: renders block + table, exit 0, posts nothing", () => {
    put("s1", "running");
    let posted = 0;
    const r = run([], hermetic({}, () => ({ ok: true, ts: "1.0", posted: ++posted } as any)));
    expect(r.code).toBe(0);
    expect(r.json.dry_run).toBe(true);
    expect(r.json.block).toContain("*Fleet — 2026-08-18*");
    expect(r.json.table).toContain("s1");
    expect(r.json.table).toContain("running");
    expect(posted).toBe(0);
  });

  it("degrade-graceful: a down machine is a row, never a failed digest", () => {
    const r = run(
      ["--machines", "alpha,beta"],
      hermetic({
        alpha: { alias: "alpha", ok: true, detail: "host-a" },
        beta: { alias: "beta", ok: false, detail: "ssh: connect timed out" },
      }),
    );
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.block).toContain("alpha ✓ · beta ✗");
    expect(r.json.table).toMatch(/beta\s+✗\s+ssh: connect timed out/);
  });

  it("unconfigured machines render n/a, not an error", () => {
    const r = run([], hermetic({}));
    expect(r.code).toBe(0);
    expect(r.json.block).toContain("machines: n/a (not configured)");
  });

  it("empty registry renders 0 live sessions honestly", () => {
    const r = run([], hermetic({}));
    expect(r.code).toBe(0);
    expect(r.json.block).toContain("sessions: 0 live (registry empty)");
    expect(r.json.table).toContain("0 records");
  });

  it("--jobs-line renders as the jobs line (the Notturno wrapper's injection point)", () => {
    const r = run(["--jobs-line", "10/11 green, eod-checkin failed"], hermetic({}));
    expect(r.json.block).toContain("jobs: 10/11 green, eod-checkin failed");
  });

  it("terminal records show in the counts; live rows carry age", () => {
    put("live-1", "running", { started: "2026-08-18T11:30:00.000Z" });
    put("dead-1", "killed");
    const r = run([], hermetic({}));
    expect(r.json.block).toContain("sessions: 1 live of 2 (running 1 · killed 1)");
    expect(r.json.table).toContain("live-1  running  test-host  30m");
    expect(r.json.table).toContain("killed 1");
  });
});

describe("amico fleet digest --post", () => {
  it("posts the block then the table as a thread reply", () => {
    put("s1", "running");
    const calls: Array<Record<string, string>> = [];
    const post: DigestPoster = (channel, block, table) => {
      calls.push({ channel, block, table });
      return { ok: true, ts: "1787000000.000100" };
    };
    const r = run(["--post", "#ops-fleet"], hermetic({}, post));
    expect(r.code).toBe(0);
    expect(r.json.posted).toBe(true);
    expect(r.json.ts).toBe("1787000000.000100");
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe("#ops-fleet");
    expect(calls[0].block).toContain("*Fleet — 2026-08-18*");
    expect(calls[0].table).toContain("s1");
  });

  it("a failed table post is a warning, not a failed digest (the block outranks the reply)", () => {
    const r = run(
      ["--post", "#ops-fleet"],
      hermetic({}, () => ({ ok: true, ts: "1.0", warnings: ["thread table not posted: boom"] })),
    );
    expect(r.code).toBe(0);
    expect(r.json.posted).toBe(true);
    expect((r.json.warnings as string[]).join("; ")).toContain("thread table not posted: boom");
  });

  it("poster failure → errors-as-data at exit 64, never a stack trace", () => {
    const r = run(["--post", "#ops-fleet"], hermetic({}, () => ({ ok: false, errors: ["amico-slack not found on PATH"] })));
    expect(r.code).toBe(64);
    expect(r.json.ok).toBe(false);
    expect((r.json.errors as string[])[0]).toContain("amico-slack not found");
  });

  it("--dry-run beats the resolved channel (explicit dry-run with --post)", () => {
    let posted = 0;
    const r = run(["--post", "#ops-fleet", "--dry-run"], hermetic({}, () => ({ ok: true, ts: "1.0", posted: ++posted } as any)));
    expect(r.code).toBe(0);
    expect(r.json.dry_run).toBe(true);
    expect(posted).toBe(0);
  });
});

// ── vault health + migration debt (M4: layout invariant, portability, drift) ─────

describe("parseVaultHealth — the vault-probe output contract (pure, no ssh)", () => {
  const out = (layout: string, sync: string, sched: string, cfg = "resolved") =>
    `LAYOUT:${layout}\nSYNC:${sync}\nSCHED:${sched}\nCONFIG:${cfg}\n`;

  it("reads all four fields from one probe invocation", () => {
    const vh = parseVaultHealth("alpha", out("aligned", "ok 2026-09-02 08:00 (2 mounts, 0 stale)", "loaded"));
    expect(vh).toEqual({
      alias: "alpha",
      layout: "aligned",
      sync_state: "ok 2026-09-02 08:00 (2 mounts, 0 stale)",
      scheduler: "loaded",
      config: "resolved",
    });
  });

  it("misaligned layout + no sidecar + written-only scheduler — every honest degraded value, none an error", () => {
    const vh = parseVaultHealth("beta", out("misaligned", "no-sidecar", "written-only"));
    expect(vh).toEqual({ alias: "beta", layout: "misaligned", sync_state: "no-sidecar", scheduler: "written-only", config: "resolved" });
  });

  it("a machine with no scheduler manager reads unknown, never a guessed state", () => {
    expect(parseVaultHealth("gamma", out("aligned", "no-sidecar", "unknown")).scheduler).toBe("unknown");
  });

  it("config resolution: the found incident renders foreign-home, never a guessed pass", () => {
    // a /Users/ config string surviving on a non-Mac home — the 2026-09-02 incident
    expect(parseVaultHealth("zeta", out("aligned", "no-sidecar", "loaded", "foreign-home")).config).toBe("foreign-home");
    expect(parseVaultHealth("eta", out("aligned", "no-sidecar", "loaded", "absent")).config).toBe("absent");
    expect(parseVaultHealth("theta", out("aligned", "no-sidecar", "loaded", "")).config).toBe("unknown");
  });

  it("garbled or empty probe output → unprobeable, never a fake pass", () => {
    const vh = parseVaultHealth("delta", "");
    expect(vh).toEqual({ alias: "delta", layout: "unprobeable", sync_state: "unknown", scheduler: "unknown", config: "unknown" });
    expect(parseVaultHealth("eps", "total nonsense from a broken shell").layout).toBe("unprobeable");
  });
});

describe("MIGRATION_DEBT — the seeded migration-debt ledger (M4)", () => {
  it("holds the real current debt, all open, partitura owned by content resolution", () => {
    expect(MIGRATION_DEBT.map((d) => d.id)).toEqual(["partitura-archived", "compat-symlinks", "sync-script-rollout"]);
    for (const d of MIGRATION_DEBT) {
      expect(d.state).toBe("open");
      expect(d.label.length).toBeGreaterThan(0);
    }
    expect(MIGRATION_DEBT.find((d) => d.id === "partitura-archived")?.owner).toBe("content resolution");
  });
});

describe("formatDigestBlock — the vaults line (M4)", () => {
  const vh = (alias: string, layout: VaultHealth["layout"]): VaultHealth => ({
    alias,
    layout,
    config: "resolved",
    sync_state: "no-sidecar",
    scheduler: "unknown",
  });
  const emptySessions: DigestView["sessions"] = { total: 0, byState: {}, live: [], terminal: 0, unreadable: 0 };

  it("renders layout counts and the open-debt count in one vaults line", () => {
    const block = formatDigestBlock({
      date: "2026-08-18",
      machines: [],
      vaults: [vh("alpha", "aligned"), vh("beta", "aligned"), vh("gamma", "misaligned"), vh("delta", "unprobeable")],
      sessions: { ...emptySessions },
      debt: [
        { id: "partitura-archived", label: "conflicted clone parked in vaults-archive", state: "open", owner: "content resolution" },
        { id: "done-already", label: "resolved", state: "closed", owner: "x" },
      ],
    });
    expect(block).toContain("vaults: 2 aligned · 1 misaligned · 1 unverified · debt 1 open");
    expect(block.split("\n").length).toBeLessThanOrEqual(6);
  });

  it("omits zero-count layout segments; closed debt items do not count", () => {
    const block = formatDigestBlock({
      date: "2026-08-18",
      machines: [],
      vaults: [vh("alpha", "aligned")],
      sessions: { ...emptySessions },
      debt: [{ id: "done-already", label: "resolved", state: "closed", owner: "x" }],
    });
    expect(block).toContain("vaults: 1 aligned · debt 0 open");
    expect(block).not.toContain("misaligned");
    expect(block).not.toContain("unverified");
  });

  it("an unconfigured machine list renders an honest vaults n/a line", () => {
    const block = formatDigestBlock({
      date: "2026-08-18",
      machines: null,
      vaults: null,
      sessions: { ...emptySessions },
    });
    expect(block).toContain("vaults: n/a (not configured)");
  });

  it("a view without vault data renders no vaults line (back-compat)", () => {
    const block = formatDigestBlock({ date: "2026-08-18", machines: null, sessions: { ...emptySessions } });
    expect(block).not.toContain("vaults:");
  });
});

describe("formatDigestTable — vault-health rows + the migration-debt checklist (M4)", () => {
  const emptySessions: DigestView["sessions"] = { total: 0, byState: {}, live: [], terminal: 0, unreadable: 0 };

  it("renders per-machine layout/sync/scheduler rows, the parked state verbatim, and open debt rows only", () => {
    const table = formatDigestTable(
      {
        date: "2026-08-18",
        machines: [],
        vaults: [
          { alias: "alpha", layout: "aligned", sync_state: "ok 2026-09-02 08:00", scheduler: "loaded", config: "resolved" },
          { alias: "beta", layout: "misaligned", sync_state: "no-sidecar", scheduler: "written-only", config: "resolved" },
          { alias: "gamma", layout: "unprobeable", sync_state: "unknown", scheduler: "unknown", config: "unknown" },
        ],
        sessions: { ...emptySessions },
        debt: [
          { id: "partitura-archived", label: "conflicted clone parked in vaults-archive", state: "open", owner: "content resolution" },
          { id: "done-already", label: "resolved", state: "closed", owner: "x" },
        ],
      },
      "/registry/root",
    );
    expect(table).toContain("*Vaults*");
    expect(table).toMatch(/alpha\s+layout aligned\s+· sync ok 2026-09-02 08:00\s+· scheduler loaded/);
    expect(table).toMatch(/beta\s+layout misaligned\s+· sync no-sidecar\s+· scheduler written-only/);
    // parked: an explicit state with the named re-check trigger — never a fake pass
    expect(table).toMatch(/gamma\s+layout unverified \(parked; owner: fleet ritual\)/);
    expect(table).toContain("*Migration debt*");
    expect(table).toMatch(/partitura-archived\s+open — conflicted clone parked in vaults-archive \(owner: content resolution\)/);
    // items render UNTIL closed — a closed item stops rendering
    expect(table).not.toContain("done-already");
  });

  it("the debt checklist renders even with no machines configured — debt is fleet state, not per-machine", () => {
    const table = formatDigestTable(
      { date: "2026-08-18", machines: null, vaults: null, sessions: { ...emptySessions } },
      "/registry/root",
    );
    expect(table).toContain("*Vaults*");
    expect(table).toContain("(not configured — pass --machines or set AMICO_FLEET_MACHINES)");
    expect(table).toContain("*Migration debt*");
  });

  it("a view without vault data renders no Vaults or debt sections (back-compat)", () => {
    const table = formatDigestTable(
      { date: "2026-08-18", machines: null, sessions: { ...emptySessions } },
      "/registry/root",
    );
    expect(table).not.toContain("*Vaults*");
    expect(table).not.toContain("*Migration debt*");
  });
});

describe("amico fleet digest — vault-health lines (hermetic, M4)", () => {
  const up = (alias: string, host: string): MachineProbe => ({ alias, ok: true, detail: host });
  const aligned = (alias: string): VaultHealth => ({ alias, layout: "aligned", sync_state: "ok", scheduler: "loaded", config: "resolved" });

  it("probes vault health per configured machine; all aligned → vaults line + debt rows, ok, exit 0", () => {
    const r = run(
      ["--machines", "alpha,beta"],
      hermetic(
        { alpha: up("alpha", "host-a"), beta: up("beta", "host-b") },
        undefined,
        { alpha: aligned("alpha"), beta: aligned("beta") },
      ),
    );
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.block).toContain("vaults: 2 aligned · debt 3 open");
    expect(r.json.table).toMatch(/alpha\s+layout aligned/);
    expect(r.json.table).toContain("partitura-archived");
    expect(r.json.vaults).toEqual([aligned("alpha"), aligned("beta")]);
    expect((r.json.migration_debt as MigrationDebtItem[]).every((d) => d.state === "open")).toBe(true);
  });

  it("a misaligned machine FAILS the digest (layout invariant), yet the digest still renders — errors-as-data", () => {
    const r = run(
      ["--machines", "alpha,beta"],
      hermetic(
        { alpha: up("alpha", "host-a"), beta: up("beta", "host-b") },
        undefined,
        {
          alpha: aligned("alpha"),
          beta: { alias: "beta", layout: "misaligned", sync_state: "no-sidecar", scheduler: "written-only", config: "resolved" },
        },
      ),
    );
    expect(r.code).toBe(64);
    expect(r.json.ok).toBe(false);
    expect((r.json.errors as string[]).join(" ")).toMatch(/beta/);
    expect((r.json.errors as string[]).join(" ")).toMatch(/misaligned/);
    // always-renders: the block and table still come back
    expect(r.json.block).toContain("vaults: 1 aligned · 1 misaligned");
    expect(r.json.table).toMatch(/beta\s+layout misaligned/);
  });

  it("a down machine is parked with the fleet-ritual trigger — a row, never a failed digest, never a fake pass", () => {
    const r = run(
      ["--machines", "alpha,gamma"],
      hermetic({
        alpha: up("alpha", "host-a"),
        gamma: { alias: "gamma", ok: false, detail: "ssh: connect timed out" },
      }), // the hermetic default derives: gamma down → vault unprobeable (parked)
    );
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.block).toContain("vaults: 1 aligned · 1 unverified · debt 3 open");
    expect(r.json.table).toContain("unverified (parked; owner: fleet ritual)");
  });

  it("an injected debt ledger with a closed item counts only the open ones and stops rendering the closed row", () => {
    const debt: MigrationDebtItem[] = [
      { id: "partitura-archived", label: "conflicted clone parked in vaults-archive", state: "closed", owner: "content resolution" },
      { id: "compat-symlinks", label: "removal gated on confirmation", state: "open", owner: "Aaron's no-session-broke confirmation" },
      { id: "sync-script-rollout", label: "new sidecar script deploys fleet-wide post-merge", state: "open", owner: "post-merge deploy" },
    ];
    const r = run(
      ["--machines", "alpha"],
      hermetic({ alpha: up("alpha", "host-a") }, undefined, { alpha: aligned("alpha") }, debt),
    );
    expect(r.json.block).toContain("vaults: 1 aligned · debt 2 open");
    expect(r.json.table).not.toContain("partitura-archived");
    expect(r.json.table).toContain("compat-symlinks");
  });

  it("no machines configured → honest vaults n/a line in the block, debt checklist still in the table", () => {
    const r = run([], hermetic({}));
    expect(r.code).toBe(0);
    expect(r.json.block).toContain("vaults: n/a (not configured)");
    expect(r.json.table).toContain("*Migration debt*");
  });
});

// ── the router + the topology invariant ──────────────────────────────────────────

describe("the fleetVerb router", () => {
  it("routes `fleet digest` (dry-run smoke — no machines, no post, so nothing impure)", () => {
    const r = fleetVerb(["digest", "--root", root]) as { json: Record<string, any>; code: number };
    expect(r.code).toBe(0);
    expect(r.json.subcommand).toBe("digest");
    expect(r.json.dry_run).toBe(true);
  });
});

describe("no topology in code (spec invariant)", () => {
  it("the module source names no channels and no hosts (word-boundary match)", () => {
    const src = readFileSync(new URL("../src/fleet_digest.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/#fleet|#amico|#general|#amicode/);
    expect(src).not.toMatch(/\b(mini|macbook|erlich)\b/);
  });
});

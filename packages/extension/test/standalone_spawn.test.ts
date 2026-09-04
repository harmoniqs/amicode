import { describe, it, expect } from "vitest";
import {
  isDbMigrationCrash,
  spawnFailureNotice,
  ReofferBackoff,
  OfferGate,
  FleetPollGuard,
  journalSelfHeal,
  goStandaloneSpawn,
  type StandaloneSpawnDeps,
  KNOWN_DRIFTED_MIGRATION_IDS,
  localDbPath,
  REOFFER_BASE_MS,
  REOFFER_CEILING_MS,
} from "../src/standalone_spawn";

// ============================================================================
// #781 — Go-Standalone spawn hardening: never park the window on a failed
// spawn. The 2026-09-03 incident: the vendored binary crashed on a drifted
// local DB (`duplicate column name: directories`), the attach poll had
// already been cleared, and the window was dead until reload — the failure
// surfaced as a generic "failed to start within 30s".
// ============================================================================

describe("isDbMigrationCrash (#781 AC3)", () => {
  it("matches the known local-DB migration crash signature", () => {
    expect(isDbMigrationCrash("sqlite: duplicate column name: directories")).toBe(true);
    expect(isDbMigrationCrash("opencode exited code=1\ncolumns... Duplicate Column Name: directories")).toBe(true);
  });

  it("does not match unrelated spawn failures", () => {
    expect(isDbMigrationCrash("opencode failed to start within 30s")).toBe(false);
    expect(isDbMigrationCrash("spawn ENOENT")).toBe(false);
    expect(isDbMigrationCrash("")).toBe(false);
  });
});

describe("spawnFailureNotice (#781 AC3)", () => {
  it("surfaces the actual cause and the self-heal remediation for the DB crash", () => {
    const notice = spawnFailureNotice(
      "opencode failed to start within 30s — check the output channel",
      "[opencode!] Error: duplicate column name: directories",
    );
    expect(notice.dbCrash).toBe(true);
    expect(notice.title).toMatch(/duplicate column name/i);
    expect(notice.title).toMatch(/schema migration/i);
    expect(notice.actions).toContain("Self-heal local DB…");
  });

  it("keeps the generic message for non-matching failures", () => {
    const notice = spawnFailureNotice("opencode failed to start within 30s");
    expect(notice.dbCrash).toBe(false);
    expect(notice.title).toContain("go standalone failed");
    expect(notice.actions).not.toContain("Self-heal local DB…");
  });

  it("detects the signature from spawn output alone", () => {
    const notice = spawnFailureNotice("opencode failed to start within 30s", "duplicate column name: directories");
    expect(notice.dbCrash).toBe(true);
  });
});

describe("ReofferBackoff (#781 AC2 — re-offer with backoff, reset on attach)", () => {
  it("is due immediately before any offer", () => {
    const bo = new ReofferBackoff(() => 1000);
    expect(bo.due()).toBe(true);
  });

  it("is not due right after an offer, but becomes due after the base delay", () => {
    let t = 1000;
    const bo = new ReofferBackoff(() => t);
    bo.recordOffer();
    t += REOFFER_BASE_MS - 1;
    expect(bo.due()).toBe(false);
    t += 1;
    expect(bo.due()).toBe(true);
  });

  it("backs off exponentially between offers", () => {
    let t = 0;
    const bo = new ReofferBackoff(() => t);
    bo.recordOffer(); // offer 1
    t += REOFFER_BASE_MS - 1;
    expect(bo.due()).toBe(false);
    bo.recordOffer(); // offer 2 — delay now 2×
    t += 2 * REOFFER_BASE_MS - 1;
    expect(bo.due()).toBe(false);
    bo.recordOffer(); // offer 3 — delay now 4×
    t += 4 * REOFFER_BASE_MS - 1;
    expect(bo.due()).toBe(false);
    t += 1;
    expect(bo.due()).toBe(true);
  });

  it("caps the backoff at the ceiling (5 min)", () => {
    let t = 0;
    const bo = new ReofferBackoff(() => t);
    for (let i = 0; i < 20; i++) bo.recordOffer();
    t += REOFFER_CEILING_MS - 1;
    expect(bo.due()).toBe(false);
    t += 1;
    expect(bo.due()).toBe(true);
  });

  it("resets on a successful attach — due again immediately, schedule restarts at base", () => {
    let t = 0;
    const bo = new ReofferBackoff(() => t);
    bo.recordOffer();
    bo.recordOffer();
    bo.recordOffer();
    bo.reset();
    expect(bo.due()).toBe(true);
    bo.recordOffer();
    t += REOFFER_BASE_MS - 1;
    expect(bo.due()).toBe(false);
    t += 1;
    expect(bo.due()).toBe(true);
  });
});

describe("OfferGate (#781 AC4 — no double banners)", () => {
  it("admits one offer and blocks the rest until it ends", () => {
    const gate = new OfferGate();
    expect(gate.tryBegin()).toBe(true);
    expect(gate.tryBegin()).toBe(false);
    gate.end();
    expect(gate.tryBegin()).toBe(true);
  });
});

describe("FleetPollGuard (#781 AC1 + AC4 — poll lifetime vs spawn)", () => {
  it("stops the poll exactly once when the local server is healthy", () => {
    let stops = 0;
    const guard = new FleetPollGuard({ stopPoll: () => stops++, resumePoll: () => {} });
    guard.onLocalHealthy();
    guard.onLocalHealthy();
    expect(stops).toBe(1);
  });

  it("never stops the poll before the spawn — stop only happens on healthy", () => {
    let stops = 0;
    let resumes = 0;
    const guard = new FleetPollGuard({ stopPoll: () => stops++, resumePoll: () => resumes++ });
    guard.onSpawnFailure();
    expect(stops).toBe(0);
    expect(resumes).toBe(1);
  });

  it("resumes polling after a failure that follows a prior successful stop", () => {
    let stops = 0;
    let resumes = 0;
    const guard = new FleetPollGuard({ stopPoll: () => stops++, resumePoll: () => resumes++ });
    guard.onLocalHealthy();
    expect(stops).toBe(1);
    guard.onSpawnFailure();
    expect(resumes).toBe(1);
    guard.onLocalHealthy();
    expect(stops).toBe(2);
  });

  it("failure after failure keeps requesting a poll (idempotent resume)", () => {
    let resumes = 0;
    const guard = new FleetPollGuard({ stopPoll: () => {}, resumePoll: () => resumes++ });
    guard.onSpawnFailure();
    guard.onSpawnFailure();
    expect(resumes).toBe(2);
  });
});

describe("localDbPath (#781 AC3)", () => {
  it("points at the opencode data dir's session DB", () => {
    expect(localDbPath()).toMatch(/opencode[\\/]opencode\.db$/);
  });
});

describe("goStandaloneSpawn (#781 wiring — poll lifetime, failure notice, confirmed heal)", () => {
  const baseDeps = (over: Partial<StandaloneSpawnDeps> = {}): StandaloneSpawnDeps => ({
    poll: { stopPoll: () => {}, resumePoll: () => {} },
    startServer: async () => {},
    notice: async () => undefined,
    confirmHeal: async () => false,
    heal: async () => ({ ok: true, steps: [] }),
    onHealResult: () => {},
    ...over,
  });
  const dbCrashError = () => {
    const e = new Error("opencode failed to start within 30s — check the output channel") as Error & { spawnOutput?: string };
    e.spawnOutput = "opencode! Error: duplicate column name: directories";
    return e;
  };

  it("AC1/AC4: success stops the poll exactly once and never resumes it", async () => {
    let stops = 0;
    let resumes = 0;
    const result = await goStandaloneSpawn(
      baseDeps({ poll: { stopPoll: () => stops++, resumePoll: () => resumes++ } }),
    );
    expect(result.ok).toBe(true);
    expect(stops).toBe(1);
    expect(resumes).toBe(0);
  });

  it("AC1: the poll is still running while the spawn is in flight — stop happens only after health", async () => {
    let stops = 0;
    let stopDuringSpawn: number | undefined;
    const result = await goStandaloneSpawn(
      baseDeps({
        poll: {
          stopPoll: () => stops++,
          resumePoll: () => {},
        },
        startServer: async () => {
          stopDuringSpawn = stops; // the old bug cleared the poll BEFORE this line
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(stopDuringSpawn).toBe(0); // nothing was stopped while spawning
    expect(stops).toBe(1); // and exactly once, after health
  });

  it("AC1/AC3: failure resumes the poll and surfaces the DB-crash cause, not the generic timeout", async () => {
    let stops = 0;
    let resumes = 0;
    let shown: string | undefined;
    const result = await goStandaloneSpawn(
      baseDeps({
        poll: { stopPoll: () => stops++, resumePoll: () => resumes++ },
        startServer: async () => {
          throw dbCrashError();
        },
        notice: async (n) => {
          shown = n.title;
          return undefined;
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(resumes).toBe(1);
    expect(stops).toBe(0);
    expect(shown).toMatch(/duplicate column name/i);
    expect(result.notice?.dbCrash).toBe(true);
  });

  it("AC3: picking the heal action and confirming runs the self-heal and reports the result", async () => {
    const healed: boolean[] = [];
    const result = await goStandaloneSpawn(
      baseDeps({
        startServer: async () => {
          throw dbCrashError();
        },
        notice: async () => "Self-heal local DB…",
        confirmHeal: async () => true,
        heal: async () => {
          healed.push(true);
          return { ok: true, steps: [{ step: "insert", ok: true, detail: "journal row present" }] };
        },
        onHealResult: (r) => healed.push(r.ok),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.heal?.ok).toBe(true);
    expect(healed).toEqual([true, true]);
  });

  it("CONSTRAINT: the self-heal NEVER runs without user confirmation", async () => {
    let healRan = false;
    const result = await goStandaloneSpawn(
      baseDeps({
        startServer: async () => {
          throw dbCrashError();
        },
        notice: async () => "Self-heal local DB…",
        confirmHeal: async () => false,
        heal: async () => {
          healRan = true;
          return { ok: true, steps: [] };
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.heal).toBeUndefined();
    expect(healRan).toBe(false);
  });

  it("CONSTRAINT: dismissing the failure notice never runs the self-heal", async () => {
    let healRan = false;
    let confirmAsked = false;
    await goStandaloneSpawn(
      baseDeps({
        startServer: async () => {
          throw dbCrashError();
        },
        notice: async () => undefined,
        confirmHeal: async () => {
          confirmAsked = true;
          return true;
        },
        heal: async () => {
          healRan = true;
          return { ok: true, steps: [] };
        },
      }),
    );
    expect(confirmAsked).toBe(false);
    expect(healRan).toBe(false);
  });

  it("AC3: a generic failure keeps the existing error surface — no heal flow", async () => {
    let confirmAsked = false;
    const result = await goStandaloneSpawn(
      baseDeps({
        startServer: async () => {
          throw new Error("spawn ENOENT");
        },
        notice: async () => "Show log",
        confirmHeal: async () => {
          confirmAsked = true;
          return true;
        },
        heal: async () => ({ ok: true, steps: [] }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.notice?.dbCrash).toBe(false);
    expect(result.notice?.title).toContain("go standalone failed — spawn ENOENT");
    expect(confirmAsked).toBe(false);
  });
});

describe("journalSelfHeal (#781 AC3 — the Aug-30 medicine, confirmed + backed up)", () => {
  const fsDeps = () => ({ existsSync: () => true, copyFileSync: () => {} });
  const okRun = (expectedCmd: (cmd: string[]) => boolean) => async (cmd: string[]) => {
    if (!expectedCmd(cmd)) return { code: 1, stdout: "", stderr: "unexpected command" };
    return { code: 0, stdout: "1|1", stderr: "" };
  };

  it("backs up the DB, verifies the drift, and inserts the missing journal row", async () => {
    const copies: Array<[string, string]> = [];
    const cmds: string[][] = [];
    const result = await journalSelfHeal({
      dbPath: "/data/opencode.db",
      run: async (cmd) => {
        cmds.push(cmd);
        return { code: 0, stdout: "1|1", stderr: "" };
      },
      fs: { existsSync: () => true, copyFileSync: (src, dest) => copies.push([src, dest]) },
      now: () => 1700000000000,
    });
    expect(result.ok).toBe(true);
    expect(copies).toHaveLength(1);
    expect(copies[0]![0]).toBe("/data/opencode.db");
    expect(copies[0]![1]).toMatch(/^\/data\/opencode\.db\.bak-/);
    const insert = cmds.find((c) => c.some((a) => a.includes("INSERT OR IGNORE")));
    expect(insert).toBeDefined();
    expect(insert!.join(" ")).toContain(KNOWN_DRIFTED_MIGRATION_IDS[0]!);
    expect(insert!.join(" ")).toContain("migration");
  });

  it("refuses to fake the journal row when the schema does not show the migration applied", async () => {
    const result = await journalSelfHeal({
      dbPath: "/data/opencode.db",
      run: async () => ({ code: 0, stdout: "1|0", stderr: "" }),
      fs: fsDeps(),
    });
    expect(result.ok).toBe(false);
    expect(result.steps.some((s) => !s.ok && /refus/i.test(s.detail))).toBe(true);
  });

  it("reports honestly when the journal table is missing", async () => {
    const result = await journalSelfHeal({
      dbPath: "/data/opencode.db",
      run: async () => ({ code: 0, stdout: "0|1", stderr: "" }),
      fs: fsDeps(),
    });
    expect(result.ok).toBe(false);
    expect(result.steps.some((s) => !s.ok && /journal table/i.test(s.detail))).toBe(true);
  });

  it("fails when the local DB does not exist — nothing is written", async () => {
    const result = await journalSelfHeal({
      dbPath: "/data/opencode.db",
      run: async () => ({ code: 0, stdout: "1|1", stderr: "" }),
      fs: { existsSync: () => false, copyFileSync: () => {} },
    });
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.ok).toBe(false);
    expect(result.steps[0]!.detail).toMatch(/not found/);
  });

  it("propagates sqlite3 failures honestly", async () => {
    const result = await journalSelfHeal({
      dbPath: "/data/opencode.db",
      run: async () => ({ code: 127, stdout: "", stderr: "sqlite3: command not found" }),
      fs: fsDeps(),
    });
    expect(result.ok).toBe(false);
    expect(result.steps.some((s) => !s.ok)).toBe(true);
  });

  it("continues past journal ids already present (INSERT OR IGNORE is idempotent)", async () => {
    const result = await journalSelfHeal({
      dbPath: "/data/opencode.db",
      run: async () => ({ code: 0, stdout: "1|1", stderr: "" }),
      fs: fsDeps(),
      migrationIds: ["20260828201050_normal_stryfe"],
    });
    expect(result.ok).toBe(true);
  });
});

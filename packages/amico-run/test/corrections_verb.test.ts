// `amico corrections scan` — issue #1677: session-correction mining into
// skills-integrity findings. Pure core (markers, gates, builders, renders)
// unit-tested against src; the scan flow runs against SEEDED COPY databases
// in temp dirs with an INJECTED jev seam (hermetic — no network, no key,
// never the live chat DB or the live vault); the CLI dispatch runs through
// dist/amico.js with AMICO_JEV_DISABLED (the fail-open path).
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clipBytes,
  clusterKey,
  correctionsQuestions,
  correctionsScan,
  correctionsVerb,
  correctionsWatermarkFile,
  DEFAULT_SCAN_DAYS,
  effectiveSinceMs,
  filingAdmits,
  findExistingScanFinding,
  isCorrectionCandidate,
  pingWorthy,
  readWatermarkMs,
  renderDigestSection,
  renderFinding,
  renderUpdate,
  severityOf,
  type AdmittedCorrection,
  type CorrectionCandidate,
} from "../src/corrections_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";

const now = Date.now();
const min = (n: number) => now - n * 60_000;

// ── AC: the pre-filter owns recall (pure) ─────────────────────────────────────

describe("the deterministic marker pre-filter", () => {
  it("matches real correction phrasings", () => {
    expect(isCorrectionCandidate("no — the channel clock is 4 ns, use the grid")).toBe(true);
    expect(isCorrectionCandidate("that's not what I asked for")).toBe(true);
    expect(isCorrectionCandidate("that's wrong, stop re-running the sweep")).toBe(true);
    expect(isCorrectionCandidate("you're misunderstanding the routing, we agreed on plan B")).toBe(true);
    expect(isCorrectionCandidate("I said dt=4, not 1")).toBe(true);
    expect(isCorrectionCandidate("Actually, I meant the Fock basis instead")).toBe(true);
  });

  it("does not match fresh instructions, praise, or questions", () => {
    expect(isCorrectionCandidate("thanks, looks great!")).toBe(false);
    expect(isCorrectionCandidate("what about trying a 10 ns pulse?")).toBe(false);
    expect(isCorrectionCandidate("please run the sweep next")).toBe(false);
    expect(isCorrectionCandidate("here are the numbers: 1.2, 3.4")).toBe(false);
  });
});

// ── AC: the state fold stays under the Jev 4096-byte cap ──────────────────────

describe("the questions builder + state fold", () => {
  const base: CorrectionCandidate = {
    messageId: "m1",
    sessionId: "ses_a",
    sessionTitle: "pasqal campaign",
    timeCreated: now,
    userText: "no — wrong grid",
    precedingAssistantText: "running with dt=1",
  };

  it("builds the three questions (noul + kind + severity) with closed criteria", () => {
    const { questions } = correctionsQuestions(base);
    expect(questions.correction?.type).toBe("noul");
    expect(questions.correction?.criteria.true).toMatch(/pushing back/);
    expect(questions.kind?.type).toBe("choice");
    expect(Object.keys(questions.kind!.criteria).sort()).toEqual(["behavior-gap", "not-a-correction", "skill-drift", "skill-gap"]);
    expect(questions.severity?.type).toBe("choice");
    expect(Object.keys(questions.severity!.criteria).sort()).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("keeps the state fold under 4096 bytes even with huge inputs (multibyte-safe)", () => {
    const { state } = correctionsQuestions({
      ...base,
      sessionTitle: "α".repeat(400),
      userText: "β".repeat(6000),
      precedingAssistantText: "γ".repeat(8000),
    });
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(clipBytes("α".repeat(100), 10), "utf8")).toBeLessThanOrEqual(10);
  });
});

// ── AC: the calibrated filing gate ────────────────────────────────────────────

describe("the filing gate + severity ladder", () => {
  it("admits kind-carrying corrections at ≥ 0.90 corroborated by noul ≥ 0.5", () => {
    expect(filingAdmits("behavior-gap", 0.92, 0.8)).toBe(true);
    expect(filingAdmits("skill-drift", 0.99, 0.99)).toBe(true);
    expect(filingAdmits("skill-gap", 0.95, 0.5)).toBe(true);
  });

  it("never files below threshold, without corroboration, without a kind, or not-a-correction", () => {
    expect(filingAdmits("behavior-gap", 0.89, 0.9)).toBe(false);
    expect(filingAdmits("skill-drift", 0.95, 0.4)).toBe(false);
    expect(filingAdmits(undefined, 1, 1)).toBe(false);
    expect(filingAdmits("not-a-correction", 0.99, 0.9)).toBe(false);
    expect(filingAdmits("made-up-kind", 0.99, 0.9)).toBe(false);
  });

  it("maps severities onto the P-ladder and gates the ping on P0/P1", () => {
    expect(severityOf("p0")).toBe("P0");
    expect(severityOf("P1")).toBe("P1");
    expect(severityOf(undefined)).toBe("P2");
    expect(severityOf("bogus")).toBe("P2");
    expect(pingWorthy("P0")).toBe(true);
    expect(pingWorthy("P1")).toBe(true);
    expect(pingWorthy("P2")).toBe(false);
    expect(pingWorthy("P3")).toBe(false);
  });
});

// ── AC: the watermark window logic ───────────────────────────────────────────

describe("the pass watermark", () => {
  const cutoff = now - DEFAULT_SCAN_DAYS * 86_400_000;
  it("narrows the default window to the watermark", () => {
    expect(effectiveSinceMs(now, 7, false, cutoff + 1000)).toBe(cutoff + 1000);
  });
  it("an explicit --days forces the full window (backfill)", () => {
    expect(effectiveSinceMs(now, 30, true, cutoff + 1000)).toBe(now - 30 * 86_400_000);
  });
  it("no watermark → the plain --days cutoff", () => {
    expect(effectiveSinceMs(now, 7, false, undefined)).toBe(cutoff);
  });
});

// ── AC: findings render per the skills-integrity TEMPLATE shapes ─────────────

const cand = (over: Partial<CorrectionCandidate> = {}): CorrectionCandidate => ({
  messageId: `m${Math.random().toString(36).slice(2, 8)}`,
  sessionId: "ses_a",
  sessionTitle: "pasqal gate autoresearch",
  timeCreated: min(30),
  userText: "no — the channel clock is 4 ns, use the grid",
  precedingAssistantText: "emitting pulse.toml at 1 ns samples",
  ...over,
});

const admitted = (over: Partial<AdmittedCorrection> = {}, c?: CorrectionCandidate): AdmittedCorrection => ({
  candidate: c ?? cand(),
  kind: "skill-drift",
  severity: "P2",
  kindConfidence: 0.93,
  noul: 0.8,
  ...over,
});

describe("finding rendering (TEMPLATE shapes)", () => {
  it("renders skill-drift as a skill-finding with the full frontmatter", () => {
    const { filename, content } = renderFinding([admitted()], "2026-10-02T00:00:00Z", 1);
    expect(filename).toMatch(/^finding-\d{4}-\d{2}-\d{2}-cs1-/);
    expect(content).toContain("type: skill-finding");
    expect(content).toContain("finding_id: CS-1");
    expect(content).toContain("severity: P2");
    expect(content).toContain("status: open");
    expect(content).toContain('session_id: "ses_a"');
    expect(content).toContain("correction_kind: skill-drift");
    expect(content).toContain("corrections_scan: true");
    expect(content).toContain("no — the channel clock is 4 ns");
  });

  it("renders gaps as skill-proposals with the occurrences as evidence", () => {
    const a1 = admitted({ kind: "behavior-gap", severity: "P1" }, cand({ messageId: "m1" }));
    const a2 = admitted({ kind: "behavior-gap", severity: "P1" }, cand({ messageId: "m2", userText: "that's wrong again, stop re-running the sweep" }));
    const { filename, content } = renderFinding([a1, a2], "2026-10-02T00:00:00Z", 2);
    expect(filename).toMatch(/^proposal-\d{4}-\d{2}-\d{2}-cs2-/);
    expect(content).toContain("type: skill-proposal");
    expect(content).toContain("proposal_id: CS-2");
    expect(content).toContain("evidence:");
    expect(content).toContain("stop re-running the sweep");
    expect(content).toMatch(/Occurrences \(2\)/);
  });

  it("clusters repeated same-kind corrections within one session into one key", () => {
    const a1 = admitted({ kind: "behavior-gap" }, cand({ sessionId: "ses_a" }));
    const a2 = admitted({ kind: "behavior-gap" }, cand({ sessionId: "ses_a" }));
    const a3 = admitted({ kind: "skill-drift" }, cand({ sessionId: "ses_a" }));
    const a4 = admitted({ kind: "behavior-gap" }, cand({ sessionId: "ses_b" }));
    expect(clusterKey(a1)).toBe(clusterKey(a2));
    expect(clusterKey(a1)).not.toBe(clusterKey(a3));
    expect(clusterKey(a1)).not.toBe(clusterKey(a4));
  });
});

describe("cross-pass dedup (UPDATE appends, never duplicates)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amico-corrections-dedup-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the open scan finding for the same session + kind", () => {
    const { content } = renderFinding([admitted()], "2026-10-02T00:00:00Z", 1);
    const path = join(dir, "finding-x.md");
    writeFileSync(path, content);
    expect(findExistingScanFinding(dir, "ses_a", "skill-drift")).toBe(path);
    expect(findExistingScanFinding(dir, "ses_a", "behavior-gap")).toBeUndefined();
    expect(findExistingScanFinding(dir, "ses_b", "skill-drift")).toBeUndefined();
  });

  it("ignores closed findings and non-scan findings", () => {
    writeFileSync(join(dir, "closed.md"), renderFinding([admitted()], "p", 1).content.replace("status: open", "status: fixed"));
    writeFileSync(join(dir, "human.md"), "---\ntype: skill-finding\nstatus: open\n---\nhuman note");
    expect(findExistingScanFinding(dir, "ses_a", "skill-drift")).toBeUndefined();
  });

  it("renders an UPDATE section that appends without rewriting the claim", () => {
    const update = renderUpdate([admitted()], "2026-10-02T12:00:00Z");
    expect(update.trimStart()).toMatch(/^## UPDATE \d{4}-\d{2}-\d{2}/);
    expect(update).toContain("re-observed this correction");
  });
});

describe("the digest section", () => {
  it("renders one pass section with window, verdicts, and filed list", () => {
    const section = renderDigestSection({
      passIso: "2026-10-02T00:00:00Z",
      days: 7,
      sinceIso: "2026-09-25T00:00:00Z",
      scanned: 42,
      candidates: 5,
      jevStatus: "ran",
      filed: [{ path: "/v/finding.md", type: "skill-proposal", kind: "behavior-gap", severity: "P1", occurrences: 2 }],
      unverified: [],
      overflow: 0,
      pinged: undefined,
    });
    expect(section).toContain("## Pass 2026-10-02T00:00:00Z — corrections-scan");
    expect(section).toContain("jev: ran");
    expect(section).toContain("filed: 1 finding(s)");
    expect(section).toContain("behavior-gap");
  });
});

describe("verb registration", () => {
  it("corrections is a real (non-stub) spine verb — CLI dispatch + MCP facade", () => {
    const verb = SPINE_VERBS.find((v) => v.name === "corrections");
    expect(verb).toBeDefined();
    expect(verb!.stub).toBeFalsy();
    expect(verb!.summary).toMatch(/corrections/i);
    expect(verb!.summary).not.toMatch(/amico-run/);
  });
});

// ── the seeded-DB harness (NEVER the live chat DB) ───────────────────────────

interface SeedMsg {
  role: "user" | "assistant";
  text: string;
  at?: number;
}
interface SeedSession {
  id: string;
  title: string;
  msgs: SeedMsg[];
  archived?: boolean;
  parent?: string;
}

function seedDb(dbPath: string, sessions: SeedSession[]): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const script = `
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1], timeout=5)
con.executescript("""
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT NOT NULL,
  title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
""")
for s in json.loads(sys.argv[2]):
    now = int(sys.argv[3])
    times = [m.get("at", now - (len(s["msgs"]) - i) * 60000) for i, m in enumerate(s["msgs"])]
    con.execute("INSERT INTO session (id, directory, title, time_created, time_updated, time_archived, parent_id) VALUES (?,?,?,?,?,?,?)",
                (s["id"], "/w", s["title"], times[0] if times else now, times[-1] if times else now,
                 now if s.get("archived") else None, s.get("parent")))
    for i, m in enumerate(s["msgs"]):
        mid = s["id"] + "-m" + str(i)
        con.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
                    (mid, s["id"], times[i], times[i], json.dumps({"role": m["role"]})))
        con.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
                    (mid + "-p0", mid, s["id"], times[i], times[i], json.dumps({"type": "text", "text": m["text"]})))
con.commit()
`;
  execFileSync("python3", ["-c", script, dbPath, JSON.stringify(sessions), String(now)], { encoding: "utf8" });
}

const SEED: SeedSession[] = [
  {
    id: "ses_paq",
    title: "Pasqal gate autoresearch",
    msgs: [
      { role: "assistant", text: "emitting pulse.toml at 1 ns samples", at: min(60) },
      { role: "user", text: "no — the channel clock is 4 ns, use the grid", at: min(50) },
      { role: "assistant", text: "understood, re-emitting at the 4 ns grid", at: min(40) },
      { role: "user", text: "that's wrong again, stop re-running the jitter sweep and use the grid", at: min(30) },
      { role: "assistant", text: "done — sweep halted", at: min(25) },
      { role: "user", text: "thanks, looks good now", at: min(20) },
    ],
  },
  { id: "ses_noise", title: "Greeting", msgs: [{ role: "assistant", text: "hello!", at: min(10) }, { role: "user", text: "no that's wrong", at: min(9) }] },
  { id: "ses_arch", title: "Archived campaign", archived: true, msgs: [{ role: "assistant", text: "x", at: min(8) }, { role: "user", text: "wrong", at: min(7) }] },
  { id: "ses_kid", title: "spawned child", parent: "ses_paq", msgs: [{ role: "assistant", text: "x", at: min(6) }, { role: "user", text: "wrong", at: min(5) }] },
];

function fakeJev(status: "ran" | "unavailable" | "disabled" = "ran", conf = 0.93) {
  return async (candidates: CorrectionCandidate[]) => {
    const verdicts: Record<string, { noul: number; kind: string; kind_confidence: number; severity: string }> = {};
    for (const c of candidates) verdicts[c.messageId] = { noul: 0.85, kind: "behavior-gap", kind_confidence: conf, severity: "p1" };
    return { status, verdicts };
  };
}

// ── the scan flow (injected jev seam — hermetic) ──────────────────────────────

describe("the scan flow", () => {
  let db: string;
  let vault: string;
  let ops: string;
  let seenCandidates: string[] | undefined;
  beforeEach(() => {
    db = join(mkdtempSync(join(tmpdir(), "amico-corrections-db-")), "opencode.db");
    vault = mkdtempSync(join(tmpdir(), "amico-corrections-vault-"));
    ops = mkdtempSync(join(tmpdir(), "amico-corrections-ops-"));
    seenCandidates = undefined;
    seedDb(db, SEED);
  });
  afterEach(() => {
    rmSync(join(db, ".."), { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
    rmSync(ops, { recursive: true, force: true });
  });

  const env = () => ({ AMICODE_OPS_DIR: ops }) as NodeJS.ProcessEnv;
  const argv = (extra: string[] = []) => ["--db", db, "--vault", vault, ...extra];

  it("gathers only pre-filtered top-level unarchived candidates (recall rules eat noise)", async () => {
    const deps = {
      jev: async (cs: CorrectionCandidate[]) => {
        seenCandidates = cs.map((c) => c.messageId);
        return fakeJev()(cs);
      },
    };
    const r = await correctionsScan(argv(), env(), deps);
    expect(r.code).toBe(0);
    // ses_paq corrections m1 and m3 (the "thanks" m5 is pre-filtered out);
    // greeting, archived, and child sessions never reach the middle layer.
    expect(seenCandidates).toEqual(["ses_paq-m1", "ses_paq-m3"]);
  });

  it("is dry-run by default: admits and clusters but writes nothing", async () => {
    const r = await correctionsScan(argv(), env(), { jev: fakeJev() });
    const json = r.json as Record<string, unknown>;
    expect(json.dry_run).toBe(true);
    expect(json.admitted).toBe(2);
    expect(json.clusters).toBe(1);
    expect(json.filed).toEqual([]);
    expect(existsSync(join(vault, "amicode"))).toBe(false);
    expect(existsSync(correctionsWatermarkFile(env()))).toBe(false);
  });

  it("--apply files one clustered proposal (behavior-gap → skill-proposal), writes watermark + digest", async () => {
    const r = await correctionsScan(argv(["--apply"]), env(), { jev: fakeJev() });
    const json = r.json as Record<string, unknown>;
    expect(json.dry_run).toBe(false);
    const filed = json.filed as { path: string; type: string; kind: string; severity: string; occurrences: number }[];
    expect(filed).toHaveLength(1);
    expect(filed[0]!.type).toBe("skill-proposal");
    expect(filed[0]!.kind).toBe("behavior-gap");
    expect(filed[0]!.severity).toBe("P1");
    expect(filed[0]!.occurrences).toBe(2);
    const finding = readFileSync(filed[0]!.path, "utf8");
    expect(finding).toContain("type: skill-proposal");
    expect(finding).toContain("status: open");
    expect(finding).toContain("use the grid");
    expect(finding).toContain("stop re-running the jitter sweep");
    expect(readWatermarkMs(env())).toBeGreaterThanOrEqual(now - 60_000);
    const digest = readFileSync(join(vault, "dashboards", "user-corrections.md"), "utf8");
    expect(digest).toContain("type: dashboard");
    expect(digest).toContain("## Pass ");
    expect(digest).toContain("filed: 1 finding(s)");
  });

  it("the watermark narrows a second default-window scan to zero; --days forces re-scan and dedup appends an UPDATE", async () => {
    await correctionsScan(argv(["--apply"]), env(), { jev: fakeJev() });
    const second = await correctionsScan(argv(["--apply"]), env(), { jev: fakeJev() });
    expect((second.json as Record<string, unknown>).candidates).toBe(0);
    const third = await correctionsScan(argv(["--apply", "--days", "7"]), env(), { jev: fakeJev() });
    const json = third.json as Record<string, unknown>;
    expect(json.candidates).toBe(2);
    expect(json.filed).toEqual([]);
    expect(json.updated).toHaveLength(1);
    const updatedPath = (json.updated as string[])[0]!;
    expect(readFileSync(updatedPath, "utf8")).toMatch(/## UPDATE /);
    // the findings dir still holds exactly one file — no duplicate
    expect(readdirSync(join(vault, "amicode", "skills-integrity", "findings"))).toHaveLength(1);
  });

  it("fail-open: jev unavailable files NOTHING, and the digest lists the candidates as unverified", async () => {
    const r = await correctionsScan(argv(["--apply"]), env(), { jev: fakeJev("unavailable") });
    const json = r.json as Record<string, unknown>;
    expect(r.code).toBe(0);
    expect(json.jev_status).toBe("unavailable");
    expect(json.filed).toEqual([]);
    expect(json.unverified).toBe(2);
    expect(existsSync(join(vault, "amicode", "skills-integrity", "findings"))).toBe(false);
    const digest = readFileSync(join(vault, "dashboards", "user-corrections.md"), "utf8");
    expect(digest).toContain("unverified candidates (jev unavailable");
  });

  it("below-threshold confidence never files", async () => {
    const r = await correctionsScan(argv(["--apply"]), env(), { jev: fakeJev("ran", 0.5) });
    const json = r.json as Record<string, unknown>;
    expect(json.admitted).toBe(0);
    expect(json.filed).toEqual([]);
  });

  it("caps jev consultations at --max-jev and reports the overflow", async () => {
    const r = await correctionsScan(argv(["--apply", "--max-jev", "1"]), env(), { jev: fakeJev() });
    const json = r.json as Record<string, unknown>;
    expect(json.judged).toBe(1);
    expect(json.overflow).toBe(1);
  });

  it("P0/P1 findings ping Slack through the injected seam", async () => {
    const calls: { channel: string; text: string }[] = [];
    const ok = await correctionsScan(argv(["--apply", "--post", "#fleet"]), env(), {
      jev: fakeJev(),
      post: (channel, text) => {
        calls.push({ channel, text });
        return { ok: true };
      },
    });
    expect((ok.json as Record<string, unknown>).ping).toMatchObject({ ok: true, channel: "#fleet" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("P0/P1");
  });

  it("a failed ping is a warning, never a failed pass (findings stay filed)", async () => {
    const bad = await correctionsScan(argv(["--apply", "--post", "#fleet"]), env(), {
      jev: fakeJev(),
      post: () => ({ ok: false, error: "slack down" }),
    });
    expect(bad.code).toBe(0);
    const json = bad.json as Record<string, unknown>;
    expect(json.ping).toMatchObject({ ok: false });
    expect((json.filed as unknown[]).length).toBe(1);
    expect(readFileSync(join(vault, "dashboards", "user-corrections.md"), "utf8")).toContain("ping FAILED");
  });

  it("refuses to run without a personal mount or --vault (never guesses a findings target)", async () => {
    const prevRoot = process.env.AMICO_VAULTS_ROOT;
    const prevDir = process.env.AMICO_VAULT_DIR;
    delete process.env.AMICO_VAULT_DIR;
    process.env.AMICO_VAULTS_ROOT = "/nonexistent-vaults-root-xyz";
    try {
      const r = await correctionsScan(["--db", db], env(), { jev: fakeJev() });
      expect(r.code).toBe(64);
      expect((r.json as Record<string, unknown>).error).toMatch(/personal vault/);
    } finally {
      if (prevRoot === undefined) delete process.env.AMICO_VAULTS_ROOT;
      else process.env.AMICO_VAULTS_ROOT = prevRoot;
      if (prevDir !== undefined) process.env.AMICO_VAULT_DIR = prevDir;
    }
  });

  it("usage errors: bad --days, bad --max-jev, missing DB", async () => {
    expect((await correctionsScan(argv(["--days", "x"]), env(), { jev: fakeJev() })).code).toBe(64);
    expect((await correctionsScan(argv(["--max-jev", "0"]), env(), { jev: fakeJev() })).code).toBe(64);
    // direct call (no argv() helper) — the helper prepends --db with the seeded DB
    expect((await correctionsScan(["--db", "/no/such/db.sqlite", "--vault", vault], env(), { jev: fakeJev() })).code).toBe(64);
  });
});

// ── the CLI surface (bundle; AMICO_JEV_DISABLED → the fail-open path) ────────

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], {
      encoding: "utf8",
      env: { ...process.env, AMICO_JEV_DISABLED: "1", ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "" };
  }
}

describe("the CLI dispatch", () => {
  it("unknown subcommand → 64 with usage", async () => {
    const r = await correctionsVerb(["bogus"]);
    expect(r.code).toBe(64);
    expect((r.json as Record<string, unknown>).usage).toMatch(/amico corrections scan/);
  });

  it("the bundle reaches the scan and degrades fail-open with jev disabled", () => {
    const db = join(mkdtempSync(join(tmpdir(), "amico-corrections-cli-")), "opencode.db");
    const vault = mkdtempSync(join(tmpdir(), "amico-corrections-cli-v-"));
    const ops = mkdtempSync(join(tmpdir(), "amico-corrections-cli-ops-"));
    try {
      seedDb(db, SEED);
      const r = runCli(["corrections", "scan", "--db", db, "--vault", vault, "--apply"], { AMICODE_OPS_DIR: ops });
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(json.jev_status).toBe("disabled");
      expect(json.unverified).toBe(2);
      expect(json.filed).toEqual([]);
      expect(json.dry_run).toBe(false);
      expect(existsSync(join(vault, "dashboards", "user-corrections.md"))).toBe(true);
    } finally {
      rmSync(join(db, ".."), { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
      rmSync(ops, { recursive: true, force: true });
    }
  });
});

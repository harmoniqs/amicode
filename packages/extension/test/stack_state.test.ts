// Tests for the amicode_context plugin's stack_state.ts (live stack-state
// injection: fleet line + Armonia mount discovery + the user-memory sections
// formerly boot-time file splices).
//
// stack_state.ts is deliberately dependency-free (node: builtins only — it is
// imported by the opencode plugin, which executes inside opencode's embedded
// Bun runtime, NOT in the extension bundle) — so these tests exercise it as
// plain functions. The section-builder text is pinned byte-for-byte here
// (golden strings carried over from the retired substrate/user_splice.ts, the
// parity oracle for the splice these tests replace).
//
// buildStackStateBlock() reads env seams (the plugin has no params); the
// composition test stubs ALL seven seams to fixtures so it is hermetic on any
// machine (no reads of the real ~/.amico tree).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildStackStateBlock } from "../opencode-plugin/stack_state";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkVault(root: string, name: string, kind: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".amico-vault.toml"), `kind = "${kind}"\nname = "${name}"\n`);
  return dir;
}

function mkFixtureVault(root: string): string {
  const v = mkVault(root, "armonia-fixture", "personal");
  fs.mkdirSync(path.join(v, "amicode", "memory"), { recursive: true });
  fs.writeFileSync(path.join(v, "amicode", "PROFILE.md"), "# Profile — Fixture\n- Role: researcher\n");
  fs.writeFileSync(path.join(v, "amicode", "KNOWLEDGE.md"), "- [p1](problems/p1.md) — thing one\n");
  fs.writeFileSync(path.join(v, "amicode", "DEMOS.md"), "- [d1](demos/d1.md) — demo one\n");
  fs.writeFileSync(path.join(v, "amicode", "memory", "MEMORY.md"), "- [m1](m1.md) — fact one\n");
  return v;
}

// ── Fleet section ────────────────────────────────────────────────────────────

describe("buildFleetSection (lean fleet line + pointers)", () => {
  it("no fleet.json (standalone machine) → no section", () => {
    const dir = mkTmp("fleet-");
    const s = fleetSectionWith({ configPath: path.join(dir, "absent.json") });
    expect(s).toBe("");
  });
  it("server role with live status renders role, devices, freshness", () => {
    const dir = mkTmp("fleet-");
    const cfg = path.join(dir, "fleet.json");
    fs.writeFileSync(cfg, JSON.stringify({ role: "server", canonical: { host: "127.0.0.1", port: 4096 } }));
    const status = path.join(dir, "fleet-status.json");
    fs.writeFileSync(
      status,
      JSON.stringify({
        collected_at: new Date().toISOString(),
        devices: [
          { name: "mini", reachable: true },
          { name: "macbook", reachable: true },
          { name: "erlich", reachable: false },
        ],
      }),
    );
    const s = fleetSectionWith({ configPath: cfg, statusPath: status });
    expect(s).toContain("## Fleet (live)");
    expect(s).toContain("**server** — this machine is the canonical Amicode server");
    expect(s).toContain("Devices: 2/3 reachable (mini, macbook, erlich)");
    expect(s).toContain("refreshed 0 min ago");
    expect(s).toContain("fleet-status.json");
    expect(s).toContain("`fleet` skill");
  });
  it("unreadable status degrades to 'status unknown', not an error", () => {
    const dir = mkTmp("fleet-");
    const cfg = path.join(dir, "fleet.json");
    fs.writeFileSync(cfg, JSON.stringify({ role: "client" }));
    const s = fleetSectionWith({ configPath: cfg, statusPath: path.join(dir, "nope.json") });
    expect(s).toContain("**client** — rides the tunnel to the canonical server");
    expect(s).toContain("status unknown");
  });
});

// buildFleetSection is module-private; reach it through buildStackStateBlock's
// seams for these unit cases (config + status stubbed, everything else empty).
function fleetSectionWith(opts: { configPath?: string; statusPath?: string }): string {
  const stubs = stubAllSeams({ fleetConfig: opts.configPath, fleetStatus: opts.statusPath });
  try {
    const block = buildStackStateBlock() ?? "";
    const m = block.match(/## Fleet \(live\)[\s\S]*?(?=\n\n## |\n*$)/);
    return m ? m[0] : "";
  } finally {
    restoreSeams(stubs);
  }
}

// ── Mount discovery ──────────────────────────────────────────────────────────

describe("mount discovery (marker-only port of mount_store semantics)", () => {
  it("personal before team regardless of directory name; marker-less dirs skipped", () => {
    const root = mkTmp("vaults-");
    const team = mkVault(root, "aaa-team", "team");
    const personal = mkVault(root, "zzz-personal", "personal");
    fs.mkdirSync(path.join(root, "marker-less"));
    const { mounts } = discoverWith(root);
    expect(mounts.map((m) => m.kind)).toEqual(["personal", "team"]);
    expect(mounts[0].path).toBe(personal);
    expect(mounts[1].path).toBe(team);
  });
  it("duplicate resolved id: later discovery skipped with a warning", () => {
    const root = mkTmp("vaults-");
    mkVault(root, "one", "personal");
    const two = path.join(root, "two");
    fs.mkdirSync(two, { recursive: true });
    fs.writeFileSync(path.join(two, ".amico-vault.toml"), 'kind = "personal"\nname = "one"\n');
    const { mounts, warnings } = discoverWith(root);
    expect(mounts.length).toBe(1);
    expect(warnings.some((w) => w.includes("duplicate id 'one'"))).toBe(true);
  });
  it("marker missing kind → skipped with warning; missing root → empty", () => {
    const root = mkTmp("vaults-");
    const noKind = path.join(root, "no-kind");
    fs.mkdirSync(noKind, { recursive: true });
    fs.writeFileSync(path.join(noKind, ".amico-vault.toml"), 'name = "no-kind"\n');
    // A valid mount must coexist, else the section (and its warnings) doesn't render.
    mkVault(root, "valid", "team");
    const { mounts, warnings } = discoverWith(root);
    expect(mounts.length).toBe(1);
    expect(mounts[0].name).toBe("valid");
    expect(warnings.some((w) => w.includes("missing 'kind'"))).toBe(true);
    expect(discoverWith(path.join(root, "absent")).mounts).toEqual([]);
  });
});

function discoverWith(root: string) {
  const stubs = stubAllSeams({ vaultsRoot: root });
  try {
    // Re-discover through the public block: the mount-stack section lines
    // encode name · kind · rw/ro · path, ordered.
    const block = buildStackStateBlock() ?? "";
    const lines = block
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes(" · kind="))
      .map((l) => l.slice(2));
    const mounts = lines.map((l) => {
      const [name, kind, rw, p] = l.split(" · ");
      return { name, kind: kind.replace("kind=", ""), writable: rw === "rw", path: p };
    });
    const warnings = block
      .split("\n")
      .filter((l) => l.startsWith("- ⚠ "))
      .map((l) => l.slice(4));
    return { mounts, warnings };
  } finally {
    restoreSeams(stubs);
  }
}

// ── User-memory sections (golden text parity with the retired file splice) ──

describe("user-memory section text (parity oracle vs the retired user_splice.ts)", () => {
  it("## About this user wraps the profile with the anchor guidance", () => {
    const stubs = stubAllSeams({ vault: "profile" });
    try {
      const block = buildStackStateBlock() ?? "";
      expect(block).toContain(
        [
          "## About this user",
          "",
          "# Profile — Fixture",
          "- Role: researcher",
          "",
          "Greet and recommend with this context. Anchor the hardware stage on the",
          "user's environment card (read it from the vault path above when you reach",
          "that stage). Never re-ask what the profile already answers.",
        ].join("\n"),
      );
    } finally {
      restoreSeams(stubs);
    }
  });
  it("## Your recent problems carries the warm-start guidance", () => {
    const stubs = stubAllSeams({ vault: "knowledge" });
    try {
      const block = buildStackStateBlock() ?? "";
      expect(block).toContain(
        [
          "## Your recent problems",
          "",
          "- [p1](problems/p1.md) — thing one",
          "",
          "Before recommending parameters, check whether the user's target matches one",
          "of these cards (read the card file on demand for details). If a prior",
          "attempt failed, surface its lesson before re-authoring.",
        ].join("\n"),
      );
    } finally {
      restoreSeams(stubs);
    }
  });
  it("## Reference demos carries the precedent guidance", () => {
    const stubs = stubAllSeams({ vault: "demos" });
    try {
      const block = buildStackStateBlock() ?? "";
      expect(block).toContain(
        [
          "## Reference demos",
          "",
          "- [d1](demos/d1.md) — demo one",
          "",
          "Curated demos we've built — use them as PRECEDENT (medium confidence) when",
          "the user's target matches one and there's no own-precedent card. Read the",
          "demo card on demand for its params, and cite it in your recommendation.",
        ].join("\n"),
      );
    } finally {
      restoreSeams(stubs);
    }
  });
  it("## Memory index carries the typed-card pointer guidance", () => {
    const stubs = stubAllSeams({ vault: "memory" });
    try {
      const block = buildStackStateBlock() ?? "";
      expect(block).toContain(
        [
          "## Memory index",
          "",
          "- [m1](m1.md) — fact one",
          "",
          "These are one-line pointers. The full typed-memory cards (user / feedback /",
          "project / reference) load on demand from the granted vault path under",
          "`amicode/memory/` — read a card only when its hook is relevant to the turn.",
        ].join("\n"),
      );
    } finally {
      restoreSeams(stubs);
    }
  });
  it("## Mount stack renders the resolution & write-routing block", () => {
    const stubs = stubAllSeams({});
    try {
      const block = buildStackStateBlock() ?? "";
      expect(block).toContain("## Mount stack (Armonia — read precedence top→bottom)");
      expect(block).toContain("- armonia-fixture · kind=personal · rw · ");
      expect(block).toContain("Resolution & write-routing (condensed from the amico-vault skill):");
    } finally {
      restoreSeams(stubs);
    }
  });
});

// ── Active Research Project injection (#670) ─────────────────────────────────

describe("Active Research Project injection (#670)", () => {
  it("project-bound session → '## Active Research Project' block in context", () => {
    const projDir = mkTmp("research-proj-");
    fs.writeFileSync(
      path.join(projDir, ".amico"),
      'schema_version = 1\nname = "My Research"\nquestion = "Does it work?"\nstatus = "running"\n',
    );
    const stubs = stubAllSeams({});
    process.env.AMICODE_WORKSPACE_FOLDERS = projDir;
    try {
      const block = buildStackStateBlock() ?? "";
      expect(block).toContain("## Active Research Project");
      expect(block).toContain("**My Research** (running)");
      expect(block).toContain("**Question:** Does it work?");
      expect(block).toContain(`**Path:** \`${projDir}\``);
      expect(block).toContain("Hypotheses: `<project>/ledger/hypotheses/`");
      expect(block).toContain("Reports: `<project>/reports/`");
      expect(block).toContain("`reports/{weekly,presentations,milestones}`");
    } finally {
      restoreSeams(stubs);
    }
  });

  it("non-project session → no Active Research Project block", () => {
    const stubs = stubAllSeams({});
    // No AMICODE_WORKSPACE_FOLDERS set (cleared by stubAllSeams)
    try {
      const block = buildStackStateBlock() ?? "";
      expect(block).not.toContain("## Active Research Project");
    } finally {
      restoreSeams(stubs);
    }
  });

  it("dev project (no .amico) → no Active Research Project block", () => {
    const devDir = mkTmp("dev-proj-");
    const stubs = stubAllSeams({});
    process.env.AMICODE_WORKSPACE_FOLDERS = devDir;
    try {
      const block = buildStackStateBlock() ?? "";
      expect(block).not.toContain("## Active Research Project");
    } finally {
      restoreSeams(stubs);
    }
  });
});

// ── Caps + composition ───────────────────────────────────────────────────────

describe("caps + composition", () => {
  it("KNOWLEDGE/DEMOS/MEMORY list lines are capped (50/30/50)", () => {
    const root = mkTmp("vaults-");
    const v = mkVault(root, "capped", "personal");
    fs.mkdirSync(path.join(v, "amicode", "memory"), { recursive: true });
    const mk = (n: number, t: (i: number) => string) => Array.from({ length: n }, (_, i) => t(i)).join("\n");
    fs.writeFileSync(path.join(v, "amicode", "KNOWLEDGE.md"), mk(60, (i) => `- k${i}`));
    fs.writeFileSync(path.join(v, "amicode", "DEMOS.md"), mk(40, (i) => `- d${i}`));
    fs.writeFileSync(path.join(v, "amicode", "memory", "MEMORY.md"), mk(60, (i) => `- m${i}`));
    const stubs = stubAllSeams({ vaultsRoot: root });
    try {
      const block = buildStackStateBlock() ?? "";
      const count = (re: RegExp) => (block.match(re) ?? []).length;
      expect(count(/^- k\d+$/gm)).toBe(50);
      expect(count(/^- d\d+$/gm)).toBe(30);
      expect(count(/^- m\d+$/gm)).toBe(50);
    } finally {
      restoreSeams(stubs);
    }
  });
  it("composition: sections in splice-parity order (about → recent → demos → mounts → memory)", () => {
    const stubs = stubAllSeams({});
    try {
      const block = buildStackStateBlock();
      expect(block).toBeTruthy();
      const order = [
        "## About this user",
        "## Your recent problems",
        "## Reference demos",
        "## Mount stack (Armonia",
        "## Memory index",
      ].map((h) => (block as string).indexOf(h));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    } finally {
      restoreSeams(stubs);
    }
  });
  it("empty vaults root + no fleet + no ops state → null (nothing to inject)", () => {
    const stubs = stubAllSeams({ vaultsRoot: path.join(mkTmp("empty-"), "vaults") });
    try {
      expect(buildStackStateBlock()).toBeNull();
    } finally {
      restoreSeams(stubs);
    }
  });
});

// ── Live-runs block: live/stale/summary ──────────────────────────────────────

describe("buildLiveRunsBlock (live individually, zombies flagged, backlog summarized)", () => {
  function mkRun(lab: string, name: string, opts: { finished?: boolean; fidelity?: number } = {}): void {
    const dir = path.join(lab, name);
    fs.mkdirSync(dir, { recursive: true });
    if (opts.finished) fs.writeFileSync(path.join(dir, "FINISHED"), "");
    if (opts.fidelity !== undefined) {
      fs.writeFileSync(path.join(dir, "result.toml"), `fidelity = ${opts.fidelity}\n`);
    }
  }
  function runsBlockWith(runs: (labDir: string) => void): string {
    const root = mkTmp("runs-");
    const lab = path.join(root, "default");
    fs.mkdirSync(lab, { recursive: true });
    runs(lab);
    const stubs = stubAllSeams({ runsDir: root });
    try {
      const block = buildStackStateBlock() ?? "";
      const m = block.match(/\*\*live runs\*\*[\s\S]*?(?=\n\n|$)/);
      return m ? m[0] : "";
    } finally {
      restoreSeams(stubs);
    }
  }
  const now = new Date();
  const stamp = (hoursAgo: number): string => {
    const t = new Date(now.getTime() - hoursAgo * 3_600_000);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `r${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}Z-x`;
  };

  it("a fresh unfinished run is LIVE with its age; a days-old one is STALE, never 'solving'", () => {
    const s = runsBlockWith((lab) => {
      mkRun(lab, stamp(0.2)); // 12 min ago
      mkRun(lab, stamp(24 * 8)); // 8 days ago — zombie
    });
    expect(s).toContain("solving (");
    expect(s).toMatch(/STALE — no FINISHED since \d{4}-\d{2}-\d{2}/);
    expect(s).toContain("do not present as live");
    // the zombie line must NOT read as solving
    const zombieLine = s.split("\n").find((l) => l.includes("STALE"));
    expect(zombieLine).not.toContain("solving");
  });
  it("finished runs collapse to ONE backlog line: count, best F, latest", () => {
    const s = runsBlockWith((lab) => {
      mkRun(lab, stamp(30), { finished: true, fidelity: 0.999 });
      mkRun(lab, stamp(20), { finished: true, fidelity: 0.999979 });
      mkRun(lab, stamp(10), { finished: true, fidelity: 0.99 });
      mkRun(lab, stamp(5), { finished: true }); // finished, no result.toml
    });
    const backlog = s.split("\n").filter((l) => l.startsWith("- backlog:"));
    expect(backlog.length).toBe(1);
    expect(backlog[0]).toContain("4 finished");
    expect(backlog[0]).toContain("best F=0.999979");
    expect(backlog[0]).toContain("full history in the runs dir");
    // no individually listed done runs
    expect(s.split("\n").filter((l) => l.startsWith("- ") && /: done/.test(l)).length).toBe(0);
  });
  it("no runs at all → no live-runs section", () => {
    const root = mkTmp("runs-");
    fs.mkdirSync(path.join(root, "default"), { recursive: true });
    const stubs = stubAllSeams({ runsDir: root });
    try {
      expect(buildStackStateBlock() ?? "").not.toContain("**live runs**");
    } finally {
      restoreSeams(stubs);
    }
  });
});

// ── Env-seam plumbing ────────────────────────────────────────────────────────

interface SeamOpts {
  vaultsRoot?: string;
  fleetConfig?: string;
  fleetStatus?: string;
  runsDir?: string;
  /** Prebuilt fixture vault flavor for the golden-text cases. */
  vault?: "profile" | "knowledge" | "demos" | "memory";
}

const SEAM_KEYS = [
  "AMICO_VAULTS_ROOT",
  "AMICO_FLEET_CONFIG",
  "AMICO_FLEET_STATUS",
  "AMICODE_OPS_DIR",
  "AMICODE_CONNECTIONS_FILE",
  "AMICODE_PROBLEMS_DIR",
  "AMICODE_RUNS_DIR",
  "AMICODE_WORKSPACE_FOLDERS",
] as const;

let fixtureRoot: string | undefined;

function stubAllSeams(opts: SeamOpts): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of SEAM_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  if (!fixtureRoot) fixtureRoot = mkTmp("stackstate-fixture-");
  const root = opts.vaultsRoot ?? fixtureRoot;
  if (opts.vault) {
    // Rebuild the full fixture vault; only the requested file is populated
    // (the flavor switch keeps the golden-text cases independent).
    fs.rmSync(root, { recursive: true, force: true });
    const v = mkVault(root, "armonia-fixture", "personal");
    fs.mkdirSync(path.join(v, "amicode", "memory"), { recursive: true });
    if (opts.vault === "profile") {
      fs.writeFileSync(path.join(v, "amicode", "PROFILE.md"), "# Profile — Fixture\n- Role: researcher\n");
    }
    if (opts.vault === "knowledge") {
      fs.writeFileSync(path.join(v, "amicode", "KNOWLEDGE.md"), "- [p1](problems/p1.md) — thing one\n");
    }
    if (opts.vault === "demos") {
      fs.writeFileSync(path.join(v, "amicode", "DEMOS.md"), "- [d1](demos/d1.md) — demo one\n");
    }
    if (opts.vault === "memory") {
      fs.writeFileSync(path.join(v, "amicode", "memory", "MEMORY.md"), "- [m1](m1.md) — fact one\n");
    }
  } else if (!opts.vaultsRoot) {
    // Default root: the full fixture vault with every file present.
    fs.rmSync(root, { recursive: true, force: true });
    mkFixtureVault(root);
  }
  const ops = mkTmp("ops-");
  const conn = mkTmp("conn-");
  const problems = path.join(mkTmp("problems-"), "none");
  const runs = path.join(mkTmp("runs-"), "none");
  const fleetDir = mkTmp("fleetdir-");
  process.env.AMICO_VAULTS_ROOT = root;
  process.env.AMICO_FLEET_CONFIG = opts.fleetConfig ?? path.join(fleetDir, "absent-fleet.json");
  process.env.AMICO_FLEET_STATUS = opts.fleetStatus ?? path.join(fleetDir, "absent-status.json");
  process.env.AMICODE_OPS_DIR = ops; // no solver-mode.json → piccolo/ready → no section
  process.env.AMICODE_CONNECTIONS_FILE = path.join(conn, "absent.json"); // not connected
  process.env.AMICODE_PROBLEMS_DIR = problems; // no active problem
  process.env.AMICODE_RUNS_DIR = opts.runsDir ?? runs; // no runs unless a fixture is passed
  return saved;
}

function restoreSeams(saved: Record<string, string | undefined>): void {
  for (const k of SEAM_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

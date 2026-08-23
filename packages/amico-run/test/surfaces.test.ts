// surfaces.test.ts — doctor v2's verdict-matrix fixture suite (#525, spec D1 +
// Measurement Protocol). Fully hermetic: every fixture injects temp roots — fake
// binaries are shell scripts printing PINNED version strings, sidecars are
// fabricated next to them, git fixtures are real repos with PINNED commit dates
// (env overrides at setup) whose "remotes" are local bare repos (or dead paths
// for the unreachable-remote cells). The real ~/.amico, ~/.vscode and
// ~/armonia are NEVER touched.
//
// Date determinism (the spec's rule): current cells pin BOTH sides — fake
// binaries print FAR-FUTURE build dates (2099…), git commits carry FAR-PAST
// pinned dates (2026-08-01); stale cells flip one side. No mtime is ever read.
import { describe, test, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { surfaceInventory, type SurfaceContext } from "../src/surfaces.js";

// ── pinned dates ─────────────────────────────────────────────────────────────
// Git commit dates via the standard env overrides (far past); fake binaries
// print far-future build dates for current cells, far-past for stale ones.
const GIT_COMMIT_DATE = "2026-08-01T12:00:00Z";
const GIT_DATE_ENV = {
  GIT_AUTHOR_DATE: GIT_COMMIT_DATE,
  GIT_COMMITTER_DATE: GIT_COMMIT_DATE,
  GIT_AUTHOR_NAME: "doctor fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "doctor fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};
const FUTURE_BUILD = "0.0.0-local/amicode-209901010000"; // build date 2099-01-01
const PAST_BUILD = "0.0.0-local/amicode-202601010000"; // build date 2026-01-01

// ── fixture helpers ──────────────────────────────────────────────────────────
let dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "doctor-v2-"));
  dirs.push(d);
  return d;
}

function cleanup(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
}

function git(dir: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", ["-C", dir, ...args], {
    env: { ...process.env, ...GIT_DATE_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A fake "binary": a shell script printing a pinned version string. */
function fakeBin(dir: string, name: string, versionLine: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "${versionLine}"\n`);
  chmodSync(p, 0o755);
  return p;
}

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function writeJson(p: string, v: unknown): void {
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}

interface World {
  root: string;
  server: string;
  vscext: string;
  config: string;
  repoAmicode: string;
  repoFork: string;
  remoteAmicode: string;
  remoteFork: string;
  staging: string;
  running: string;
  frozenBin: string;
}

interface WorldOpts {
  /** printed by the frozen server binary (build date embedded) */
  frozenVersion?: string;
  /** the running-process stub; null = fabricate a byte-copy of frozen */
  runningVersion?: string | null;
}

/** The canonical CURRENT world: every surface at its source of truth. */
function buildWorld(opts: WorldOpts = {}): World {
  const root = tmp();
  const server = join(root, "server");
  const vscext = join(root, "vscode", "extensions");
  const config = join(root, "config", "opencode");
  const staging = join(root, "staging", "opencode-project");
  const repoAmicode = join(root, "repos", "amicode");
  const repoFork = join(root, "repos", "opencode");
  const remoteAmicode = join(root, "remotes", "amicode.git");
  const remoteFork = join(root, "remotes", "opencode.git");

  // ── frozen server binary + sidecar + running-process stub ──
  const frozenBin = fakeBin(join(server, "bin"), "opencode", opts.frozenVersion ?? FUTURE_BUILD);
  writeFileSync(`${frozenBin}.sha256`, `${sha256(frozenBin)}  opencode\n`);
  const running = opts.runningVersion === null ? "" : join(root, "running-opencode");
  if (opts.runningVersion === undefined) copyFileSync(frozenBin, running);
  else if (opts.runningVersion !== null) fakeBin(root, "running-opencode", opts.runningVersion);

  // ── VSIX extension dirs: 0.2.6 NEWEST by version, 0.2.4 written AFTER it
  //    (newer mtime) — proves selection is version-sorted, never mtime ──
  const extDir = join(vscext, "harmoniqs.amicode-0.2.6");
  const oldExtDir = join(vscext, "harmoniqs.amicode-0.2.4-darwin-arm64");
  for (const s of ["alpha", "beta"]) {
    mkdirSync(join(extDir, "skills", s), { recursive: true });
    writeFileSync(join(extDir, "skills", s, "SKILL.md"), `# ${s}\nVSIX skill ${s} v0.2.6\n`);
  }
  // (created after 0.2.6 → newer mtime; different skills so a mispick shows)
  for (const s of ["alpha", "beta"]) {
    mkdirSync(join(oldExtDir, "skills", s), { recursive: true });
    writeFileSync(join(oldExtDir, "skills", s, "SKILL.md"), `# ${s}\nVSIX skill ${s} v0.2.4\n`);
  }

  // ── staged skills: byte-identical to the newest VSIX set ──
  for (const s of ["alpha", "beta"]) {
    mkdirSync(join(staging, "skills", s), { recursive: true });
    copyFileSync(join(extDir, "skills", s, "SKILL.md"), join(staging, "skills", s, "SKILL.md"));
  }

  // ── agent cards: source (amicode repo) + both deployments + receipt ──
  const agentsSrc = join(repoAmicode, "packages", "extension", "agents");
  for (const c of ["autodev.md", "autoresearch.md"]) {
    mkdirSync(agentsSrc, { recursive: true });
    writeFileSync(join(agentsSrc, c), `---\nmode: ${c.replace(".md", "")}\n---\n# ${c}\n`);
  }
  mkdirSync(join(config, "agents"), { recursive: true });
  mkdirSync(join(staging, ".opencode", "agents"), { recursive: true });
  for (const c of ["autodev.md", "autoresearch.md"]) {
    copyFileSync(join(agentsSrc, c), join(config, "agents", c));
    copyFileSync(join(agentsSrc, c), join(staging, ".opencode", "agents", c));
  }
  writeJson(join(agentsSrc, ".deploy-receipt.json"), {
    receipt_version: 1,
    deployed_at: "2026-08-01T00:00:00.000Z",
    dry_run: false,
    sources: ["autodev.md", "autoresearch.md"].map((c) => ({
      card: c,
      path: join(agentsSrc, c),
      sha256: `sha256:${sha256(join(agentsSrc, c))}`,
    })),
    destinations: [],
  });

  // ── amicode repo (git fixture): extension version 0.2.6 on main, vendored
  //    binary printing the fork release base version, agent-card sources ──
  writeFileSync(
    join(repoAmicode, "packages", "extension", "package.json"),
    JSON.stringify({ name: "amicode", version: "0.2.6" }, null, 2) + "\n",
  );
  fakeBin(
    join(repoAmicode, "packages", "extension", "vendor", "opencode", "darwin-arm64"),
    "opencode",
    "1.18.10",
  );
  git(repoAmicode, ["init", "-b", "main"]);
  git(repoAmicode, ["add", "-A"]);
  git(repoAmicode, ["commit", "-m", "amicode fixture"]);
  execFileSync("git", ["init", "--bare", "-b", "main", remoteAmicode]);
  git(repoAmicode, ["remote", "add", "origin", remoteAmicode]);
  git(repoAmicode, ["push", "-u", "origin", "main"]);

  // ── fork repo (git fixture): branch local/amicode, release tag on tip ──
  mkdirSync(repoFork, { recursive: true });
  writeFileSync(join(repoFork, "README.md"), "fork fixture\n");
  git(repoFork, ["init", "-b", "local/amicode"]);
  git(repoFork, ["add", "-A"]);
  git(repoFork, ["commit", "-m", "fork fixture"]);
  git(repoFork, ["tag", "v1.18.10-amicode.15"]);
  execFileSync("git", ["init", "--bare", "-b", "local/amicode", remoteFork]);
  git(repoFork, ["remote", "add", "origin", remoteFork]);
  git(repoFork, ["push", "-u", "origin", "local/amicode"]);
  git(repoFork, ["push", "origin", "v1.18.10-amicode.15"]);

  return { root, server, vscext, config, repoAmicode, repoFork, remoteAmicode, remoteFork, staging, running, frozenBin };
}

function ctxFor(w: World, over: Partial<SurfaceContext> = {}): SurfaceContext {
  return {
    rootServer: w.server,
    rootVscext: w.vscext,
    rootConfig: w.config,
    rootRepoAmicode: w.repoAmicode,
    rootRepoFork: w.repoFork,
    rootStaging: w.staging,
    runningBinary: w.running || null,
    platform: "darwin-arm64",
    ...over,
  };
}

const bySurface = (report: { surfaces: { surface: string }[] }, name: string) =>
  report.surfaces.find((r) => r.surface === name)!;

// ── remote-side mutations (the source of truth moves WITHOUT the local
//    checkout — commits/tags are pushed from throwaway clones only, so the
//    fixture's checkout learns of them solely through doctor's fetch) ────────
function withBareClone(bare: string, branch: string, fn: (clone: string) => void): void {
  const clone = join(tmp(), "clone");
  execFileSync("git", ["clone", "--branch", branch, bare, clone], { stdio: ["ignore", "pipe", "pipe"] });
  fn(clone);
  git(clone, ["push", "origin", `HEAD:refs/heads/${branch}`]);
}

function bumpExtensionOnRemote(bare: string, version: string): void {
  withBareClone(bare, "main", (clone) => {
    writeFileSync(
      join(clone, "packages", "extension", "package.json"),
      JSON.stringify({ name: "amicode", version }, null, 2) + "\n",
    );
    git(clone, ["add", "-A"]);
    git(clone, ["commit", "-m", `bump extension to ${version}`]);
  });
}

function addReleaseTagOnRemote(bare: string, tag: string): void {
  withBareClone(bare, "local/amicode", (clone) => {
    git(clone, ["tag", tag]);
    git(clone, ["push", "origin", tag]);
  });
}

// ── the matrix ───────────────────────────────────────────────────────────────
describe("doctor v2 surface inventory — current cells", () => {
  test("current world: all six surfaces current, records complete and ordered", async () => {
    const w = buildWorld();
    const report = await surfaceInventory(ctxFor(w));
    expect(report.surfaces.map((r) => [r.surface, r.verdict])).toEqual([
      ["server-binary", "current"],
      ["extension", "current"],
      ["vendored-binary", "current"],
      ["staged-skills", "current"],
      ["agent-cards-global", "current"],
      ["agent-cards-staging", "current"],
    ]);
    for (const r of report.surfaces) {
      expect(r.version, `${r.surface} version`).toBeTruthy();
      expect(r.source_version, `${r.surface} source_version`).toBeTruthy();
      expect(r.evidence.length, `${r.surface} evidence`).toBeGreaterThan(0);
    }
    // server-binary: frozen version observed, source = fetched HEAD commit date
    const sb = bySurface(report, "server-binary");
    expect(sb.version).toBe(FUTURE_BUILD);
    expect(sb.evidence.join(" ")).toMatch(/sha256/);
    // extension: version-SORTED newest (0.2.6), never mtime (0.2.4 dir is newer)
    const ext = bySurface(report, "extension");
    expect(ext.version).toContain("0.2.6");
    expect(ext.source_version).toBe("0.2.6");
    // vendored: printed version == latest release tag base
    const vb = bySurface(report, "vendored-binary");
    expect(vb.version).toBe("1.18.10");
    expect(vb.source_version).toBe("1.18.10");
    cleanup();
  });
});

describe("doctor v2 surface inventory — integrity-failure cell", () => {
  test("server-binary integrity-failure: tampered sidecar (frozen sha ≠ sidecar)", async () => {
    const w = buildWorld();
    const sidecar = `${w.frozenBin}.sha256`;
    writeFileSync(sidecar, `${"0".repeat(64)}  opencode\n`); // the sidecar lies
    const report = await surfaceInventory(ctxFor(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("integrity-failure");
    expect(sb.evidence.join(" ")).toMatch(/frozen sha256 .* ≠ sidecar/);
    // one bad surface never fails the report: the other five still judged
    expect(bySurface(report, "extension").verdict).toBe("current");
    expect(bySurface(report, "agent-cards-global").verdict).toBe("current");
    cleanup();
  });
});

describe("doctor v2 surface inventory — unknown cells (every surface degrades individually)", () => {
  const DEAD_REMOTE = "/nonexistent/doctors-fixture-remote.git";

  test("server-binary unknown: unreachable fork remote", async () => {
    const w = buildWorld();
    git(w.repoFork, ["remote", "set-url", "origin", DEAD_REMOTE]);
    const report = await surfaceInventory(ctxFor(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("unknown");
    expect(sb.evidence.join(" ")).toMatch(/fork fetch failed/);
    // local facts still reported: integrity + running checks pass
    expect(sb.evidence.join(" ")).toMatch(/running .* = frozen|local checks pass/);
    cleanup();
  });

  test("extension unknown: unreachable amicode remote", async () => {
    const w = buildWorld();
    git(w.repoAmicode, ["remote", "set-url", "origin", DEAD_REMOTE]);
    const report = await surfaceInventory(ctxFor(w));
    const ext = bySurface(report, "extension");
    expect(ext.verdict).toBe("unknown");
    expect(ext.evidence.join(" ")).toMatch(/amicode fetch failed/);
    // the agent-cards source is the LOCAL checkout — unaffected by the dead remote
    expect(bySurface(report, "agent-cards-global").verdict).toBe("current");
    cleanup();
  });

  test("vendored-binary unknown: unreachable fork remote (release tags not refreshable)", async () => {
    const w = buildWorld();
    git(w.repoFork, ["remote", "set-url", "origin", DEAD_REMOTE]);
    const report = await surfaceInventory(ctxFor(w));
    const vb = bySurface(report, "vendored-binary");
    expect(vb.verdict).toBe("unknown");
    expect(vb.evidence.join(" ")).toMatch(/fork fetch failed/);
    cleanup();
  });

  test("staged-skills unknown: missing local source (no VSIX skills set)", async () => {
    const w = buildWorld();
    rmSync(w.vscext, { recursive: true, force: true });
    const report = await surfaceInventory(ctxFor(w));
    const sk = bySurface(report, "staged-skills");
    expect(sk.verdict).toBe("unknown");
    expect(sk.evidence.join(" ")).toMatch(/missing local source/);
    cleanup();
  });

  test("agent-cards-global unknown: missing source dir", async () => {
    const w = buildWorld();
    rmSync(join(w.repoAmicode, "packages", "extension", "agents"), { recursive: true, force: true });
    const report = await surfaceInventory(ctxFor(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("unknown");
    expect(g.evidence.join(" ")).toMatch(/missing local source/);
    cleanup();
  });

  test("agent-cards-staging unknown: missing source dir", async () => {
    const w = buildWorld();
    rmSync(join(w.repoAmicode, "packages", "extension", "agents"), { recursive: true, force: true });
    const report = await surfaceInventory(ctxFor(w));
    const st = bySurface(report, "agent-cards-staging");
    expect(st.verdict).toBe("unknown");
    expect(st.evidence.join(" ")).toMatch(/missing local source/);
    cleanup();
  });

  test("no report ever fails: all six records present even when every source is unreachable", async () => {
    const w = buildWorld();
    git(w.repoFork, ["remote", "set-url", "origin", DEAD_REMOTE]);
    git(w.repoAmicode, ["remote", "set-url", "origin", DEAD_REMOTE]);
    rmSync(w.vscext, { recursive: true, force: true });
    rmSync(join(w.repoAmicode, "packages", "extension", "agents"), { recursive: true, force: true });
    const report = await surfaceInventory(ctxFor(w));
    expect(report.surfaces).toHaveLength(6);
    // every source of truth is dead → every surface degrades to unknown, and
    // the report still returns all six records — never a failed report
    expect(report.surfaces.every((r) => r.verdict === "unknown")).toBe(true);
    expect(report.surfaces.every((r) => r.evidence.length > 0)).toBe(true);
    cleanup();
  });
});

describe("doctor v2 surface inventory — stale cells", () => {
  test("server-binary stale (version): far-past build date < pinned HEAD commit date", async () => {
    const w = buildWorld({ frozenVersion: PAST_BUILD }); // build 2026-01-01 < HEAD 2026-08-01
    const report = await surfaceInventory(ctxFor(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("stale");
    expect(sb.version).toBe(PAST_BUILD);
    expect(sb.evidence.join(" ")).toMatch(/build date .* < HEAD commit date/);
    cleanup();
  });

  test("server-binary stale (restart pending): running binary sha ≠ frozen sha", async () => {
    // different bytes (one-digit-different version line) → different sha
    const w = buildWorld({ runningVersion: "0.0.0-local/amicode-209901010001" });
    const report = await surfaceInventory(ctxFor(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("stale");
    expect(sb.evidence.join(" ")).toMatch(/running .* sha256 .* ≠ frozen sha256 .* \(restart pending\)/);
    cleanup();
  });

  test("server-binary stale (server-down): absent process is stale with server-down evidence", async () => {
    const w = buildWorld({ runningVersion: null });
    const report = await surfaceInventory(ctxFor(w, { discoverRunning: async () => null }));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("stale");
    expect(sb.evidence.join(" ")).toMatch(/server-down: no running opencode serve process/);
    cleanup();
  });

  test("extension stale: installed 0.2.6 behind fetched origin/main 0.2.7", async () => {
    const w = buildWorld();
    bumpExtensionOnRemote(w.remoteAmicode, "0.2.7");
    const report = await surfaceInventory(ctxFor(w));
    const ext = bySurface(report, "extension");
    expect(ext.verdict).toBe("stale");
    expect(ext.version).toContain("0.2.6");
    expect(ext.source_version).toBe("0.2.7");
    expect(ext.evidence.join(" ")).toMatch(/behind/);
    cleanup();
  });

  test("vendored-binary stale: printed 1.18.10 behind new release tag base 1.18.12", async () => {
    const w = buildWorld();
    addReleaseTagOnRemote(w.remoteFork, "v1.18.12-amicode.1");
    const report = await surfaceInventory(ctxFor(w));
    const vb = bySurface(report, "vendored-binary");
    expect(vb.verdict).toBe("stale");
    expect(vb.version).toBe("1.18.10");
    expect(vb.source_version).toBe("1.18.12");
    expect(vb.evidence.join(" ")).toMatch(/behind/);
    cleanup();
  });

  test("staged-skills stale: per-skill digest diff (changed skill named in evidence)", async () => {
    const w = buildWorld();
    writeFileSync(join(w.staging, "skills", "beta", "SKILL.md"), "# beta\nDRIFTED staged copy\n");
    const report = await surfaceInventory(ctxFor(w));
    const sk = bySurface(report, "staged-skills");
    expect(sk.verdict).toBe("stale");
    expect(sk.evidence.join(" ")).toMatch(/skill beta changed/);
    expect(sk.evidence.join(" ")).not.toMatch(/skill alpha/); // alpha still byte-matches
    cleanup();
  });

  test("agent-cards-global stale: deployed card tampered (per-card digest diff)", async () => {
    const w = buildWorld();
    writeFileSync(join(w.config, "agents", "autodev.md"), "---\nmode: autodev\n---\n# TAMPERED\n");
    const report = await surfaceInventory(ctxFor(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    expect(g.evidence.join(" ")).toMatch(/card autodev\.md changed/);
    const st = bySurface(report, "agent-cards-staging");
    expect(st.verdict).toBe("current"); // the OTHER deployment is unaffected
    cleanup();
  });

  test("agent-cards-staging stale: source present + receipt missing is stale (digest diff governs, receipt secondary)", async () => {
    const w = buildWorld();
    rmSync(join(w.repoAmicode, "packages", "extension", "agents", ".deploy-receipt.json"));
    const report = await surfaceInventory(ctxFor(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const r = bySurface(report, name);
      expect(r.verdict).toBe("stale");
      expect(r.evidence.join(" ")).toMatch(/receipt missing/);
      expect(r.evidence.join(" ")).toMatch(/byte-match/); // bytes agree — the receipt is the staleness
    }
    cleanup();
  });

  test("agent-cards stale: receipt source digests ≠ current sources", async () => {
    const w = buildWorld();
    const receiptPath = join(w.repoAmicode, "packages", "extension", "agents", ".deploy-receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { sources: { card: string; sha256: string }[] };
    receipt.sources[0].sha256 = "sha256:" + "0".repeat(64); // lies about autodev.md
    writeJson(receiptPath, receipt);
    const report = await surfaceInventory(ctxFor(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    expect(g.evidence.join(" ")).toMatch(/receipt source digest for autodev\.md ≠ current source/);
    cleanup();
  });
});

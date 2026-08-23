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

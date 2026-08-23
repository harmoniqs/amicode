import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import type { SurfaceContext } from "../src/surfaces.js";
import { realExec } from "../src/surfaces.js";

export function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "amico-run-test-"));
}

/** Env every CLI-spawning test should start from, so the suite never inherits
 *  the DEVELOPER's amicode state. Without this, a machine whose solver-mode.json
 *  says `hp` fails every local-solve test — Piccolissimo + Altissimo refuses a
 *  local launch — which is correct behaviour reported as a bogus test failure
 *  (found exactly that way, 2026-07-28). Points at an empty temp dir: absent
 *  files are the fresh-install state every reader already fails safe to.
 *  Spread it BEFORE per-test overrides so a test can still opt into an ops dir. */
export function hermeticOpsEnv(): { AMICODE_OPS_DIR: string } {
  return { AMICODE_OPS_DIR: mkdtempSync(join(tmpdir(), "amico-run-ops-")) };
}

export function readToml(path: string): Record<string, unknown> {
  return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Create an executable fake-julia "binary" (node script via shebang). It receives
 *  the julia argv (flags + script path) and ignores it unless the body uses it. */
export function fakeJulia(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// ── doctor v2 fixture worlds (#525) ─────────────────────────────────────────
// Fully hermetic surface fixtures: temp roots, fake binaries (shell scripts
// printing PINNED version strings), fabricated sidecars, real git repos with
// PINNED commit dates whose "remotes" are local bare repos. The real ~/.amico,
// ~/.vscode and ~/armonia are never touched. Date determinism: current cells
// pin far-future printed build dates + far-past git commit dates; stale cells
// flip one side.

/** Pinned git commit date for every fixture commit (far past vs build dates). */
export const GIT_COMMIT_DATE = "2026-08-01T12:00:00Z";
export const GIT_DATE_ENV = {
  GIT_AUTHOR_DATE: GIT_COMMIT_DATE,
  GIT_COMMITTER_DATE: GIT_COMMIT_DATE,
  GIT_AUTHOR_NAME: "doctor fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "doctor fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};
/** Far-future / far-past printed build dates (embedded in fake binaries). */
export const FUTURE_BUILD = "0.0.0-local/amicode-209901010000";
export const PAST_BUILD = "0.0.0-local/amicode-202601010000";

let trackedDirs: string[] = [];

/** A tracked temp dir — removed by cleanupTracked(). */
export function trackTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  trackedDirs.push(d);
  return d;
}

export function cleanupTracked(): void {
  for (const d of trackedDirs) rmSync(d, { recursive: true, force: true });
  trackedDirs = [];
}

/** git with the pinned-date env (fixtures never depend on wall-clock time). */
export function fixtureGit(dir: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", ["-C", dir, ...args], {
    env: { ...process.env, ...GIT_DATE_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A fake "binary": a shell script printing a pinned version string. */
export function fakeBin(dir: string, name: string, versionLine: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "${versionLine}"\n`);
  chmodSync(p, 0o755);
  return p;
}

export const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

export function writeJsonFile(p: string, v: unknown): void {
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}

export interface DoctorWorld {
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

export interface DoctorWorldOpts {
  /** printed by the frozen server binary (build date embedded) */
  frozenVersion?: string;
  /** running-process stub; undefined = byte-copy of frozen; null = no process */
  runningVersion?: string | null;
}

/** The vendored-binary platform dir, derived from the LIVE platform — the
 *  default SurfaceContext resolves the same way, so the CLI-level tests are
 *  runner-portable (darwin-arm64 here, linux-x64 on CI). */
export const LIVE_PLATFORM = `${process.platform}-${process.arch}`;

/** The canonical CURRENT doctor-v2 world: every surface at its source of truth. */
export function buildDoctorWorld(opts: DoctorWorldOpts = {}): DoctorWorld {
  const root = trackTmp("doctor-v2-");
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
  writeFileSync(`${frozenBin}.sha256`, `${sha256File(frozenBin)}  opencode\n`);
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
  writeJsonFile(join(agentsSrc, ".deploy-receipt.json"), {
    receipt_version: 1,
    deployed_at: "2026-08-01T00:00:00.000Z",
    dry_run: false,
    sources: ["autodev.md", "autoresearch.md"].map((c) => ({
      card: c,
      path: join(agentsSrc, c),
      sha256: `sha256:${sha256File(join(agentsSrc, c))}`,
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
    join(repoAmicode, "packages", "extension", "vendor", "opencode", LIVE_PLATFORM),
    "opencode",
    "1.18.10",
  );
  fixtureGit(repoAmicode, ["init", "-b", "main"]);
  fixtureGit(repoAmicode, ["add", "-A"]);
  fixtureGit(repoAmicode, ["commit", "-m", "amicode fixture"]);
  execFileSync("git", ["init", "--bare", "-b", "main", remoteAmicode]);
  fixtureGit(repoAmicode, ["remote", "add", "origin", remoteAmicode]);
  fixtureGit(repoAmicode, ["push", "-u", "origin", "main"]);

  // ── fork repo (git fixture): branch local/amicode, release tag on tip ──
  mkdirSync(repoFork, { recursive: true });
  writeFileSync(join(repoFork, "README.md"), "fork fixture\n");
  fixtureGit(repoFork, ["init", "-b", "local/amicode"]);
  fixtureGit(repoFork, ["add", "-A"]);
  fixtureGit(repoFork, ["commit", "-m", "fork fixture"]);
  fixtureGit(repoFork, ["tag", "v1.18.10-amicode.15"]);
  execFileSync("git", ["init", "--bare", "-b", "local/amicode", remoteFork]);
  fixtureGit(repoFork, ["remote", "add", "origin", remoteFork]);
  fixtureGit(repoFork, ["push", "-u", "origin", "local/amicode"]);
  fixtureGit(repoFork, ["push", "origin", "v1.18.10-amicode.15"]);

  return { root, server, vscext, config, repoAmicode, repoFork, remoteAmicode, remoteFork, staging, running, frozenBin };
}

export function ctxForWorld(w: DoctorWorld, over: Partial<SurfaceContext> = {}): SurfaceContext {
  const base: SurfaceContext = {
    rootServer: w.server,
    rootVscext: w.vscext,
    rootConfig: w.config,
    rootRepoAmicode: w.repoAmicode,
    rootRepoFork: w.repoFork,
    rootStaging: w.staging,
    runningBinary: w.running || null,
    platform: LIVE_PLATFORM,
    run: realExec,
    // hermetic default: a fixture that forgets to stub running-process
    // discovery gets server-down, never the REAL machine's process
    discoverRunning: async () => null,
  };
  return { ...base, ...over };
}

/** Mutate a bare remote from a throwaway clone — the fixture's checkout learns
 *  of the change ONLY through doctor's fetch (source-of-truth movement). */
export function withBareClone(bare: string, branch: string, fn: (clone: string) => void): void {
  const clone = trackTmp("doctor-v2-clone-");
  execFileSync("git", ["clone", "--branch", branch, bare, clone], { stdio: ["ignore", "pipe", "pipe"] });
  fn(clone);
  fixtureGit(clone, ["push", "origin", `HEAD:refs/heads/${branch}`]);
}

export function bumpExtensionOnRemote(bare: string, version: string): void {
  withBareClone(bare, "main", (clone) => {
    writeFileSync(
      join(clone, "packages", "extension", "package.json"),
      JSON.stringify({ name: "amicode", version }, null, 2) + "\n",
    );
    fixtureGit(clone, ["add", "-A"]);
    fixtureGit(clone, ["commit", "-m", `bump extension to ${version}`]);
  });
}

export function addReleaseTagOnRemote(bare: string, tag: string): void {
  withBareClone(bare, "local/amicode", (clone) => {
    fixtureGit(clone, ["tag", tag]);
    fixtureGit(clone, ["push", "origin", tag]);
  });
}

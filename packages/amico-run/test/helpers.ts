import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import type { SurfaceContext } from "../src/surfaces.js";
import { realExec } from "../src/surfaces.js";
import { generateLedgerDiscoveryRegion, stageModeBundles } from "@amicode/schema";

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
  /** #804: build the machine as PRE-REGISTRY — its release (v0.2.4) predates
   *  the mode registry (revision 0), the repo carries a second commit + tag
   *  (v0.2.6, revision 1), and no bundles deploy. The doctor must surface it
   *  as stale-to-release, never current. */
  preRegistryMachine?: boolean;
  /** #806: seed the fixture repo's agents/ from the REAL extension cards
   *  (packages/extension/agents) instead of the synthetic one-line cards —
   *  the machine's release tag then carries the D3-seeded role cards
   *  byte-for-byte, exactly like a post-seed release. Default false keeps
   *  the synthetic cards (the historical pre-D3 world, unchanged for the
   *  pre-existing cells). */
  realAgents?: boolean;
}

/** The vendored-binary platform dir, derived from the LIVE platform — the
 *  default SurfaceContext resolves the same way, so the CLI-level tests are
 *  runner-portable (darwin-arm64 here, linux-x64 on CI). */
export const LIVE_PLATFORM = `${process.platform}-${process.arch}`;

// ── #804: the mode-registry fixture — a hermetic registry that is VALID
// against the shared validator (the stager refuses an invalid source, and the
// world builder stages the deployed bundles through the REAL stager, so the
// fixture must parse + validate + carry a proper generated region). The
// machine's release tag carries this registry; the doctor's bundle probes
// compare deployed bytes against the TAG's bytes (never origin HEAD).
function writeModeRegistryFixture(
  extRoot: string,
  releases: Array<{ vsix_tag: string; registry_revision: number }>,
): void {
  const modes = join(extRoot, "modes");
  // handoff-seed schemas the manifests declare (tiny but present + JSON)
  const seeds = join(extRoot, "handoff-seeds");
  mkdirSync(seeds, { recursive: true });
  for (const s of ["issue-seed.schema.json", "hypothesis-seed.schema.json"]) {
    writeFileSync(join(seeds, s), JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" }, null, 2) + "\n");
  }
  const card = (mode: string): string =>
    [
      "---",
      "description: fixture director card",
      "mode: primary",
      "---",
      "",
      `# Fixture ${mode} director`,
      "",
      "## The spine",
      "",
      "<!-- DIRECTOR-SPINE v1 START -->",
      "Any campaign is one loop: plan, dispatch through gates, analyze, record.",
      generateLedgerDiscoveryRegion(),
      "<!-- DIRECTOR-SPINE v1 END -->",
      "",
    ].join("\n");
  const bundle = (mode: string, roles: string[], pack: string, seed: string): void => {
    const dir = join(modes, mode);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "card.md"), card(mode));
    writeFileSync(join(dir, "pack.toml"), pack);
    const roleLines = roles.map((r) => `\n[[roles]]\nname = "${r}"\npath = "../../agents/${r}.md"\n`).join("");
    writeFileSync(
      join(dir, "mode.toml"),
      [
        `schema_version = "1"`,
        `mode = "${mode}"`,
        'card = "card.md"',
        'pack = "pack.toml"',
        'protocol_skills = ["director-core"]',
        roleLines.trimEnd(),
        "",
        "[[handoff_seeds]]",
        `kind = "${seed === "issue" ? "issue_seed" : "hypothesis_seed"}"`,
        `schema = "../../handoff-seeds/${seed === "issue" ? "issue" : "hypothesis"}-seed.schema.json"`,
        "",
        "[consumer_floors]",
        'doctor = "1"',
        'plugin = "1"',
        'stager = "1"',
        'tests = "1"',
        "",
      ].join("\n"),
    );
  };
  bundle(
    "autodev",
    ["implementer"],
    [
      'closing_artifact = "landed-delta record"',
      "",
      "[[phases]]",
      'name = "decompose"',
      "",
      "  [[phases.gates]]",
      '  name = "dev-gate"',
      '  kind = "mechanical"',
      '  owner = "director"',
      '  procedure = "Attach every unit of package work to an issue and a PR before any file is modified."',
      "",
      "[[phases]]",
      'name = "implement"',
      'roles = ["implementer"]',
      "",
      "  [[phases.gates]]",
      '  name = "tdd-red-green"',
      '  kind = "mechanical"',
      '  owner = "implementer"',
      '  procedure = "Drive each acceptance criterion red-then-green; never delete tests to force green."',
      "",
      "[[phases]]",
      'name = "integrate"',
      "",
      "  [[phases.gates]]",
      '  name = "draft-pr-lifecycle"',
      '  kind = "derived"',
      '  owner = "director"',
      '  procedure = "Draft at first commit, ready only when green; never merge non-green work."',
      "",
      "[[handoffs]]",
      'kind = "hypothesis_seed"',
      'target = "autoresearch"',
      "",
    ].join("\n"),
    "issue",
  );
  bundle(
    "autoresearch",
    ["hypothesizer", "experimenter", "analyzer"],
    [
      'closing_artifact = "experiment note + ledger delta"',
      "",
      "[[phases]]",
      'name = "hypothesize"',
      'roles = ["hypothesizer"]',
      "",
      "  [[phases.gates]]",
      '  name = "ledger-currency"',
      '  kind = "derived"',
      '  owner = "director"',
      '  procedure = "Re-read the session ledger from disk before trusting the hypothesis queue."',
      "",
      "[[phases]]",
      'name = "experiment"',
      'roles = ["experimenter"]',
      "",
      "  [[phases.gates]]",
      '  name = "run-gates"',
      '  kind = "mechanical"',
      '  owner = "director"',
      '  procedure = "Run the gates through the shell; verdicts derive from command output, never self-reported."',
      "",
      "[[phases]]",
      'name = "analyze"',
      'roles = ["analyzer"]',
      "",
      "  [[phases.gates]]",
      '  name = "catalog-promotion"',
      '  kind = "human"',
      '  owner = "human"',
      '  procedure = "Promotion to catalog is human-only, always."',
      "",
      "[[handoffs]]",
      'kind = "issue_seed"',
      'target = "autodev"',
      "",
    ].join("\n"),
    "hypothesis",
  );
  writeFileSync(
    join(modes, "release-index.toml"),
    [
      'schema_version = "1"',
      "",
      ...releases.flatMap((r) => ["[[releases]]", `vsix_tag = "${r.vsix_tag}"`, `registry_revision = ${r.registry_revision}`, ""]),
    ].join("\n"),
  );
}

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
  const CARDS = ["analyzer.md", "autodev.md", "autoresearch.md", "experimenter.md", "hypothesizer.md", "implementer.md", "librarian.md"];
  for (const c of CARDS) {
    mkdirSync(agentsSrc, { recursive: true });
    writeFileSync(join(agentsSrc, c), `---\nmode: ${c.replace(".md", "")}\n---\n# ${c}\n`);
  }
  // #806: optionally seed the fixture's agent cards from the REAL extension
  // sources, so the machine's release tag carries the D3-seeded role cards
  // byte-for-byte (a post-seed release). The fixture's registry (below) and
  // the staged bundles then validate + stage against the same real bytes.
  if (opts.realAgents === true) {
    const realAgents = join(__dirname, "..", "..", "extension", "agents");
    for (const c of CARDS) {
      copyFileSync(join(realAgents, c), join(agentsSrc, c));
    }
  }
  mkdirSync(join(config, "agents"), { recursive: true });
  mkdirSync(join(staging, ".opencode", "agents"), { recursive: true });
  for (const c of CARDS) {
    copyFileSync(join(agentsSrc, c), join(config, "agents", c));
    copyFileSync(join(agentsSrc, c), join(staging, ".opencode", "agents", c));
  }
  writeJsonFile(join(agentsSrc, ".deploy-receipt.json"), {
    receipt_version: 1,
    deployed_at: "2026-08-01T00:00:00.000Z",
    dry_run: false,
    sources: CARDS.map((c) => ({
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
  // the amico-run package with its REAL bin map (#643): the server-binary
  // upgrade's dist-rebuild reads this map to know which bundles to verify +
  // refresh, exactly as the extension staging and assert_packaged_cli.mjs do.
  mkdirSync(join(repoAmicode, "packages", "amico-run"), { recursive: true });
  writeFileSync(
    join(repoAmicode, "packages", "amico-run", "package.json"),
    JSON.stringify(
      {
        name: "@amicode/amico-run",
        bin: {
          "amico-run": "./launcher/amico-run",
          amico: "./launcher/amico",
          "amico-pasqal": "./launcher/amico-pasqal",
          "amico-git-credential": "./launcher/amico-git-credential",
        },
        amicode: { shadowBins: { gh: "./launcher/gh" } },
      },
      null,
      2,
    ) + "\n",
  );
  fixtureGit(repoAmicode, ["init", "-b", "main"]);
  // #804: the mode registry rides the fixture repo. A PRE-REGISTRY machine's
  // release tag (v0.2.4) predates the registry — commit 1 carries no modes/,
  // then the registry lands in commit 2 (tagged v0.2.6, revision 1) so the
  // release index can map the old release to revision 0.
  const extRoot = join(repoAmicode, "packages", "extension");
  if (!opts.preRegistryMachine) {
    writeModeRegistryFixture(extRoot, [{ vsix_tag: "v0.2.6", registry_revision: 1 }]);
  }
  fixtureGit(repoAmicode, ["add", "-A"]);
  fixtureGit(repoAmicode, ["commit", "-m", "amicode fixture"]);
  if (opts.preRegistryMachine) {
    fixtureGit(repoAmicode, ["tag", "v0.2.4"]);
    writeModeRegistryFixture(extRoot, [
      { vsix_tag: "v0.2.4", registry_revision: 0 },
      { vsix_tag: "v0.2.6", registry_revision: 1 },
    ]);
    fixtureGit(repoAmicode, ["add", "-A"]);
    fixtureGit(repoAmicode, ["commit", "-m", "mode registry fixture"]);
    fixtureGit(repoAmicode, ["tag", "v0.2.6"]);
    // the pre-registry machine runs the OLD release: no 0.2.6 install at all
    rmSync(join(vscext, "harmoniqs.amicode-0.2.6"), { recursive: true, force: true });
  } else {
    fixtureGit(repoAmicode, ["tag", "v0.2.6"]);
  }
  execFileSync("git", ["init", "--bare", "-b", "main", remoteAmicode]);
  fixtureGit(repoAmicode, ["remote", "add", "origin", remoteAmicode]);
  fixtureGit(repoAmicode, ["push", "-u", "origin", "main"]);
  fixtureGit(repoAmicode, ["push", "origin", "--tags"]);

  // #804: the deployed mode bundles, staged through the REAL stager (valid
  // source ⇒ staged with receipt, no lock left behind) into BOTH deployed
  // roots — exactly what an activation or `amico upgrade agents` leaves. A
  // pre-registry machine's old build has no stager: nothing deploys.
  if (!opts.preRegistryMachine) {
    stageModeBundles(extRoot, config);
    stageModeBundles(extRoot, join(staging, ".opencode"));
  }

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

/** Move the fork remote's local/amicode tip forward one commit — the
 *  checkout learns of it ONLY through a fetch (clean-but-behind fixtures,
 *  #526's fast-forward branch). */
export function bumpForkHead(bare: string): void {
  withBareClone(bare, "local/amicode", (clone) => {
    writeFileSync(join(clone, "fork-update.txt"), "fork head moves forward\n");
    fixtureGit(clone, ["add", "-A"]);
    fixtureGit(clone, ["commit", "-m", "fork head moves forward"]);
  });
}

export function addReleaseTagOnRemote(bare: string, tag: string): void {
  withBareClone(bare, "local/amicode", (clone) => {
    fixtureGit(clone, ["tag", tag]);
    fixtureGit(clone, ["push", "origin", tag]);
  });
}

/** #804: cut a NEWER amicode release on the remote — a registry content bump
 *  (a pack gate procedure gains a sentence) + an index entry mapping the new
 *  tag to a higher registry revision + the extension version bump. The
 *  fixture checkout learns of it ONLY through the doctor's fetch; a machine a
 *  release behind must read `current to vX, stale to release vY`. */
export function advanceRegistryOnRemote(bare: string, newTag: string, newRevision: number): void {
  withBareClone(bare, "main", (clone) => {
    const base = newTag.replace(/^v/, "");
    writeFileSync(
      join(clone, "packages", "extension", "package.json"),
      JSON.stringify({ name: "amicode", version: base }, null, 2) + "\n",
    );
    const pack = join(clone, "packages", "extension", "modes", "autodev", "pack.toml");
    writeFileSync(pack, readFileSync(pack, "utf8").replace("never delete tests to force green.", "never delete tests to force green. Bumped registry content."));
    const index = join(clone, "packages", "extension", "modes", "release-index.toml");
    writeFileSync(
      index,
      readFileSync(index, "utf8").trimEnd() + `\n\n[[releases]]\nvsix_tag = "${newTag}"\nregistry_revision = ${newRevision}\n`,
    );
    fixtureGit(clone, ["add", "-A"]);
    fixtureGit(clone, ["commit", "-m", `release ${newTag} (registry revision ${newRevision})`]);
    fixtureGit(clone, ["tag", newTag]);
    fixtureGit(clone, ["push", "origin", newTag]);
  });
}

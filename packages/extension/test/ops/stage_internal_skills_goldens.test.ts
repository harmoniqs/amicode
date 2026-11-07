// Hub-side staging goldens (amicode#1743, spec-20261008-054129 §D4/B1) — the
// mirror of the client admission goldens (test/scores/admission_goldens.test.ts)
// against the HUB's staging output.
//
// The hub's staging set builder is ops/server/stage-internal-skills.sh — a
// shell script with NO importable seam (its only configurability is $HOME;
// the armonissima vault root and the staged opencode-project tree are both
// $HOME-relative). The mirror therefore spawns the REAL script under a
// synthetic HOME: fixture vault, fixture staged tree, nothing from the live
// machine. We assert the script's declared inputs/outputs — we never
// re-implement its allowlist logic in a fixture.
//
// What this pins (the hub direction of the issue's admission contract):
//  - internal mount present: exactly the ALLOWLISTED vault skills stage
//    (the allowlist is the hub's admission gate — more restrictive than the
//    client, which is the drift the issue records; pinned as-is, the
//    manifest workstream (A2) owns changing it);
//  - LEAK PIN: a vault skill NOT on the allowlist never stages, however
//    much it exists in the mount;
//  - internal mount absent: nothing stages, no crash (the SKIP branch);
//  - the reference audit fires for vault content referenced by armed content
//    but not staged (WARN referenced-but-unstaged — the audit is the hub's
//    only admission-adjacent check, so it rides this suite).
//
// Hermetic: runs in CI from fixture state — no chat-DB, no live-machine paths.
// The hub's PUBLIC skill staging (amicode-server.sh's rsync of the VSIX public
// set) is NOT exercisable here — that script is server-local and unversioned
// (ops/server/README.md documents the state-capture policy); recorded as a
// seam gap in the issue notes.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const OPS_SCRIPT = path.resolve(__dirname, "..", "..", "..", "..", "ops", "server", "stage-internal-skills.sh");

/** The script's committed ALLOWLIST, pinned HERE as the golden (not parsed
 *  from the script — parsing it would make the test its own fixture). A
 *  script allowlist change without a test change must fail red: that is the
 *  contract-change review discipline. */
const ALLOWLIST = [
  "director-core",
  "develop",
  "implement-issue",
  "write-an-issue",
  "break-into-subissues",
  "bosonic-gkp",
  "calibrate",
  "harmony",
  "shape",
  "sweep",
];

/** Vault content NOT on the allowlist — the hub leak-pin direction. */
const NEVER_STAGES = ["dream", "hopper", "pr"];

const tmpHomes: string[] = [];
afterEach(() => {
  for (const home of tmpHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** Build the fixture HOME. `withVault` mounts the armonissima tree; without
 *  it the vault skills dir is absent (the unmounted-hub shape). The staged
 *  project tree (skills dir + AGENTS.md) is pre-created in BOTH shapes —
 *  the production layout (amicode-server.sh stages public skills first, so
 *  the dir exists before this script runs). AGENTS.md references a staged
 *  skill (quiet) and an unstaged vault skill (`pr` — the WARN audit case). */
function fixtureHome(withVault: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "admission-hub-home-"));
  tmpHomes.push(home);
  const project = path.join(home, ".amico", "server", "opencode-project-staging", "opencode-project");
  fs.mkdirSync(path.join(project, "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "AGENTS.md"),
    "# fixture hub prompt\n\nInvoke `director-core` for campaign protocol. The `pr` skill exists in the vault.\n",
  );
  if (!withVault) return home;
  const vault = path.join(home, "armonia", "data", "vaults", "armonissima", "skills");
  for (const name of [...ALLOWLIST, ...NEVER_STAGES]) {
    fs.mkdirSync(path.join(vault, name), { recursive: true });
    fs.writeFileSync(
      path.join(vault, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} fixture protocol\nsurface: internal\n---\n\n# ${name} fixture body\n`,
    );
  }
  return home;
}

function stagedDir(home: string): string {
  return path.join(home, ".amico", "server", "opencode-project-staging", "opencode-project", "skills");
}

function runScript(home: string) {
  return spawnSync("/bin/bash", [OPS_SCRIPT], { encoding: "utf8", env: { ...process.env, HOME: home } });
}

describe("hub staging goldens — stage-internal-skills.sh (the #1743 mirror)", () => {
  it("internal mount present: exactly the ALLOWLISTED vault skills stage, and nothing else", () => {
    const home = fixtureHome(true);
    const r = runScript(home);
    expect(r.status).toBe(0);
    const staged = fs.readdirSync(stagedDir(home)).sort();
    expect(staged).toEqual([...ALLOWLIST].sort());
    // content plumbs through per-skill (rsync of the whole dir, not a name touch)
    expect(fs.readFileSync(path.join(stagedDir(home), "director-core", "SKILL.md"), "utf8")).toContain(
      "director-core fixture body",
    );
    // LEAK PIN: non-allowlisted vault skills never stage, however present they are
    for (const name of NEVER_STAGES) expect(staged).not.toContain(name);
    // the reference audit: armed content references unstaged vault content → WARN
    expect(r.stderr).toMatch(/WARN referenced-but-unstaged: pr/);
    // and a referenced STAGED skill stays quiet (real hits only, never noise)
    expect(r.stderr).not.toMatch(/referenced-but-unstaged: director-core/);
  });

  it("internal mount absent: nothing stages, no crash — every allowlisted skill SKIPs", () => {
    const home = fixtureHome(false);
    const r = runScript(home);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/SKIP director-core \(absent from armonissima/);
    // the pre-existing staged tree stays untouched — nothing new stages
    expect(fs.readdirSync(stagedDir(home))).toEqual([]);
  });
});

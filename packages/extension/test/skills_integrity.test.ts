// Skills-integrity lint (#1045) — the standing teeth for the skill-integrity
// loop (spec-20260913-skill-integrity-loop, spec O1). Exercises the CLI
// end-to-end: retired `amico-plugin:` namespace, dead companion-file refs,
// frontmatter drift, the deployed-copy (workspaceStorage) refusal, and the
// `--known` escape hatch that lets today's tree pass while new occurrences
// fail.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(EXT_ROOT, "scripts", "lint-skills.mjs");
const REAL_SKILLS = join(EXT_ROOT, "skills");
const KNOWN_FILE = join(EXT_ROOT, "scripts", "lint-skills-known.txt");

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function makeSkill(dir: string, name: string, body: string, frontmatter?: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const fm = frontmatter ?? `---\nname: ${name}\ndescription: test skill\nsurface: public\n---\n`;
  writeFileSync(join(skillDir, "SKILL.md"), fm + "\n" + body + "\n");
}

function makeFixtureTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-integrity-"));
  // clean skill
  makeSkill(dir, "clean-skill", "Does the thing. See `references/guide.md` and [notes](notes.md).");
  mkdirSync(join(dir, "clean-skill", "references"), { recursive: true });
  writeFileSync(join(dir, "clean-skill", "references", "guide.md"), "guide\n");
  writeFileSync(join(dir, "clean-skill", "notes.md"), "notes\n");
  // retired namespace
  makeSkill(dir, "ns-skill", "Dispatches the `amico-plugin:code-reviewer` subagent.");
  // dead companions: backticked subdir path + bare markdown link
  makeSkill(dir, "dead-path-skill", "Read [the guide](guide.md) and `tdd/tests.md` first.");
  // frontmatter drift
  makeSkill(dir, "drift-skill", "Body.", "---\nname: not-drift-skill\ndescription: x\nsurface: secret\n---\n");
  // unknown agent value → WARNING, not an error
  makeSkill(dir, "agent-skill", "Body.", "---\nname: agent-skill\ndescription: x\nsurface: public\nagents: [wizard]\n---\n");
  return dir;
}

describe("skills-integrity lint CLI (#1045)", () => {
  it("flags retired amico-plugin: namespace, dead companions, and frontmatter drift; warns on unknown agents", () => {
    const dir = makeFixtureTree();
    try {
      const r = run(["--dir", dir]);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      // errors carry file + line
      expect(out).toMatch(/ns-skill\/SKILL\.md:\d+:.*amico-plugin/);
      expect(out).toMatch(/dead-path-skill\/SKILL\.md:\d+:.*companion/);
      expect(out).toMatch(/drift-skill\/SKILL\.md:\d+:.*(name|surface)/);
      // unknown agent is a warning, not an error — still listed, but the exit
      // is driven by the errors above
      expect(out).toMatch(/agent-skill\/SKILL\.md:\d+:.*agents.*warning/i);
      // clean skill contributes nothing
      expect(out).not.toMatch(/clean-skill\/SKILL\.md:\d+:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 on a tree whose only problems are warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-warn-"));
    try {
      makeSkill(dir, "agent-skill", "Body.", "---\nname: agent-skill\ndescription: x\nsurface: public\nagents: [wizard]\n---\n");
      const r = run(["--dir", dir]);
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/agents.*warning/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--known exemptions let listed occurrences pass, but NOT unlisted ones", () => {
    const dir = makeFixtureTree();
    try {
      // exempt ns-skill's namespace hit only — the rest still fail
      const known = join(dir, "known.txt");
      writeFileSync(known, "# exempted 2026-09-13, F09\nns-skill/SKILL.md:amico-plugin\n");
      const r = run(["--dir", dir, "--known", known]);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).not.toMatch(/ns-skill\/SKILL\.md:\d+: \[amico-plugin\] error:/);
      expect(out).toMatch(/ns-skill\/SKILL\.md:\d+: \[amico-plugin\] known:/);
      expect(out).toMatch(/dead-path-skill\/SKILL\.md:\d+: \[companion\] error:/);

      // a ref-scoped companion exemption covers exactly that reference —
      // the other dead path in the same file still fails
      writeFileSync(known, "dead-path-skill/SKILL.md:companion:tdd/tests.md\n");
      const r3 = run(["--dir", dir, "--known", known]);
      expect(r3.status).toBe(1);
      expect(r3.stdout + r3.stderr).toMatch(/companion file `guide\.md` does not exist/);
      expect(r3.stdout + r3.stderr).not.toMatch(/\[companion\] error: companion file `tdd\/tests\.md`/);
      expect(r3.stdout + r3.stderr).toMatch(/\[companion\] known: companion file `tdd\/tests\.md`/);

      // exempting every rule the fixture trips → exit 0
      writeFileSync(
        known,
        [
          "ns-skill/SKILL.md:amico-plugin",
          "dead-path-skill/SKILL.md:companion",
          "drift-skill/SKILL.md:name",
          "drift-skill/SKILL.md:surface",
        ].join("\n") + "\n",
      );
      const r2 = run(["--dir", dir, "--known", known]);
      expect(r2.status).toBe(0);
      // an unknown rule name in the known file exempts nothing
      writeFileSync(known, "ns-skill/SKILL.md:amico-plugin-typo\n");
      const r4 = run(["--dir", dir, "--known", known]);
      expect(r4.status).toBe(1);
      expect(r4.stdout + r4.stderr).toMatch(/ns-skill\/SKILL\.md:\d+: \[amico-plugin\] error:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run against a deployed workspaceStorage copy (spec O1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspaceStorage-probe-"));
    try {
      makeSkill(dir, "some-skill", "Body.");
      const r = run(["--dir", dir]);
      expect(r.status).not.toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/workspaceStorage/i);
      expect(out).toMatch(/deployed|build artifact/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is green over the repo's real skills tree with the checked-in known list", () => {
    const r = run(["--dir", REAL_SKILLS, "--known", KNOWN_FILE]);
    if (r.status !== 0) {
      throw new Error(`lint failed over the real tree:\n${r.stdout}\n${r.stderr}`);
    }
    expect(r.status).toBe(0);
  });

  it("errors on a missing --dir (usage, not silent ok)", () => {
    const r = run(["--dir", join(tmpdir(), "does-not-exist-skills-integrity")]);
    expect(r.status).not.toBe(0);
  });
});

// [vpath] — rotted vault-path shapes (finding F28, repo half). The 2026-09-13
// campaign fixed five instances of the same disease (dream-state, dream-journal,
// linkedin example path, sota-review ledger line, dream-family routing); this
// rule is the standing tooth. Doctrine: vaults by role/kind, ops tree via
// $AMICO_OPS, never a raw home path embedding a vault name.
describe("skills-integrity lint [vpath] rotted vault-path rule (F28)", () => {
  it("errors on the rotted shapes: amico/vault/, vault-aaron, ~/.claude/", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-vpath-"));
    try {
      makeSkill(dir, "old-ops-skill", "The ledger lives under `amico/vault/ledger/hypotheses.jsonl`.");
      makeSkill(dir, "old-name-skill", "Read the profile at vault-aaron/amicode/ first.");
      makeSkill(dir, "old-claude-skill", "Transcripts are read from `~/.claude/projects/` by the distiller.");
      const r = run(["--dir", dir]);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/old-ops-skill\/SKILL\.md:\d+: \[vpath\] error:.*amico\/vault\//);
      expect(out).toMatch(/old-name-skill\/SKILL\.md:\d+: \[vpath\] error:.*vault-aaron/);
      expect(out).toMatch(/old-claude-skill\/SKILL\.md:\d+: \[vpath\] error:.*~\/\.claude\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns (exit 0) on rot-prone raw home paths embedding vault names", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-vpath-warn-"));
    try {
      makeSkill(dir, "home-path-skill", "Mounts live under `~/armonia/data/vaults/team-vault/notes.toml` per doctrine.");
      makeSkill(dir, "data-path-skill", "The store is at `~/ops/armonia-data/mounts/index.toml`.");
      const r = run(["--dir", dir]);
      expect(r.status).toBe(0); // warnings never fail the lint
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/home-path-skill\/SKILL\.md:\d+: \[vpath\] warning:/);
      expect(out).toMatch(/data-path-skill\/SKILL\.md:\d+: \[vpath\] warning:/);
      // a clean home path embedding no vault name is not even a warning
      expect(out).not.toMatch(/clean-skill/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--known can exempt a vpath error (rule name is valid, never a silent typo-widen)", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-vpath-known-"));
    try {
      makeSkill(dir, "old-ops-skill", "The ledger lives under `amico/vault/ledger/hypotheses.jsonl`.");
      const known = join(dir, "known.txt");
      writeFileSync(known, "old-ops-skill/SKILL.md:vpath\n");
      const r = run(["--dir", dir, "--known", known]);
      expect(r.status).toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/old-ops-skill\/SKILL\.md:\d+: \[vpath\] known:/);
      expect(out).not.toMatch(/\[vpath\] error:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is clean of [vpath] errors over the repo's real skills tree", () => {
    const r = run(["--dir", REAL_SKILLS, "--known", KNOWN_FILE]);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/\[vpath\] error:/);
  });
});

// [private-package] — the public repo is world-readable, so a shippable skill
// (public / entitled / untagged surface) must not name a private package. The
// denylist lives in ONE file (scripts/lint-skills-private-packages.txt); the
// rule is on by default for the repo library and opt-in (`--denylist`) for
// any other root. `surface: internal` cards are vault-only and exempt.
const DENYLIST_FILE = join(EXT_ROOT, "scripts", "lint-skills-private-packages.txt");

function readDenylist(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

describe("skills-integrity lint [private-package] denylist rule", () => {
  it("errors on a shippable skill naming a denylisted package in its body or frontmatter name", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-priv-"));
    try {
      const deny = join(dir, "deny.txt");
      writeFileSync(deny, "# fixture denylist\nSecretissimo\nhushpkg\n");
      makeSkill(dir, "body-skill", "Plug in SECRETISSIMO integrators for speed.");
      makeSkill(dir, "hushpkg-usage", "Body without the word.");
      makeSkill(dir, "untagged-skill", "Uses secretissimo.", "---\nname: untagged-skill\ndescription: x\n---\n");
      makeSkill(dir, "internal-skill", "Secretissimo internals.", "---\nname: internal-skill\ndescription: x\nsurface: internal\n---\n");
      makeSkill(dir, "near-miss-skill", "Secretissimos and hushpkgs are different words.");
      const r = run(["--dir", dir, "--denylist", deny]);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/body-skill\/SKILL\.md:\d+: \[private-package\] error:.*Secretissimo/i);
      expect(out).toMatch(/hushpkg-usage\/SKILL\.md:2: \[private-package\] error:.*hushpkg/);
      expect(out).toMatch(/untagged-skill\/SKILL\.md:\d+: \[private-package\] error:/);
      expect(out).not.toMatch(/internal-skill\/SKILL\.md/); // vault-only cards may name them
      expect(out).not.toMatch(/near-miss-skill\/SKILL\.md/); // whole-word match only
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every entry of the checked-in denylist trips the rule", () => {
    const names = readDenylist(DENYLIST_FILE);
    expect(names.length).toBeGreaterThanOrEqual(11);
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-priv-default-"));
    try {
      names.forEach((n, i) => makeSkill(dir, `skill-${i}`, `See ${n}.jl for details.`));
      const r = run(["--dir", dir, "--denylist", DENYLIST_FILE]);
      expect(r.status).toBe(1);
      const hits = (r.stdout.match(/\[private-package\] error:/g) ?? []).length;
      expect(hits).toBe(names.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is off for a non-library root unless --denylist is passed (vault roots keep their verdict)", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-priv-off-"));
    try {
      const deny = join(dir, "deny.txt");
      writeFileSync(deny, "Secretissimo\n");
      makeSkill(dir, "body-skill", "Plug in Secretissimo.");
      expect(run(["--dir", dir]).status).toBe(0);
      expect(run(["--dir", dir, "--denylist", deny]).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--known can exempt a private-package hit (the documented exception list)", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-priv-known-"));
    try {
      const deny = join(dir, "deny.txt");
      writeFileSync(deny, "Secretissimo\n");
      makeSkill(dir, "body-skill", "Plug in Secretissimo.");
      const known = join(dir, "known.txt");
      writeFileSync(known, "body-skill/SKILL.md:private-package\n");
      const r = run(["--dir", dir, "--denylist", deny, "--known", known]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/\[private-package\] known:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the repo library is clean by default, with ZERO private-package exceptions", () => {
    const r = run(["--dir", REAL_SKILLS, "--known", KNOWN_FILE]);
    expect(r.stdout + r.stderr).not.toMatch(/\[private-package\] (error|known):/);
    expect(readFileSync(KNOWN_FILE, "utf8")).not.toMatch(/:private-package/);
    // default-on for the library: the denylist file is actually consulted
    expect(readDenylist(DENYLIST_FILE).length).toBeGreaterThan(0);
  });
});

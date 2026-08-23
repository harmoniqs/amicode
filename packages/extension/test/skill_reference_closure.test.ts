// Skill-reference closure (#537) — every skill-invocation directive in the
// agent cards must resolve against the repo's public skills plus a committed
// registry of internally-homed skills. Born from the 2026-08-23 outage: both
// mode cards' first action invokes `director-core`, but the server's staging
// allowlist omitted it, and runtime died with "skill director-core
// unavailable". CI must catch what staging forgot.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "..");
const AGENTS_DIR = path.join(EXT, "agents");
const SKILLS_DIR = path.join(EXT, "skills");
const REGISTRY_PATH = path.join(HERE, "fixtures", "internal-skill-registry.json");

// The live armonissima team mount — canonical home of the registry's skills;
// absent on machines without the mount (same conditional as mode_cards.test.ts).
const ARMONISSIMA_SKILLS = path.join(
  process.env.HOME ?? "",
  ".amico",
  "vaults",
  "armonissima",
  "skills",
);

const registry: string[] = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as string[];

/**
 * Skill-invocation directives in a card: "the `X` skill", "invoke the `X`",
 * "invoke the **`X`**". Deliberately narrow — this is an invocation contract,
 * not every mention.
 */
function skillDirectives(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/`([a-z][a-z0-9-]+)`\s+skill\b/g)) names.add(m[1]!);
  for (const m of text.matchAll(/invoke the (?:\*\*)?`([a-z][a-z0-9-]+)`/gi))
    names.add(m[1]!);
  return [...names];
}

const cards = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));

// Repo public skills + the committed internal registry = the resolvable set.
const repoSkills = readdirSync(SKILLS_DIR).filter((f) =>
  existsSync(path.join(SKILLS_DIR, f, "SKILL.md")),
);
const resolvable = new Set<string>([...repoSkills, ...registry]);

describe("skill-reference closure — agent card directives resolve", () => {
  it("the card set is non-empty (guard against a vacuous suite)", () => {
    expect(cards.length).toBeGreaterThan(0);
  });

  it("cards carry at least one skill directive (guard against a vacuous scan)", () => {
    const all = cards.flatMap((c) =>
      skillDirectives(readFileSync(path.join(AGENTS_DIR, c), "utf8")),
    );
    expect(all.length).toBeGreaterThan(0);
  });

  for (const card of cards) {
    it(`${card}: every skill directive resolves`, () => {
      const text = readFileSync(path.join(AGENTS_DIR, card), "utf8");
      const directives = skillDirectives(text);
      for (const name of directives) {
        expect(
          resolvable.has(name),
          `${card} invokes "${name}" — not in repo skills nor the internal registry`,
        ).toBe(true);
      }
    });
  }
});

describe("skill-reference closure — internal registry", () => {
  it("the registry is non-empty and duplicate-free (guard against a vacuous check)", () => {
    expect(registry.length).toBeGreaterThan(0);
    expect(new Set(registry).size).toBe(registry.length);
  });

  it("registry entries are not shadows of repo skills (registry = internal-only)", () => {
    for (const name of registry) {
      expect(
        repoSkills.includes(name),
        `"${name}" exists in repo skills — remove it from the internal registry`,
      ).toBe(false);
    }
  });

  it("every registry entry exists in the team mount when the mount is present", () => {
    if (!existsSync(ARMONISSIMA_SKILLS)) return; // mount absent: registry is the record
    for (const name of registry) {
      expect(
        existsSync(path.join(ARMONISSIMA_SKILLS, name, "SKILL.md")),
        `registry entry "${name}" has no SKILL.md in the armonissima mount`,
      ).toBe(true);
    }
  });
});

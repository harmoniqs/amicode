// role_cards.test.ts — slice 2 / D3 (#806, spec-20260905-063000): the four
// director-cast role cards (hypothesizer, experimenter, analyzer, implementer)
// are VERSIONED repo sources owned by their mode bundles, SEEDED verbatim
// from the live deployed staging artifacts on the seed machine (erlich's
// server staging root) — the seed gate's integrity half.
//
// The seed is GATED (spec D3): the deployed artifacts are plausibly
// per-machine drifted, so garbage-in must never be enshrined as the tested
// baseline. This file pins the RECORD side of that gate, mechanically:
//
//   - SEED INTEGRITY — each repo card's bytes match the sha256 recorded in
//     packages/extension/agents/.seed-provenance.json (the record of what the
//     implementing cast seeded). The repo carries either the seed VERBATIM or
//     a RECORDED amendment (the human-signed diff): a card that drifts from
//     its recorded bytes with no recorded amendment is a failure here, never
//     a silent pass.
//   - OWNERSHIP — the bundles' manifests declare the roles they cast
//     (research: hypothesizer/experimenter/analyzer; dev: implementer), and
//     the shared validator is green over the whole registry (the one
//     validator both the vitest suite and the doctor import).
//   - STAGING — the atomic bundle stager materializes each role card into
//     its bundle's roles/ dir, byte-identical, with a digest row on the
//     deploy receipt — staged and digest-verified with the director cards.
//   - STRUCTURAL FLOOR — frontmatter shape, the blocklist (open-protocol
//     vocabulary), and the cast-card section structure. Structural only,
//     pre-signature: the seed-diff gate owns content parity
//     (role_cards_parity.test.ts), and this floor never pins flagged
//     content.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseModeManifest,
  validateModeRegistry,
  declaredComponents,
  stageModeBundles,
} from "@amicode/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "..");
const AGENTS_DIR = join(EXT, "agents");
const MODES_DIR = join(EXT, "modes");
const PROVENANCE_PATH = join(AGENTS_DIR, ".seed-provenance.json");

/** The four role cards this slice owns, by bundle. */
const ROLE_CARDS = {
  autoresearch: ["hypothesizer", "experimenter", "analyzer"] as const,
  autodev: ["implementer"] as const,
} as const;
const ALL_ROLES = [...ROLE_CARDS.autoresearch, ...ROLE_CARDS.autodev] as const;
type Role = (typeof ALL_ROLES)[number];

const cardPath = (role: Role): string => join(AGENTS_DIR, `${role}.md`);
const cardText = (role: Role): string => readFileSync(cardPath(role), "utf8");
const sha256 = (p: string): string =>
  "sha256:" + createHash("sha256").update(readFileSync(p)).digest("hex");

// D4's proper-noun blocklist, from the fixture of record — the same
// floor the director cards and the worker cards carry.
const BLOCKLIST = JSON.parse(readFileSync(join(EXT, "protocol-blocklist.json"), "utf8")) as {
  proprietary_strings: string[];
  banned_names: string[];
};
const BLOCKED = [...BLOCKLIST.proprietary_strings, ...BLOCKLIST.banned_names];

// Guards: the blocklist fixtures of record carry the real lists — an empty
// blocklist would make this floor vacuously green.
expect(BLOCKLIST.proprietary_strings.length).toBeGreaterThanOrEqual(5);
expect(BLOCKLIST.banned_names.length).toBeGreaterThanOrEqual(2);

interface ProvenanceEntry {
  role: string;
  source_path: string;
  seeded_sha256: string;
  seeded_at: string;
}
interface SeedProvenance {
  record_version: number;
  issue: number;
  seed_machine: string;
  seed_root: string;
  captured_at: string;
  /** Absent/false until the human gate signs an amendment (the seed gate). */
  amended?: boolean;
  amendment_signed_by?: string;
  roles: ProvenanceEntry[];
}

describe("seed provenance — the record of what was seeded (the gate's mechanical half)", () => {
  it("the committed record exists and names the seed machine, root, and all four roles", () => {
    expect(existsSync(PROVENANCE_PATH), ".seed-provenance.json must be committed").toBe(true);
    const record = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as SeedProvenance;
    expect(record.record_version).toBe(1);
    expect(record.issue).toBe(806);
    expect(record.seed_machine).toMatch(/^\S+$/);
    expect(record.seed_root).toMatch(/agents$/);
    expect(record.roles.map((r) => r.role).sort()).toEqual([...ALL_ROLES].sort());
  });

  it("SEED INTEGRITY: every role card in the repo is byte-identical to its recorded seed hash", () => {
    const record = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as SeedProvenance;
    for (const entry of record.roles) {
      const actual = sha256(cardPath(entry.role as Role));
      if (actual === entry.seeded_sha256) continue;
      // drifted from the seed: only a RECORDED, SIGNED amendment may carry it
      expect(
        record.amended === true && typeof record.amendment_signed_by === "string" && record.amendment_signed_by.length > 0,
        `${entry.role} no longer matches its recorded seed hash, and the provenance record carries no signed amendment — a silent content change to a seeded role card is never a pass`,
      ).toBe(true);
    }
  });

  it("each entry's source_path points inside the seed root it records", () => {
    const record = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as SeedProvenance;
    for (const entry of record.roles) {
      expect(entry.source_path.startsWith(record.seed_root)).toBe(true);
    }
  });
});

describe("bundle ownership — the manifests declare the roles they cast (D3)", () => {
  it("the registry validates through the ONE shared validator", () => {
    expect(validateModeRegistry(MODES_DIR, EXT).ok).toBe(true);
  });

  it("each bundle declares exactly its slice's roles, and the declared set materializes as roles/<name>.md", () => {
    for (const [mode, roles] of Object.entries(ROLE_CARDS)) {
      const manifest = parseModeManifest(readFileSync(join(MODES_DIR, mode, "mode.toml"), "utf8"));
      expect(manifest.roles.map((r) => r.name).sort()).toEqual([...roles].sort());
      const inBundle = declaredComponents(manifest)
        .filter((c) => c.inBundle.startsWith("roles/"))
        .map((c) => c.inBundle);
      expect(inBundle.sort()).toEqual([...roles].map((r) => `roles/${r}.md`).sort());
    }
  });

  it("no other shipped card is a bundle-declared role (librarian and the directors are not role cards)", () => {
    const declared = new Set(
      Object.values(ROLE_CARDS)
        .flat()
        .map((r) => `${r}.md`),
    );
    const shipped = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
    expect(shipped.filter((f) => declared.has(f)).sort()).toEqual([...declared].sort());
  });
});

describe("staging — the seeded role cards ride the bundle, digest-verified (H2)", () => {
  it("stageModeBundles materializes each seeded card into its bundle's roles/, byte-identical, with receipt digest rows", () => {
    // hermetic source: the REAL registry copied to a temp extension root
    const src = mkdtempSync(join(tmpdir(), "role-cards-src-"));
    cpSync(MODES_DIR, join(src, "modes"), { recursive: true });
    cpSync(AGENTS_DIR, join(src, "agents"), { recursive: true });
    cpSync(join(EXT, "handoff-seeds"), join(src, "handoff-seeds"), { recursive: true });
    const dest = mkdtempSync(join(tmpdir(), "role-cards-dest-"));

    const r = stageModeBundles(src, dest);
    expect(r.outcome).toBe("staged");
    const receipt = JSON.parse(readFileSync(r.receiptPath!, "utf8")) as {
      modes: Array<{ mode: string; files: Array<{ path: string; sha256: string }> }>;
    };
    for (const [mode, roles] of Object.entries(ROLE_CARDS)) {
      const files = receipt.modes.find((m) => m.mode === mode)!.files;
      for (const role of roles) {
        const row = files.find((f) => f.path === `roles/${role}.md`);
        expect(row, `${mode}/roles/${role}.md on the deploy receipt`).toBeDefined();
        // digest-verified against the SEEDED bytes
        expect(row!.sha256).toBe(sha256(cardPath(role)));
        // byte-identical materialization inside the deployed bundle
        expect(readFileSync(join(dest, "modes", mode, "roles", `${role}.md`), "utf8")).toBe(
          cardText(role),
        );
      }
    }
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("tamper repair: a tampered deployed role component is repaired as a unit by the next pass", () => {
    const src = mkdtempSync(join(tmpdir(), "role-cards-src2-"));
    cpSync(MODES_DIR, join(src, "modes"), { recursive: true });
    cpSync(AGENTS_DIR, join(src, "agents"), { recursive: true });
    cpSync(join(EXT, "handoff-seeds"), join(src, "handoff-seeds"), { recursive: true });
    const dest = mkdtempSync(join(tmpdir(), "role-cards-dest2-"));
    stageModeBundles(src, dest);
    const deployedRole = join(dest, "modes", "autodev", "roles", "implementer.md");
    writeFileSync(deployedRole, "# TAMPERED ROLE\n");
    const r = stageModeBundles(src, dest);
    expect(r.outcome).toBe("staged");
    expect(readFileSync(deployedRole, "utf8")).toBe(cardText("implementer"));
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });
});

describe("role-card structural floor (pre-signature: shape, never flagged content)", () => {
  for (const role of ALL_ROLES) {
    it(`${role}: frontmatter — description, subagent mode, permission scoping, and NO overlay dispatch`, () => {
      const text = cardText(role);
      expect(text.startsWith("---\n")).toBe(true);
      const end = text.indexOf("\n---\n", 4);
      expect(end).toBeGreaterThan(-1);
      const fm = text.slice(4, end);
      expect(fm).toMatch(/^description:\s*\S/m);
      expect(fm).toMatch(/^mode:\s*subagent/m);
      expect(fm).toMatch(/^permission:\s*$/m);
      // role cards are bundle-owned registry artifacts, not overlay-tuned
      // worker cards (#758's architecture survives on librarian alone)
      expect(fm, `${role} must not carry a dispatch target`).not.toMatch(/^dispatch:/m);
    });

    it(`${role}: zero blocklisted proprietary strings / banned names`, () => {
      const text = cardText(role);
      for (const s of BLOCKED) {
        expect(text.toLowerCase().includes(s.toLowerCase()), `${role} must not contain "${s}"`).toBe(false);
      }
    });

    it(`${role}: the cast-card section structure — briefing, job, and rules`, () => {
      const text = cardText(role);
      expect(text).toMatch(/\*\*Briefing you receive:?\*\*/i);
      expect(text).toMatch(/\*\*Your job:?\*\*/i);
      expect(text).toMatch(/\*\*(Hard )?[Rr]ules:?\*\*/);
    });
  }
});

// The claims render live smoke (amicode #1682, brain flywheel slice 3) — the
// ONE non-hermetic render test, mirroring the distill/claims parity
// discipline: the REAL memory cards of the personal vault (read-only source)
// are projected into a TEMP registry by the real `amico claims project`
// (slice 2's migration path), the hot-layer index is rendered from those real
// claims by the real `amico claims render` into a TEMP vault layout — never
// the live vault — and the generated MEMORY.md is parsed by the REAL plugin
// reader (readIndexLines, byte-extracted from the extension's stack_state.ts),
// the exact code path that injects the memory index into every session.
//
// Two synthetic claims (adoption + confidence variance, clearly synthetic,
// TEMP registry only) prove the ranked order over the real pipeline: the
// adopted+high+recent one ranks FIRST, the stale+low one LAST — the day-one
// registry is all applied=0, so without them the ranking would be a uniform
// tie and the smoke would prove rendering, not ranking.
//
// Gate (the claims live smoke pattern): AMICO_CLAIMS_SMOKE=1 AND the personal
// vault's memory cards present. CI has neither → the suite skips honestly;
// the fleet server runs it real:
//   AMICO_CLAIMS_SMOKE=1 pnpm --filter @amicode/amico-run test:slow claims
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimsVerb } from "../../src/claims_verb.js";
import { personalMount, resolveMountStack } from "../../src/mounts.js";
import { loadPluginIndexReader } from "../helpers.js";

const mount = personalMount(resolveMountStack());
const memoryDir = mount !== undefined ? join(mount.path, "amicode", "memory") : undefined;
const gated = process.env.AMICO_CLAIMS_SMOKE === "1" && memoryDir !== undefined && existsSync(memoryDir!);

describe.skipIf(!gated)("claims render live smoke — real claims, ranked index, the real plugin reader", () => {
  it("renders the ranked hot-layer index from REAL projected claims and the plugin reader parses it unchanged", async () => {
    // 1. the real migration path: every real typed memory card → a temp registry.
    //    Reality (checked against the live vault 2026-10-02): 21 of the 47 cards
    //    honestly REFUSE projection — 20 carry no `description` (slice 2 never
    //    invents a statement) and one has malformed YAML frontmatter. Those
    //    refusals are the migration's own gate, not this slice's; the smoke
    //    requires only that every card either projects or refuses HONESTLY
    //    (exit 64, never a crash) and that enough real claims land to rank.
    const cards = readdirSync(memoryDir!)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort();
    expect(cards.length).toBeGreaterThan(10); // the real vault's memory layer, not a fixture
    const tmp = mkdtempSync(join(tmpdir(), "amico-render-smoke-"));
    try {
      // the temp vault mirrors the real layout — the registry at
      // amicode/claims/ and the index at amicode/memory/MEMORY.md — because the
      // generated bullets link their claims as ../claims/<file>, exactly the
      // shape the real vault's mount must resolve
      const vaultRoot = tmp;
      const registry = join(vaultRoot, "amicode", "claims");
      mkdirSync(join(vaultRoot, "amicode", "memory"), { recursive: true });
      let refused = 0;
      for (const card of cards) {
        const r = await claimsVerb(["project", join(memoryDir!, card), "--out", registry, "--apply"], {});
        if (r.code === 0) continue;
        expect(r.code, `projecting ${card}: a refusal must be exit 64, never a crash`).toBe(64);
        refused++;
      }
      const projected = readdirSync(registry).filter((f) => f.endsWith(".md"));
      expect(projected.length).toBeGreaterThan(10); // enough real claims to exercise ranking + caps

      // 2. the ranking proofs: synthetic adoption/confidence variance (TEMP registry only)
      writeFileSync(
        join(registry, "zz_synthetic_adopted.md"),
        "---\ntype: method\nstatement: synthetic-adopted — the ranking proof claim\nstatus: corroborated\nconfidence: high\nevidence: []\napplied: 7\nlast_applied: null\nhistory:\n  - date: 2026-09-30T00:00:00.000Z\n    event: applied\n    note: synthetic ranking proof (temp registry only, never the live vault)\nscope: personal\ntags: []\n---\n\nbody\n",
      );
      writeFileSync(
        join(registry, "aa_synthetic_stale.md"),
        "---\ntype: hazard\nstatement: synthetic-stale — the ranking proof claim\nstatus: unverified\nconfidence: low\nevidence: []\napplied: 0\nlast_applied: null\nhistory:\n  - date: 2026-01-01T00:00:00.000Z\n    event: created\n    note: synthetic ranking proof (temp registry only, never the live vault)\nscope: personal\ntags: []\n---\n\nbody\n",
      );

      // 3. the real render: the temp vault's index, real clock
      const out = join(vaultRoot, "amicode", "memory", "MEMORY.md");
      const r = await claimsVerb(["render", "--registry", registry, "--out", out, "--apply"], {});
      expect(r.code).toBe(0);
      const j = r.json as Record<string, unknown>;
      expect(j.skipped).toEqual([]); // every real card projected a contract object
      const bulletsReported = j.bullets as number;
      expect(bulletsReported).toBeGreaterThan(10);
      expect(bulletsReported).toBeLessThanOrEqual(50);

      // 4. the REAL plugin reader — byte-extracted from the extension source —
      //    parses the generated output unchanged
      const read = loadPluginIndexReader();
      const bullets = read(vaultRoot, join("memory", "MEMORY.md"), 50);
      expect(bullets.length).toBe(bulletsReported); // nothing lost, nothing truncated
      expect(bullets.every((b) => b.startsWith("- "))).toBe(true);

      // 5. ranked order over the real set: adopted+high+recent FIRST, stale+low LAST
      expect(bullets[0]!).toContain("synthetic-adopted");
      expect(bullets[bullets.length - 1]!).toContain("synthetic-stale");

      // 6. every bullet's pointer resolves — the index is a view of REAL claims
      for (const b of bullets) {
        const link = b.match(/\]\((\.\.\/claims\/([^)]+))\)/);
        expect(link, `bullet carries a claim link: ${b}`).not.toBeNull();
        expect(existsSync(join(vaultRoot, "amicode", "memory", link![1]))).toBe(true);
        expect(cards.includes(link![2]) || link![2].startsWith("zz_synthetic_") || link![2].startsWith("aa_synthetic_")).toBe(true);
      }

      // 7. the provenance header rides the file (derived, never authoritative)
      const text = readFileSync(out, "utf8");
      for (const needle of ["generated view", "amico claims render", "hand-edits are regenerated away by design"])
        expect(text).toContain(needle);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The claims live smoke (amicode #1681, brain flywheel slice 2) — the ONE
// non-hermetic claims test, mirroring the distill/notturno parity discipline:
// run the real `amico claims project` against a REAL memory card from the
// personal vault (read-only source), writing into a TEMP registry — never the
// live vault — then lint the projected claim with the REAL vault as substrate
// so the evidence pointer's resolvability is proven against live data.
//
// Gate (the distill live smoke pattern): AMICO_CLAIMS_SMOKE=1 AND the personal
// vault's memory cards present. CI has neither → the suite skips honestly;
// the fleet server runs it real:
//   AMICO_CLAIMS_SMOKE=1 pnpm --filter @amicode/amico-run test:slow claims
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { claimsVerb } from "../../src/claims_verb.js";
import { parseClaimNote } from "../../src/claims.js";
import { validateClaim } from "@amicode/schema";
import { personalMount, resolveMountStack } from "../../src/mounts.js";

const mount = personalMount(resolveMountStack());
const memoryDir = mount !== undefined ? join(mount.path, "amicode", "memory") : undefined;
const gated = process.env.AMICO_CLAIMS_SMOKE === "1" && memoryDir !== undefined && existsSync(memoryDir!);

describe.skipIf(!gated)("claims live smoke — a real memory card, projected + linted real", () => {
  it("projects a real card into a temp registry with every field preserved, and the claim lints clean against the real vault", async () => {
    // the first REAL typed memory card on disk (deterministic order; MEMORY.md
    // is the hand-maintained index, not a card — the verb refuses it honestly)
    const card = readdirSync(memoryDir!)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort()[0]!;
    const cardPath = join(memoryDir!, card);
    const raw = readFileSync(cardPath, "utf8");

    const tmp = mkdtempSync(join(tmpdir(), "amico-claims-smoke-"));
    try {
      const registry = join(tmp, "claims");
      const noon = () => new Date("2026-10-02T12:00:00.000Z");
      const r = await claimsVerb(["project", cardPath, "--out", registry, "--apply"], {}, { now: noon });
      expect(r.code).toBe(0);

      const written = join(registry, card);
      const parsed = parseClaimNote(readFileSync(written, "utf8"));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        // the projection emitted a contract object
        expect(validateClaim(parsed.claim)).toEqual({ ok: true, errors: [] });
        // provenance intact: the evidence pointer names the real card
        expect(parsed.claim.evidence).toEqual([`memory-card/${card}`]);
      }
      // all fields preserved: the original card's frontmatter lines ride the
      // note verbatim (the preserved frontmatter block), and the body's first
      // non-empty line survives the verbatim body section
      const note = readFileSync(written, "utf8");
      for (const line of raw.split("---")[1]!.split("\n")) {
        if (line.trim() !== "") expect(note).toContain(line);
      }
      const bodyFirstLine = raw.replace(/^---[\s\S]*?---[ \t]*\r?\n?/, "").split("\n").find((l) => l.trim() !== "")!;
      expect(note).toContain(bodyFirstLine);

      // and the registry lints CLEAN with the real vault as substrate
      const lint = await claimsVerb(["lint", "--registry", registry, "--vault", mount!.path], {});
      expect(lint.code).toBe(0);
      expect((lint.json as Record<string, unknown>).clean).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

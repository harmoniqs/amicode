// Golden compiled-output parity (WS1 #369, AC2): the extension loads the
// existing pulse-designer repertoire through a pack manifest with
// BYTE-IDENTICAL compiled output against today's golden.
//
// The goldens are generated from TODAY's path (loadRepertoire) with:
//   GEN_GOLDEN=1 pnpm vitest run test/scores/golden_parity.test.ts
// and committed. The parity assertions then pin TWO things:
//   1. the pack path reproduces today's path byte-for-byte (same compiled
//      sections, same absolute template paths via identical score dirs), and
//   2. both paths keep matching the committed golden — so when WS2 folds
//      scores/ into the pack and loadRepertoire retires, the golden remains
//      the arbiter.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileScore, compileChainedScore } from "../../src/scores/compiler";
import { loadRepertoire } from "../../src/scores/loader";
import { loadPacks } from "../../src/scores/packs";
import { buildRouterSection } from "../../src/scores/router";

const SCORES_ROOT = path.resolve(__dirname, "..", "..", "scores");
const PACKS_ROOT = path.resolve(__dirname, "..", "..", "packs");
const GOLDEN_DIR = path.resolve(__dirname, "golden");

// The compiled output embeds ABSOLUTE template paths, which differ per
// checkout. The goldens are therefore stored PATH-PORTABLE: the repo root is
// normalized to <workspace> on both write and compare. The pack-vs-today
// equivalence assertions below stay RAW (same machine, strict byte equality);
// only the golden-file comparisons are normalized.
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");
const portable = (s: string) => s.split(WORKSPACE_ROOT).join("<workspace>");

function today() {
  const load = loadRepertoire(SCORES_ROOT);
  const score0 = load.scores.find((s) => s.manifest.id === "pulse-designer");
  const overture = load.scores.find((s) => s.manifest.id === "overture");
  if (!score0 || !overture) throw new Error("today's repertoire is missing pulse-designer/overture");
  return { load, score0, overture };
}

function viaPack() {
  const load = loadPacks([PACKS_ROOT]);
  const pack = load.packs.find((p) => p.manifest.id === "quantum-control");
  if (!pack) throw new Error(`default pack not found; errors: ${JSON.stringify(load.errors)}`);
  const primary = pack.scores.find((s) => s.manifest.id === pack.manifest.onboarding.primary);
  const head = pack.scores.find((s) => s.manifest.id === pack.manifest.onboarding.head);
  if (!primary || !head) throw new Error("pack onboarding chain not resolvable in its own scores");
  return { load, pack, primary, head };
}

function golden(name: string, content: string): string {
  const file = path.join(GOLDEN_DIR, name);
  if (process.env.GEN_GOLDEN) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, portable(content));
    return portable(content);
  }
  return fs.readFileSync(file, "utf8");
}

// Today's compiled surfaces (the pre-refactor baseline this slice snapshots).
function todaySurfaces() {
  const { load, score0, overture } = today();
  return {
    compileScore: compileScore(score0),
    compileChained: compileChainedScore(overture, score0),
    router: buildRouterSection(load.scores),
  };
}

describe("golden parity — the pack path is byte-identical to today's path", () => {
  it("the bundled default pack loads clean (no errors)", () => {
    expect(viaPack().load.errors).toEqual([]);
  });

  it("pack scores resolve to TODAY's score dirs (template paths identical)", () => {
    const { score0, overture } = today();
    const { primary, head } = viaPack();
    expect(primary.dir).toBe(score0.dir);
    expect(head.dir).toBe(overture.dir);
  });

  it("compileScore(pulse-designer) === today === golden", () => {
    const t = todaySurfaces();
    const p = viaPack();
    expect(compileScore(p.primary)).toBe(t.compileScore); // raw byte equality
    expect(portable(t.compileScore)).toBe(golden("compile-score.md", t.compileScore));
  });

  it("compileChainedScore(overture → pulse-designer) === today === golden", () => {
    const t = todaySurfaces();
    const { primary, head } = viaPack();
    expect(compileChainedScore(head, primary)).toBe(t.compileChained); // raw byte equality
    expect(portable(t.compileChained)).toBe(golden("compile-chained.md", t.compileChained));
  });

  it("buildRouterSection over the pack's visible scores === today === golden", () => {
    const t = todaySurfaces();
    const { pack } = viaPack();
    // the router renders the repertoire in the order it is handed; the pack's
    // manifest order must reproduce today's effective order exactly
    expect(buildRouterSection(pack.scores)).toBe(t.router);
    expect(portable(t.router)).toBe(golden("router-section.md", t.router));
  });
});

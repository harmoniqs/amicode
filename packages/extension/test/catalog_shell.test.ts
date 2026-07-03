import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrateFromRunDir } from "../src/catalog_card_shell";
import { SessionCatalogTree, type SessionCatalogEntry } from "../src/trees";

// The save-to-catalog flow (#47): entry hydration from real run artifacts,
// and the session catalog (pointer records in workspaceState — NOT the
// Phase-3 CatalogStore; Q91/Q92 open).

function stageRun(opts: { pulseLines?: string; gate?: string; system?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "card-run-"));
  writeFileSync(join(dir, "run.toml"),
    'schema_version = "1"\nrun_id = "r20260703-000000Z-cafe"\nlab_id = "default"\nscript_path = "/s.jl"\n' +
    'lab = "default"\ncreated_at = "2026-07-03T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n');
  const params = [
    opts.system ? `system = "${opts.system}"` : "",
    opts.gate ? `gate = "${opts.gate}"` : "",
    "levels = 3",
  ].filter(Boolean).join("\n");
  writeFileSync(join(dir, "result.toml"),
    `schema_version = "1"\nfidelity = 0.9998\niterations = 60\nwall_seconds = 41.5\n[params]\n${params}\n`);
  if (opts.pulseLines !== undefined) writeFileSync(join(dir, "run.log"), opts.pulseLines);
  return dir;
}

describe("hydrateFromRunDir — entry from real run artifacts", () => {
  it("maps identity, fidelity, params (gate lifted to top level), proposed block, and the newest pulse", () => {
    const dir = stageRun({
      gate: "X", system: "transmon",
      pulseLines:
        'AMICODE_PULSE_META drives=1 knots=2 labels="u_1" bounds=-0.2:0.2\n' +
        "AMICODE_PULSE iter=1 dt=0.2 a=0.1,0.2\n" +
        "AMICODE_PULSE iter=2 dt=0.2 a=0.3,0.4\n",
    });
    const data = hydrateFromRunDir(dir)!;
    expect(data.entry).toMatchObject({
      run_id: "r20260703-000000Z-cafe",
      lab_id: "default",
      gate: "X",
      fidelity: 0.9998,
      proposed: { iterations: 60, wall_seconds: 41.5 },
    });
    expect((data.entry.params as Record<string, unknown>).system).toBe("transmon");
    expect(data.pulse).toMatchObject({ record: { iter: 2 } });   // newest record, not the first
  });

  it("degrades: no run.log → no pulse; missing result.toml → undefined", () => {
    const dir = stageRun({ gate: "X" });
    expect(hydrateFromRunDir(dir)!.pulse).toBeUndefined();
    const empty = mkdtempSync(join(tmpdir(), "card-empty-"));
    expect(hydrateFromRunDir(empty)).toBeUndefined();
  });
});

describe("SessionCatalogTree — pointer records, newest first", () => {
  function makeCtx() {
    const store = new Map<string, unknown>();
    return {
      workspaceState: {
        get: (k: string, d: unknown) => (store.has(k) ? store.get(k) : d),
        update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
      },
    } as never;
  }
  const entry = (run_id: string, over: Partial<SessionCatalogEntry> = {}): SessionCatalogEntry => ({
    run_id, runDir: `/runs/${run_id}`, lab_id: "default", fidelity: 0.999,
    gate: "X", system: "transmon", saved_at: "2026-07-03T00:00:00Z", ...over,
  });

  it("saves newest-first, dedupes by run_id, and rows open the card for the run dir", async () => {
    const tree = new SessionCatalogTree(makeCtx());
    await tree.save(entry("r1"));
    await tree.save(entry("r2"));
    await tree.save(entry("r1", { fidelity: 0.5 }));   // re-save moves to front, replaces
    const rows = tree.getChildren() as SessionCatalogEntry[];
    expect(rows.map((r) => r.run_id)).toEqual(["r1", "r2"]);
    expect(rows[0].fidelity).toBe(0.5);

    const item = tree.getTreeItem(rows[1]) as { label: string; command?: { command: string; arguments: unknown[] } };
    expect(item.label).toContain("transmon");
    expect(item.command?.command).toBe("amicode.catalogCard.open");
    expect(item.command?.arguments).toEqual(["/runs/r2", "transmon", undefined]);   // runDir + name + tags → card
  });

  it("empty state renders the hint row", () => {
    const tree = new SessionCatalogTree(makeCtx());
    const rows = tree.getChildren();
    expect(rows).toHaveLength(1);
    expect(String(rows[0])).toContain("empty");
  });
});

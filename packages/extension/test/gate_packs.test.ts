import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { validateGatePack } from "@amicode/schema";

// Gate-pack fixtures of record: the research pack (extracted from the live
// director research protocol) and the dev pack (extracted from the issue-DAG
// walk). This suite IS the spec's gate_pack_mapping_complete criterion:
// pack schema, forward + reverse mapping completeness, non-triviality
// floors, distinctness, and faithfulness of the extraction.
//
// #804 re-home: the packs live in their mode bundles — modes/autodev/pack.toml
// and modes/autoresearch/pack.toml — same tests, new home. The structural
// schema checks now run through the shared validator (validateGatePack), the
// same code the amico-run doctor probe imports; the fixture-content floors
// stay here.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const MODES_DIR = path.join(EXT, "modes");
const PACK_DIR = MODES_DIR; // each bundle's pack.toml — the registry layout

const GATE_KINDS = ["mechanical", "human", "derived"] as const;
const HANDOFF_KINDS = ["issue_seed", "hypothesis_seed"] as const;
const HANDOFF_TARGETS = ["autoresearch", "autodev"] as const;

interface Gate {
  name: string;
  kind: string;
  owner: string;
  procedure: string;
}

interface Phase {
  name: string;
  gates?: Gate[];
  roles?: string[];
}

interface Handoff {
  kind: string;
  target: string;
}

interface Pack {
  phases?: Phase[];
  closing_artifact?: string;
  handoffs?: Handoff[];
}

function loadPack(file: string): Pack {
  return parse(fs.readFileSync(path.join(PACK_DIR, file), "utf8")) as unknown as Pack;
}

const research = loadPack(path.join("autoresearch", "pack.toml"));
const dev = loadPack(path.join("autodev", "pack.toml"));
const PACKS: Array<[string, Pack]> = [
  ["research", research],
  ["dev", dev],
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function phases(pack: Pack): Phase[] {
  return Array.isArray(pack.phases) ? (pack.phases as Phase[]) : [];
}

function gates(pack: Pack): Array<{ phase: string; gate: Gate }> {
  const out: Array<{ phase: string; gate: Gate }> = [];
  for (const phase of phases(pack)) {
    for (const gate of phase.gates ?? []) out.push({ phase: phase.name, gate });
  }
  return out;
}

function roles(pack: Pack): string[] {
  return phases(pack).flatMap((p) => p.roles ?? []);
}

// Normalized-text equality: case-insensitive, whitespace collapsed.
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function gateByName(pack: Pack, name: string): Gate {
  const found = gates(pack).find((g) => g.gate.name === name);
  expect(found, `gate ${name} missing`).toBeDefined();
  return found!.gate;
}

describe("gate-pack fixtures of record", () => {
  it("the packs live inside their mode bundles (the registry re-home, #804) — no stray gate-packs dir", () => {
    // the registry layout: one bundle per director mode, pack.toml inside
    expect(fs.readdirSync(MODES_DIR).sort()).toEqual(["autodev", "autoresearch", "release-index.toml"]);
    expect(fs.existsSync(path.join(EXT, "gate-packs"))).toBe(false);
    for (const [name, mode] of [["dev", "autodev"], ["research", "autoresearch"]] as const) {
      expect(fs.existsSync(path.join(MODES_DIR, mode, "pack.toml")), `${name} pack in its bundle`).toBe(true);
    }
  });

  it("both packs pass the SHARED validator's gate-pack schema (one code path with the doctor)", () => {
    for (const mode of ["autodev", "autoresearch"]) {
      const v = validateGatePack(fs.readFileSync(path.join(MODES_DIR, mode, "pack.toml"), "utf8"));
      expect(v.errors, `${mode}: ${v.errors.join("; ")}`).toEqual([]);
      expect(v.ok).toBe(true);
    }
  });
});

describe.each(PACKS)("%s pack: schema", (_name, pack) => {
  it("has exactly the pack fields: phases, closing_artifact, handoffs", () => {
    expect(Object.keys(pack).sort()).toEqual(["closing_artifact", "handoffs", "phases"]);
  });

  it("declares exactly one closing artifact, a non-empty string", () => {
    // The strict pack-key set above guarantees there is no second artifact field.
    expect(isNonEmptyString(pack.closing_artifact)).toBe(true);
  });

  it("gives every phase a name and a gates array, carrying only schema'd keys", () => {
    for (const phase of phases(pack)) {
      expect(isNonEmptyString(phase.name)).toBe(true);
      expect(Array.isArray(phase.gates)).toBe(true);
      const keys = Object.keys(phase).sort();
      const allowed =
        JSON.stringify(keys) === JSON.stringify(["gates", "name"]) ||
        JSON.stringify(keys) === JSON.stringify(["gates", "name", "roles"]);
      expect(allowed, `phase keys ${keys.join(",")}`).toBe(true);
    }
  });

  it("gives every gate exactly name, kind, owner, procedure — all non-empty strings", () => {
    for (const { gate } of gates(pack)) {
      expect(Object.keys(gate).sort()).toEqual(["kind", "name", "owner", "procedure"]);
      expect(isNonEmptyString(gate.name)).toBe(true);
      expect(isNonEmptyString(gate.kind)).toBe(true);
      expect(isNonEmptyString(gate.owner)).toBe(true);
      expect(isNonEmptyString(gate.procedure)).toBe(true);
    }
  });

  it("enforces the gate-kind vocabulary: mechanical | human | derived", () => {
    for (const { gate } of gates(pack)) {
      expect(GATE_KINDS, `gate ${gate.name} kind ${gate.kind}`).toContain(gate.kind);
    }
  });

  it("gives every handoff exactly kind and target, each in vocabulary", () => {
    for (const handoff of pack.handoffs ?? []) {
      expect(Object.keys(handoff).sort()).toEqual(["kind", "target"]);
      expect(HANDOFF_KINDS).toContain(handoff.kind);
      expect(HANDOFF_TARGETS).toContain(handoff.target);
    }
  });
});

describe.each(PACKS)("%s pack: forward mapping completeness", (_name, pack) => {
  it("every phase carries at least one gate", () => {
    for (const phase of phases(pack)) {
      expect((phase.gates ?? []).length, `phase ${phase.name}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("names exactly one closing artifact", () => {
    expect(isNonEmptyString(pack.closing_artifact)).toBe(true);
  });

  it("every gate names an owner and a kind", () => {
    for (const { gate } of gates(pack)) {
      expect(isNonEmptyString(gate.owner), `${gate.name}.owner`).toBe(true);
      expect(isNonEmptyString(gate.kind), `${gate.name}.kind`).toBe(true);
    }
  });

  it("every role appears in at least one phase", () => {
    for (const role of new Set(roles(pack))) {
      expect(phases(pack).some((p) => (p.roles ?? []).includes(role)), `role ${role}`).toBe(true);
    }
  });
});

describe.each(PACKS)("%s pack: reverse mapping completeness", (_name, pack) => {
  it("every gate belongs to a phase (no pack-level or orphan gates)", () => {
    // Gates are reachable only through phases[].gates (strict pack and phase
    // key sets), so no gate can exist outside a phase; count consistency
    // proves the enumeration sees them all.
    expect("gates" in pack).toBe(false);
    const viaPhases = phases(pack).reduce((n, p) => n + (p.gates ?? []).length, 0);
    expect(gates(pack).length).toBe(viaPhases);
    for (const { gate } of gates(pack)) {
      expect(isNonEmptyString(gate.name)).toBe(true);
    }
  });

  it("every role belongs to the pack — a non-empty string declared inside a phase", () => {
    for (const phase of phases(pack)) {
      for (const role of phase.roles ?? []) {
        expect(isNonEmptyString(role), `role in phase ${phase.name}`).toBe(true);
      }
    }
  });

  it("every handoff has a target kind (a named autonomous mode)", () => {
    for (const handoff of pack.handoffs ?? []) {
      expect(HANDOFF_TARGETS, `handoff target ${handoff.target}`).toContain(handoff.target);
    }
  });
});

describe.each(PACKS)("%s pack: non-triviality floors", (_name, pack) => {
  it("declares at least 3 phases", () => {
    expect(phases(pack).length).toBeGreaterThanOrEqual(3);
  });

  it("carries at least 5 gates", () => {
    expect(gates(pack).length).toBeGreaterThanOrEqual(5);
  });

  it("carries at least one gate of each kind: mechanical, human, derived", () => {
    const kinds = new Set(gates(pack).map((g) => g.gate.kind));
    for (const kind of GATE_KINDS) {
      expect(kinds.has(kind), `no ${kind} gate`).toBe(true);
    }
  });

  it("every phase that declares roles declares at least one", () => {
    for (const phase of phases(pack)) {
      if (phase.roles !== undefined) {
        expect(phase.roles.length, `phase ${phase.name}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("declares at least one handoff", () => {
    expect((pack.handoffs ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("gate names are unique within the pack", () => {
    const names = gates(pack).map((g) => g.gate.name);
    expect(new Set(names).size, `duplicate gate names`).toBe(names.length);
  });

  it("gate procedures are pairwise distinct under normalized-text equality", () => {
    const procedures = gates(pack).map((g) => normalize(g.gate.procedure));
    for (let i = 0; i < procedures.length; i++) {
      for (let j = i + 1; j < procedures.length; j++) {
        expect(procedures[i] === procedures[j], `procedures ${i} and ${j} collide`).toBe(false);
      }
    }
  });
});

describe("research pack extraction (faithful to the director research protocol)", () => {
  it("runs the five phases hypothesize → deliberate → experiment → gate → analyze", () => {
    expect(phases(research).map((p) => p.name)).toEqual([
      "hypothesize",
      "deliberate",
      "experiment",
      "gate",
      "analyze",
    ]);
  });

  it("carries the spec-review gate: mechanical, round budget of 3, no unreviewed launch-shaped work", () => {
    const gate = gateByName(research, "spec-review");
    expect(gate.kind).toBe("mechanical");
    expect(gate.procedure).toContain("round budget of 3");
    expect(gate.procedure).toContain("launch-shaped");
  });

  it("carries run gates whose verdicts derive from commands, never self-reported", () => {
    const gate = gateByName(research, "run-gates");
    expect(gate.kind).toBe("mechanical");
    expect(gate.procedure).toContain("self-reported");
  });

  it("carries catalog promotion as human-only", () => {
    const gate = gateByName(research, "catalog-promotion");
    expect(gate.kind).toBe("human");
    expect(gate.owner).toBe("human");
    expect(gate.procedure).toContain("human-only");
  });

  it("carries the protocol's additional gates: advisory closure and ledger commit", () => {
    expect(gateByName(research, "advisory-closure").procedure).toContain("waived");
    expect(gateByName(research, "ledger-commit").procedure).toContain("sole writer");
  });

  it("casts hypothesizer, experimenter, analyzer — each bound to its phase", () => {
    const byPhase = new Map(phases(research).map((p) => [p.name, p.roles ?? []]));
    expect(byPhase.get("hypothesize")).toEqual(["hypothesizer"]);
    expect(byPhase.get("experiment")).toEqual(["experimenter"]);
    expect(byPhase.get("analyze")).toEqual(["analyzer"]);
    expect(new Set(roles(research))).toEqual(
      new Set(["hypothesizer", "experimenter", "analyzer"]),
    );
  });

  it("closes with the experiment note + ledger delta", () => {
    expect(research.closing_artifact).toContain("experiment note");
    expect(research.closing_artifact).toContain("ledger delta");
  });

  it("hands off issue seeds to the dev mode", () => {
    expect((research.handoffs ?? []).length).toBeGreaterThanOrEqual(1);
    for (const handoff of research.handoffs ?? []) {
      expect(handoff.kind).toBe("issue_seed");
      expect(handoff.target).toBe("autodev");
    }
  });
});

describe("dev pack extraction (faithful to the issue-DAG walk)", () => {
  it("runs the three phases decompose → implement → integrate", () => {
    expect(phases(dev).map((p) => p.name)).toEqual(["decompose", "implement", "integrate"]);
  });

  it("carries the dev gate: issue + PR before any package work", () => {
    const gate = gateByName(dev, "dev-gate");
    expect(gate.kind).toBe("mechanical");
    expect(gate.procedure).toContain("issue");
    expect(gate.procedure).toContain("PR");
  });

  it("carries TDD red-green with the test-protection clause", () => {
    const gate = gateByName(dev, "tdd-red-green");
    expect(gate.kind).toBe("mechanical");
    expect(gate.procedure).toContain("force green");
  });

  it("carries the draft-PR lifecycle: draft at first commit, ready only when green, never merge non-green", () => {
    const gate = gateByName(dev, "draft-pr-lifecycle");
    expect(gate.kind).toBe("derived");
    expect(gate.procedure).toContain("draft");
    expect(gate.procedure).toContain("non-green");
  });

  it("carries review as a human gate where the reviewer is never the implementer", () => {
    const gate = gateByName(dev, "review");
    expect(gate.kind).toBe("human");
    expect(gate.procedure).toContain("never the implementer");
  });

  it("binds one role: the implementer, worktree-bound and merge-free", () => {
    const implement = phases(dev).find((p) => p.name === "implement");
    expect(implement?.roles).toEqual(["implementer"]);
    expect(new Set(roles(dev))).toEqual(new Set(["implementer"]));
    expect(gateByName(dev, "tdd-red-green").procedure).toContain("worktree");
    expect(gateByName(dev, "draft-pr-lifecycle").procedure).toContain("never merges");
  });

  it("closes with the landed-delta record", () => {
    expect(dev.closing_artifact).toContain("landed-delta record");
  });

  it("hands off hypothesis seeds to the research mode", () => {
    expect((dev.handoffs ?? []).length).toBeGreaterThanOrEqual(1);
    for (const handoff of dev.handoffs ?? []) {
      expect(handoff.kind).toBe("hypothesis_seed");
      expect(handoff.target).toBe("autoresearch");
    }
  });
});

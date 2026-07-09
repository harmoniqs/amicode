// Tests for the amicode_* tool pack's entity layer (opencode-plugin/entities.ts).
//
// entities.ts is deliberately dependency-free (it is imported by the opencode
// plugin, which executes inside opencode's embedded Bun runtime, NOT in the
// extension bundle) — so these tests exercise it as plain functions. Round-trips
// go through `smol-toml`, the SAME parser @amicode/schema and the extension use
// (run_dir_reader.ts, schema/src/index.ts) — what these serializers emit must be
// readable by the validators downstream.
//
// The plugin module itself (amicode_tools.ts) is NOT imported here: it holds a
// module-scope console.log + fs side effects and must keep a single plugin-function
// export (opencode's getLegacyPlugins throws on any extra export). Its runtime
// loading is verified against the real binary (see the night-build handoff), not
// in vitest.
import { describe, it, expect } from "vitest";
import { parse } from "smol-toml";
import {
  systemToml,
  formulationToml,
  runStubToml,
  deviceSessionStubToml,
  calibrationStubToml,
  validateSystem,
  validateFormulation,
  updateSystem,
  validateCompositeSystem,
  compositeSystemWarnings,
  normalizeSystem,
  updateCompositeSystem,
  compositeSystemToml,
  expandTopology,
  replicateHomogeneous,
  type CompositeSystem,
  canonicalJson,
  deriveSlug,
  entityDiff,
  truncateDiffForSentinel,
  problemToml,
  runRefsToml,
  type SystemEntity,
  type FormulationEntity,
  type ProblemMeta,
} from "../opencode-plugin/entities";

const SYS: SystemEntity = {
  platform: "transmon",
  levels: 3,
  params: { omega: 4.8, delta: -0.2 },
};

const FORM: FormulationEntity = {
  problem: "gate_synthesis",
  target: "X",
  objective: "unitary infidelity",
  constraints: ["amplitude bound (drive_max)", "smoothness"],
};

describe("systemToml", () => {
  it("emits valid TOML that round-trips through smol-toml (the repo parser)", () => {
    const doc = parse(systemToml(SYS)) as any;
    expect(doc.system).toBeDefined(); // [system] header
    expect(doc.system.platform).toBe("transmon");
    expect(doc.system.levels).toBe(3);
    expect(doc.system.params.omega).toBeCloseTo(4.8);
    expect(doc.system.params.delta).toBeCloseTo(-0.2);
  });
  it("stamps an ISO-8601 `recorded` field (quoted string — parseable, no TomlDate surprises)", () => {
    const doc = parse(systemToml(SYS)) as any;
    expect(typeof doc.system.recorded).toBe("string");
    expect(Number.isNaN(Date.parse(doc.system.recorded))).toBe(false);
  });
  it("accepts the levels boundary values 2 and 6", () => {
    expect(() => systemToml({ ...SYS, levels: 2 })).not.toThrow();
    expect(() => systemToml({ ...SYS, levels: 6 })).not.toThrow();
  });
  it("accepts an arbitrary platform, rejects an empty one (opened model, spec A)", () => {
    expect(() => systemToml({ ...SYS, platform: "gkp-cavity" })).not.toThrow();
    expect(() => systemToml({ ...SYS, platform: "" })).toThrow(/platform/);
  });
  it("rejects levels < 2 and non-integers, but allows levels > 6 (warning, not error)", () => {
    expect(() => systemToml({ ...SYS, levels: 1 })).toThrow(/levels/);
    expect(() => systemToml({ ...SYS, levels: 3.5 })).toThrow(/levels/);
    expect(() => systemToml({ ...SYS, levels: 7 })).not.toThrow();
  });
  it("rejects non-finite param values (NaN/Infinity have no TOML representation)", () => {
    expect(() => systemToml({ ...SYS, params: { omega: NaN } })).toThrow(/param/);
    expect(() => systemToml({ ...SYS, params: { omega: Infinity } })).toThrow(/param/);
  });
  it("quotes param keys that are not TOML bare keys", () => {
    const doc = parse(systemToml({ ...SYS, params: { "drive max": 0.2 } })) as any;
    expect(doc.system.params["drive max"]).toBeCloseTo(0.2);
  });
});

describe("formulationToml", () => {
  it("round-trips problem/target/objective/constraints under [formulation]", () => {
    const doc = parse(formulationToml(FORM)) as any;
    expect(doc.formulation.problem).toBe("gate_synthesis");
    expect(doc.formulation.target).toBe("X");
    expect(doc.formulation.objective).toBe("unitary infidelity");
    expect(doc.formulation.constraints).toEqual(FORM.constraints);
    expect(Number.isNaN(Date.parse(doc.formulation.recorded))).toBe(false);
  });
  it("escapes quotes, backslashes, and newlines in string values (round-trip exact)", () => {
    const nasty = 'say "hi" \\ then\nnewline\ttab';
    const doc = parse(formulationToml({ ...FORM, target: nasty, constraints: [nasty] })) as any;
    expect(doc.formulation.target).toBe(nasty);
    expect(doc.formulation.constraints).toEqual([nasty]);
  });
  it("rejects an empty or whitespace-only target", () => {
    expect(() => formulationToml({ ...FORM, target: "" })).toThrow(/target/);
    expect(() => formulationToml({ ...FORM, target: "   " })).toThrow(/target/);
  });
  it("rejects an empty problem", () => {
    expect(() => formulationToml({ ...FORM, problem: "" })).toThrow(/problem/);
  });
});

describe("validateSystem / validateFormulation", () => {
  it("return [] for valid entities", () => {
    expect(validateSystem(SYS)).toEqual([]);
    expect(validateFormulation(FORM)).toEqual([]);
  });
  it("name the offending field in each problem message", () => {
    expect(validateSystem({ ...SYS, platform: "" as any }).join(" ")).toMatch(/platform/);
    expect(validateSystem({ ...SYS, levels: 1 }).join(" ")).toMatch(/levels/);
    expect(validateFormulation({ ...FORM, target: "" }).join(" ")).toMatch(/target/);
  });
});

describe("updateSystem (the amicode_set_model merge)", () => {
  it("merges levels and params, preserving untouched params and the platform", () => {
    const merged = updateSystem(SYS, { levels: 4, params: { drive_max: 0.2, delta: -0.25 } });
    expect(merged.platform).toBe("transmon");
    expect(merged.levels).toBe(4);
    expect(merged.params.omega).toBeCloseTo(4.8); // untouched param preserved
    expect(merged.params.delta).toBeCloseTo(-0.25); // overwritten
    expect(merged.params.drive_max).toBeCloseTo(0.2); // added
  });
  it("does not mutate the input entity", () => {
    const before = JSON.parse(JSON.stringify(SYS));
    updateSystem(SYS, { levels: 5, params: { omega: 5.1 } });
    expect(SYS).toEqual(before);
  });
  it("leaves levels alone when the patch omits it", () => {
    expect(updateSystem(SYS, { params: { drive_max: 0.3 } }).levels).toBe(3);
  });
  it("throws when the merge would produce an invalid entity", () => {
    expect(() => updateSystem(SYS, { levels: 1 })).toThrow(/levels/);
    expect(() => updateSystem(SYS, { params: { omega: NaN } })).toThrow(/param/);
  });
});

describe("runStubToml (bookkeeping stub — NOT amico-run's run.toml)", () => {
  it("round-trips refs + launched_via under [run]", () => {
    const doc = parse(
      runStubToml({
        formulation_ref: "/home/u/.amico/runs/default/_entities/formulation.toml",
        system_ref: "/home/u/.amico/runs/default/_entities/system.toml",
        run_dir: "/home/u/.amico/runs/default/20260703-021500-abcd",
        note: "X gate, defaults",
      }),
    ) as any;
    expect(doc.run.launched_via).toBe("bash amico-run"); // the tool never launches — bash does
    expect(doc.run.formulation_ref).toMatch(/formulation\.toml$/);
    expect(doc.run.system_ref).toMatch(/system\.toml$/);
    expect(doc.run.run_dir).toMatch(/20260703-021500-abcd$/);
    expect(doc.run.note).toBe("X gate, defaults");
    expect(Number.isNaN(Date.parse(doc.run.recorded))).toBe(false);
  });
  it("omits absent optional refs instead of writing empty strings", () => {
    const doc = parse(runStubToml({})) as any;
    expect(doc.run.launched_via).toBe("bash amico-run");
    expect("formulation_ref" in doc.run).toBe(false);
    expect("system_ref" in doc.run).toBe(false);
    expect("note" in doc.run).toBe(false);
    expect("verification" in doc.run).toBe(false); // spec C: absent until amicode_verify
  });
  it("round-trips the free-tier verification sub-table (spec C)", () => {
    const doc = parse(
      runStubToml({
        tier: "free",
        verification: { agree: false, fidelity_rerolled: 0.0004, fidelity_reported: 0.9999 },
      }),
    ) as any;
    expect(doc.run.tier).toBe("free");
    expect(doc.run.verification.agree).toBe(false);
    expect(doc.run.verification.fidelity_rerolled).toBeCloseTo(0.0004);
    expect(doc.run.verification.fidelity_reported).toBeCloseTo(0.9999);
  });
});

describe("deviceSessionStubToml (stage-8 guided stub — NO device I/O in this build)", () => {
  it("round-trips refs + the fixed gate/checks under [device_session]", () => {
    const doc = parse(
      deviceSessionStubToml({
        pulse_ref: "/home/u/.amico/runs/default/20260703-021500-abcd/pulse.jld2",
        run_dir: "/home/u/.amico/runs/default/20260703-021500-abcd",
        note: "X gate pulse, F=0.9999",
      }),
    ) as any;
    expect(doc.device_session.gate).toBe("pending-human-signoff"); // never auto-approved
    expect(doc.device_session.checks).toEqual([
      // the send-to-device gate's auto checks
      "fidelity>=threshold",
      "|drive|<=cap",
      "bandwidth",
      "leakage",
    ]);
    expect(doc.device_session.pulse_ref).toMatch(/pulse\.jld2$/);
    expect(doc.device_session.run_dir).toMatch(/20260703-021500-abcd$/);
    expect(doc.device_session.note).toBe("X gate pulse, F=0.9999");
    expect(Number.isNaN(Date.parse(doc.device_session.recorded))).toBe(false);
  });
  it("omits absent optional refs; gate + checks are always present", () => {
    const doc = parse(deviceSessionStubToml({})) as any;
    expect(doc.device_session.gate).toBe("pending-human-signoff");
    expect(doc.device_session.checks).toHaveLength(4);
    expect("pulse_ref" in doc.device_session).toBe(false);
    expect("run_dir" in doc.device_session).toBe(false);
    expect("note" in doc.device_session).toBe(false);
  });
  it("rejects given-but-empty refs (a caller bug, not an omission)", () => {
    expect(() => deviceSessionStubToml({ pulse_ref: "" })).toThrow(/pulse_ref/);
    expect(() => deviceSessionStubToml({ run_dir: "   " })).toThrow(/run_dir/);
  });
});

describe("calibrationStubToml (guided follow-up stub — loop not wired in this build)", () => {
  it("round-trips the ref + fixed loop/status under [calibration]", () => {
    const doc = parse(
      calibrationStubToml({
        device_session_ref: "/home/u/.amico/runs/default/_entities/device_session.toml",
        note: "after first hardware shots",
      }),
    ) as any;
    expect(doc.calibration.loop).toBe("ILC"); // the loop that follows hardware runs
    expect(doc.calibration.status).toBe("not-wired"); // honest: recorded follow-up only tonight
    expect(doc.calibration.device_session_ref).toMatch(/device_session\.toml$/);
    expect(doc.calibration.note).toBe("after first hardware shots");
    expect(Number.isNaN(Date.parse(doc.calibration.recorded))).toBe(false);
  });
  it("omits absent optionals; loop + status are always present", () => {
    const doc = parse(calibrationStubToml({})) as any;
    expect(doc.calibration.loop).toBe("ILC");
    expect(doc.calibration.status).toBe("not-wired");
    expect("device_session_ref" in doc.calibration).toBe(false);
    expect("note" in doc.calibration).toBe(false);
  });
  it("rejects a given-but-empty device_session_ref", () => {
    expect(() => calibrationStubToml({ device_session_ref: "" })).toThrow(/device_session_ref/);
  });
});

describe("opened entity model (spec A)", () => {
  it("accepts an unknown platform and optional levels", () => {
    expect(validateSystem({ platform: "gkp-cavity", params: { chi: 0.5 } } as SystemEntity)).toEqual([]);
    expect(validateSystem({ platform: "", params: {} } as SystemEntity)).not.toEqual([]);
  });
  it("warns but does not reject levels > 6", () => {
    expect(validateSystem({ platform: "transmon", levels: 7, params: {} } as SystemEntity)).toEqual([]);
  });
  it("round-trips formulation.solve through TOML", () => {
    const f: FormulationEntity = {
      problem: "min_time",
      target: "CZ",
      objective: "unitary infidelity",
      constraints: ["amplitude bound"],
      solve: { T: 10, N: 50, max_iter: 60, integrator: "MagnusGL4" },
    };
    const parsed = parse(formulationToml(f)) as any;
    expect(parsed.formulation.solve.T).toBe(10);
    expect(parsed.formulation.solve.integrator).toBe("MagnusGL4");
  });
});

describe("canonicalJson + hash input rules", () => {
  it("sorts keys and excludes recorded/notes", () => {
    expect(canonicalJson({ b: 1, a: 2, recorded: "x", notes: "y" })).toBe('{"a":2,"b":1}');
  });
  it("is stable across key order", () => {
    expect(canonicalJson({ x: { b: 1, a: [1, 2] } })).toBe(canonicalJson({ x: { a: [1, 2], b: 1 } }));
  });
});

describe("deriveSlug", () => {
  it("kebab-cases and strips punctuation", () => {
    expect(deriveSlug("X gate on Q1!")).toBe("x-gate-on-q1");
    expect(deriveSlug("///")).toBe("untitled");
  });
});

describe("entityDiff + sentinel truncation", () => {
  it("produces dotted keys for nested params and skips recorded", () => {
    const d = entityDiff(
      { levels: 3, params: { drive_max: 0.2 } },
      { levels: 4, params: { drive_max: 0.2 }, recorded: "x" },
    );
    expect(d).toEqual({ levels: { from: 3, to: 4 } });
  });
  it("null from on create", () => {
    expect(entityDiff(undefined, { platform: "transmon" })).toEqual({ platform: { from: null, to: "transmon" } });
  });
  it("keeps the sentinel line under 1 KB", () => {
    const big = entityDiff(undefined, { notes2: "z".repeat(5000) });
    const line = JSON.stringify(truncateDiffForSentinel(big));
    expect(line.length).toBeLessThanOrEqual(1024);
    expect(line).toContain("…");
  });
});

describe("problem + run-ref serializers", () => {
  it("round-trips problem.toml", () => {
    const meta: ProblemMeta = {
      name: "X gate on Q1",
      slug: "x-gate-q1",
      created: "2026-07-03T00:00:00Z",
      status: "designing",
      score: { id: "pulse-designer", version: 3 },
      env: { kind: "provisioned" },
    };
    const parsed = parse(problemToml(meta)) as any;
    expect(parsed.problem.slug).toBe("x-gate-q1");
    expect(parsed.problem.score.id).toBe("pulse-designer");
    expect(parsed.problem.env.kind).toBe("provisioned");
  });
  it("round-trips runs.toml appends", () => {
    const t = runRefsToml([{ run_id: "r1", lab: "default", tier: "vetted", recorded: "x" }]);
    expect((parse(t) as any).runs[0].tier).toBe("vetted");
  });
});

describe("composite system schema + validation (spec-20260709)", () => {
  const COMP: CompositeSystem = {
    platform: "transmon",
    components: [
      { id: "q1", role: "qubit", levels: 3, params: { omega: 4.8, delta: -0.2 } },
      { id: "q2", role: "qubit", levels: 3, params: { omega: 4.9, delta: -0.2 } },
    ],
    couplings: [{ between: ["q1", "q2"], kind: "cross-resonance", params: { g: 0.005 } }],
    topology: "single-pair",
    drive: { arch: "per-component" },
  };

  it("accepts a valid composite", () => {
    expect(validateCompositeSystem(COMP)).toEqual([]);
  });

  it("N=1 (degenerate single-qubit) is valid with empty couplings", () => {
    expect(
      validateCompositeSystem({
        platform: "transmon",
        components: [{ id: "q1", role: "qubit", levels: 3, params: {} }],
        couplings: [],
        drive: { arch: "per-component" },
      }),
    ).toEqual([]);
  });

  it("accepts an arbitrary (open) platform string; rejects empty", () => {
    expect(validateCompositeSystem({ ...COMP, platform: "fluxonium-xyz" })).toEqual([]);
    expect(validateCompositeSystem({ ...COMP, platform: "" }).join(" ")).toMatch(/platform/);
  });

  it("rejects unknown role / kind / topology / drive.arch (closed sets)", () => {
    expect(
      validateCompositeSystem({ ...COMP, components: [{ id: "q1", role: "spin" as any, params: {} }] }).join(" "),
    ).toMatch(/role/);
    expect(
      validateCompositeSystem({
        ...COMP,
        couplings: [{ between: ["q1", "q2"], kind: "banana" as any, params: {} }],
      }).join(" "),
    ).toMatch(/kind/);
    expect(validateCompositeSystem({ ...COMP, topology: "grid" as any }).join(" ")).toMatch(/topology/);
    expect(validateCompositeSystem({ ...COMP, drive: { arch: "telepathy" as any } }).join(" ")).toMatch(/drive/);
  });

  it("rejects a coupling referencing an unknown component id", () => {
    expect(
      validateCompositeSystem({
        ...COMP,
        couplings: [{ between: ["q1", "q9"], kind: "cross-resonance", params: {} }],
      }).join(" "),
    ).toMatch(/unknown component/);
  });

  it("rejects duplicate component ids", () => {
    expect(
      validateCompositeSystem({ ...COMP, components: [COMP.components[0], COMP.components[0]] }).join(" "),
    ).toMatch(/duplicate/);
  });

  it("mode-mediated requires exactly one mode/resonator member (ion + motional mode)", () => {
    const ok: CompositeSystem = {
      platform: "ion",
      components: [
        { id: "i1", role: "atom", params: {} },
        { id: "i2", role: "atom", params: {} },
        { id: "m1", role: "mode", levels: 8, params: {} },
      ],
      couplings: [{ between: ["i1", "i2", "m1"], kind: "mode-mediated", params: { eta: 0.1 } }],
      drive: { arch: "global" },
    };
    expect(validateCompositeSystem(ok)).toEqual([]);
    const bad = { ...ok, couplings: [{ between: ["i1", "i2"], kind: "mode-mediated" as const, params: {} }] };
    expect(validateCompositeSystem(bad).join(" ")).toMatch(/mode-mediated/);
  });

  it("rejects non-integer / <2 component levels", () => {
    expect(
      validateCompositeSystem({ ...COMP, components: [{ id: "q1", role: "qubit", levels: 1, params: {} }] }).join(" "),
    ).toMatch(/levels/);
    expect(
      validateCompositeSystem({ ...COMP, components: [{ id: "q1", role: "qubit", levels: 3.5, params: {} }] }).join(" "),
    ).toMatch(/levels/);
  });

  it("heterogeneous cavity+qubit (bosonic) is native", () => {
    const bosonic: CompositeSystem = {
      platform: "bosonic",
      components: [
        { id: "q1", role: "qubit", levels: 2, params: {} },
        { id: "cav", role: "cavity", levels: 12, params: { kerr: -0.001 } },
      ],
      couplings: [{ between: ["q1", "cav"], kind: "dispersive-chi", params: { chi: 0.002 } }],
      drive: { arch: "per-component" },
    };
    expect(validateCompositeSystem(bosonic)).toEqual([]);
  });

  it("compositeSystemWarnings are soft (never a rejection)", () => {
    const lowCav: CompositeSystem = {
      platform: "bosonic",
      components: [{ id: "cav", role: "cavity", levels: 2, params: {} }],
      couplings: [],
      drive: { arch: "per-component" },
    };
    expect(validateCompositeSystem(lowCav)).toEqual([]); // valid...
    expect(compositeSystemWarnings(lowCav).join(" ")).toMatch(/Fock/); // ...but warned
    expect(compositeSystemWarnings(COMP)).toEqual([]); // clean 3-level qubits, no warning
  });
});

describe("normalizeSystem + composite merge/toml/hash (spec-20260709)", () => {
  const COMPOSITE: CompositeSystem = {
    platform: "transmon",
    components: [
      { id: "q1", role: "qubit", levels: 3, params: { omega: 4.8, delta: -0.2 } },
      { id: "q2", role: "qubit", levels: 3, params: { omega: 4.9, delta: -0.2 } },
    ],
    couplings: [{ between: ["q1", "q2"], kind: "cross-resonance", params: { g: 0.005 } }],
    topology: "single-pair",
    drive: { arch: "per-component" },
  };

  it("flat → N=1 composite (levels→components[0], notes carried, role/arch from platform)", () => {
    const c = normalizeSystem({ platform: "transmon", levels: 3, params: { omega: 4.8 }, notes: "prose" });
    expect(c.components).toHaveLength(1);
    expect(c.components[0]).toMatchObject({ id: "q1", role: "qubit", levels: 3, params: { omega: 4.8 } });
    expect(c.couplings).toEqual([]);
    expect(c.drive.arch).toBe("per-component");
    expect(c.notes).toBe("prose");
    expect(validateCompositeSystem(c)).toEqual([]);
  });

  it("rydberg→atom/global; unknown→qubit/per-component; absent flat levels stays absent", () => {
    const r = normalizeSystem({ platform: "rydberg", levels: 3, params: {} });
    expect(r.components[0].role).toBe("atom");
    expect(r.drive.arch).toBe("global");
    const u = normalizeSystem({ platform: "fluxonium", params: {} });
    expect(u.components[0].role).toBe("qubit");
    expect(u.components[0].levels).toBeUndefined();
    expect(u.drive.arch).toBe("per-component");
  });

  it("is idempotent on an already-composite entity", () => {
    expect(normalizeSystem(COMPOSITE)).toEqual(COMPOSITE);
  });

  it("updateCompositeSystem tolerates a FLAT existing (F1) + merges a composite patch", () => {
    const merged = updateCompositeSystem(
      { platform: "transmon", levels: 3, params: { omega: 4.8 } },
      {
        components: [{ id: "q2", role: "qubit", levels: 3, params: { omega: 4.9 } }],
        couplings: [{ between: ["q1", "q2"], kind: "cross-resonance", params: { g: 0.005 } }],
        topology: "single-pair",
        drive: { arch: "per-component" },
      },
    );
    expect(merged.components.map((c) => c.id).sort()).toEqual(["q1", "q2"]);
    expect(merged.couplings).toHaveLength(1);
    expect(merged.topology).toBe("single-pair");
    expect(validateCompositeSystem(merged)).toEqual([]);
  });

  it("compositeSystemToml round-trips through smol-toml (AoT + inline params)", () => {
    const doc = parse(compositeSystemToml(COMPOSITE)) as any;
    expect(doc.system.platform).toBe("transmon");
    expect(doc.system.topology).toBe("single-pair");
    expect(doc.system.drive.arch).toBe("per-component");
    expect(doc.system.components).toHaveLength(2);
    expect(doc.system.components[0].id).toBe("q1");
    expect(doc.system.components[0].params.omega).toBe(4.8);
    expect(doc.system.couplings[0].kind).toBe("cross-resonance");
    expect(doc.system.couplings[0].between).toEqual(["q1", "q2"]);
  });

  it("canonicalJson drops notes → composites differing only in notes hash-equal", () => {
    const a = normalizeSystem({ platform: "transmon", levels: 3, params: { omega: 4.8 }, notes: "x" });
    const b = normalizeSystem({ platform: "transmon", levels: 3, params: { omega: 4.8 }, notes: "DIFFERENT" });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("topology expansion + homogeneous replicate (spec-20260709)", () => {
  it("single-pair → 1 edge over [q1,q2]", () => {
    const edges = expandTopology("single-pair", ["q1", "q2"], "cross-resonance", { g: 0.005 });
    expect(edges).toEqual([{ between: ["q1", "q2"], kind: "cross-resonance", params: { g: 0.005 } }]);
  });
  it("linear-chain(N) → N-1 edges in canonical order", () => {
    const edges = expandTopology("linear-chain", ["q1", "q2", "q3", "q4"], "exchange");
    expect(edges.map((e) => e.between)).toEqual([
      ["q1", "q2"],
      ["q2", "q3"],
      ["q3", "q4"],
    ]);
    expect(edges.every((e) => e.kind === "exchange")).toBe(true);
  });
  it("custom → [] (edges authored directly)", () => {
    expect(expandTopology("custom", ["q1", "q2"], "ZZ")).toEqual([]);
  });
  it("single-pair with wrong arity throws", () => {
    expect(() => expandTopology("single-pair", ["q1", "q2", "q3"], "ZZ")).toThrow(/single-pair/);
  });
  it("deferred presets (e.g. ring) throw §9", () => {
    expect(() => expandTopology("ring" as any, ["q1", "q2"], "ZZ")).toThrow(/deferred/);
  });
  it("replicateHomogeneous → N components identical except id (q1..qN)", () => {
    const comps = replicateHomogeneous({ role: "qubit", levels: 3, params: { omega: 4.8 } }, 3);
    expect(comps.map((c) => c.id)).toEqual(["q1", "q2", "q3"]);
    expect(comps.every((c) => c.role === "qubit" && c.levels === 3 && c.params.omega === 4.8)).toBe(true);
    // mutating one component's params must not alias the others
    comps[0].params.omega = 9;
    expect(comps[1].params.omega).toBe(4.8);
  });
  it("replicateHomogeneous rejects n < 1", () => {
    expect(() => replicateHomogeneous({ role: "qubit", params: {} }, 0)).toThrow(/n >= 1/);
  });
});

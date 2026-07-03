// ============================================================================
// amicode_* tool pack v0 — an opencode PLUGIN, not extension-bundle code.
//
// RUNTIME: this file executes inside opencode's embedded Bun runtime. It is
// registered by ABSOLUTE PATH via OPENCODE_CONFIG_CONTENT `plugin: ["<abs>"]`
// (built in ../src/opencode_config.ts) and imported by the binary's plugin
// loader with a bare dynamic `import()` — Bun transpiles TS natively, so the
// relative `./entities` sibling import below resolves; nothing else does.
// Keep this module dependency-free (node: builtins + ./entities only) and it
// must have EXACTLY ONE export: opencode 1.17.3's legacy-plugin scan
// (plugin/index.ts getLegacyPlugins) throws "Plugin export is not a function"
// on any extra named export. It is deliberately OUTSIDE the extension's
// tsconfig include and vitest graph; its pure logic lives in ./entities.ts,
// which IS unit-tested (test/amicode_tools.test.ts).
//
// T8 REGISTRATION DECISION (probed on the stock vendored binary v1.17.3):
//   chosen: OPENCODE_CONFIG_CONTENT carrying BOTH
//     - `agent: {"pulse-designer": {description, prompt}}`  → shows in GET /agent
//     - `plugin: ["/abs/path/amicode_tools.ts"]`            → module executes on
//       session creation (plugin_origins lists source OPENCODE_CONFIG_CONTENT)
//   fallback (if a future binary drops either): instructions-only interview —
//   AGENTS.md already tells the agent to summarize each stage in one line when
//   the amicode_* tools are absent, and the solve launch is ALWAYS the bash
//   `amico-run` workflow. The tools are bookkeeping, not gates.
//
// ARGS-SCHEMA DECISION: plain JSON-Schema property objects, validated inside
// execute(). Rationale (from the v1.17.3 source, tool/registry.ts fromPlugin):
//   - if every `args` value is a Zod type it uses z.object(...); the only zod
//     the loader accepts is zod v4 (`"_zod" in value`) and the sanctioned way
//     to get it is `tool.schema` from @opencode-ai/plugin — which is NOT a
//     dependency of this repo and MUST NOT become one (the binary can't be
//     assumed to resolve npm imports from this directory).
//   - otherwise `legacyJsonSchema` treats each value as a raw JSON-Schema
//     property definition: {type:"object", properties, required: ALL keys},
//     and server-side validation is skipped (parameters = Schema.Unknown).
//   Consequences we design for: every declared arg is REQUIRED in the schema
//   the LLM sees, so optional args are declared nullable ("pass null to skip")
//   and all real validation happens in execute() via ./entities validators.
//
// STATE: entities are written under entitiesDir():
//   $AMICODE_ENTITIES_DIR if set, else ~/.amico/runs/default/_entities
// system.json is a machine-readable sidecar of system.toml — the merge source
// for amicode_set_model (this module is TOML-writer-only; it carries no TOML
// parser, and won't grow one). The Run stub (run.toml here) is bookkeeping —
// NOT the run-dir run.toml that amico-run writes.
//
// TODO(follow-up): extension.ts should pass the plugin path explicitly to
// buildOpencodeConfigContent once packaging (.vsix layout) is verified; today
// the default path is derived from __dirname in opencode_config.ts.
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  systemToml,
  formulationToml,
  runStubToml,
  deviceSessionStubToml,
  calibrationStubToml,
  updateSystem,
  validateSystem,
  validateFormulation,
  PLATFORMS,
  type SystemEntity,
  type FormulationEntity,
  type RunStub,
  type DeviceSessionStub,
  type CalibrationStub,
} from "./entities";

// Load line goes to STDERR, not stdout: `opencode debug config` imports plugin
// modules before printing the resolved config as JSON on stdout (verified on
// v1.17.3) — a stdout log here corrupts that JSON and breaks any caller that
// parses it (test/opencode_config.test.ts does). stderr still lands in the
// serve log, which is where the load line is grepped for.
console.error("[amicode-tools] loaded — amicode_* tool pack v0 (entities → " + entitiesDir() + ")");

function entitiesDir(): string {
  const env = process.env.AMICODE_ENTITIES_DIR;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "runs", "default", "_entities");
}

function writeEntity(name: string, content: string): string {
  const dir = entitiesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** null/undefined → absent (the schema forces the LLM to pass every key, so
 *  "not applicable" arrives as null — see the args-schema decision above). */
function given<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

function readSystemState(): SystemEntity | undefined {
  const file = path.join(entitiesDir(), "system.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SystemEntity;
  } catch {
    return undefined;
  }
}

function persistSystem(e: SystemEntity): string {
  const tomlPath = writeEntity("system.toml", systemToml(e));
  writeEntity("system.json", JSON.stringify(e, null, 2) + "\n");
  return tomlPath;
}

function paramsSummary(params: Record<string, number>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return "no params recorded";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

// LaTeX shown at the PLATFORM stage — kept verbatim in sync with AGENTS.md's
// "Pulse-designer interview" section (the agent renders these in chat).
const TRANSMON_LATEX = String.raw`$\hat H/\hbar = \omega\,\hat a^\dagger\hat a + \tfrac{\delta}{2}\,\hat a^{\dagger 2}\hat a^2 + u_1(t)\,(\hat a + \hat a^\dagger) + i\,u_2(t)\,(\hat a - \hat a^\dagger)$`;
const RYDBERG_DESC = String.raw`3-level ladder: $|0\rangle$ dark, $|1\rangle\!\leftrightarrow\!|r\rangle$ laser-driven, blockade shift on $|rr\rangle$`;
const RYDBERG_SCOPE_NOTE =
  "Honest scope note: this build's vetted solve template is transmon-only — " +
  "Rydberg solve authoring is not wired yet. The System entity is recorded so the " +
  "formulation can be captured for follow-up; don't improvise an unvetted script.";

// The plugin: exactly one export (see header). opencode calls it on session
// creation with PluginInput; we need nothing from it today.
export const AmicodeTools = async (_input: unknown) => ({
  tool: {
    amicode_ask: {
      description:
        "Present ONE multiple-choice question to the user as clickable buttons in the Amicode chat. " +
        "Use for interview stages with a small option set (platform, sim-vs-solve, problem/gate). " +
        "The user's next message is their answer (a button click sends the option text verbatim). " +
        "End your turn after calling this — never answer on the user's behalf.",
      args: {
        question: {
          type: "string",
          description: "The single question to ask.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2-6 short option labels, one per button.",
        },
        details: {
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "Optional one-per-option short qualifier rendered dimly under each button " +
            "(e.g. \"fully supported end-to-end\"). Same length as options, or null.",
        },
      },
      async execute(a: { question: string; options: string[]; details?: string[] | null }) {
        const opts = Array.isArray(a.options)
          ? a.options.filter((o) => typeof o === "string" && o.trim() !== "")
          : [];
        if (!a.question || a.question.trim() === "") return "Cannot ask: empty question.";
        if (opts.length < 2 || opts.length > 6) return "Cannot ask: need 2-6 non-empty options.";
        if (a.details != null && (!Array.isArray(a.details) || a.details.length !== opts.length))
          return "Cannot ask: details must be null or exactly one per option.";
        // The renderer draws the buttons from this tool part's INPUT args; this
        // return text is for the model (and the pre-rail fallback display).
        return (
          `Question presented with ${opts.length} option buttons. STOP HERE: write no ` +
          `further text this turn, do NOT repeat the question in prose, and NEVER pick ` +
          `an option yourself — the user's next message is their click.`
        );
      },
    },
    amicode_pick_system: {
      description:
        "Record the chosen platform as the System entity (interview stage 1: PLATFORM). " +
        "Returns the model Hamiltonian in LaTeX to show the user for confirmation. " +
        "Bookkeeping only — never launches anything.",
      args: {
        platform: {
          type: "string",
          enum: [...PLATFORMS],
          description: "Device platform the user named.",
        },
        omega: {
          type: ["number", "null"],
          description: "Transmon frequency ω in GHz; pass null if not yet known.",
        },
        delta: {
          type: ["number", "null"],
          description: "Anharmonicity δ in GHz; pass null if not yet known.",
        },
      },
      async execute(a: { platform: string; omega?: number | null; delta?: number | null }) {
        const params: Record<string, number> = {};
        if (given(a.omega)) params.omega = a.omega;
        if (given(a.delta)) params.delta = a.delta;
        const entity: SystemEntity = { platform: a.platform as SystemEntity["platform"], levels: 3, params };
        const problems = validateSystem(entity);
        if (problems.length) return `Cannot record system: ${problems.join("; ")}`;
        const file = persistSystem(entity);
        if (entity.platform === "transmon") {
          return (
            `System recorded (transmon, ${entity.levels} levels, ${paramsSummary(params)}) → ${file}\n\n` +
            `Model Hamiltonian:\n${TRANSMON_LATEX}\n\n` +
            `Show this to the user and confirm it matches their device.`
          );
        }
        return (
          `System recorded (rydberg, ${entity.levels} levels, ${paramsSummary(params)}) → ${file}\n\n` +
          `Model: ${RYDBERG_DESC}\n\n${RYDBERG_SCOPE_NOTE}`
        );
      },
    },

    amicode_set_model: {
      description:
        "Merge model details (interview stage 2: MODEL) into the recorded System entity: " +
        "levels, drive_max, and any extra named numeric parameters. Requires " +
        "amicode_pick_system to have run first. Bookkeeping only.",
      args: {
        levels: {
          type: ["integer", "null"],
          description: "Number of transmon levels to model (2–6, default 3); null to leave unchanged.",
        },
        drive_max: {
          type: ["number", "null"],
          description: "Drive amplitude bound (GHz); null to leave unchanged.",
        },
        params: {
          type: ["object", "null"],
          additionalProperties: { type: "number" },
          description: "Extra named numeric model parameters to merge (e.g. {\"T1\": 80}); null for none.",
        },
      },
      async execute(a: { levels?: number | null; drive_max?: number | null; params?: Record<string, number> | null }) {
        const existing = readSystemState();
        if (!existing) return "No system recorded yet — call amicode_pick_system first (interview stage 1).";
        const patchParams: Record<string, number> = { ...(given(a.params) ? a.params : {}) };
        if (given(a.drive_max)) patchParams.drive_max = a.drive_max;
        try {
          const merged = updateSystem(existing, {
            levels: given(a.levels) ? a.levels : undefined,
            params: patchParams,
          });
          const file = persistSystem(merged);
          return `System updated (${merged.platform}, ${merged.levels} levels, ${paramsSummary(merged.params)}) → ${file}`;
        } catch (err) {
          return `Cannot update model: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    amicode_formulate: {
      description:
        "Record the Formulation entity (interview stages 4–5: PROBLEM + FORMULATION): " +
        "problem kind, target, objective, constraints. Bookkeeping only.",
      args: {
        problem: {
          type: "string",
          description: "Problem kind: \"gate_synthesis\" or \"state_prep\".",
        },
        target: {
          type: "string",
          description: "The target, e.g. \"X\", \"H\", \"sqrt(X)\", or a description of the unitary/state.",
        },
        objective: {
          type: ["string", "null"],
          description: "Objective; null for the default \"unitary infidelity\".",
        },
        constraints: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "Constraint list; null for the default [\"amplitude bound (drive_max)\"].",
        },
      },
      async execute(a: { problem: string; target: string; objective?: string | null; constraints?: string[] | null }) {
        const entity: FormulationEntity = {
          problem: a.problem,
          target: a.target,
          objective: given(a.objective) ? a.objective : "unitary infidelity",
          constraints: given(a.constraints) ? a.constraints : ["amplitude bound (drive_max)"],
        };
        const problems = validateFormulation(entity);
        if (problems.length) return `Cannot record formulation: ${problems.join("; ")}`;
        const file = writeEntity("formulation.toml", formulationToml(entity));
        return (
          `Formulation recorded → ${file}\n` +
          `problem: ${entity.problem}; target: ${entity.target}; objective: ${entity.objective}; ` +
          `constraints: ${entity.constraints.join(" · ")}`
        );
      },
    },

    amicode_solve: {
      description:
        "Record the Run entity stub (interview stage 6: SOLVE PARAMS). This tool NEVER " +
        "launches a solve — the launch is the AGENTS.md bash workflow (`nohup amico-run …`). " +
        "Call this to record that a launch was requested/performed. Bookkeeping, not a gate.",
      args: {
        run_dir: {
          type: ["string", "null"],
          description: "The run directory if the bash launch already happened and it is known; else null.",
        },
        note: {
          type: ["string", "null"],
          description: "Short free-text note, e.g. \"X gate, T=10ns, N=50, defaults\"; null for none.",
        },
      },
      async execute(a: { run_dir?: string | null; note?: string | null }) {
        const dir = entitiesDir();
        const stub: RunStub = {};
        const sysPath = path.join(dir, "system.toml");
        const formPath = path.join(dir, "formulation.toml");
        if (fs.existsSync(sysPath)) stub.system_ref = sysPath;
        if (fs.existsSync(formPath)) stub.formulation_ref = formPath;
        if (given(a.run_dir)) stub.run_dir = a.run_dir;
        if (given(a.note)) stub.note = a.note;
        const file = writeEntity("run.toml", runStubToml(stub));
        const missing = [
          ...(stub.system_ref ? [] : ["system (stage 1 skipped?)"]),
          ...(stub.formulation_ref ? [] : ["formulation (stages 4–5 skipped?)"]),
        ];
        const warn = missing.length ? ` Note: no recorded ${missing.join(" or ")}.` : "";
        return (
          `Run entity recorded → ${file} — launch via the workflow's amico-run bash command ` +
          `if not already launched.${warn}`
        );
      },
    },

    amicode_to_hardware: {
      description:
        "Record the DeviceSession entity stub (interview stage 8: HARDWARE — guided stub). " +
        "THIS BUILD PERFORMS NO DEVICE I/O: the tool records intent only and returns an " +
        "explanation of the send-to-device gate. Bookkeeping, not a gate.",
      args: {
        pulse_ref: {
          type: ["string", "null"],
          description: "Path to the solved pulse artifact (pulse.jld2) if known; else null.",
        },
        run_dir: {
          type: ["string", "null"],
          description: "The run directory the pulse came from, if known; else null.",
        },
        note: {
          type: ["string", "null"],
          description: "Short free-text note; null for none.",
        },
      },
      async execute(a: { pulse_ref?: string | null; run_dir?: string | null; note?: string | null }) {
        const stub: DeviceSessionStub = {};
        if (given(a.pulse_ref)) stub.pulse_ref = a.pulse_ref;
        if (given(a.run_dir)) stub.run_dir = a.run_dir;
        if (given(a.note)) stub.note = a.note;
        let file: string;
        try {
          file = writeEntity("device_session.toml", deviceSessionStubToml(stub));
        } catch (err) {
          return `Cannot record device session: ${err instanceof Error ? err.message : String(err)}`;
        }
        const warn = stub.pulse_ref || stub.run_dir
          ? ""
          : " Note: no pulse/run referenced yet — re-record after the solve finishes.";
        return (
          `Device session recorded → ${file} (gate: pending-human-signoff).${warn}\n\n` +
          `The send-to-device gate, when wired: (1) automated checks — fidelity ≥ threshold, ` +
          `|drive| ≤ amplitude cap, bandwidth within hardware limits, leakage bounded; ` +
          `(2) a human visually signs off on the pulse before anything is sent. ` +
          `THIS BUILD PERFORMS NO DEVICE I/O — intent recorded only; set no expectation of ` +
          `hardware execution tonight.`
        );
      },
    },

    amicode_calibrate: {
      description:
        "Record the Calibration entity stub (interview stage 8: CALIBRATE — guided stub). " +
        "The calibration loop is NOT wired in this build: the tool records the follow-up " +
        "and returns an explanation of the loop. Bookkeeping, not a gate.",
      args: {
        device_session_ref: {
          type: ["string", "null"],
          description:
            "Path to the recorded device_session.toml; null to auto-reference the recorded one if present.",
        },
        note: {
          type: ["string", "null"],
          description: "Short free-text note; null for none.",
        },
      },
      async execute(a: { device_session_ref?: string | null; note?: string | null }) {
        const stub: CalibrationStub = {};
        if (given(a.device_session_ref)) {
          stub.device_session_ref = a.device_session_ref;
        } else {
          // Mirror amicode_solve's auto-ref idiom: point at the recorded device
          // session when one exists (existence check only — no TOML parsing here).
          const dsPath = path.join(entitiesDir(), "device_session.toml");
          if (fs.existsSync(dsPath)) stub.device_session_ref = dsPath;
        }
        if (given(a.note)) stub.note = a.note;
        let file: string;
        try {
          file = writeEntity("calibration.toml", calibrationStubToml(stub));
        } catch (err) {
          return `Cannot record calibration: ${err instanceof Error ? err.message : String(err)}`;
        }
        const warn = stub.device_session_ref
          ? ""
          : " Note: no device session recorded yet — amicode_to_hardware comes first.";
        return (
          `Calibration follow-up recorded → ${file} (loop: ILC, status: not-wired).${warn}\n\n` +
          `After hardware runs, a calibration loop (ILC — iterative learning control) closes ` +
          `the model-device gap: run the pulse, measure, compare against the model's ` +
          `prediction, update, repeat until the device matches the design. In this build ` +
          `that loop is a recorded follow-up only — nothing is executed tonight.`
        );
      },
    },
  },
});

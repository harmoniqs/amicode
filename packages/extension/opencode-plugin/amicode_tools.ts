// ============================================================================
// amicode_* tool pack v1 — an opencode PLUGIN, not extension-bundle code.
//
// RUNTIME: this file executes inside opencode's embedded Bun runtime. It is
// registered by ABSOLUTE PATH via OPENCODE_CONFIG_CONTENT `plugin: ["<abs>"]`
// (built in ../src/opencode_config.ts) and imported by the binary's plugin
// loader with a bare dynamic `import()` — Bun transpiles TS natively, so the
// relative `./entities` / `./problems` / `./hashes` / `./score_guard` sibling
// imports below resolve; nothing else does. It must have EXACTLY ONE export:
// opencode 1.17.3's legacy-plugin scan (plugin/index.ts getLegacyPlugins) throws
// "Plugin export is not a function" on any extra named export. It is deliberately
// OUTSIDE the extension's tsconfig include and vitest graph; its pure logic lives
// in ./entities.ts + ./problems.ts + ./hashes.ts, which ARE unit-tested.
//
// v1 (spec A — Problem workspaces): entities live under a durable, named Problem
// workspace (~/.amico/problems/<slug>/), NOT the old global _entities singleton.
// Every entity write appends a structured-diff event to the workspace's
// events.jsonl AND returns an `AMICODE_DIFF {json}` sentinel as its LAST line
// (the UI parses it into a diff receipt — same idiom as the run-dir contract's
// AMICODE_ITER/AMICODE_PULSE lines). The active problem is auto-created if none
// exists, so fast-path sessions never stall on bookkeeping.
//
// ARGS-SCHEMA DECISION (unchanged): plain JSON-Schema property objects validated
// inside execute(); every declared arg is REQUIRED in the schema the LLM sees,
// so optional args are declared nullable ("pass null to skip") and all real
// validation happens in execute() via ./entities validators.
// ============================================================================

import * as fs from "node:fs";
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
  entityDiff,
  truncateDiffForSentinel,
  KNOWN_PLATFORMS,
  MAX_LEVELS,
  type SystemEntity,
  type FormulationEntity,
  type RunStub,
  type DeviceSessionStub,
  type CalibrationStub,
} from "./entities";
import { entityHash } from "./hashes";
import {
  ensureActiveProblem,
  problemsDir,
  problemDir,
  writeEntityFiles,
  appendEvent,
  appendRunRef,
  createProblem,
  openProblem,
  renameProblem,
  archiveProblem,
  listProblems,
  lastEventSeq,
  migrateLegacyEntities,
} from "./problems";
import { guardAndRecordStage, completeStage } from "./score_guard";

// Load line goes to STDERR, not stdout: `opencode debug config` imports plugin
// modules before printing the resolved config as JSON on stdout (verified on
// v1.17.3) — a stdout log here corrupts that JSON and breaks any caller that
// parses it (test/opencode_config.test.ts does). stderr still lands in the
// serve log, which is where the load line is grepped for.
console.error("[amicode-tools] loaded — amicode_* tool pack v1 (problems → " + problemsDir() + ")");

// One-shot legacy _entities → problem-workspace migration. Skipped when either
// env override is set (test harnesses point them at temp dirs). stderr-only.
if (!process.env.AMICODE_ENTITIES_DIR && !process.env.AMICODE_PROBLEMS_DIR) {
  try {
    migrateLegacyEntities();
  } catch (e) {
    console.error(`[amicode-tools] legacy migration skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** null/undefined → absent (the schema forces the LLM to pass every key, so
 *  "not applicable" arrives as null — see the args-schema decision above). */
function given<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

function paramsSummary(params: Record<string, number>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return "no params recorded";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

/** Read an entity's JSON sidecar from the active problem's workspace (the plugin
 *  is TOML-writer-only; all reads go through .json). */
function readEntityJson<T>(slug: string, kind: string): T | undefined {
  const file = path.join(problemDir(slug), "entities", `${kind}.json`);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The AMICODE_DIFF sentinel line (LAST line of a tool return) — the UI parses
 *  it into a diff receipt; the prose above it is for the model. */
function sentinelLine(
  problem: string,
  entity: string,
  action: string,
  seq: number,
  diff: Record<string, { from: unknown; to: unknown }>,
): string {
  return "AMICODE_DIFF " + JSON.stringify({ problem, entity, action, seq, diff: truncateDiffForSentinel(diff) });
}

/** Persist an entity to the active problem workspace: write TOML+JSON sidecar,
 *  append a structured-diff event (with content hash), and return the sentinel
 *  line. `action` is derived from whether a prior snapshot exists. */
function recordEntity(
  slug: string,
  kind: string,
  entity: Record<string, unknown>,
  toml: string,
  source: { tool: string; stage?: string },
): string {
  const before = readEntityJson<Record<string, unknown>>(slug, kind);
  const action: "created" | "updated" = before ? "updated" : "created";
  writeEntityFiles(slug, kind, toml, JSON.stringify(entity, null, 2) + "\n");
  const diff = entityDiff(before, entity);
  const seq = appendEvent(slug, { entity: kind, action, diff, hash: entityHash(entity), source });
  return sentinelLine(slug, kind, action, seq, diff);
}

// LaTeX shown at the PLATFORM stage — kept verbatim in sync with AGENTS.md's
// "Pulse-designer interview" section (the agent renders these in chat).
const TRANSMON_LATEX = String.raw`$\hat H/\hbar = \omega\,\hat a^\dagger\hat a + \tfrac{\delta}{2}\,\hat a^{\dagger 2}\hat a^2 + u_1(t)\,(\hat a + \hat a^\dagger) + i\,u_2(t)\,(\hat a - \hat a^\dagger)$`;
const RYDBERG_DESC = String.raw`3-level ladder: $|0\rangle$ dark, $|1\rangle\!\leftrightarrow\!|r\rangle$ laser-driven, blockade shift on $|rr\rangle$`;
const RYDBERG_SCOPE_NOTE =
  "Good news, with an asterisk: Rydberg solve authoring IS wired via the tiered " +
  "resolver (it runs at solve time). Gate synthesis lands on the COMPOSED tier — the " +
  "`rydberg-cz` exemplar (experimental, not-yet-vetted; the 2-qubit CZ is a touch " +
  "sluggish in the current Piccolo path). Other shapes drop to the free tier " +
  "(public-package authoring, re-rollout-checked). Offer to proceed, be honest about " +
  "the tier — and do NOT tell the user Rydberg is unsupported, because it isn't.";

// The plugin: exactly one export (see header). opencode calls it on session
// creation with PluginInput; we need nothing from it today.
export const AmicodeTools = async (_input: unknown) => ({
  tool: {
    amicode_ask: {
      description:
        "DEPRECATED — prefer the native `question` tool (turn-blocking form with options, " +
        "descriptions, and custom answers). Kept for compatibility: presents ONE multiple-choice " +
        "question as clickable buttons; the user's next message is their answer. " +
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
          // Optional nullable array. The registry's legacyJsonSchema strips the
          // "null" and marks the field optional, yielding a clean singular-typed
          // schema every provider accepts (a raw nullable array is what Gemini
          // rejected). execute() also tolerates absent/empty defensively.
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "Optional one-per-option short qualifier rendered dimly under each button " +
            "(e.g. \"fully supported end-to-end\"). Same length as options; omit for none.",
        },
      },
      async execute(a: { question: string; options: string[]; details?: string[] | null }) {
        const opts = Array.isArray(a.options)
          ? a.options.filter((o) => typeof o === "string" && o.trim() !== "")
          : [];
        if (!a.question || a.question.trim() === "") return "Cannot ask: empty question.";
        if (opts.length < 2 || opts.length > 6) return "Cannot ask: need 2-6 non-empty options.";
        if (Array.isArray(a.details) && a.details.length > 0 && a.details.length !== opts.length)
          return "Cannot ask: details must be one per option (or omitted).";
        // The renderer draws the buttons from this tool part's INPUT args; this
        // return text is for the model (and the pre-rail fallback display).
        return (
          `Question presented with ${opts.length} option buttons. STOP HERE: write no ` +
          `further text this turn, do NOT repeat the question in prose, and NEVER pick ` +
          `an option yourself — the user's next message is their click.`
        );
      },
    },

    amicode_problem: {
      description:
        "Open or create the Problem workspace the design state belongs to (spec A). " +
        "Call this at the start of a design session (fold the name into the first " +
        "confirmation — never a separate 'workspace' question), and to rename the " +
        "auto-created untitled problem once the target is known. Bookkeeping only.",
      args: {
        action: {
          type: "string",
          enum: ["open", "create", "rename", "archive"],
          description: "open (by name/slug) | create | rename the active/target problem | archive.",
        },
        name: {
          type: "string",
          description: "For create/open: the problem name (or slug) to create/find. For rename/archive: the target slug.",
        },
        new_name: {
          type: ["string", "null"],
          description: "For rename: the new name. Null otherwise.",
        },
      },
      async execute(a: { action: string; name: string; new_name?: string | null }) {
        if (!a.name || a.name.trim() === "") return "Cannot: empty name.";
        if (a.action === "create") {
          const meta = createProblem(a.name);
          return (
            `Problem created: "${meta.name}" (${meta.slug}).\n\n` +
            sentinelLine(meta.slug, "problem", "created", lastEventSeq(meta.slug), {
              slug: { from: null, to: meta.slug },
              name: { from: null, to: meta.name },
            })
          );
        }
        if (a.action === "open") {
          const meta = openProblem(a.name);
          if (!meta) {
            const near = listProblems()
              .filter((p) => p.status !== "archived")
              .map((p) => `${p.name} (${p.slug})`)
              .slice(0, 8);
            return near.length
              ? `No problem matches "${a.name}". Open problems: ${near.join("; ")}.`
              : `No problem matches "${a.name}", and none exist yet — create one first.`;
          }
          return `Opened problem: "${meta.name}" (${meta.slug}).`;
        }
        if (a.action === "rename") {
          if (!given(a.new_name) || a.new_name.trim() === "") return "Cannot rename: new_name is required.";
          let meta;
          try {
            meta = renameProblem(a.name, a.new_name);
          } catch (err) {
            return `Cannot rename: ${err instanceof Error ? err.message : String(err)}`;
          }
          return (
            `Problem renamed to "${meta.name}" (${meta.slug}).\n\n` +
            sentinelLine(meta.slug, "problem", "renamed", lastEventSeq(meta.slug), {
              name: { from: null, to: meta.name },
            })
          );
        }
        if (a.action === "archive") {
          let meta;
          try {
            meta = archiveProblem(a.name);
          } catch (err) {
            return `Cannot archive: ${err instanceof Error ? err.message : String(err)}`;
          }
          return (
            `Problem archived: "${meta.name}" (${meta.slug}).\n\n` +
            sentinelLine(meta.slug, "problem", "archived", lastEventSeq(meta.slug), {
              status: { from: null, to: "archived" },
            })
          );
        }
        return `Unknown action "${a.action}".`;
      },
    },

    amicode_pick_system: {
      description:
        "Record the chosen platform as the System entity (interview stage 1: PLATFORM). " +
        "Returns the model Hamiltonian in LaTeX to show the user for confirmation. " +
        "Platform is free-form — known platforms (" +
        KNOWN_PLATFORMS.join(", ") +
        ") get built-in affordances; others are recorded honestly. Bookkeeping only.",
      args: {
        platform: {
          type: "string",
          description: `Device platform the user named (e.g. ${KNOWN_PLATFORMS.join(", ")}, or anything else).`,
        },
        omega: {
          type: ["number", "null"],
          description: "Transmon frequency ω in GHz; pass null if not applicable/known.",
        },
        delta: {
          type: ["number", "null"],
          description: "Anharmonicity δ in GHz; pass null if not applicable/known.",
        },
        notes: {
          type: ["string", "null"],
          description: "Free-text notes for what params can't hold (e.g. topology); null for none.",
        },
      },
      async execute(a: { platform: string; omega?: number | null; delta?: number | null; notes?: string | null }) {
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "platform");
        if (blocked) return blocked;
        if (!a.platform || a.platform.trim() === "") return "Cannot record system: platform must be non-empty.";
        const params: Record<string, number> = {};
        if (given(a.omega)) params.omega = a.omega;
        if (given(a.delta)) params.delta = a.delta;
        // Known platforms default to a sensible model size; unknown ones get no
        // levels default (recorded honestly — spec A).
        const known = (KNOWN_PLATFORMS as readonly string[]).includes(a.platform);
        const entity: SystemEntity = { platform: a.platform, params };
        if (known) entity.levels = 3;
        if (given(a.notes)) entity.notes = a.notes;
        const problems = validateSystem(entity);
        if (problems.length) return `Cannot record system: ${problems.join("; ")}`;
        const sentinel = recordEntity(meta.slug, "system", entity as any, systemToml(entity), {
          tool: "amicode_pick_system",
          stage: "platform",
        });
        completeStage(dir, "platform");
        const levelsDesc = entity.levels !== undefined ? `${entity.levels} levels` : "levels TBD";
        if (a.platform === "transmon") {
          return (
            `Transmon it is — ${levelsDesc}, ${paramsSummary(params)}. Filed under "${meta.slug}".\n\n` +
            `Model Hamiltonian:\n${TRANSMON_LATEX}\n\n` +
            `Show this to the user and confirm it matches their device.\n\n${sentinel}`
          );
        }
        if (a.platform === "rydberg") {
          return (
            `Rydberg, ${levelsDesc}, ${paramsSummary(params)} — noted and filed under "${meta.slug}".\n\n` +
            `Model: ${RYDBERG_DESC}\n\n${RYDBERG_SCOPE_NOTE}\n\n${sentinel}`
          );
        }
        return (
          `${a.platform}, ${levelsDesc}, ${paramsSummary(params)} — filed under "${meta.slug}".\n\n` +
          `I don't have a built-in template for ${a.platform} in this build, so let's capture the ` +
          `formulation for follow-up — I won't improvise an unvetted script.\n\n${sentinel}`
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
          description: "Number of levels to model (>=2, default 3); null to leave unchanged.",
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
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "model");
        if (blocked) return blocked;
        const existing = readEntityJson<SystemEntity>(meta.slug, "system");
        if (!existing) return "No system recorded yet — call amicode_pick_system first (interview stage 1).";
        const patchParams: Record<string, number> = { ...(given(a.params) ? a.params : {}) };
        if (given(a.drive_max)) patchParams.drive_max = a.drive_max;
        try {
          const merged = updateSystem(existing, {
            levels: given(a.levels) ? a.levels : undefined,
            params: patchParams,
          });
          const sentinel = recordEntity(meta.slug, "system", merged as any, systemToml(merged), {
            tool: "amicode_set_model",
            stage: "model",
          });
          completeStage(dir, "model");
          const warn =
            merged.levels !== undefined && merged.levels > MAX_LEVELS
              ? ` ⚠️ ${merged.levels} levels worsens conditioning/leakage and solve cost — convergence may degrade.`
              : "";
          return `Tweaked — ${merged.platform}, ${merged.levels ?? "levels TBD"}, ${paramsSummary(merged.params)}.${warn}\n\n${sentinel}`;
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
          description: "Problem kind, e.g. \"gate_synthesis\", \"state_prep\", \"min_time\".",
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
          // Optional nullable array — see the details field above. legacyJsonSchema
          // strips "null" → optional singular-typed array (provider-agnostic).
          type: ["array", "null"],
          items: { type: "string" },
          description: "Constraint list; omit for the default [\"amplitude bound (drive_max)\"].",
        },
      },
      async execute(a: { problem: string; target: string; objective?: string | null; constraints?: string[] | null }) {
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "formulate");
        if (blocked) return blocked;
        // Preserve any solve sub-object already recorded (stage 6 writes it via
        // amicode_solve; re-running formulate must not wipe it).
        const existing = readEntityJson<FormulationEntity>(meta.slug, "formulation");
        const entity: FormulationEntity = {
          problem: a.problem,
          target: a.target,
          objective: given(a.objective) ? a.objective : "unitary infidelity",
          constraints:
            Array.isArray(a.constraints) && a.constraints.length > 0
              ? a.constraints
              : ["amplitude bound (drive_max)"],
        };
        if (existing?.solve) entity.solve = existing.solve;
        const problems = validateFormulation(entity);
        if (problems.length) return `Cannot record formulation: ${problems.join("; ")}`;
        const sentinel = recordEntity(meta.slug, "formulation", entity as any, formulationToml(entity), {
          tool: "amicode_formulate",
          stage: "formulate",
        });
        completeStage(dir, "formulate");
        return (
          `Formulation's locked for "${meta.slug}" — ${entity.problem}, targeting ${entity.target}; ` +
          `objective: ${entity.objective}; constraints: ${entity.constraints.join(" · ")}\n\n${sentinel}`
        );
      },
    },

    amicode_solve: {
      description:
        "Record the Run entity stub (interview stage 6: SOLVE PARAMS), merging solve " +
        "parameters (T/N/max_iter/integrator) into the Formulation. This tool NEVER " +
        "launches a solve — the launch is the AGENTS.md bash workflow (`nohup amico-run …`). " +
        "Bookkeeping, not a gate.",
      args: {
        run_dir: {
          type: ["string", "null"],
          description: "The run directory if the bash launch already happened and it is known; else null.",
        },
        T: { type: ["number", "null"], description: "Gate time T in ns; null if not applicable." },
        N: { type: ["integer", "null"], description: "Number of timesteps N; null if not applicable." },
        max_iter: { type: ["integer", "null"], description: "Solver max iterations; null for the default." },
        integrator: { type: ["string", "null"], description: "Integrator name (e.g. \"MagnusGL4\"); null for the default." },
        tier: {
          type: ["string", "null"],
          description: "Authoring tier: \"vetted\" | \"composed\" | \"free\" (spec C); null if unknown.",
        },
        note: {
          type: ["string", "null"],
          description: "Short free-text note, e.g. \"X gate, T=10ns, N=50, defaults\"; null for none.",
        },
      },
      async execute(a: {
        run_dir?: string | null;
        T?: number | null;
        N?: number | null;
        max_iter?: number | null;
        integrator?: string | null;
        tier?: string | null;
        note?: string | null;
      }) {
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "solve");
        if (blocked) return blocked;

        // Merge solve params into the Formulation (they are the hash-relevant
        // half of #64's formulation_hash). One event, no sentinel (the Run
        // sentinel below is this call's receipt).
        if (given(a.T) || given(a.N) || given(a.max_iter) || given(a.integrator)) {
          const form = readEntityJson<FormulationEntity>(meta.slug, "formulation");
          if (form) {
            const solve = { ...(form.solve ?? {}) };
            if (given(a.T)) solve.T = a.T;
            if (given(a.N)) solve.N = a.N;
            if (given(a.max_iter)) solve.max_iter = a.max_iter;
            if (given(a.integrator)) solve.integrator = a.integrator;
            const merged: FormulationEntity = { ...form, solve };
            recordEntity(meta.slug, "formulation", merged as any, formulationToml(merged), {
              tool: "amicode_solve",
              stage: "solve",
            });
          }
        }

        // Run stub — refs point at the workspace entity files.
        const stub: RunStub = {};
        const sysPath = path.join(dir, "entities", "system.toml");
        const formPath = path.join(dir, "entities", "formulation.toml");
        if (fs.existsSync(sysPath)) stub.system_ref = sysPath;
        if (fs.existsSync(formPath)) stub.formulation_ref = formPath;
        if (given(a.run_dir)) stub.run_dir = a.run_dir;
        if (given(a.tier)) stub.tier = a.tier as RunStub["tier"];
        if (given(a.note)) stub.note = a.note;
        const sentinel = recordEntity(meta.slug, "run", stub as any, runStubToml(stub), {
          tool: "amicode_solve",
          stage: "solve",
        });

        // Append a run REF (lab/run_id parsed from run_dir's last two segments).
        if (given(a.run_dir)) {
          const parts = a.run_dir.replace(/\/+$/, "").split("/");
          const run_id = parts[parts.length - 1];
          const lab = parts[parts.length - 2] ?? "default";
          appendRunRef(meta.slug, {
            run_id,
            lab,
            tier: given(a.tier) ? (a.tier as RunStub["tier"]) : undefined,
            recorded: new Date().toISOString(),
          });
        }

        const missing = [
          ...(stub.system_ref ? [] : ["system (stage 1 skipped?)"]),
          ...(stub.formulation_ref ? [] : ["formulation (stages 4–5 skipped?)"]),
        ];
        const warn = missing.length ? ` Note: no recorded ${missing.join(" or ")}.` : "";
        const runWarn = given(a.run_dir) ? "" : " No run_dir yet — launch via the workflow's amico-run bash command.";
        completeStage(dir, "solve");
        return `Solve knobs set for "${meta.slug}".${warn}${runWarn}\n\n${sentinel}`;
      },
    },

    amicode_verify: {
      description:
        "Record the free-tier re-rollout VERIFICATION outcome on the Run entity (spec C). " +
        "Call this AFTER a `tier=\"free\"` solve finishes: amico-run runs the fixed re-rollout " +
        "harness and writes verification.toml; read it and pass agree + the two fidelities here. " +
        "Bookkeeping AFTER the fact — no stage gate (a verification record must never be lost). " +
        "Promotion of a free run is blocked until agree = true.",
      args: {
        agree: {
          type: "boolean",
          description: "Did the independent re-rollout agree with the reported fidelity (verification.toml `agree`)?",
        },
        fidelity_rerolled: {
          type: ["number", "null"],
          description: "The harness's re-rolled fidelity; null if unavailable.",
        },
        fidelity_reported: {
          type: ["number", "null"],
          description: "The solve's reported fidelity; null if unavailable.",
        },
      },
      async execute(a: { agree: boolean; fidelity_rerolled?: number | null; fidelity_reported?: number | null }) {
        const meta = ensureActiveProblem();
        const existing = readEntityJson<RunStub>(meta.slug, "run");
        if (!existing) {
          return (
            `No Run entity recorded in "${meta.slug}" yet — record the solve (amicode_solve) ` +
            `before its verification.`
          );
        }
        const merged: RunStub = {
          ...existing,
          verification: {
            agree: a.agree === true,
            fidelity_rerolled: given(a.fidelity_rerolled) ? a.fidelity_rerolled : null,
            fidelity_reported: given(a.fidelity_reported) ? a.fidelity_reported : null,
          },
        };
        const sentinel = recordEntity(meta.slug, "run", merged as any, runStubToml(merged), {
          tool: "amicode_verify",
        });
        const verdict = a.agree
          ? "agree = true — the re-rollout confirms the reported fidelity; the run can be promoted."
          : "agree = FALSE — the independent re-rollout disagrees; the run is UNTRUSTED and cannot be promoted. Relay this honestly.";
        return `Verification's in for "${meta.slug}". ${verdict}\n\n${sentinel}`;
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
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "hardware");
        if (blocked) return blocked;
        const stub: DeviceSessionStub = {};
        if (given(a.pulse_ref)) stub.pulse_ref = a.pulse_ref;
        if (given(a.run_dir)) stub.run_dir = a.run_dir;
        if (given(a.note)) stub.note = a.note;
        let sentinel: string;
        try {
          sentinel = recordEntity(meta.slug, "device_session", stub as any, deviceSessionStubToml(stub), {
            tool: "amicode_to_hardware",
            stage: "hardware",
          });
        } catch (err) {
          return `Cannot record device session: ${err instanceof Error ? err.message : String(err)}`;
        }
        const warn = stub.pulse_ref || stub.run_dir
          ? ""
          : " Note: no pulse/run referenced yet — re-record after the solve finishes.";
        return (
          `Hardware intent noted for "${meta.slug}" — pending your sign-off.${warn}\n\n` +
          `The send-to-device gate, when wired: (1) automated checks — fidelity ≥ threshold, ` +
          `|drive| ≤ amplitude cap, bandwidth within hardware limits, leakage bounded; ` +
          `(2) a human eyeballs the pulse and signs off before anything ships. ` +
          `Full disclosure — this build touches no real silicon, so this is a promissory note, not a live session.\n\n${sentinel}`
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
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "hardware");
        if (blocked) return blocked;
        const stub: CalibrationStub = {};
        if (given(a.device_session_ref)) {
          stub.device_session_ref = a.device_session_ref;
        } else {
          const dsPath = path.join(dir, "entities", "device_session.toml");
          if (fs.existsSync(dsPath)) stub.device_session_ref = dsPath;
        }
        if (given(a.note)) stub.note = a.note;
        let sentinel: string;
        try {
          sentinel = recordEntity(meta.slug, "calibration", stub as any, calibrationStubToml(stub), {
            tool: "amicode_calibrate",
            stage: "hardware",
          });
        } catch (err) {
          return `Cannot record calibration: ${err instanceof Error ? err.message : String(err)}`;
        }
        const warn = stub.device_session_ref
          ? ""
          : " Note: no device session recorded yet — amicode_to_hardware comes first.";
        return (
          `Calibration follow-up on the books for "${meta.slug}" (loop: ILC, status: not-wired).${warn}\n\n` +
          `Once hardware runs, an ILC loop (iterative learning control) closes ` +
          `the model-device gap: run the pulse, measure, compare against the model's ` +
          `prediction, update, repeat until the device matches the design on paper. In this build ` +
          `that loop's a recorded follow-up only — nothing actually fires here yet.\n\n${sentinel}`
        );
      },
    },
  },
});

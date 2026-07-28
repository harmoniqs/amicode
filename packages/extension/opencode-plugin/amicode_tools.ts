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
  compositeSystemToml,
  validateCompositeSystem,
  compositeSystemWarnings,
  normalizeSystem,
  updateCompositeSystem,
  expandTopology,
  platformDefaultRole,
  platformDefaultArch,
  type SystemEntity,
  type CompositeSystem,
  type Component,
  type Coupling,
  type CompositeSystemPatch,
  type CouplingKind,
  type Topology,
  type DriveArch,
  type FormulationEntity,
  normalizeFormulation,
  updateFormulation,
  formulationWarnings,
  type FormulationPatch,
  type TrajectoryType,
  type TimeMode,
  type Parameterization,
  type Robustness,
  type RunStub,
  type DeviceSessionStub,
  type CalibrationStub,
} from "./entities";
import { entityHash } from "./hashes";
import {
  ensureActiveProblem,
  readActiveSlug,
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
import {
  onboardingStreamDir,
  isOnboardingEntity,
  appendOnboardingEvent,
  statusSummary,
  triggerOnboardingDistill,
} from "./onboarding";
import {
  appendStanza,
  queryLedger,
  resolveWorkspaceSpecContext,
  stampStructureHash,
  selectRecommendations,
  attemptErrorStanza,
  fallbackStanza,
  verdictStanza,
  resolveRunHashes,
} from "./ledger_client";

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

/** The most recently `propose`d value for a recommendation key (stage/param),
 *  read back from events.jsonl — an `outcome:"overridden"` call only carries
 *  applied_value, but the ledger's `override` stanza needs BOTH recommended
 *  and applied; this recovers the former from the append-only event log. */
function lastProposedValue(slug: string, key: string): unknown {
  const file = path.join(problemDir(slug), "events.jsonl");
  if (!fs.existsSync(file)) return undefined;
  let found: unknown;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const rec = JSON.parse(line) as { entity?: string; action?: string; diff?: { key?: string; value?: unknown } };
      if (rec.entity === "recommendation" && rec.action === "proposed" && rec.diff?.key === key) {
        found = rec.diff.value;
      }
    } catch {
      /* malformed line — skip */
    }
  }
  return found;
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
  const before0 = readEntityJson<Record<string, unknown>>(slug, kind);
  // F1 (spec §6 / §3.3): normalize a system OR formulation `before` snapshot so the
  // diff is structured-vs-structured, not a spurious legacy→structured restructure
  // on first touch.
  const before =
    before0 === undefined
      ? before0
      : kind === "system"
        ? (normalizeSystem(before0) as unknown as Record<string, unknown>)
        : kind === "formulation"
          ? (normalizeFormulation(before0) as unknown as Record<string, unknown>)
          : before0;
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
  "Good news, with an asterisk: Rydberg solve authoring IS wired. When the ## Skill " +
  "index lists `Piccolissimo/piccolissimo-authoring`, recommend the Piccolissimo " +
  "free-phase CZ path (skill-guided, from scratch, subsystem_levels=[3,3]) — free-phase " +
  "is the honest primary metric for entangling gates. Otherwise the composed `rydberg-cz` " +
  "exemplar is the public fallback (experimental, not-yet-vetted, fixed-phase + virtual-Z " +
  "scan; the 2-qubit CZ is a touch sluggish in the current Piccolo path). Either way, be " +
  "honest about the tier — and do NOT tell the user Rydberg is unsupported, because it isn't.";

// The plugin: exactly one export (see header). opencode calls it on session
// creation with PluginInput; we need nothing from it today.
export const AmicodeTools = async (_input: unknown) => ({
  tool: {
    // Capability warrant request (spec-20260727-164748 §9.5 / G-9). The CARD is the
    // point: this tool exists so a refusal from amico-run's --spec gate becomes a
    // button the researcher can press, instead of prose asking them to run a CLI verb.
    // The tool records NOTHING and authorises NOTHING — it only renders the ask. The
    // warrant is minted by the card's bridge through `amico ledger approve`, so the
    // agent can never approve on the user's behalf (that separation is the whole
    // provenance argument in §9.5).
    amicode_request_approval: {
      description:
        "Ask the researcher to approve a capability warrant, rendering an in-chat Approve " +
        "button. Call this when `amico run --spec` refused with `warrant_required`: pass the " +
        "plan_hash it named and the bounds from its `required` list. This tool NEITHER " +
        "records nor grants anything — pressing the button is what mints the warrant. " +
        "End your turn after calling it; never approve on the user's behalf, and never " +
        "shell `amico ledger approve` yourself.",
      args: {
        plan_hash: {
          type: "string",
          description: "The plan being approved — use the plan_hash the gate's refusal named.",
        },
        bounds: {
          type: "object",
          description:
            "What to authorise. Declare ONLY what the launch needs (the gate refuses a launch " +
            "needing a bound the warrant omits, so an over-broad warrant is worse than a precise " +
            "one): {max_solves?: int>=1, tier?: string, max_size_class?: 'SMALL'|'MEDIUM', " +
            "device?: 'none'|'ro'|'rw'}.",
        },
        rationale: {
          type: "string",
          description: "One line on WHY this needs approving — shown on the card. Null for none.",
        },
      },
      async execute(a: { plan_hash: string; bounds?: Record<string, unknown> | null; rationale?: string | null }) {
        if (!a.plan_hash || a.plan_hash.trim() === "") return "Cannot request approval: plan_hash is required.";
        // Returned text is agent-directed only — the card renders from the tool INPUT
        // (parseApprovalInput), the same way the ask card does.
        const declared = a.bounds && typeof a.bounds === "object" ? Object.keys(a.bounds).join(", ") : "none";
        return (
          `Approval requested for plan ${a.plan_hash.trim()} (bounds declared: ${declared}). ` +
          `The researcher now has an Approve button in chat. Stop here and wait — do not ` +
          `re-run the solve until they press it, and do not mint the warrant yourself.`
        );
      },
    },
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
            '(e.g. "fully supported end-to-end"). Same length as options; omit for none.',
        },
      },
      async execute(a: { question: string; options: string[]; details?: string[] | null }) {
        const opts = Array.isArray(a.options) ? a.options.filter((o) => typeof o === "string" && o.trim() !== "") : [];
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
          description:
            "For create/open: the problem name (or slug) to create/find. For rename/archive: the target slug.",
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
        // Seed an N=1 COMPOSITE (spec §2/§3): one component with the platform's default role.
        // Known platforms default to 3 levels; unknown ones stay "levels TBD" (recorded honestly).
        const known = (KNOWN_PLATFORMS as readonly string[]).includes(a.platform);
        const seed: Component = { id: "q1", role: platformDefaultRole(a.platform), params };
        if (known) seed.levels = 3;
        const entity: CompositeSystem = {
          platform: a.platform,
          components: [seed],
          couplings: [],
          drive: { arch: platformDefaultArch(a.platform) },
        };
        if (given(a.notes)) entity.notes = a.notes;
        const problems = validateCompositeSystem(entity);
        if (problems.length) return `Cannot record system: ${problems.join("; ")}`;
        const sentinel = recordEntity(meta.slug, "system", entity as any, compositeSystemToml(entity), {
          tool: "amicode_pick_system",
          stage: "platform",
        });
        completeStage(dir, "platform");
        const levelsDesc = seed.levels !== undefined ? `${seed.levels} levels` : "levels TBD";
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
        // Author-first / open intake (spec-20260704-113005 §5). Any platform is
        // acknowledged AS STATED (recorded here with the actual string). No vetted
        // template ≠ decline: offer free-tier from-scratch authoring, honest that
        // it is unvetted and that every result is independently re-rolled before
        // we trust it. (This return string previously said "I won't improvise an
        // unvetted script" — the exact tool output that declined the spin-CX ask.)
        return (
          `${a.platform}, ${levelsDesc}, ${paramsSummary(params)} — noted and filed under "${meta.slug}".\n\n` +
          `No vetted template for ${a.platform} in this build. That's fine — I can author a ` +
          `from-scratch script for it against the public stack (unvetted), and every result is ` +
          `independently re-checked (re-rolled) before we trust it. If a platform skill for ` +
          `${a.platform} is listed in the Skill index, I'll follow it; otherwise I'll build from ` +
          `first principles and flag it honestly. Want me to proceed?\n\n${sentinel}`
        );
      },
    },

    amicode_set_model: {
      description:
        "Merge model details into the recorded COMPOSITE System entity (interview stages MODEL / " +
        "STRUCTURE / COMPONENT-PARAMS / COUPLINGS — all sub-steps of the `model` gate). Requires " +
        "amicode_pick_system first. Two ways to use it, mixable in one call: (a) single-qubit " +
        "back-compat — `levels`/`drive_max`/`params` fold onto the first component; (b) composite — " +
        "`components` (upserted by id), `couplings` (replaces the set), `topology` (a preset expands " +
        "to edges — pass `coupling_kind`), `drive_arch`. Bookkeeping only.",
      args: {
        levels: {
          type: ["integer", "null"],
          description: "Back-compat: levels for the FIRST component (>=2); null to leave unchanged.",
        },
        drive_max: {
          type: ["number", "null"],
          description: "Back-compat: drive amplitude bound (GHz) onto the first component; null to skip.",
        },
        params: {
          type: ["object", "null"],
          additionalProperties: { type: "number" },
          description: "Back-compat: extra numeric params merged onto the FIRST component; null for none.",
        },
        components: {
          // Array-of-objects arg. legacyJsonSchema only strips "null" at THIS top level (not inside
          // `items`), so per-object optionals (levels) are expressed by OMITTING from `required`,
          // NEVER a nested type:["integer","null"] (that re-trips the Gemini rejection).
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              role: { type: "string" },
              levels: { type: "integer" },
              params: { type: "object", additionalProperties: { type: "number" } },
            },
            required: ["id", "role", "params"],
          },
          description:
            "Components to upsert by id. role ∈ qubit|cavity|resonator|mode|atom. levels optional. " +
            "For N identical components, list them all (ids q1..qN).",
        },
        couplings: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              between: { type: "array", items: { type: "string" } },
              kind: { type: "string" },
              params: { type: "object", additionalProperties: { type: "number" } },
            },
            required: ["between", "kind", "params"],
          },
          description:
            "Explicit coupling edges (replaces the set). between = >=2 component ids (a mode-mediated " +
            "hyperedge includes the shared mode's id). kind ∈ exchange|ZZ|cross-resonance|dispersive-chi|vdW|mode-mediated.",
        },
        topology: {
          type: ["string", "null"],
          description: "Preset provenance: single-pair | linear-chain | custom. A non-custom preset expands to edges (pass coupling_kind).",
        },
        coupling_kind: {
          type: ["string", "null"],
          description: "Edge kind stamped when a topology preset expands into couplings (e.g. cross-resonance, vdW).",
        },
        coupling_params: {
          type: ["object", "null"],
          additionalProperties: { type: "number" },
          description: "Shared numeric params for the edges an expanding topology preset generates.",
        },
        drive_arch: {
          type: ["string", "null"],
          description: "Drive architecture: global | per-component | zoned.",
        },
      },
      async execute(a: {
        levels?: number | null;
        drive_max?: number | null;
        params?: Record<string, number> | null;
        components?: Component[] | null;
        couplings?: Coupling[] | null;
        topology?: Topology | null;
        coupling_kind?: CouplingKind | null;
        coupling_params?: Record<string, number> | null;
        drive_arch?: DriveArch | null;
      }) {
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "model");
        if (blocked) return blocked;
        const existingRaw = readEntityJson<Record<string, unknown>>(meta.slug, "system");
        if (!existingRaw) return "No system recorded yet — call amicode_pick_system first (interview stage 1).";
        const existing = normalizeSystem(existingRaw); // F1: tolerate a legacy flat on-disk entity

        const patch: CompositeSystemPatch = {};
        if (given(a.components)) patch.components = a.components;
        if (given(a.couplings)) patch.couplings = a.couplings;
        if (given(a.topology)) patch.topology = a.topology;
        if (given(a.drive_arch)) patch.drive = { arch: a.drive_arch };
        // Back-compat single-field path: fold levels/drive_max/params onto the FIRST component
        // (only when no explicit `components` array was given).
        if (!given(a.components) && (given(a.levels) || given(a.drive_max) || given(a.params))) {
          const first = existing.components[0];
          const c: Component = { id: first.id, role: first.role, params: { ...(given(a.params) ? a.params : {}) } };
          if (given(a.drive_max)) c.params.drive_max = a.drive_max;
          if (given(a.levels)) c.levels = a.levels;
          patch.components = [c];
        }

        try {
          let merged = updateCompositeSystem(existing, patch);
          // F2 (spec §2.3): a non-custom topology preset expands to explicit couplings when none
          // were supplied. Needs coupling_kind; without it we record the topology and note it.
          let couplingNote = "";
          if (given(a.topology) && a.topology !== "custom" && !given(a.couplings)) {
            if (given(a.coupling_kind)) {
              const ids = merged.components.map((c) => c.id);
              const edges = expandTopology(a.topology, ids, a.coupling_kind, given(a.coupling_params) ? a.coupling_params : {});
              merged = updateCompositeSystem(merged, { couplings: edges });
            } else {
              couplingNote = ` (topology recorded — pass coupling_kind to expand it into edges)`;
            }
          }
          const sentinel = recordEntity(meta.slug, "system", merged as any, compositeSystemToml(merged), {
            tool: "amicode_set_model",
            stage: "model",
          });
          completeStage(dir, "model");
          const warnings = compositeSystemWarnings(merged);
          const warn = warnings.length ? ` ⚠️ ${warnings.join("; ")}` : "";
          const nC = merged.components.length;
          const nK = merged.couplings.length;
          return (
            `Tweaked — ${merged.platform}: ${nC} component${nC === 1 ? "" : "s"}, ${nK} coupling${nK === 1 ? "" : "s"}, ` +
            `drive ${merged.drive.arch}.${couplingNote}${warn}\n\n${sentinel}`
          );
        } catch (err) {
          return `Cannot update model: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    amicode_formulate: {
      description:
        "Record the Formulation entity (interview stages 4–5: PROBLEM + FORMULATION) as TYPED " +
        "facets. The primary infidelity objective is DERIVED from trajectory_type + free_phase + " +
        "time_mode — do NOT pass it; `objectives` holds only ADDED terms (regularizers, etc.). " +
        "Upsert: any omitted facet keeps its existing/default value. Bookkeeping only.",
      args: {
        trajectory_type: {
          type: ["string", "null"],
          description: "ket | multiket | gate | density | multidensity. null keeps existing (default gate).",
        },
        time_mode: {
          type: ["string", "null"],
          description: "fixed | min_time (orthogonal to type). null keeps existing (default fixed).",
        },
        time_params: {
          type: ["object", "null"],
          additionalProperties: { type: "number" },
          description: "{final_fidelity, D} — the min-time fidelity floor + duration weight. null to skip.",
        },
        parameterization: {
          type: ["string", "null"],
          description: "smooth | linear_spline | cubic_spline | bang_bang. null keeps existing (default smooth).",
        },
        robustness: {
          // Loose object (kind + params) — kept schema-shallow to avoid the nested
          // legacyJsonSchema union gotcha; normalized in execute.
          type: ["object", "null"],
          description: "{ kind: none|ensemble|sensitivity, params: {...} }. null keeps existing (default none).",
        },
        free_phase: {
          type: ["boolean", "null"],
          description: "Virtual-Z free phase (objective-only, never in the ODE). null keeps existing (default false).",
        },
        leakage: {
          type: ["boolean", "null"],
          description: "Leakage suppression (its sole home — not an objective/constraint kind). null keeps existing.",
        },
        leakage_params: {
          type: ["object", "null"],
          additionalProperties: { type: "number" },
          description: "{value, cost} for the leakage flag. null to skip.",
        },
        target: {
          type: ["string", "null"],
          description: 'Target gate/state, e.g. "CZ", "H", "|1>". null keeps existing.',
        },
        objectives: {
          // Array-of-objects. legacyJsonSchema strips "null" only at THIS top level, not
          // inside `items` — per-object optionals (label) are expressed by OMITTING from
          // `required`, NEVER a nested type:[...,"null"]. Replaces the ADDED-terms set.
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              kind: { type: "string" },
              params: { type: "object", additionalProperties: { type: "number" } },
              label: { type: "string" },
            },
            required: ["kind", "params"],
          },
          description: "ADDED objective terms: kind ∈ reg_u|reg_du|reg_ddu|sensitivity|custom. Replaces the set.",
        },
        constraints: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              kind: { type: "string" },
              params: { type: "object", additionalProperties: { type: "number" } },
              label: { type: "string" },
            },
            required: ["kind", "params"],
          },
          description:
            "Typed constraints: kind ∈ bounds|du_bound|ddu_bound|dt_bounds|final_fidelity|calibration_pin|custom. " +
            "Replaces the set. final_fidelity is normally derived from time_params, not authored here.",
        },
      },
      async execute(a: {
        trajectory_type?: string | null;
        time_mode?: string | null;
        time_params?: Record<string, number> | null;
        parameterization?: string | null;
        robustness?: { kind?: string; params?: Record<string, number | string> } | null;
        free_phase?: boolean | null;
        leakage?: boolean | null;
        leakage_params?: Record<string, number> | null;
        target?: string | null;
        objectives?: FormulationPatch["objectives"] | null;
        constraints?: FormulationPatch["constraints"] | null;
      }) {
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "formulate");
        if (blocked) return blocked;
        // Upsert onto the existing (legacy-tolerant) entity via the pure merge.
        const existing = readEntityJson<Record<string, unknown>>(meta.slug, "formulation");
        const patch: FormulationPatch = {};
        if (given(a.trajectory_type)) patch.trajectory_type = a.trajectory_type as TrajectoryType;
        if (given(a.time_mode)) patch.time_mode = a.time_mode as TimeMode;
        if (given(a.time_params)) patch.time_params = a.time_params;
        if (given(a.parameterization)) patch.parameterization = a.parameterization as Parameterization;
        if (given(a.robustness))
          patch.robustness = {
            kind: (a.robustness.kind ?? "none") as Robustness["kind"],
            params: a.robustness.params ?? {},
          };
        if (given(a.free_phase)) patch.free_phase = a.free_phase;
        if (given(a.leakage)) patch.leakage = a.leakage;
        if (given(a.leakage_params)) patch.leakage_params = a.leakage_params;
        if (given(a.target)) patch.target = a.target;
        if (given(a.objectives)) patch.objectives = a.objectives;
        if (given(a.constraints)) patch.constraints = a.constraints;

        const merged = updateFormulation(existing, patch);
        const problems = validateFormulation(merged);
        if (problems.length) return `Cannot record formulation: ${problems.join("; ")}`;
        const sentinel = recordEntity(meta.slug, "formulation", merged as any, formulationToml(merged), {
          tool: "amicode_formulate",
          stage: "formulate",
        });
        completeStage(dir, "formulate");
        // Surface soft warnings (spec §3.2) — N comes from the sibling System.
        const sysRaw = readEntityJson<Record<string, unknown>>(meta.slug, "system");
        const componentCount = sysRaw ? normalizeSystem(sysRaw).components.length : undefined;
        const warnings = formulationWarnings(merged, componentCount);
        const warn = warnings.length ? ` ⚠️ ${warnings.join("; ")}` : "";
        const modes = [
          merged.trajectory_type,
          merged.time_mode === "min_time" ? "min-time" : undefined,
          merged.robustness.kind !== "none" ? merged.robustness.kind : undefined,
          merged.free_phase ? "free-phase" : undefined,
        ].filter(Boolean).join(" · ");
        return `Formulation's locked for "${meta.slug}" — ${modes}, target ${merged.target}${warn}\n\n${sentinel}`;
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
        integrator: {
          type: ["string", "null"],
          description: 'Integrator name (e.g. "MagnusGL4"); null for the default.',
        },
        tier: {
          type: ["string", "null"],
          description: 'Authoring tier: "vetted" | "composed" | "free" (spec C); null if unknown.',
        },
        note: {
          type: ["string", "null"],
          description: 'Short free-text note, e.g. "X gate, T=10ns, N=50, defaults"; null for none.',
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
          const formRaw = readEntityJson<Record<string, unknown>>(meta.slug, "formulation");
          if (formRaw) {
            // Normalize a possibly-legacy on-disk formulation before re-serializing
            // (spec §3.1.3 "all read sites normalize") — else the structured
            // formulationToml would reject/misserialize the legacy shape.
            const form = normalizeFormulation(formRaw);
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
        'Call this AFTER a `tier="free"` solve finishes: amico-run runs the fixed re-rollout ' +
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
        // Run-ledger `verdict` stanza (learning-loops L-A/L-D): joins to the run's
        // `solve` record on problem_hash — "verified" means verdict=agree via this
        // join. Only possible when the run_dir's result.toml carries a problem_hash
        // (Task 5's stamp); silently skipped otherwise (bookkeeping, never a gate).
        if (existing.run_dir) {
          const hashes = resolveRunHashes(existing.run_dir);
          if (hashes?.problem_hash) {
            appendStanza(
              verdictStanza({
                problemHash: hashes.problem_hash,
                structureHash: hashes.structure_hash,
                verdict: a.agree ? "agree" : "disagree",
                fidelityRerolled: given(a.fidelity_rerolled) ? a.fidelity_rerolled : undefined,
                fidelityReported: given(a.fidelity_reported) ? a.fidelity_reported : undefined,
              }),
            );
          }
        }
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
        const warn =
          stub.pulse_ref || stub.run_dir
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
          description: "Path to the recorded device_session.toml; null to auto-reference the recorded one if present.",
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
    // ── Onboarding (spec-20260705-002847 §3) — NOT a problem stage: UNGATED
    // (no guardAndRecordStage), writes the ops-side onboarding stream, never the
    // vault. The distiller materializes the cards on the completion marker.
    amicode_profile: {
      description:
        "Record onboarding entities during the overture interview (session zero), and read them " +
        "back to resume. Entities: `profile` {name, role, org, platforms[], goals}; " +
        "`environment` {slug, archetype: qick-lab|cloud-pasqal|local-sim|other, control_stack, " +
        "integration, emulator, endpoints[] — POINTERS ONLY, never credentials}; " +
        "`device` {name, platform, environment, qubits, params, status}; and " +
        "`onboarding_completed` {} — record it EXACTLY ONCE, at the handoff stage (it is what " +
        "lets the background distiller materialize the user's profile). " +
        "Pass `status` as the entity to read back everything recorded so far — call that FIRST " +
        "when the overture starts, and resume from it (ask only what's missing).",
      args: {
        entity: {
          type: "string",
          description: "profile | environment | device | onboarding_completed | status",
        },
        payload: {
          type: ["object", "null"],
          description: "The entity's fields (see tool description). Pass null for status / onboarding_completed.",
        },
      },
      async execute(a: { entity: string; payload?: Record<string, unknown> | null }) {
        try {
          const dir = onboardingStreamDir();
          if (a.entity === "status") return statusSummary(dir);
          if (!isOnboardingEntity(a.entity)) {
            return `Cannot record "${a.entity}" — valid entities: profile, environment, device, onboarding_completed, status.`;
          }
          const { seq, clean } = appendOnboardingEvent(dir, a.entity, a.payload ?? {});
          if (a.entity === "onboarding_completed") {
            const spawned = triggerOnboardingDistill();
            return (
              `Onboarding complete (event ${seq}). ` +
              (spawned
                ? "Your profile is being materialized in the background — the next session opens personalized."
                : "Profile materialization queued (distiller transport not armed yet — it runs on the next drain).")
            );
          }
          const fields = Object.keys(clean).join(", ") || "(empty)";
          return `Recorded ${a.entity} (event ${seq}): ${fields}.`;
        } catch (err) {
          return `Cannot record onboarding entity: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    // ── Recommendations (spec-20260705-024340 L1) — advisory, UNGATED. Records
    // WHY a parameter is what it is (value + confidence + cited provenance), and
    // the accept/override outcome. The value still LANDS via amicode_set_model /
    // amicode_formulate; this annotates the decision so it's inspectable and so
    // L2 (Veloce) has a machine-readable confidence to act on.
    amicode_recommend: {
      description:
        "Record a parameter recommendation and its outcome, or retrieve ledger-backed " +
        "priors (L1 + learning-loops L-A). Three actions: " +
        "action=`propose` logs {stage, param, value, confidence: high|medium|low, " +
        "provenance:[{source: own-precedent|demo|physics|ledger|default, ref, note}], alternatives?} — " +
        "confidence is MECHANICAL per scores/memory/confidence-rubric.md (never a guess); " +
        "action=`outcome` logs {stage, param, outcome: accepted|overridden, applied_value} AFTER " +
        "the value lands via set_model/formulate (append-only pair, keyed on stage+param) — an " +
        "`overridden` outcome also appends a run-ledger `override` stanza; " +
        "action=`query` retrieves honest ledger priors (medians/IQR, \"n runs, m verified\" " +
        "provenance) for the active workspace's most recent structure_hash — pass `params` " +
        "(e.g. [\"Q\",\"N\"]) to select which recommendable knobs to return, or omit for all. " +
        "Ledger-sourced confidence is CAPPED at medium (interim guard until per-structure trust " +
        "lands) — never auto-applied. propose/outcome events are stamped with structure_hash when " +
        "known. No active problem workspace yet → a no-op receipt (recommendations begin at the problem stage).",
      args: {
        action: { type: "string", description: "propose | outcome | query" },
        stage: { type: "string", description: "interview stage, e.g. model | formulate" },
        param: { type: "string", description: "parameter name, e.g. N | T | levels | drive_max | warm_start" },
        value: { type: ["string", "number", "boolean", "null"], description: "recommended value (propose)" },
        confidence: { type: ["string", "null"], description: "high | medium | low (propose)" },
        provenance: {
          type: ["array", "null"],
          description: "[{source, ref, note}] (propose) — cite where it came from",
        },
        alternatives: { type: ["array", "null"], description: "optional [{value, note}] considered (propose)" },
        outcome: { type: ["string", "null"], description: "accepted | overridden (outcome)" },
        applied_value: {
          type: ["string", "number", "boolean", "null"],
          description: "the value actually applied (outcome)",
        },
        auto_accepted: {
          type: ["boolean", "null"],
          description: "true when Veloce (L2) auto-accepted this without asking (propose)",
        },
        params: {
          type: ["array", "null"],
          description: 'Recommendable knob names to retrieve, e.g. ["Q","N"] (query); null/omitted = all.',
        },
      },
      async execute(a: {
        action: string;
        stage?: string;
        param?: string;
        value?: unknown;
        confidence?: string | null;
        provenance?: unknown[] | null;
        alternatives?: unknown[] | null;
        outcome?: string | null;
        applied_value?: unknown;
        auto_accepted?: boolean | null;
        params?: string[] | null;
      }) {
        try {
          const slug = readActiveSlug();
          if (!slug)
            return "No active problem yet — recommendation not recorded (recommendations begin at the problem stage).";

          // ── query: retrieve honest ledger priors (learning-loops L-A) ──
          if (a.action === "query") {
            const ctx = resolveWorkspaceSpecContext(slug);
            if (!ctx)
              return (
                `No ledger history yet for "${slug}" — action=query needs at least one completed, ` +
                `hash-stamped run to key on (run a solve first).`
              );
            if (ctx.N === undefined || ctx.T === undefined)
              return `Ledger history found for "${slug}" but its N/T are unavailable — cannot bucket the query.`;
            // ctx.goal keys the query on the task, not just the type skeleton —
            // without it a CZ's medians would be recommended for an X gate.
            const result = queryLedger(ctx.structure_hash, ctx.N, ctx.T, ctx.goal);
            if (!result) return `Ledger query unavailable for "${slug}" (amico CLI unreachable, or no matching history).`;
            const wanted = Array.isArray(a.params) && a.params.length > 0 ? a.params.map(String) : undefined;
            const recs = selectRecommendations(result, wanted);
            if (recs.length === 0) return `No ledger-backed recommendations yet for "${slug}" (${result.provenance}).`;
            const lines = recs.map((r) => `  ${r.param} = ${JSON.stringify(r.value)} (${r.confidence}, ${r.provenance})`);
            return `Ledger-backed recommendations for "${slug}":\n${lines.join("\n")}`;
          }

          const key = `${a.stage ?? "?"}/${a.param ?? "?"}`;
          const structureHash = stampStructureHash(slug);
          if (a.action === "outcome") {
            const seq = appendEvent(slug, {
              entity: "recommendation",
              action: "outcome",
              diff: {
                key,
                stage: a.stage,
                param: a.param,
                outcome: a.outcome,
                applied_value: a.applied_value,
                ...(structureHash ? { structure_hash: structureHash } : {}),
              },
              source: { tool: "amicode_recommend", stage: a.stage },
            });
            // An override gets its own run-ledger stanza (single-writer: shell `amico
            // ledger append`, never touch runs.jsonl directly) — recommended value is
            // recovered from the matching `proposed` event (outcome only carries applied).
            if (a.outcome === "overridden" && structureHash) {
              appendStanza({
                type: "override",
                ts: new Date().toISOString(),
                param: a.param ?? "?",
                recommended: lastProposedValue(slug, key) ?? null,
                applied: a.applied_value ?? null,
                structure_hash: structureHash,
                // "overridden" IS a human declining the recommendation — never auto-accepted.
                auto_accepted: false,
              });
            }
            return `Recorded outcome for ${key}: ${a.outcome} (applied ${JSON.stringify(a.applied_value)}) [event ${seq}].`;
          }
          // default: propose
          const seq = appendEvent(slug, {
            entity: "recommendation",
            action: "proposed",
            diff: {
              key,
              stage: a.stage,
              param: a.param,
              value: a.value,
              confidence: a.confidence,
              provenance: a.provenance ?? [],
              ...(structureHash ? { structure_hash: structureHash } : {}),
              ...(a.alternatives ? { alternatives: a.alternatives } : {}),
              // Veloce (L2): an auto-accept records auto_accepted AND outcome:accepted
              // in one step (spec L2 §5).
              ...(a.auto_accepted ? { auto_accepted: true, outcome: "accepted", applied_value: a.value } : {}),
            },
            source: { tool: "amicode_recommend", stage: a.stage },
          });
          const prov =
            Array.isArray(a.provenance) && a.provenance.length
              ? ((a.provenance[0] as { source?: string }).source ?? "?")
              : "none";
          const auto = a.auto_accepted ? " ⚡auto" : "";
          return `Recommended ${a.param}=${JSON.stringify(a.value)} (${a.confidence ?? "?"}, via ${prov})${auto} [event ${seq}].`;
        } catch (err) {
          return `Cannot record recommendation: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    // ── Ledger observability (learning-loops L1 Task 7) — bookkeeping tools for
    // events the extension has no other hook into: a solvespec/problem_spec
    // validation failure and a tier fallback both happen inside `amico run
    // --spec` (a bash invocation the agent runs directly — the extension has no
    // in-process gate on either), so the agent reports what it observed in the
    // CLI's output. Mirrors amicode_recommend's own doctrine: bookkeeping AFTER
    // the fact, driven by an explicit call describing what happened elsewhere.
    // Both shell `amico ledger append` via ledger_client.ts — never touch
    // runs.jsonl directly.
    amicode_report_attempt_error: {
      description:
        "Record a solvespec/problem_spec VALIDATION FAILURE observed from an `amico run --spec` " +
        "(or amico-validate) invocation's error output (L-B: repeated identical rejections are a " +
        "spec-surface bug signal, not a user failure — this feeds that weekly report). " +
        "Call this right after seeing a schema/gate rejection in the CLI's stderr/JSON.",
      args: {
        errors: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, msg: { type: "string" } },
            required: [],
          },
          description: "[{path, msg}] — the field-precise errors from the CLI's rejection.",
        },
      },
      async execute(a: { errors: Array<{ path?: string; msg?: string }> }) {
        const slug = readActiveSlug();
        const ok = appendStanza(attemptErrorStanza(a.errors ?? [], slug));
        return ok
          ? `Recorded ${a.errors?.length ?? 0} validation error(s) to the run ledger.`
          : "Could not record validation errors to the run ledger (amico CLI unreachable) — not fatal, continuing.";
      },
    },
    amicode_report_fallback: {
      description:
        "Record a TIER FALLBACK observed from an `amico run --spec` invocation (e.g. composed → " +
        "free, the gate's demote_to). L-C ranks spec-coverage gaps (missing trajectory kinds, " +
        "objective terms) by how often people actually needed them — this is that demand signal. " +
        "Call this right after seeing a demotion in the CLI's output.",
      args: {
        from_tier: { type: "string", description: 'The tier the run demoted FROM, e.g. "composed".' },
        reason: { type: "string", description: "Why it fell back (the gate's stated reason)." },
      },
      async execute(a: { from_tier: string; reason: string }) {
        const ok = appendStanza(fallbackStanza(a.from_tier, a.reason));
        return ok
          ? `Recorded fallback from "${a.from_tier}" to the run ledger.`
          : "Could not record the fallback to the run ledger (amico CLI unreachable) — not fatal, continuing.";
      },
    },
    // ── Veloce (spec-20260705-024341 L2) — records the autonomy-mode transition.
    // The policy itself (auto-accept HIGH-confidence downstream params; resource
    // gates always confirm; interrupt-off) is prompt-level in SCORE.md; this tool
    // makes the mode durable + inspectable (⚡ badge) and returns current state.
    amicode_veloce: {
      description:
        "Turn Amico Veloce on/off, or read its state. Veloce auto-accepts HIGH-confidence " +
        "downstream recommendations (never system params, never past a resource gate — those " +
        "always confirm). action=`on` {reason: explicit|offered|persisted}, action=`off` " +
        "{reason: interrupt|explicit}, action=`status` returns current mode. Record `off, " +
        "reason:interrupt` the moment the user corrects a value, asks a question, or says stop.",
      args: {
        action: { type: "string", description: "on | off | status" },
        reason: { type: ["string", "null"], description: "explicit | offered | persisted | interrupt" },
      },
      async execute(a: { action: string; reason?: string | null }) {
        try {
          const slug = readActiveSlug();
          if (!slug) return "No active problem yet — veloce state not recorded.";
          if (a.action === "status") {
            // Latest veloce event wins.
            const file = path.join(problemDir(slug), "events.jsonl");
            let mode = "off";
            try {
              for (const line of fs.readFileSync(file, "utf8").split("\n")) {
                if (!line.trim()) continue;
                const e = JSON.parse(line);
                if (e.entity === "veloce" && e.diff?.mode) mode = e.diff.mode;
              }
            } catch {
              /* no events yet */
            }
            return `Veloce is ${mode}.`;
          }
          const mode = a.action === "on" ? "on" : "off";
          const seq = appendEvent(slug, {
            entity: "veloce",
            action: "transition",
            diff: { mode, reason: a.reason ?? "explicit" },
            source: { tool: "amicode_veloce" },
          });
          return mode === "on"
            ? `⚡ Veloce ON (${a.reason ?? "explicit"}) — I'll auto-accept high-confidence choices and still confirm before any solve [event ${seq}].`
            : `Veloce OFF (${a.reason ?? "explicit"}) — back to asking each step [event ${seq}].`;
        } catch (err) {
          return `Cannot set veloce: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  },
});

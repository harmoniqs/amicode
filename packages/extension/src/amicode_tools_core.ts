// ============================================================================
// amicode_tools_core — the ONE implementation of the amicode_* tool surface
// (#700, harness-contract A3: one implementation, two transports).
//
// HARNESS-NEUTRAL BY CONTRACT: everything here is filesystem + explicit
// arguments. The two transports project this table:
//   - the opencode plugin (opencode-plugin/amicode_tools.ts) — a thin adapter
//     that supplies the engine SDK client + per-call session ctx and keeps the
//     plugin-file startup ritual (stderr load line, legacy-migration one-shot);
//   - the MCP stdio server (src/mcp_amico_server.ts → bin/dist/mcp-amico.mjs) —
//     the portable carrier any MCP client can drive.
// The plugin's behavior stays byte-identical (pinned by the existing plugin
// tests + the adapter projection test in test/amicode_tools_core.test.ts).
//
// ARGS-SCHEMA DECISION (unchanged from the plugin): plain JSON-Schema property
// objects validated inside execute(); every declared arg is REQUIRED in the
// schema the LLM sees, so optional args are declared nullable ("pass null to
// skip") and all real validation happens in execute() via the entities
// validators. The MCP projection mirrors this 1:1 (required = every key).
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

import {
  formulationToml,
  runStubToml,
  deviceSessionStubToml,
  calibrationStubToml,
  validateFormulation,
  entityDiff,
  truncateDiffForSentinel,
  KNOWN_PLATFORMS,
  compositeSystemToml,
  validateCompositeSystem,
  compositeSystemWarnings,
  normalizeSystem,
  updateCompositeSystem,
  expandTopology,
  platformDefaultRole,
  platformDefaultArch,
  type CompositeSystem,
  type Component,
  type Coupling,
  type CompositeSystemPatch,
  type HamiltonianTerm,
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
  type RehearsalRecord,
  rehearsalSatisfiesStage,
} from "../opencode-plugin/entities";
import { entityHash } from "../opencode-plugin/hashes";
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
} from "../opencode-plugin/problems";
import {
  guardAndRecordStage, completeStage } from "../opencode-plugin/score_guard";
import { readRehearsalRecord } from "../opencode-plugin/rehearsal";
import {
  recordCalibChain,
  completeCalibChain,
  type ChainLeg,
} from "../opencode-plugin/calib_chain";
import {
  SPAWN_MAX_COUNT,
  SPAWN_MAX_DEPTH,
  parseSpawnArgs,
  computeDepth,
  depthRefusal,
  defaultTitle,
  childTitle,
  unwrap,
  summarizeSpawned,
  type SpawnedChild,
} from "../opencode-plugin/session_spawn";
import {
  onboardingStreamDir,
  isOnboardingEntity,
  appendOnboardingEvent,
  statusSummary,
  triggerOnboardingDistill,
} from "../opencode-plugin/onboarding";
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
} from "../opencode-plugin/ledger_client";



/** The server-bound SDK client the opencode fork builds per plugin load. Only
 *  amicode_session touches it (session spawn is the one harness-coupled verb);
 *  every other tool is local bookkeeping. Under transports with no engine
 *  (MCP stdio) it stays undefined and amicode_session refuses honestly. */
export interface EngineClientShape {
  session: {
    get: (o: unknown) => Promise<unknown>;
    create: (o: unknown) => Promise<unknown>;
    update: (o: unknown) => Promise<unknown>;
    fork: (o: unknown) => Promise<unknown>;
    promptAsync: (o: unknown) => Promise<unknown>;
  };
}

/** What a transport hands each execute() call. The plugin fills engineClient
 *  from its load input and sessionID/directory from opencode's per-call ctx;
 *  the MCP server passes carrier:"mcp" and nothing else. */
export interface AmicodeToolContext {
  engineClient?: EngineClientShape | undefined;
  sessionID?: string;
  directory?: string;
  carrier?: string;
}

/** One JSON-Schema property object of the args map (the plugin's args-schema
 *  decision: loose on purpose — validation lives in execute()). */
export type AmicodeArgSchema = {
  type: unknown;
  [key: string]: unknown;
};

/** A registered amicode_* tool: the LLM-facing surface (description + args)
 *  and the implementation. Method-syntax execute keeps the moved tool bodies'
 *  narrow arg typings assignable (bivariance), matching how they were declared
 *  inside the plugin closure. */
export interface AmicodeToolDef {
  description: string;
  args: Record<string, AmicodeArgSchema>;
  execute(a: any, ctx: AmicodeToolContext): Promise<string>;
}

// ── The naming contract (one canonical name per tool, two transport views) ────
//
// The table is keyed by each tool's CANONICAL PRODUCT NAME (`amicode_pick_system`,
// …) — the name the product has always surfaced, stored exactly once, here.
// The transports derive their wire names from it (#700 A3, director decision
// on the #700 escalation):
//   - the opencode plugin registers the canonical name verbatim;
//   - the MCP server serves the BARE name (`pick_system`) — the MCP-native
//     pattern, where each CLIENT namespaces by server. opencode's fork does
//     exactly that (McpCatalog.toolName = sanitize(serverName) + "_" + name),
//     so a server named "amicode" renders `amicode_pick_system` — the
//     product-identical view. Non-opencode clients see clean bare names
//     namespaced by whatever they call the server.

/** The MCP wire name of a tool: the canonical product name minus the
 *  `amicode_` prefix (the server's own namespace is not repeated in the tool
 *  name — the client adds it back). Throws on a non-prefixed key: the table's
 *  naming contract is that every canonical name carries the product prefix. */
export function mcpBareName(productName: string): string {
  if (!productName.startsWith("amicode_") || productName.length === "amicode_".length) {
    throw new Error(`tool "${productName}" violates the naming contract: canonical names are "amicode_"-prefixed`);
  }
  return productName.slice("amicode_".length);
}

/** The inverse: the canonical product name for a bare MCP wire name. */
export function mcpProductName(bareName: string): string {
  return "amicode_" + bareName;
}



// Domain-pack gate (ADR 0008): quantum-control-specific tools (amicode_pick_system,
// amicode_set_model, amicode_formulate, amicode_solve, amicode_to_hardware,
// amicode_calibrate) are registered only when the quantum-control pack is active.
// Always true today; the seam exists for future domain packs that would register
// their own entity tools without the quantum-control ones.
const QUANTUM_CONTROL_PACK_ACTIVE = true;


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
//
// THIRD COPY WARNING. The same physics is written down in three places: here,
// the System card's fallback tables (opencode fork, ui/src/amicode/system-render.ts),
// and the Julia templates. They HAVE drifted — the card rendered a single
// quadrature `ε(t)(â+â†)` while this string and Piccolo's `n_drives = 2` both say
// two. Two quadratures is correct; the card was fixed to match. The real cure is
// `amicode_set_model`'s `hamiltonian` arg: once the model is recorded on the
// entity, every surface renders that one artifact and these constants are only a
// pre-MODEL fallback.
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



// ── The tool table (the one source of truth) ──────────────────────────────────
export const AMICODE_TOOLS: Record<string, AmicodeToolDef> = {

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

    // ── Quantum-control domain tools (gated by QUANTUM_CONTROL_PACK_ACTIVE) ──
    // These tools record quantum-control-specific entities (System, Formulation,
    // Run, DeviceSession, Calibration). When a second domain pack arrives, its
    // entity tools would register here conditionally alongside these.
    ...(QUANTUM_CONTROL_PACK_ACTIVE ? {

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
          description: "Transition frequency ω in GHz (transmon ω₀₁, cavity ω_c); null if not applicable/known.",
        },
        delta: {
          type: ["number", "null"],
          description:
            "Anharmonicity δ in GHz — a transmon-like ladder ONLY; null if not applicable/known. A Rydberg " +
            "atom has no anharmonicity: its detuning Δ and Rabi bound Ω are platform params for " +
            "amicode_set_model's `params` at the MODEL stage, never this field.",
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
        // LEVELS ARE NOT SEEDED. Known platforms used to get a silent levels=3 here, which the
        // System card then rendered indistinguishably from a number the researcher had actually
        // given — the one confident-looking row on the card was the one nobody had said. The
        // MODEL stage asks for levels (default 3) and records the answer.
        const seed: Component = { id: "q1", role: platformDefaultRole(a.platform), params };
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
        // Structure (how many components) and levels are the MODEL stage's job — say so, so the
        // agent asks rather than letting the recorded N=1 seed pass for a confirmed answer.
        const levelsAsk =
          `Structure and levels are NOT recorded yet — the System card shows "1 ${seed.role}, levels not set" ` +
          `because that is all anyone has said. Ask at the MODEL stage (3 levels is the usual default; ` +
          `record it only once the researcher confirms).`;
        // Off-template platforms get role `other` rather than a fabricated `qubit`, and the card
        // shows no Hamiltonian at all for them — so the agent has to supply the physics it knows.
        const offTemplateAsk =
          seed.role === "other"
            ? `\n\nThe component's role is recorded as \`other\` — no structural model was assumed from ` +
              `the platform string. At the MODEL stage set the real role AND record the model term by term ` +
              `via amicode_set_model's \`hamiltonian\`: you know what ${a.platform} looks like, the card's ` +
              `built-in fallback table does not, and until you record it the card will show no Hamiltonian.`
            : "";
        if (a.platform === "transmon") {
          return (
            `Transmon it is — ${paramsSummary(params)}. Filed under "${meta.slug}".\n\n` +
            `Model Hamiltonian:\n${TRANSMON_LATEX}\n\n` +
            `Show this to the user and confirm it matches their device.\n\n${levelsAsk}\n\n${sentinel}`
          );
        }
        if (a.platform === "rydberg") {
          return (
            `Rydberg, ${paramsSummary(params)} — noted and filed under "${meta.slug}".\n\n` +
            `Model: ${RYDBERG_DESC}\n\n${RYDBERG_SCOPE_NOTE}\n\n${levelsAsk}\n\n${sentinel}`
          );
        }
        // Author-first / open intake (spec-20260704-113005 §5). Any platform is
        // acknowledged AS STATED (recorded here with the actual string). No vetted
        // template ≠ decline: offer free-tier from-scratch authoring, honest that
        // it is unvetted and that every result is independently re-rolled before
        // we trust it. (This return string previously said "I won't improvise an
        // unvetted script" — the exact tool output that declined the spin-CX ask.)
        return (
          `${a.platform}, ${paramsSummary(params)} — noted and filed under "${meta.slug}".\n\n` +
          `No vetted template for ${a.platform} in this build. That's fine — I can author a ` +
          `from-scratch script for it against the public stack (unvetted), and every result is ` +
          `independently re-checked (re-rolled) before we trust it. If a platform skill for ` +
          `${a.platform} is listed in the Skill index, I'll follow it; otherwise I'll build from ` +
          `first principles and flag it honestly. Want me to proceed?\n\n${levelsAsk}${offTemplateAsk}\n\n${sentinel}`
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
            "Components to upsert by id. role ∈ qubit|cavity|resonator|mode|atom|other — use `other` " +
            "when none of the structural models fit, never a near-miss. levels optional. " +
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
        hamiltonian: {
          // Per-object optionals are expressed by OMITTING from `required`, never a
          // nested type:[...,"null"] — legacyJsonSchema only strips "null" at the top
          // level, and a nested one re-trips the Gemini rejection.
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              kind: { type: "string" },
              latex: { type: "string" },
              acts_on: { type: "array", items: { type: "string" } },
              label: { type: "string" },
            },
            required: ["kind", "latex"],
          },
          description:
            "THE MODEL YOU ARE ACTUALLY SOLVING, term by term — record it once the researcher has " +
            "confirmed it. Each term: kind ∈ drift|coupling|drive, `latex` renderable by KaTeX with no " +
            "leading '+' (e.g. \"-\\\\Delta\\\\,\\\\hat n_i\"), optional `acts_on` component ids and `label`. " +
            "Without this the System card falls back to a canonical form for the platform and SAYS it is " +
            "inferred — which is all it can honestly do off-template. You know what an exchange-only spin " +
            "qubit or a fluxonium looks like; the card's built-in table never will. Record it especially " +
            "when the platform is not transmon/rydberg/bosonic. Replaces any previously recorded set.",
        },
        hamiltonian_notes: {
          type: ["string", "null"],
          description: "Conventions the terms assume — rotating frame, units, basis ordering; null for none.",
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
        hamiltonian?: HamiltonianTerm[] | null;
        hamiltonian_notes?: string | null;
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
        if (given(a.hamiltonian)) {
          patch.hamiltonian = { terms: a.hamiltonian };
          if (given(a.hamiltonian_notes)) patch.hamiltonian.notes = a.hamiltonian_notes;
        }
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
        "Record the DeviceSession entity (interview stage 8: HARDWARE). Real device I/O " +
        "stays PROPOSE-ONLY (human sign-off gate). SEAM 1 (#680): the stage gains a REHEARSAL — " +
        "the solved pulse runs a full sim preview through the ACTUAL Strumento.jl MockSoc transport " +
        "path (translate → envelopes → execute! → synthetic IQ → Measurement → one strategy step), " +
        "in pure Julia, no Python, no board. Launch it per the run-launch seam (bash, julia " +
        "--startup-file=no): julia --startup-file=no --project=<ext>/templates/mocksoc-rehearsal " +
        "<ext>/templates/mocksoc_rehearsal.jl <pulse.jld2> <result.toml> [out_dir] — it writes " +
        "rehearsal.toml (honestly labeled sim; carries the pulse content-hash, the mismatch " +
        "declaration, the strategy-step outcome). Pass that artifact's path as `rehearsal_ref` to " +
        "record it into the device session. Outcome-gated: a rehearsal with outcome=success " +
        "SATISFIES the hardware stage (the sim preview part — the send-to-device gate stays " +
        "pending-human-sign-off); a FAILED rehearsal is surfaced distinctly and does NOT satisfy " +
        "the stage — it stays an honest stub until a rehearsal passes.",
      args: {
        pulse_ref: {
          type: ["string", "null"],
          description: "Path to the solved pulse artifact (pulse.jld2) if known; else null.",
        },
        run_dir: {
          type: ["string", "null"],
          description: "The run directory the pulse came from, if known; else null.",
        },
        rehearsal_ref: {
          type: ["string", "null"],
          description:
            "Path to the rehearsal.toml artifact from the MockSoc rehearsal (the Strumento " +
            "transport path); null to record intent only (the pre-rehearsal stub).",
        },
        note: {
          type: ["string", "null"],
          description: "Short free-text note; null for none.",
        },
      },
      async execute(a: {
        pulse_ref?: string | null;
        run_dir?: string | null;
        rehearsal_ref?: string | null;
        note?: string | null;
      }) {
        const meta = ensureActiveProblem();
        const dir = problemDir(meta.slug);
        const blocked = guardAndRecordStage(problemsDir(), dir, "hardware");
        if (blocked) return blocked;
        const stub: DeviceSessionStub = {};
        if (given(a.pulse_ref)) stub.pulse_ref = a.pulse_ref;
        if (given(a.run_dir)) stub.run_dir = a.run_dir;
        if (given(a.note)) stub.note = a.note;
        // SEAM 1: the rehearsal artifact — read + validate BEFORE any entity
        // write. A broken/dishonest artifact records nothing (honest refusal),
        // never a costume of progress.
        let rehearsal: RehearsalRecord | undefined;
        if (given(a.rehearsal_ref)) {
          const rr = readRehearsalRecord(a.rehearsal_ref);
          if (!rr.ok) {
            return (
              `Cannot record the rehearsal for "${meta.slug}": ${rr.problem}.\n\n` +
              `Nothing was recorded. Re-run the rehearsal (the artifact must declare ` +
              `sim = true and carry outcome, pulse_hash, mismatch, and the step outcome) ` +
              `and pass the fresh rehearsal.toml path as rehearsal_ref.`
            );
          }
          rehearsal = rr.record;
          stub.rehearsal = rehearsal;
        }
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
        if (rehearsal && rehearsalSatisfiesStage(rehearsal)) {
          // The outcome gate (SEAM 1 AC): only a PASSED rehearsal satisfies the
          // stage. The sim preview is satisfied — the send-to-device gate itself
          // stays pending-human-sign-off (no costume of hardware progress).
          completeStage(dir, "hardware");
          return (
            `MockSoc rehearsal PASSED for "${meta.slug}" — the hardware stage's sim preview is satisfied.\n\n` +
            `Transport (translate → envelopes → execute! → synthetic IQ → Measurement → one ` +
            `strategy step) ran through the actual Strumento.jl path; the device session records ` +
            `it honestly labeled sim: pulse ${rehearsal.pulse_hash}, mismatch "${rehearsal.mismatch}", ` +
            `step: ${rehearsal.step_outcome}.\n\n` +
            `Still pending — the send-to-device gate: (1) automated checks — fidelity ≥ threshold, ` +
            `|drive| ≤ amplitude cap, bandwidth within hardware limits, leakage bounded; ` +
            `(2) a human eyeballs the pulse and signs off before anything ships. This rehearsal ` +
            `touched no real silicon — it is the sim preview, not a live session.\n\n${sentinel}`
          );
        }
        if (rehearsal) {
          // FAILED — surfaced DISTINCTLY; the stage stays an honest stub.
          return (
            `MockSoc rehearsal FAILED for "${meta.slug}" — the failure is recorded, but it does ` +
            `NOT satisfy the hardware stage: the stage stays an honest stub until a rehearsal ` +
            `passes.\n\nWhat failed: ${rehearsal.error ?? "no error recorded"}\n\n` +
            `Diagnose (pulse.jld2 readable? result.toml carries [params]? the env resolved?), ` +
            `re-run the rehearsal, and pass the fresh rehearsal.toml path as rehearsal_ref.\n\n${sentinel}`
          );
        }
        return (
          `Hardware intent noted for "${meta.slug}" — pending your sign-off.${warn}\n\n` +
          `The stage's sim preview (SEAM 1): run the solved pulse through the MockSoc rehearsal ` +
          `(julia --startup-file=no --project=<ext>/templates/mocksoc-rehearsal ` +
          `<ext>/templates/mocksoc_rehearsal.jl <pulse.jld2> <result.toml> [out_dir]) and pass the ` +
          `resulting rehearsal.toml back as rehearsal_ref — a passed rehearsal satisfies the ` +
          `stage's sim preview; a failed one is surfaced distinctly and satisfies nothing.\n\n` +
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

    // SEAM 5 (#681) — the calibrate→pin→re-optimize→re-bank chain: ONE recorded
    // verb path composed from existing seams. The recording core (calib_chain.ts)
    // owns the logic and is unit-tested; this wrapper is the agent-facing
    // surface (args → core → AMICODE_DIFF receipt), never a launch, never a
    // promotion (the staged re-bank runs out-of-band, human-gated).
    amicode_calib_chain: {
      description:
        "Record the calibrate→pin→re-optimize→re-bank chain (SEAM 5, #681) — the drift-response " +
        "tune-up as ONE recorded verb. TWO calls, one chain: STAGE with the calibration + pin + " +
        "seed; COMPLETE with the promoted entry's metadata once the re-bank ran.\n" +
        "CALIBRATE (leg=mock): the SEAM 1 MockSoc rehearsal is the calibration data source — " +
        "run it first per the run-launch seam (bash, julia --startup-file=no): " +
        "julia --startup-file=no --project=<ext>/templates/mocksoc-rehearsal " +
        "<ext>/templates/mocksoc_rehearsal.jl <pulse.jld2> <result.toml> [out_dir], and pass the " +
        "rehearsal.toml as rehearsal_ref (validated through the same reader amicode_to_hardware " +
        "uses — a dishonest artifact records nothing). leg=hardware is REFUSED: real-board " +
        "sessions are an enumerated human gate and this build has no real-board session surface.\n" +
        "PIN: pass `pinned` (global → calibrated value, e.g. {delta: 0.21}) — it lands on the " +
        "recorded formulation as the existing calibration_pin constraint (the " +
        "fix_global_variable! path) + solve.pinned_globals; re-staging replaces the pin.\n" +
        "RE-OPTIMIZE: pass warm_start (the bank seed — catalog entry id or pulse ref); the run " +
        "stub records it. The re-solve itself launches through the EXISTING solve path (bash " +
        "amico-run), warm-started via the load_traj idiom; pass its run_dir when known.\n" +
        "RE-BANK: the tool STAGES the exact `amico catalog ingest` command with the chain's " +
        "provenance flags (--warm-start/--calibration-ref/--pin — which calibration, which pin, " +
        "which seed). Promotion is human-gated like all promotions: run it ONLY after the " +
        "researcher signs off (with verification evidence). Then COMPLETE: pass the promoted " +
        "entry's metadata.toml path as rebank_metadata_ref — the fingerprint is verified and the " +
        "executed_on_mock event lands on the provenance spine (the countable execution record).",
      args: {
        leg: {
          type: ["string", "null"],
          description: 'mock (the only recordable leg) | hardware (refused — real-board sessions are an enumerated human gate). Null = mock.',
        },
        rehearsal_ref: {
          type: ["string", "null"],
          description: "The SEAM 1 rehearsal.toml artifact — the mock leg's calibration data source. Null to complete a staged chain.",
        },
        pinned: {
          type: ["object", "null"],
          additionalProperties: { type: "number" },
          description: "The calibrated globals to pin (global → value), e.g. {delta: 0.21} from a 'delta × 1.05' rehearsal mismatch on a 0.2 nominal.",
        },
        warm_start: {
          type: ["string", "null"],
          description: "The bank seed the re-solve warm-starts from (catalog entry id or pulse ref).",
        },
        run_dir: {
          type: ["string", "null"],
          description: "The re-solve's run directory, once launched through the solve path; else null.",
        },
        note: {
          type: ["string", "null"],
          description: "Short free-text note; null for none.",
        },
        rebank_metadata_ref: {
          type: ["string", "null"],
          description: "COMPLETE the chain: the promoted catalog entry's metadata.toml path — verified (read-only) against the chain's fingerprint, then the executed_on_mock event is recorded. Null to stage.",
        },
      },
      async execute(a: {
        leg?: string | null;
        rehearsal_ref?: string | null;
        pinned?: Record<string, number> | null;
        warm_start?: string | null;
        run_dir?: string | null;
        note?: string | null;
        rebank_metadata_ref?: string | null;
      }) {
        const meta = ensureActiveProblem();

        // COMPLETE — verify the promoted entry's fingerprint + the execution record.
        if (given(a.rebank_metadata_ref)) {
          const res = completeCalibChain({ slug: meta.slug, rebankMetadataRef: a.rebank_metadata_ref });
          if (!res.ok) {
            return `Cannot complete the calibrate→pin→re-optimize chain for "${meta.slug}": ${res.problem}`;
          }
          const sentinel = sentinelLine(meta.slug, "calib_chain", res.chainEvent.action, res.chainEvent.seq, res.chainEvent.diff);
          return (
            `Chain executed on mock for "${meta.slug}"${res.already ? " (re-verified; already complete)" : ""} — the re-bank ` +
            `carried the chain's fingerprint (which calibration, which pin, which warm-start ` +
            `seed), the rebank leg is recorded on the chain entity, and the executed_on_mock ` +
            `event is on the provenance spine. The promotion itself ran out-of-band through the ` +
            `human-gated ingest — this record is its receipt, not its author.\n\n${sentinel}`
          );
        }

        // STAGE — calibrate + pin + re-optimize legs.
        if (!given(a.rehearsal_ref) || !given(a.pinned) || !given(a.warm_start)) {
          return (
            `Cannot stage the chain for "${meta.slug}": rehearsal_ref (the SEAM 1 rehearsal ` +
            `artifact), pinned (the calibrated globals), and warm_start (the bank seed) are all ` +
            `required to stage — or pass rebank_metadata_ref alone to complete a staged chain. ` +
            `Nothing was recorded.`
          );
        }
        const res = recordCalibChain({
          slug: meta.slug,
          leg: (a.leg === "hardware" ? "hardware" : "mock") as ChainLeg,
          rehearsalRef: a.rehearsal_ref,
          pinned: a.pinned,
          warmStart: a.warm_start,
          runDir: given(a.run_dir) ? a.run_dir : undefined,
          note: given(a.note) ? a.note : undefined,
        });
        if (!res.ok) {
          return `Cannot stage the calibrate→pin→re-optimize chain for "${meta.slug}": ${res.problem}`;
        }
        const sentinel = sentinelLine(meta.slug, "calib_chain", res.staged.chainEvent.action, res.staged.chainEvent.seq, res.staged.chainEvent.diff);
        return (
          `Chain staged for "${meta.slug}" — calibrated via the MockSoc rehearsal (${res.staged.chainRef} ` +
          `carries the fingerprint), the pin landed on the formulation (calibration_pin + ` +
          `pinned_globals), and the re-optimize leg's warm-start seed is on the run stub.\n\n` +
          `Re-bank when the re-solve finishes — the human-gated promotion, run only after the ` +
          `researcher signs off:\n  ${res.staged.rebankCommand}\n${res.staged.humanGate}\n\n` +
          `Then complete the chain: pass the promoted entry's metadata.toml path as ` +
          `rebank_metadata_ref (the fingerprint gets verified, and the executed_on_mock event ` +
          `lands on the provenance spine).\n\n${sentinel}`
        );
      },
    },
    } : {}), // end quantum-control domain tools gate
    // ── Onboarding (spec-20260705-002847 §3) — NOT a problem stage: UNGATED
    // (no guardAndRecordStage), writes the ops-side onboarding stream, never the
    // vault. The distiller materializes the cards on the completion marker.
    amicode_profile: {
      description:
        "Record onboarding entities during the overture interview (session zero), and read them " +
        "back to resume. Entities: `profile` {name, role, org, platforms[], goals, intent, " +
        "description, research_area, experiment_kind, scholar, github, custom_link_url, custom_link_label}; " +
        "`environment` {slug, archetype: qick-lab|cloud-pasqal|local-sim|other, control_stack, " +
        "integration, emulator, endpoints[] — POINTERS ONLY, never credentials}; " +
        "`device` {name, platform, environment, qubits, params, status}; and " +
        "`onboarding_completed` {} — record it EXACTLY ONCE, at the handoff stage (it is what " +
        "lets the background distiller materialize the user's profile and bridges data to the " +
        "profile dropdown). " +
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
          // Sentinel so the in-chat receipt carries WHICH param was recommended.
          // Without it every recommend call rendered an identical "Recommend
          // updated" chip, and the interview fires one per knob — so a run of five
          // was five indistinguishable lines. `recommend` is deliberately NOT in
          // card.tsx's INLINE_KINDS (no entity view exists for it), so this renders
          // as an informative one-liner and stays non-clickable.
          return (
            `Recommended ${a.param}=${JSON.stringify(a.value)} (${a.confidence ?? "?"}, via ${prov})${auto} [event ${seq}].\n` +
            sentinelLine(slug, "recommend", "proposed", seq, {
              [String(a.param)]: { from: null, to: a.value },
            })
          );
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
    // Session spawn (amicode#639) — the FIRST tool in this pack that mutates
    // server state. Everything above is local bookkeeping; this one creates
    // live sessions that immediately spend model budget, so the policy (caps,
    // depth, force) lives in ./session_spawn.ts and is unit-tested there.
    // Children stamp metadata {spawned_by, spawned_depth}: the app's session
    // route watches for that stamp and opens each child as a background tab
    // in the pane showing THIS session (addSessionTab — no focus steal).
    amicode_session: {
      description:
        "Spawn one or a few NEW chat sessions that appear as background tabs beside this one. " +
        "Each child starts working on `prompt` immediately (its first turn is posted at spawn); " +
        "tabs open in this session's pane without stealing focus. This is the FIRST " +
        "server-mutating tool in this pack — everything else here is local bookkeeping — and " +
        "each spawned session runs on the user's model budget, so fan out deliberately (hard " +
        "cap " + SPAWN_MAX_COUNT + " per call). mode='fork' seeds the child from THIS session's " +
        "history instead of a blank start. A session that was itself spawned cannot spawn again " +
        "past depth " + SPAWN_MAX_DEPTH + " unless force=true. Do NOT use this for subagent-style " +
        "work the user need not steer (use the Task tool) — sessions are for parallel or " +
        "branching work the USER should see and interact with.",
      args: {
        prompt: {
          type: "string",
          description: "The first message for each spawned session — what it should work on.",
        },
        count: {
          type: ["integer", "null"],
          description: "How many sessions to spawn (1-" + SPAWN_MAX_COUNT + "). Null = 1.",
        },
        title: {
          type: ["string", "null"],
          description: "Tab/session title. Null = derived from the prompt.",
        },
        agent: {
          type: ["string", "null"],
          description: "Agent for the child session (e.g. 'plan', 'build'). Null = server default.",
        },
        model: {
          type: ["string", "null"],
          description: "'providerID/modelID' for the child. Null = this session's model.",
        },
        mode: {
          type: ["string", "null"],
          enum: ["fresh", "fork"],
          description: "fresh (blank session; default) | fork (seeded from this session's history).",
        },
        force: {
          type: ["boolean", "null"],
          description: "Overrule the spawn-depth cap. Null = false.",
        },
      },
      async execute(
        a: {
          prompt: string;
          count?: number | null;
          title?: string | null;
          agent?: string | null;
          model?: string | null;
          mode?: string | null;
          force?: boolean | null;
        },
        ctx: AmicodeToolContext,
      ) {
        if (!ctx.engineClient) {
          return (
            ctx.carrier === "plugin"
              ? "Cannot spawn: the engine did not hand this plugin a server client (legacy load path)."
              : "Cannot spawn: the MCP transport carries no engine client — session spawning rides " +
                "the harness's own session API (this tool only spawns inside the opencode plugin transport)."
          );
        }
        const parsed = parseSpawnArgs(a);
        if (!parsed.ok) return `Cannot spawn: ${parsed.error}.`;
        const args = parsed.args;
        // Depth comes from THIS session's own stamp — never from the caller's
        // claim — so the cap is enforced by construction, not by politeness.
        let own: { metadata?: unknown; model?: { providerID?: string; modelID?: string } } | undefined;
        try {
          own = unwrap<typeof own>(
            await ctx.engineClient.session.get({ path: { id: ctx.sessionID }, query: { directory: ctx.directory } }),
          );
        } catch {
          own = undefined;
        }
        const depth = computeDepth(own?.metadata);
        if (depth >= SPAWN_MAX_DEPTH && !args.force) return depthRefusal(depth);
        // Model precedence: explicit arg > this session's model > server default.
        const model =
          args.model ??
          (own?.model?.providerID && own?.model?.modelID
            ? { providerID: own.model.providerID, modelID: own.model.modelID }
            : null);
        const base = args.title ?? defaultTitle(args.prompt);
        const spawnMeta = { spawned_by: ctx.sessionID, spawned_depth: depth + 1 };
        const children: SpawnedChild[] = [];
        try {
          for (let i = 0; i < args.count; i++) {
            const title = childTitle(base, i, args.count);
            let id: string | undefined;
            if (args.mode === "fork") {
              const forked = unwrap<{ id?: string }>(
                await ctx.engineClient.session.fork({
                  path: { id: ctx.sessionID },
                  query: { directory: ctx.directory },
                  body: {},
                }),
              );
              id = forked?.id;
              if (id) {
                // The fork endpoint carries history but not our stamp; PATCH
                // metadata so the parent's route can auto-open the tab.
                // Tolerated failure: the child still runs, it just won't
                // auto-open — the summary below lists it either way.
                await ctx.engineClient.session
                  .update({ path: { id }, query: { directory: ctx.directory }, body: { metadata: spawnMeta } })
                  .catch(() => undefined);
              }
            } else {
              const created = unwrap<{ id?: string }>(
                await ctx.engineClient.session.create({
                  query: { directory: ctx.directory },
                  body: {
                    title,
                    metadata: spawnMeta,
                    ...(args.agent ? { agent: args.agent } : {}),
                    ...(model ? { model } : {}),
                  },
                }),
              );
              id = created?.id;
            }
            if (!id) throw new Error(`session ${args.mode === "fork" ? "fork" : "create"} returned no id`);
            await ctx.engineClient.session.promptAsync({
              path: { id },
              query: { directory: ctx.directory },
              body: {
                parts: [{ type: "text", text: args.prompt }],
                ...(model ? { model } : {}),
                ...(args.agent ? { agent: args.agent } : {}),
              },
            });
            children.push({ id, title });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (children.length > 0) return `${summarizeSpawned(children, args.mode)}\nStopped early: ${msg}`;
          return `Cannot spawn: ${msg}`;
        }
        return summarizeSpawned(children, args.mode);
      },
    },

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

};

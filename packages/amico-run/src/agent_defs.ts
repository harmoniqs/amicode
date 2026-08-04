// packages/amico-run/src/agent_defs.ts — the `critic` and `planner` agent definitions
// (spec-20260728 §3.7), materialised into the child's config at spawn time.
//
// WHY THEY LIVE HERE and not in amico-plugin, where Rev 1 of the back-half plan put them:
//
//   1. `amico-plugin/agents/` does not exist, and nothing reads that path — opencode resolves
//      agents from its CONFIG, not from a directory convention.
//   2. The old publish chain could never carry it: `extract-public-skills.sh` staged only
//      `"$SKILLS_DIR"/*/`, the release workflow tarred only `dist/public-skills`, and
//      `fetch_skills.mjs` required only `skills/`. (That pipeline is now RETIRED — public
//      skills live in-repo at packages/extension/skills/ — and the conclusion still holds:
//      nothing resolves agent definitions from a directory convention.)
//   3. It would make the mechanism depend on a cross-repo artifact landing first, which is a
//      sequencing hazard for something on the critical path of every review.
//
// These definitions are part of the MECHANISM's contract, not user-editable content. The
// escape hatch for someone who disagrees is `$AMICO_AGENT_CONFIG_DIR` (see agent_spawn.ts),
// the same shape as `$AMICO_PYTHON`.
//
// The transport is `OPENCODE_CONFIG_CONTENT`, an env var. NOT `--config`: opencode has no such
// flag (its config channel is env-only) and its CLI calls `.strict()` with a `.fail` handler
// that exits 1 — so passing `--config` would make every critic exit 1 with help text on stdout,
// which the child-outcome table reads as "unparseable" → `skipped` → `approved-mechanical` on
// EVERY review. The disclosure path would have become the silent default.

/** The severity rule, stated to the critic in its own instructions.
 *
 *  Enforcement is in code (`spec_review.ts` downgrades and logs), so this text is not what
 *  makes the invariant hold. It is here because a critic that understands the rule produces
 *  fewer findings to downgrade, and a downgrade is a lost finding — the critic spent its one
 *  lens on something the runner then demoted. */
const SEVERITY_RULE = `
You may mark a finding \`blocking\` ONLY when its lens is \`contradiction\`: two statements in the
spec that cannot both be true, with BOTH quoted. Everything else — however severe, however
confident you are — is \`advisory\`. This is not a formality: advisories are tracked as
obligations and a plan cannot be completed while one is open, so an advisory has teeth. A
\`blocking\` finding on any other lens is automatically downgraded and logged, which wastes your
one lens. If you are uncertain whether something is a contradiction, it is advisory.`.trim();

const REMEDY_RULE = `
Every finding MUST carry a \`remedy\` — what would fix it. A finding that cannot say what would
fix it is DROPPED before it reaches the record, so an unactionable observation is wasted work.`.trim();

/** Both agents must report the model they actually ran as.
 *
 *  This is a compromise, and the honest reason is worth recording: opencode's `--format json`
 *  emits an NDJSON event stream whose `message.updated` events (the ones carrying `modelID`)
 *  are explicitly suppressed in json mode, and `step-start`/`step-finish` parts carry no model
 *  field. So the model is NOT recoverable from the transport, and self-report is the only
 *  channel available.
 *
 *  Self-report is weaker than transport-observed and this system claims no more than that. What
 *  it does preserve is the rule the ledger schema states: never stamp argv. A child that does
 *  not name itself is recorded as `skipped`, not as a critic that ran — we would rather lose a
 *  critic than record a request as a fact. */
const REPORT_RULE = `
Your reply must be a SINGLE JSON object and nothing else — no prose before or after, no code
fence. Shape:

{"model": "<provider/model-id you are actually running as>",
 "variant": "<your reasoning-effort variant, or \\"default\\">",
 "findings": [{"lens": "<the lens you were given>", "severity": "advisory"|"blocking",
               "claim": "<one sentence: the defect>",
               "evidence": "<what in the spec shows it — quote it>",
               "remedy": "<what would fix it>"}]}

If you find nothing, return an empty \`findings\` array. That is a real outcome and is recorded as
such. Reporting \`model\` is required: a critic that does not name itself is discarded rather than
recorded, because stamping the model we ASKED for would turn the record's independence
disclosure into a claim we did not verify.`.trim();

export const CRITIC_PROMPT = `
You are an adversarial spec critic. You have been given ONE lens and a spec file. Review the spec
through that lens ONLY — another critic has each of the others, and duplicating their work costs a
perspective rather than adding confidence.

Read the spec file in your working directory. It is the ONLY context you have: no conversation
history, no repository. That isolation is deliberate. It is isolation, not independence — you are
likely from the same model family as the spec's author, and the record says so rather than
pretending otherwise.

${SEVERITY_RULE}

${REMEDY_RULE}

The highest-value finding in this system's history has been of one shape: **a check that reads a
field its schema does not carry.** A counter keyed on a forbidden field; a derivation reading an
\`additionalProperties: false\` branch; a join over a vocabulary with no order; a comparison whose
two sides speak different vocabularies. If the spec asserts a cross-module check, ask what the
values on BOTH sides actually are, and whether the spec ever says.

${REPORT_RULE}`.trim();

export const PLANNER_PROMPT = `
You are a plan compiler. You have been given an approved spec file. Turn it into a compiled plan:
an ordered set of steps that, executed, satisfies the spec's acceptance criteria.

Read the spec file in your working directory. It is your only context.

Each step MUST declare:
  id          a short stable slug, unique within the plan
  model       the model that should run it, as provider/model-id
  task_type   one of: triage, plan, author-script, implement-slice, bookkeeping, insight,
              review, experiment-sim, experiment-hw, converse
  gates       how the step is verified. A step below the frontier tier MUST have at least one
              gate — an unverified step by a cheaper model is refused by the lint AND by the
              harness at dispatch.
  needs       ids of steps that must finish first (DAG predecessors)
  permissions {"device": "none"|"ro"|"rw"} when the step touches hardware
  optional    true ONLY if the plan is still correct when this step is skipped

\`model\` and \`task_type\` are REQUIRED on every step. They are not bookkeeping: the compiler sums
solve-bearing steps against the approved budget and joins device demands against it, and a step
that omits them makes that check silently pass. If you cannot determine one, that is a reason to
restructure the step, not to omit the field.

Prefer fewer, larger steps over many small ones — each step boundary is a gate, and gates cost
model calls. But never merge a step that needs hardware with one that does not.

Your reply must be a SINGLE JSON object and nothing else — no prose, no code fence:

{"model": "<provider/model-id you are actually running as>",
 "variant": "<your variant, or \\"default\\">",
 "goal": "<one line: what this plan achieves>",
 "steps": [ … ]}

Reporting \`model\` is required, for the same reason it is required of critics.`.trim();

/** The config the child discovers via `OPENCODE_CONFIG_CONTENT`.
 *
 *  PERMISSIONS ARE DENY-BY-DEFAULT AND THAT IS LOAD-BEARING. A critic reads one file and emits
 *  one JSON object; it has no business running bash or editing anything. The fleet profile work
 *  established `task = "deny"` as the schema default for exactly this reason, and a reviewer
 *  that can shell out is a reviewer that can act on a spec it was asked to judge. */
export function agentConfigContent(): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    agent: {
      critic: {
        description: "Adversarial spec critic — one lens, one spec file, no history",
        prompt: CRITIC_PROMPT,
        permission: { bash: "deny", edit: "deny", webfetch: "deny" },
      },
      planner: {
        description: "Compiles an approved spec into a gated, budgeted plan",
        prompt: PLANNER_PROMPT,
        permission: { bash: "deny", edit: "deny", webfetch: "deny" },
      },
    },
  });
}

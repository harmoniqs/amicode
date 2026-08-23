// Fixture corpus generator for the vault schema contract tests (amicode#496).
// Writes valid/*.json (>= 30 cards across all 18 types), invalid/*.json
// (>= 15 refusals), and valid-md/ (one markdown card for file-level tests).
// Deterministic + canonical JSON. Run: node test/fixtures/vault-cards/generate-fixtures.mjs
// Authorship note (PR gate): this corpus is implementer-generated; the
// reviewer spot-check refusals and adds adversarial variants in PR review.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
}
const canonical = (v) => `${JSON.stringify(sortDeep(v), null, 2)}\n`;

// ---------------------------------------------------------------- valid ----
const valid = [];
const V = (name, obj) => valid.push([name, obj]);

// experiment x4
V("experiment-transmon-x.json", { type: "experiment", task_type: "experiment-sim", date: "2026-08-10", session_id: "s1", platform: "transmon", gate: "X", fidelity: 0.999986, duration_us: 10, status: "solved", tags: ["x-gate"] });
V("experiment-rydberg-cz.json", { type: "experiment", task_type: "experiment-sim", date: "2026-08-12", session_id: "s2", platform: "rydberg", gate: "CZ", fidelity: 0.9999998, duration_us: 42, status: "solved", tags: ["cz"] });
V("experiment-cavity-failed.json", { type: "experiment", task_type: "experiment-sim", date: "2026-08-14", session_id: "s3", platform: "cavity", gate: "Fock2", fidelity: 0.71, duration_us: 30, status: "failed", tags: ["fock"] });
V("experiment-fluxonium-ext.json", { type: "experiment", task_type: "experiment-sim", date: "2026-08-16", session_id: "s4", platform: "fluxonium", gate: "X", fidelity: 0.9995, duration_us: 20, status: "solved", tags: ["fluxonium"], provenance: ["experiments/exp-fluxonium.md"], review_by: "2026-11-16", subject: "fluxonium-x" });

// insight x5
V("insight-plain.json", { type: "insight", date: "2026-08-18", source: "session", evidence: ["experiments/e1.md"], confidence: "medium", tags: ["warm-starts"] });
V("insight-full-extensions.json", { type: "insight", date: "2026-08-18", source: "session", evidence: ["experiments/e2.md"], confidence: "high", tags: ["warm-starts"], provenance: ["experiments/e2.md"], review_by: "2026-11-18", subject: "warm-starts" });
V("insight-sentinel-reviewed.json", { type: "insight", date: "2026-08-18", source: "session", evidence: ["experiments/e3.md"], confidence: "low", tags: ["legacy"], provenance: [], provenance_unrecoverable: true, reviewed_after: "journal/pass-1.md" });
V("insight-minimal.json", { type: "insight", date: "2026-08-19", source: "retro", evidence: [], confidence: "medium", tags: [] });
V("insight-routing.json", { type: "insight", date: "2026-08-20", source: "session", evidence: ["experiments/e4.md"], confidence: "high", tags: ["routing"], subject: "model-routing" });

// hypothesis x3
V("hypothesis-open.json", { type: "hypothesis", date: "2026-08-18", source: "session", status: "open", evidence: [], tags: ["bilinear"] });
V("hypothesis-tested.json", { type: "hypothesis", date: "2026-08-19", source: "session", status: "tested", evidence: ["experiments/e5.md"], tags: ["bilinear"] });
V("hypothesis-falsified.json", { type: "hypothesis", date: "2026-08-20", source: "session", status: "falsified", evidence: ["experiments/e6.md"], tags: ["magnus"] });

// method x2
V("method-bangbang.json", { type: "method", name: "bang-bang parameterization", date: "2026-08-01", source: "literature", applicability: "short-time gates, drive-limited regimes", tags: ["parameterization"] });
V("method-smooth.json", { type: "method", name: "smooth parameterization", date: "2026-08-02", source: "demo", applicability: "transmon single-qubit gates", tags: ["parameterization"], provenance: ["experiments/e7.md"] });

// paper x2
V("paper-willow.json", { type: "paper", date: "2026-08-05", arxiv: "2405.17385", authors: ["Willow", "Andersen"], tags: ["spin-qubits"] });
V("paper-quera.json", { type: "paper", date: "2026-08-06", arxiv: "2211.15453", authors: ["Bluvstein"], tags: ["rydberg"] });

// spec x3
V("spec-draft.json", { type: "spec", date: "2026-08-21", status: "draft", priority: "p1", platform: "transmon", tags: ["context"] });
V("spec-approved.json", { type: "spec", date: "2026-08-21", status: "approved", priority: "p1", platform: "transmon", tags: ["context"], review_by: "2027-08-21" });
V("spec-superseded.json", { type: "spec", date: "2026-08-18", status: "superseded", priority: "p2", platform: "cavity", tags: ["distillation"] });

// plan x2
V("plan-active.json", { type: "plan", date: "2026-08-22", status: "active", tags: ["telaio"] });
V("plan-landed.json", { type: "plan", date: "2026-08-20", status: "landed", tags: ["telaio"] });

// retrospective x2
V("retro-session-a.json", { type: "retrospective", date: "2026-08-16", tags: ["session"] });
V("retro-session-b.json", { type: "retrospective", date: "2026-08-17", tags: ["session"] });

// person x2
V("person-aaron.json", { type: "person", name: "Aaron Trowbridge", org: "Harmoniqs", role: "researcher", tags: ["team"] });
V("person-collab.json", { type: "person", name: "K. Kim", org: "External", role: "collaborator", tags: ["collab"] });

// org x1
V("org-harmoniqs.json", { type: "org", name: "Harmoniqs", tags: ["team"] });

// device x1
V("device-mini.json", { type: "device", name: "Mac mini", status: "online", platforms: ["server"], tags: ["fleet"] });

// meeting x2
V("meeting-weekly.json", { type: "meeting", date: "2026-08-15", attendees: ["aaron", "kate"], tags: ["weekly"] });
V("meeting-design.json", { type: "meeting", date: "2026-08-18", attendees: ["aaron"], tags: ["design"] });

// feedback x3
V("feedback-smooth-pulses.json", { type: "feedback", name: "smooth-pulses", description: "smooth parameterization reliably achieves F>0.9999 for transmon X", status: "active", date: "2026-08-01", tags: ["memory", "parameterization"] });
V("feedback-warm-starts.json", { type: "feedback", name: "warm-starts", description: "warm-starting from prior pulses failed consistently (Jul 12 batch)", status: "active", date: "2026-08-01", tags: ["memory"] });
V("feedback-amendments.json", { type: "feedback", name: "amendment-review-budget", description: "spec amendments get the same adversarial review budget as originals", status: "active", date: "2026-08-22", tags: ["memory", "specs"], provenance: ["insights/i-amend.md"], review_by: "2026-11-22" });

// project x2
V("project-two-qubit.json", { type: "project", name: "two-qubit-challenge", description: "two-qubit gates are significantly harder than single-qubit", status: "active", date: "2026-08-01", tags: ["memory"] });
V("project-armonia.json", { type: "project", name: "public-armonia-seed", description: "harmoniqs/armonia seeded 2026-08-05", status: "active", date: "2026-08-05", tags: ["memory"] });

// reference x2
V("reference-workspace.json", { type: "reference", name: "workspace-ref", description: "Julia workspace at ~/.amico/julia", status: "active", date: "2026-08-01", tags: ["memory"] });
V("reference-altissimo.json", { type: "reference", name: "altissimo-cpu", description: "Altissimo is CPU-native; GPU is an optional lift", status: "active", date: "2026-08-10", tags: ["memory"] });

// user x1
V("user-profile.json", { type: "user", name: "profile", description: "quantum-control researcher; transmon deepest", status: "active", date: "2026-08-21", tags: ["memory"] });

// tension x2
V("tension-magnus.json", { type: "tension", date: "2026-08-22", subject: "magnus-integrator", a_cards: ["knowledge/feedback-piccolissimo.md"], b_cards: ["knowledge/insight-magnus-strong.md"], evidence: ["experiments/e8.md"], tags: ["integrators"] });
V("tension-index-size.json", { type: "tension", date: "2026-08-22", subject: "index-size", a_cards: ["knowledge/insight-index-budget.md"], b_cards: ["knowledge/insight-index-freshness.md"], tags: ["indexes"] });

// tombstone x6 (one per justification, with conditionals satisfied)
V("tombstone-superseded.json", { type: "tombstone", date: "2026-08-22", justification: "superseded_by", tombstone_of: "knowledge/insight-old.md", pointer: "knowledge/insight-new.md", tags: [] });
V("tombstone-expired.json", { type: "tombstone", date: "2026-08-22", justification: "expired_ttl", tombstone_of: "knowledge/reference-stale.md", original_review_by: "2026-01-01", tags: [] });
V("tombstone-unrecoverable.json", { type: "tombstone", date: "2026-08-22", justification: "provenance_unrecoverable", tombstone_of: "knowledge/insight-orphan.md", review_pointer: "journal/review-1.md", tags: [] });
V("tombstone-redundant.json", { type: "tombstone", date: "2026-08-22", justification: "redundant_with", tombstone_of: "knowledge/feedback-dup.md", pointer: "knowledge/feedback-live.md", tags: [] });
V("tombstone-filed.json", { type: "tombstone", date: "2026-08-22", justification: "filed_to", tombstone_of: "knowledge/insight-piccolo.md", pointer: "repo:harmoniqs/Piccolo.jl#AGENTS.md", tags: [] });
V("tombstone-lifecycle.json", { type: "tombstone", date: "2026-08-22", justification: "lifecycle_complete", tombstone_of: "work/session-2026-08-20.md", tags: [] });

// -------------------------------------------------------------- invalid ----
const invalid = [];
const I = (name, obj) => invalid.push([name, obj]);

I("sentinel-conflict.json", { type: "insight", date: "2026-08-22", source: "s", evidence: [], confidence: "medium", tags: [], provenance_unrecoverable: true, reviewed_after: "journal/pass-1.md", provenance: ["experiments/x.md"] });
I("sentinel-no-review-pointer.json", { type: "insight", date: "2026-08-22", source: "s", evidence: [], confidence: "medium", tags: [], provenance_unrecoverable: true });
I("unknown-confidence.json", { type: "insight", date: "2026-08-22", source: "s", evidence: [], confidence: "certain", tags: [] });
I("malformed-review-by.json", { type: "insight", date: "2026-08-22", source: "s", evidence: [], confidence: "medium", tags: [], review_by: "last tuesday" });
I("tombstone-open-vocabulary.json", { type: "tombstone", date: "2026-08-22", justification: "because", tombstone_of: "knowledge/x.md", tags: [] });
I("tombstone-dangling-pointer.json", { type: "tombstone", date: "2026-08-22", justification: "superseded_by", tombstone_of: "knowledge/insight-old.md", pointer: "knowledge/never-existed.md", tags: [] });
I("tombstone-superseded-no-pointer.json", { type: "tombstone", date: "2026-08-22", justification: "superseded_by", tombstone_of: "knowledge/insight-old.md", tags: [] });
I("tombstone-expired-ttl-no-date.json", { type: "tombstone", date: "2026-08-22", justification: "expired_ttl", tombstone_of: "knowledge/reference-stale.md", tags: [] });
I("missing-required.json", { type: "insight", date: "2026-08-22", evidence: [], confidence: "medium", tags: [] });
I("untyped.json", { date: "2026-08-22", source: "s", evidence: [], tags: [] });
I("unknown-type.json", { type: "flarble", date: "2026-08-22", tags: [] });
I("record-missing-origin.json", { type: "experiment", date: "2026-08-22" });
I("tension-empty-a-cards.json", { type: "tension", date: "2026-08-22", subject: "s", a_cards: [], b_cards: ["knowledge/b.md"], tags: [] });
I("confidence-wrong-type.json", { type: "insight", date: "2026-08-22", source: "s", evidence: [], confidence: 5, tags: [] });
I("review-by-wrong-type.json", { type: "insight", date: "2026-08-22", source: "s", evidence: [], confidence: "medium", tags: [], review_by: 2026 });
I("experiment-missing-fidelity.json", { type: "experiment", task_type: "experiment-sim", date: "2026-08-22", session_id: "s", platform: "transmon", gate: "X", duration_us: 10, status: "solved", tags: [] });
I("tension-missing-subject.json", { type: "tension", date: "2026-08-22", a_cards: ["knowledge/a.md"], b_cards: ["knowledge/b.md"], tags: [] });
I("memory-card-missing-description.json", { type: "feedback", name: "no-desc" });

// ----------------------------------------------------------------- write ----
for (const [sub, corpus] of [
  ["valid", valid],
  ["invalid", invalid],
]) {
  const dir = path.join(HERE, sub);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, obj] of corpus) fs.writeFileSync(path.join(dir, name), canonical(obj));
}

const mdDir = path.join(HERE, "valid-md");
fs.mkdirSync(mdDir, { recursive: true });
fs.writeFileSync(
  path.join(mdDir, "insight-cat-state.md"),
  `---\ntype: insight\ndate: 2026-08-22\nsource: session-2026-08-21\nevidence:\n  - experiments/e-cat.md\nconfidence: high\ntags:\n  - bosonic\n  - cat-state\nsubject: cat-state-prep\n---\n\n# Cat-state prep converges with Fock cutoff >= 20\n\nBody prose is ignored by the validator; only frontmatter is the card.\n`,
);

console.log(`wrote ${valid.length} valid, ${invalid.length} invalid, 1 md fixture`);

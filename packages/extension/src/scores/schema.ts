// Score manifest schema — spec §3 (spec-20260703-025314-amicode-scores-front-of-chain).
// Additive policy (spec §8): unknown fields are ignored; validation only rejects what is
// present-and-wrong or required-and-missing, so older runtimes tolerate newer scores.
export const KNOWN_ENTITIES = [
  "circuit",
  "system",
  "formulation",
  "pulse",
  "run",
  "device_session",
  "knowledge",
] as const;
export const GATE_CLASSES = ["light", "heavy"] as const;
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

export interface Question {
  id: string;
  prompt: string;
  choices?: string[];
  choice_descriptions?: string[];
  default?: string;
  skip_if?: string;
  memory_hooks?: string[];
  rationale_ref?: string;
  autonomy?: string;
}

export interface Stage {
  id: string;
  emits?: string[];
  questions?: Question[];
  executor?: string;
  template?: string;
  backend?: string;
  gate?: (typeof GATE_CLASSES)[number];
  optional?: boolean;
}

export interface ScoreManifest {
  type: "score";
  schema_version: number;
  id: string;
  version: number;
  derived_from: string | null;
  name: string;
  outcome: string;
  audience: string[];
  duration_estimate?: string;
  device?: { backend: string; qpu_runnable: boolean; emulators?: string[] };
  entitlements?: string[];
  stages: Stage[];
}

export function validateScoreManifest(raw: unknown): string[] {
  const errs: string[] = [];
  const m = raw as Partial<ScoreManifest>;
  if (m?.type !== "score") errs.push(`type must be "score"`);
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(m?.schema_version as 1))
    errs.push(`unsupported schema_version: ${m?.schema_version}`);
  if (typeof m?.id !== "string" || !m.id) errs.push("id is required");
  if (!Number.isInteger(m?.version) || (m!.version as number) < 1)
    errs.push(`version must be a positive integer, got ${m?.version}`);
  if (typeof m?.name !== "string" || !m.name) errs.push("name is required");
  if (typeof m?.outcome !== "string" || !m.outcome) errs.push("outcome is required");
  if (!Array.isArray(m?.stages) || m!.stages!.length === 0) {
    errs.push("stages must be a non-empty list");
    return errs;
  }
  const seen = new Set<string>();
  for (const s of m.stages!) {
    if (!s.id) {
      errs.push("every stage needs an id");
      continue;
    }
    if (seen.has(s.id)) errs.push(`duplicate stage id: ${s.id}`);
    seen.add(s.id);
    for (const e of s.emits ?? [])
      if (!(KNOWN_ENTITIES as readonly string[]).includes(e)) errs.push(`stage ${s.id}: unknown entity in emits: ${e}`);
    if (s.gate && !(GATE_CLASSES as readonly string[]).includes(s.gate))
      errs.push(`stage ${s.id}: unknown gate class: ${s.gate}`);
    for (const q of s.questions ?? []) {
      if (!q.id) errs.push(`stage ${s.id}: question missing id`);
      if (!q.prompt) errs.push(`stage ${s.id}: question ${q.id ?? "?"} missing prompt`);
      if (q.default && q.choices && !q.choices.includes(q.default))
        errs.push(`stage ${s.id}: question ${q.id}: default not among choices`);
    }
  }
  return errs;
}

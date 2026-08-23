/** Onboarding entity stream (spec-20260705-002847 §3.1–3.2).
 *
 *  The overture interview NEVER writes the vault: it records profile /
 *  environment / device entities here (ops-side, append-only), and the
 *  DISTILLER materializes the cards — only when the `onboarding_completed`
 *  marker is present. Same JSON envelope as the problem-workspace events. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { entityHash } from "./hashes";
import { enqueueAndDrain, defaultClock, readDistillerConfig } from "./distill_queue";

export function opsDir(): string {
  return process.env.AMICODE_OPS_DIR ?? path.join(os.homedir(), ".amico", "amicode");
}
export function onboardingStreamDir(ops: string = opsDir()): string {
  return path.join(ops, "onboarding");
}

/** Spec §7.8 / §2.5: pointers only, enforced AT RECORD TIME (extend, never shrink). */
export const SECRET_RE = /api[_-]?key|token|secret|password|Bearer |AKIA[0-9A-Z]{16}|-----BEGIN/;

export type OnboardingEntity = "profile" | "environment" | "device" | "onboarding_completed";

const ENTITY_FIELDS: Record<OnboardingEntity, string[]> = {
  profile: ["name", "role", "org", "platforms", "goals", "intent", "description", "research_area", "experiment_kind", "scholar", "github", "custom_link_url", "custom_link_label"],
  environment: ["slug", "archetype", "control_stack", "integration", "emulator", "endpoints"],
  device: ["name", "platform", "environment", "qubits", "params", "status"],
  onboarding_completed: [],
};

export function isOnboardingEntity(e: string): e is OnboardingEntity {
  return e in ENTITY_FIELDS;
}

/** Keep only the §3.2 fields; scrub credential-looking values (never store,
 *  never echo — replace so the card notes the omission). */
export function sanitizePayload(entity: OnboardingEntity, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ENTITY_FIELDS[entity]) {
    if (!(f in payload) || payload[f] === undefined || payload[f] === null) continue;
    let v = payload[f];
    if (typeof v === "string" && SECRET_RE.test(v)) v = "«credential omitted»";
    if (Array.isArray(v)) v = v.map((x) => (typeof x === "string" && SECRET_RE.test(x) ? "«credential omitted»" : x));
    out[f] = v;
  }
  return out;
}

function lastSeq(file: string): number {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** Append one event (spec §3.2 envelope: seq/ts/entity/action/diff/hash/source). */
export function appendOnboardingEvent(
  dir: string,
  entity: OnboardingEntity,
  payload: Record<string, unknown>,
): { seq: number; clean: Record<string, unknown> } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  const clean = sanitizePayload(entity, payload);
  const seq = lastSeq(file) + 1;
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(clean)) diff[k] = { from: null, to: v };
  const event = {
    seq,
    ts: new Date().toISOString(),
    entity,
    action: "created",
    diff,
    hash: entityHash(clean),
    source: { tool: "amicode_profile", stage: "onboarding" },
    provenance: null,
  };
  fs.appendFileSync(file, JSON.stringify(event) + "\n");
  return { seq, clean };
}

/** Replay the stream → latest state per entity instance (later entries win —
 *  environments keyed by slug, devices by name, profile is a singleton).
 *  This is what the overture's RESUME reads (spec §3: ask only what's missing). */
export function readOnboardingState(dir: string): {
  profile?: Record<string, unknown>;
  environments: Record<string, Record<string, unknown>>;
  devices: Record<string, Record<string, unknown>>;
  completed: boolean;
} {
  const state = {
    profile: undefined as Record<string, unknown> | undefined,
    environments: {} as Record<string, Record<string, unknown>>,
    devices: {} as Record<string, Record<string, unknown>>,
    completed: false,
  };
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  } catch {
    return state;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: { entity?: string; diff?: Record<string, { to: unknown }> };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const vals: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(ev.diff ?? {})) vals[k] = d.to;
    if (ev.entity === "profile") state.profile = { ...(state.profile ?? {}), ...vals };
    else if (ev.entity === "environment" && typeof vals.slug === "string")
      state.environments[vals.slug] = { ...(state.environments[vals.slug] ?? {}), ...vals };
    else if (ev.entity === "device" && typeof vals.name === "string")
      state.devices[vals.name] = { ...(state.devices[vals.name] ?? {}), ...vals };
    else if (ev.entity === "onboarding_completed") state.completed = true;
  }
  return state;
}

/** One line per recorded thing — the tool's `status` answer (resume anchor). */
export function statusSummary(dir: string): string {
  const s = readOnboardingState(dir);
  const lines: string[] = [];
  if (s.profile) lines.push(`profile: ${JSON.stringify(s.profile)}`);
  for (const [slug, e] of Object.entries(s.environments)) lines.push(`environment ${slug}: ${JSON.stringify(e)}`);
  for (const [name, d] of Object.entries(s.devices)) lines.push(`device ${name}: ${JSON.stringify(d)}`);
  lines.push(s.completed ? "onboarding: COMPLETED (re-run updates in place)" : "onboarding: in progress");
  return lines.length === 1 ? `nothing recorded yet\n${lines[0]}` : lines.join("\n");
}

/** Trigger 4 (spec §4.1): on the completion marker, the PLUGIN both enqueues
 *  AND spawns a drain via the distiller.config.json transport — fire-and-forget
 *  so the tool return never waits on an LLM child. Without the transport file
 *  the job simply stays queued for the next drain. */
export function triggerOnboardingDistill(ops: string = opsDir()): boolean {
  const cfg = readDistillerConfig(ops);
  const defaults = (cfg && (cfg as { job_defaults?: Record<string, unknown> }).job_defaults) ?? {};
  void enqueueAndDrain(ops, { kind: "onboarding", ops, ...defaults }, defaultClock()).catch(() => {});
  // Eagerly bridge onboarding state → profile.json so the profile dropdown
  // is populated immediately (the distiller still materializes the richer
  // vault PROFILE.md in the background).
  materializeProfileJson(ops);
  return cfg !== null;
}

/** Write the collected identity fields to ~/.amico/profile.json (the serving
 *  layer the profile dropdown reads from). Reads from the onboarding events
 *  stream first; if that's empty/missing, uses the inline profile payload
 *  (passed when the caller already has the data). Additive merge: never
 *  clobbers fields already set by the inline editor. */
export function materializeProfileJson(ops: string = opsDir(), inlineProfile?: Record<string, unknown>): void {
  const dir = onboardingStreamDir(ops);
  const state = readOnboardingState(dir);
  const profile = state.profile ?? inlineProfile;
  if (!profile) return;

  const profilePath = path.join(os.homedir(), ".amico", "profile.json");
  let current: Record<string, unknown> = {};
  try {
    if (fs.existsSync(profilePath)) {
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) current = raw;
    }
  } catch { /* start fresh */ }

  // Field mapping: onboarding field → profile.json field
  const mapping: Record<string, string> = {
    name: "name",
    role: "role",
    org: "affiliation",
    research_area: "focus",
    description: "description",
    scholar: "scholar",
    github: "github",
  };

  for (const [srcKey, dstKey] of Object.entries(mapping)) {
    const value = profile[srcKey];
    // Additive: only write if the target field is empty/unset
    if (typeof value === "string" && value.trim() && !current[dstKey]) {
      current[dstKey] = value.trim();
    }
  }

  // custom_link is compound: url + label
  const linkUrl = profile.custom_link_url;
  const linkLabel = profile.custom_link_label;
  if (typeof linkUrl === "string" && linkUrl.trim() && !current.custom_link) {
    current.custom_link = {
      url: linkUrl.trim(),
      label: typeof linkLabel === "string" ? linkLabel.trim() : "",
    };
  }

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(current, null, 2) + "\n");
}

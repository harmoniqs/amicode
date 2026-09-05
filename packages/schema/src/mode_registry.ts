// mode_registry.ts — the director-mode registry's ONE shared validator
// (spec-20260905-063000 D1, issue #804): the mode bundles under
// packages/extension/modes/<mode>/ are TYPED DATA, and this module is the
// single code path that judges them — imported by BOTH the extension's vitest
// suite and the amico-run doctor probe, so a bundle that passes tests passes
// the probe. It also owns:
//
//   - the LEDGER DISCOVERY RULE generated region (AC8): delimited,
//     generator-stamped, emitted from the registry into the cards; the stamp
//     CLASSIFIES mismatches (regenerate-and-compare detects) and never
//     authorizes a pass — a forged current-version stamp still fails.
//   - the per-consumer minimum-version map check (AC5): a consumer below its
//     floor fails LOUDLY; a plugin-side gap renders the explicit unresolvable
//     block, never silence.
//   - the release index (AC6): the vsix-tag → registry-revision mapping — the
//     doctor's remote-compare authority, never origin HEAD.
//
// No mode name appears as a hardcoded branch here: the validator is
// structural over the declared sets; cross-bundle handoff consistency is
// checked registry-level (a pack handoff's target must be a registry mode
// that declares the emitted seed kind) — data-driven, not name-driven.
//
// PLATFORM ASSUMPTION, STATED (AC10): the atomic stager (mode_staging.ts)
// relies on POSIX rename(2) atomicity. The fleet is POSIX today; Windows is
// served via the WSL/linux-x64 binary. A Windows-native target needs a
// different primitive before this pattern is copied there.
import { readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsDefault from "ajv-formats";
import type { Validation } from "./index.js";
import modeBundleSchema from "../schemas/mode-bundle.schema.json" with { type: "json" };
import gatePackSchema from "../schemas/gate-pack.schema.json" with { type: "json" };
import releaseIndexSchema from "../schemas/release-index.schema.json" with { type: "json" };

// ajv-formats ships a CJS default export; under NodeNext the default import
// can bind the module namespace rather than the callable — normalize
// defensively (same idiom as src/index.ts and src/vault-card.ts).
const addFormats = (typeof addFormatsDefault === "function"
  ? addFormatsDefault
  : (addFormatsDefault as unknown as { default: unknown }).default) as unknown as (ajv: Ajv) => void;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const manifestValidator = ajv.compile(modeBundleSchema as object) as ValidateFunction;
const packValidator = ajv.compile(gatePackSchema as object) as ValidateFunction;
const releaseIndexValidator = ajv.compile(releaseIndexSchema as object) as ValidateFunction;

// ── the ledger-discovery-rule generated region (AC8) ─────────────────────────
//
// The canonical rule text lives HERE (in the registry's code), is emitted
// byte-exact into the cards inside a delimited, generator-stamped region, and
// is the SAME block the director-core skill carries (correctness by
// containment, H1: byte-identical across card, skill, and registry). Hand
// edits to the region are forbidden — a vault hotfix that would touch it goes
// through the registry instead. Idempotence everywhere is computed over
// source-minus-generated sections; the stamp classifies mismatches, it never
// authorizes a pass.

/** The generator's version stamp, carried INSIDE the emitted region. */
export const MODE_GENERATOR_VERSION = "v1";

/** The rule body — byte-identical to the director-core skill's fenced block. */
export const LEDGER_DISCOVERY_RULE_TEXT = [
  "LEDGER DISCOVERY RULE v1",
  "",
  "Path convention — the session ledger lives in the personal vault at",
  "sessions/session-<YYYYMMDD>-<slug>.md: one ledger per campaign, created at",
  "kickoff before any work.",
  "",
  "Re-read-first discipline — the first action after any mode switch or any",
  "compaction is to re-read the ledger from disk, never from memory, and to",
  "audit any context summary against it. A mode switch re-binds the director's",
  "posture only: the ledger itself is never rewritten by a switch, and the same",
  "ledger serves every posture the campaign runs.",
].join("\n");

export const LEDGER_DISCOVERY_RULE_BEGIN =
  `<!-- AMICO-GENERATED: region=ledger-discovery-rule generator=${MODE_GENERATOR_VERSION} begin -->`;
export const LEDGER_DISCOVERY_RULE_END = "<!-- AMICO-GENERATED: region=ledger-discovery-rule end -->";

/** The canonical generated region, byte-exact — what a card must carry. */
export function generateLedgerDiscoveryRegion(): string {
  return `${LEDGER_DISCOVERY_RULE_BEGIN}\n\`\`\`text\n${LEDGER_DISCOVERY_RULE_TEXT}\n\`\`\`\n${LEDGER_DISCOVERY_RULE_END}\n`;
}

export type GeneratedRegionStatus = "ok" | "missing" | "outdated-stamp" | "divergent";

export interface GeneratedRegionClassification {
  status: GeneratedRegionStatus;
  /** For outdated-stamp: the stamp the artifact carried. */
  stamp?: string;
  /** One-line human reason — the classification, never a pass authorization. */
  detail: string;
}

/** Classify the generated region inside a card (or any artifact text). The
 *  stamp only CLASSIFIES the mismatch kind — regenerate-and-compare is the
 *  detection, and every non-ok status is a failure. */
export function classifyLedgerDiscoveryRegion(text: string): GeneratedRegionClassification {
  const beginRe = /^<!-- AMICO-GENERATED: region=ledger-discovery-rule generator=(\S+) begin -->$/m;
  const begin = beginRe.exec(text);
  if (begin === null) {
    return { status: "missing", detail: "the ledger-discovery-rule generated region is absent (hand-removed or never emitted)" };
  }
  const endIdx = text.indexOf(LEDGER_DISCOVERY_RULE_END);
  if (endIdx === -1) {
    return { status: "missing", detail: "the generated region's end delimiter is absent (unterminated region)" };
  }
  const stamp = begin[1] ?? "";
  if (stamp !== MODE_GENERATOR_VERSION) {
    return {
      status: "outdated-stamp",
      stamp,
      detail: `generated region carries generator stamp ${stamp}, current is ${MODE_GENERATOR_VERSION} — regenerate; the stamp never authorizes a pass`,
    };
  }
  const regionEnd = endIdx + LEDGER_DISCOVERY_RULE_END.length;
  const carried = text.slice(begin.index, regionEnd) + "\n";
  if (carried !== generateLedgerDiscoveryRegion()) {
    return {
      status: "divergent",
      stamp,
      detail: `generated region body diverges from the ${MODE_GENERATOR_VERSION} generator output despite its stamp — hand-edited or forged; regenerate-and-compare fails`,
    };
  }
  return { status: "ok", detail: "the ledger-discovery-rule region byte-matches the generator output" };
}

// ── version compare (natural: digits numeric, runs lexicographic) ───────────
//
// The same algorithm as amico-run's surfaces.compareVersions — schema cannot
// import amico-run (package graph is amico-run → schema); keep the two in
// step by construction (this one is exercised by the floor tests).

export function compareModeVersions(a: string, b: string): number {
  const tok = (s: string) => s.match(/\d+|[^\d]+/g) ?? [];
  const ta = tok(a);
  const tb = tok(b);
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const xa = ta[i];
    const xb = tb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const da = /^\d+$/.test(xa);
    const db = /^\d+$/.test(xb);
    if (da && db) {
      const va = Number(xa);
      const vb = Number(xb);
      if (va !== vb) return va < vb ? -1 : 1;
    } else if (da !== db) {
      return da ? -1 : 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

// ── the manifest (mode.toml) ─────────────────────────────────────────────────

export type ModeConsumer = "doctor" | "plugin" | "stager" | "tests";
export const MODE_CONSUMERS = ["doctor", "plugin", "stager", "tests"] as const;

export interface ModeRole {
  name: string;
  path: string;
}

export interface ModeHandoffSeed {
  kind: "issue_seed" | "hypothesis_seed";
  schema: string;
}

export interface ModeManifest {
  schema_version: string;
  mode: string;
  card: string;
  pack: string;
  roles: ModeRole[];
  protocol_skills: string[];
  handoff_seeds: ModeHandoffSeed[];
  consumer_floors: Record<ModeConsumer, string>;
}

function formatAjvError(e: ErrorObject): string {
  const where = e.instancePath === "" ? "(root)" : e.instancePath;
  switch (e.keyword) {
    case "required":
      return `${where}: missing required key "${(e.params as { missingProperty: string }).missingProperty}"`;
    case "additionalProperties":
      return `${where}: unknown key "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    case "enum": {
      const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      return `${where}: must be one of (${allowed.join(", ")})`;
    }
    default:
      return `${where}: ${e.message ?? "invalid"}`;
  }
}

function ajvErrors(v: ValidateFunction, label: string): string[] {
  return (v.errors ?? []).map((e) => `${label}${formatAjvError(e)}`);
}

/** Parse + schema-validate a mode.toml. Throws with field-precise errors on
 *  violation (the manifest is authored data — a bad manifest is a loud
 *  authoring failure, never a silent skip). */
export function parseModeManifest(text: string): ModeManifest {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (e) {
    throw new Error(`mode.toml: parse error — ${(e as Error).message}`);
  }
  if (!manifestValidator(parsed)) {
    throw new Error(`mode.toml: schema violation — ${ajvErrors(manifestValidator, "mode.toml").join("; ")}`);
  }
  return parsed as unknown as ModeManifest;
}

/** The gate pack: parse (if a string) + schema-validate. Descriptive,
 *  schema'd data — the declared phases carry their gates; handoff targets are
 *  slugs resolved at registry level. */
export function validateGatePack(packOrText: unknown): Validation {
  let parsed = packOrText;
  if (typeof packOrText === "string") {
    try {
      parsed = parseToml(packOrText);
    } catch (e) {
      return { ok: false, errors: [`pack.toml: parse error — ${(e as Error).message}`] };
    }
  }
  if (!packValidator(parsed)) {
    return { ok: false, errors: ajvErrors(packValidator, "pack.toml") };
  }
  return { ok: true, errors: [] };
}

// ── the bundle + registry validators (H1, AC1) ───────────────────────────────

export interface ModeBundleOpts {
  /** The extension root the declared paths resolve under (packages/extension,
   *  or the deployed staging root). Required for the containment check. */
  extensionRoot?: string;
}

/** The declared component files of a bundle, resolved against the extension
 *  root — the stager and the doctor both walk this set, so a component that
 *  stages is exactly a component that verifies. */
export interface DeclaredComponent {
  /** Path INSIDE the bundle (deployed layout): card.md, pack.toml, mode.toml,
   *  roles/<name>.md, handoff-seeds/<basename>. */
  inBundle: string;
  /** The SOURCE path relative to the extension root (for the doctor's
   *  release-tag compare). */
  sourceRel: string;
}

/** Resolve a declared role/handoff path (relative to the bundle dir) under
 *  the extension root; reject traversal outside it. */
function resolveDeclared(bundleDir: string, extensionRoot: string | undefined, rel: string, what: string): { ok: true; abs: string } | { ok: false; error: string } {
  const abs = resolve(bundleDir, rel);
  if (extensionRoot !== undefined) {
    const root = resolve(extensionRoot);
    if (abs !== root && !abs.startsWith(root + sep)) {
      return { ok: false, error: `${what} resolves outside the extension root: ${rel}` };
    }
  }
  return { ok: true, abs };
}

function isReadableFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Validate ONE mode bundle at bundleDir (…/modes/<mode>/): manifest schema,
 *  every DECLARED component file (card, pack, roles, handoff-seed schema),
 *  the gate-pack schema, the declared-set cross-checks (manifest roles ≡ pack
 *  roles), and the card's generated region. Field-precise errors; a bundle
 *  may ship fewer roles/skills only by explicit manifest declaration. */
export function validateModeBundle(bundleDir: string, opts: ModeBundleOpts = {}): Validation {
  const errors: string[] = [];
  const manifestPath = join(bundleDir, "mode.toml");
  let manifest: ModeManifest | null = null;
  try {
    manifest = parseModeManifest(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const m = manifest!;
  const modeName = bundleDir.replace(/^.*[\\/]/, "");
  if (m.mode !== modeName) {
    errors.push(`mode.toml: manifest mode "${m.mode}" does not match the bundle directory "${modeName}"`);
  }

  // the card + the pack: DECLARED bundle files, present + readable
  const cardPath = join(bundleDir, m.card);
  if (!isReadableFile(cardPath)) errors.push(`mode.toml: declared card "${m.card}" is missing or unreadable at ${cardPath}`);
  const packPath = join(bundleDir, m.pack);
  if (!isReadableFile(packPath)) {
    errors.push(`mode.toml: declared pack "${m.pack}" is missing or unreadable at ${packPath}`);
  } else {
    const pack = validateGatePack(readFileSync(packPath, "utf8"));
    errors.push(...pack.errors);
    if (pack.ok) {
      // declared-set cross-checks: manifest roles ≡ pack roles
      const parsedPack = parseToml(readFileSync(packPath, "utf8")) as {
        phases?: { name?: string; roles?: string[] }[];
        handoffs?: { kind?: string; target?: string }[];
      };
      const packRoles = [...new Set((parsedPack.phases ?? []).flatMap((p) => p.roles ?? []))];
      const declaredNames = m.roles.map((r) => r.name);
      for (const r of packRoles) {
        if (!declaredNames.includes(r)) errors.push(`mode.toml: the pack casts role "${r}" but the manifest does not declare it (declared-set violation)`);
      }
      for (const r of m.roles) {
        if (!packRoles.includes(r.name)) errors.push(`mode.toml: declared role "${r.name}" is cast by no phase in the pack (declared-set violation)`);
      }
      if ((parsedPack.handoffs ?? []).length === 0) {
        errors.push("pack.toml: no handoffs — a director mode hands its closing seed to another mode");
      }
    }
  }

  // the declared roles + handoff-seed schemas: paths that must RESOLVE
  for (const role of m.roles) {
    const r = resolveDeclared(bundleDir, opts.extensionRoot, role.path, `role "${role.name}"`);
    if (!r.ok) {
      errors.push(`mode.toml: ${r.error}`);
      continue;
    }
    if (!isReadableFile(r.abs)) errors.push(`mode.toml: declared role "${role.name}" file is missing or unreadable: ${role.path}`);
  }
  for (const seed of m.handoff_seeds) {
    const r = resolveDeclared(bundleDir, opts.extensionRoot, seed.schema, `handoff seed "${seed.kind}"`);
    if (!r.ok) {
      errors.push(`mode.toml: ${r.error}`);
      continue;
    }
    if (!isReadableFile(r.abs)) errors.push(`mode.toml: declared handoff-seed schema is missing or unreadable: ${seed.schema}`);
  }

  // the card's generated region (AC8): classify, never authorize
  if (isReadableFile(cardPath)) {
    const c = classifyLedgerDiscoveryRegion(readFileSync(cardPath, "utf8"));
    if (c.status !== "ok") {
      errors.push(`${m.card}: ledger-discovery-rule generated region is ${c.status === "divergent" ? "DIVERGENT" : c.status} — ${c.detail}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Validate the WHOLE registry at modesDir: every bundle, plus the
 *  registry-level cross-checks (a pack handoff's target must be a registry
 *  mode that declares the emitted seed kind — structural, never a hardcoded
 *  mode name). */
export function validateModeRegistry(modesDir: string, extensionRoot?: string): Validation {
  const errors: string[] = [];
  const modeDirs = readdirSync(modesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (modeDirs.length === 0) {
    return { ok: false, errors: [`no mode bundles under ${modesDir}`] };
  }
  const manifests = new Map<string, ModeManifest>();
  for (const dir of modeDirs) {
    const bundleDir = join(modesDir, dir);
    const v = validateModeBundle(bundleDir, { extensionRoot });
    errors.push(...v.errors.map((e) => `${dir}: ${e}`));
    try {
      manifests.set(dir, parseModeManifest(readFileSync(join(bundleDir, "mode.toml"), "utf8")));
    } catch {
      // already recorded by validateModeBundle
    }
  }
  // cross-bundle handoff consistency: emitted {kind, target} must be declared
  // inbound by the target bundle. The kind→mode vocabulary is DATA (each
  // manifest declares what it receives); no mode name is hardcoded here.
  for (const [dir, manifest] of manifests) {
    let pack: { handoffs?: { kind?: string; target?: string }[] };
    try {
      pack = parseToml(readFileSync(join(modesDir, dir, manifest.pack), "utf8")) as typeof pack;
    } catch {
      continue; // recorded above
    }
    for (const handoff of pack.handoffs ?? []) {
      const target = handoff.target ?? "";
      if (!manifests.has(target)) {
        errors.push(`${dir}/pack.toml: handoff target "${target}" is not a registry mode`);
        continue;
      }
      const targetManifest = manifests.get(target)!;
      const declaredKinds: string[] = targetManifest.handoff_seeds.map((s) => s.kind);
      if (!declaredKinds.includes(handoff.kind ?? "")) {
        errors.push(`${dir}/pack.toml: handoff kind "${handoff.kind}" targets ${target}, but ${target}'s manifest does not declare receiving it (declared: ${declaredKinds.join(", ") || "none"})`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The declared component set of a bundle, in bundle-relative layout — the
 *  stager's file list and the doctor's component walk share this. */
export function declaredComponents(manifest: ModeManifest): DeclaredComponent[] {
  const out: DeclaredComponent[] = [
    { inBundle: manifest.card, sourceRel: `modes/${manifest.mode}/${manifest.card}` },
    { inBundle: manifest.pack, sourceRel: `modes/${manifest.mode}/${manifest.pack}` },
    { inBundle: "mode.toml", sourceRel: `modes/${manifest.mode}/mode.toml` },
  ];
  for (const role of manifest.roles) {
    out.push({ inBundle: `roles/${role.name}.md`, sourceRel: role.path.replace(/^\.\.\//, "").replace(/^\.\.\//, "") });
  }
  for (const seed of manifest.handoff_seeds) {
    const base = seed.schema.replace(/^.*[\\/]/, "");
    out.push({ inBundle: `handoff-seeds/${base}`, sourceRel: seed.schema.replace(/^\.\.\//, "").replace(/^\.\.\//, "") });
  }
  return out;
}

// ── the per-consumer floor check (AC5) ───────────────────────────────────────

export interface ConsumerFloorOk {
  ok: true;
}
export interface ConsumerFloorGap {
  ok: false;
  kind: "version-gap";
  consumer: ModeConsumer;
  floor: string;
  consumer_version: string;
  /** The loud rendering — for the plugin it IS the explicit unresolvable
   *  block, never silence (the two vocabularies name one outcome). */
  render: string;
}

/** A consumer whose supported version is below its floor fails LOUDLY. The
 *  plugin's loud failure is the explicit unresolvable block. */
export function checkConsumerFloor(
  floors: Record<ModeConsumer, string>,
  consumer: ModeConsumer,
  consumerVersion: string,
): ConsumerFloorOk | ConsumerFloorGap {
  const floor = floors[consumer];
  if (compareModeVersions(consumerVersion, floor) < 0) {
    const gap = `mode-registry version gap: ${consumer} at v${consumerVersion} is below the bundle's floor v${floor}`;
    return {
      ok: false,
      kind: "version-gap",
      consumer,
      floor,
      consumer_version: consumerVersion,
      render: consumer === "plugin" ? `posture: unresolvable — ${gap}` : gap,
    };
  }
  return { ok: true };
}

/** The version of the mode-bundle contract THIS build's consumers support
 *  (schema, stager, doctor, tests all ship together — a deployed consumer
 *  below a staged bundle's floor is a real cross-build gap, which is exactly
 *  what the floor map catches). */
export const SUPPORTED_MODE_BUNDLE_VERSION = "1";

// ── the release index (AC6) ──────────────────────────────────────────────────

export interface ReleaseIndexEntry {
  vsix_tag: string;
  registry_revision: number;
}

export interface ReleaseIndex {
  schema_version: string;
  releases: ReleaseIndexEntry[];
}

/** Parse + schema-validate a release-index.toml. Throws named on violation —
 *  an unparseable index is a named invalid, never a silent default. */
export function parseReleaseIndex(text: string): ReleaseIndex {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (e) {
    throw new Error(`release index: parse error — ${(e as Error).message}`);
  }
  if (!releaseIndexValidator(parsed)) {
    throw new Error(`release index: schema violation — ${ajvErrors(releaseIndexValidator, "release index").join("; ")}`);
  }
  return parsed as unknown as ReleaseIndex;
}

export type ReleaseCompareStatus = "current" | "stale-to-release" | "untagged-unknown";

export interface ReleaseCompare {
  status: ReleaseCompareStatus;
  /** The machine's release tag (vsix-tag form, v-prefixed). */
  machine_release: string | null;
  /** The newest release the index knows (null when the machine is untagged). */
  newest_release: string | null;
  /** The rendering — `current to vX` / `current to vX, stale to release vY` /
   *  the named unknown. */
  render: string;
  /** The machine's registry revision per the index (null when untagged). */
  machine_revision: number | null;
}

/** The leading numeric version of an installed-extension version string:
 *  "0.3.2-darwin-arm64" → "0.3.2". */
export function versionBaseOf(installedVersion: string): string {
  return installedVersion.match(/\d+(?:\.\d+)*/)?.[0] ?? "";
}

/** Compare a machine's installed extension version against the release
 *  index: `current to vX` when the machine's registry revision equals the
 *  newest release's; `current to vX, stale to release vY` when a newer
 *  release carries a newer registry (a pre-registry machine — revision 0 —
 *  reads stale-to-release, never current); a NAMED unknown for an
 *  untagged/dev build, never a verdict. */
export function compareReleaseToIndex(installedVersion: string, index: ReleaseIndex): ReleaseCompare {
  const base = versionBaseOf(installedVersion);
  if (base === "") {
    return {
      status: "untagged-unknown",
      machine_release: null,
      newest_release: null,
      render: `untagged/dev build — no release tag for version "${installedVersion}"; registry revision unknown`,
      machine_revision: null,
    };
  }
  const machineTag = `v${base}`;
  const newest = [...index.releases].sort((a, b) => compareModeVersions(a.vsix_tag, b.vsix_tag)).at(-1)!;
  const entry = index.releases.find((r) => r.vsix_tag === machineTag);
  if (entry === undefined) {
    return {
      status: "untagged-unknown",
      machine_release: machineTag,
      newest_release: newest.vsix_tag,
      render: `untagged/dev build — no release-index entry for ${machineTag}; registry revision unknown, never a verdict`,
      machine_revision: null,
    };
  }
  if (entry.registry_revision < newest.registry_revision) {
    return {
      status: "stale-to-release",
      machine_release: machineTag,
      newest_release: newest.vsix_tag,
      render: `current to ${machineTag}, stale to release ${newest.vsix_tag}`,
      machine_revision: entry.registry_revision,
    };
  }
  return {
    status: "current",
    machine_release: machineTag,
    newest_release: newest.vsix_tag,
    render: `current to ${machineTag}`,
    machine_revision: entry.registry_revision,
  };
}

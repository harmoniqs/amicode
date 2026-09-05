/** Mode-card staging (#533, generalized #761).
 *
 *  Opencode discovers agent mode cards by globbing {agent,agents}/ *.md
 *  from each config Directory entry — notably from the global config dir
 *  `~/.config/opencode/`. The extension's per-session `opencode-project/` is
 *  delivered as an `instructions` Document reference, NOT a Directory, so
 *  agent discovery never globs it.
 *
 *  This module stages EVERY card in the package's agents directory (the two
 *  directors + the five workers) into the global config agents directory on
 *  every activation — the same always-copy semantics as `pasqal_assets.ts`.
 *  When the premium entitlement is present and an overlay source resolves,
 *  method-class overlay fields are merged into the base cards before staging
 *  (precedence: public base < entitled overlay); provenance lands in a
 *  staging receipt, never in the staged card. Failures throw; the activation
 *  caller catches and logs (staging must never kill activation). */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { readLocalEntitlements } from "./scores/entitlements";

/** The premium entitlement code that lights the overlay surface (the same
 *  code `amico premium` reports — entitlement, not capability fork). */
export const PREMIUM_ENTITLEMENT = "amicissimo";

/** Staging options (#761). Injectable for hermetic tests; production calls
 *  use the defaults (the machine's real entitlements + overlay ladder). */
export interface StageOptions {
  /** Resolved entitlement codes; null resolves the machine's real set. */
  entitlements?: string[] | null;
  /** Directory holding entitlements.toml (default ~/.amico/amicode). */
  entitlementConfigDir?: string;
  /** Explicit overlay source root (config); null/undefined walks the
   *  resolution ladder (env overrides → known checkout location). */
  overlaySource?: string | null;
  /** Clock injection (receipt timestamps); default real time. */
  now?: () => string;
}

// ── Overlay field classification — the contract freeze ─────────────────────
//
// The freeze lists of amicissimo's ADR-0003 (agent cards: public
// architecture, premium overlay), implemented verbatim as field names: an
// overlay may carry METHOD-class fields only; INTERFACE-class fields and any
// unclassified field name are rejected at the merge. The base cards' Method
// sections carry a complete default for every method-class dimension, so an
// overlay is always a delta on a working default.

/** Method-class fields (the ADR's freeze list: prompt-body sections, model
 *  routing, iteration budgets, method-flavored example briefs). */
export const METHOD_CLASS_FIELDS = [
  "prompt_body",
  "model_routing",
  "iteration_budget",
  "example_brief",
] as const;
export type MethodClassField = (typeof METHOD_CLASS_FIELDS)[number];

/** Interface-class fields (the ADR's frozen list — NEVER merged from an
 *  overlay: output schema, tool permissions, brief/cast grammar,
 *  dispatch/cast rules). */
export const INTERFACE_CLASS_FIELDS = [
  "output_schema",
  "tool_permissions",
  "brief_cast_grammar",
  "dispatch_cast_rules",
] as const;
export type InterfaceClassField = (typeof INTERFACE_CLASS_FIELDS)[number];

export type OverlayFieldClass = "method" | "interface" | "unclassified";

/** Table-driven classification: known method names merge; known interface
 *  names and every unclassified name reject. */
export function classifyOverlayField(name: string): OverlayFieldClass {
  if ((METHOD_CLASS_FIELDS as readonly string[]).includes(name)) return "method";
  if ((INTERFACE_CLASS_FIELDS as readonly string[]).includes(name)) return "interface";
  return "unclassified";
}

// ── Overlay source resolution (explicit config → known checkout → absent) ──

/** The premium checkout's overlay directory (the S5 overlay contract). */
export function overlayDirOf(root: string): string {
  return path.join(root, "vault", "agents", "overlays");
}

/** Resolve the overlay source root: explicit config wins; then the
 *  AMICO_OVERLAY_SOURCE env override; then AMICISSIMO_ROOT; then the known
 *  checkout location (the canonical workspace repo root,
 *  ~/armonia/repos/amicissimo). Absent dir ⇒ the caller treats the source as
 *  absent — never an error (the funnel invariant: a missing overlay never
 *  dead-ends staging).
 *
 *  DIVERGENCE, named (review F4): amico-run's `amico premium` verb
 *  (packages/amico-run/src/premium.ts) resolves its checkout as
 *  AMICISSIMO_ROOT → the default path under the org home dir. This module
 *  follows the same LADDER but a DIFFERENT final default: the org-home path
 *  spells a proprietary string the protocol blocklist forbids in new code,
 *  so this public module cannot name it. Both surfaces agree whenever
 *  AMICISSIMO_ROOT is set (the fleet convention); unset, `amico premium`
 *  probes the org-home path and staging probes the workspace path. Machines
 *  whose checkout lives elsewhere set AMICISSIMO_ROOT or
 *  AMICO_OVERLAY_SOURCE — the escape both surfaces share. If the default
 *  ever changes, change BOTH comments so the surfaces can't silently
 *  disagree for a reader. */
export function resolveOverlaySource(explicit?: string | null): string | null {
  if (explicit) return explicit;
  return (
    process.env.AMICO_OVERLAY_SOURCE ??
    process.env.AMICISSIMO_ROOT ??
    path.join(os.homedir(), "armonia", "repos", "amicissimo")
  );
}

export interface Overlay {
  id: string;
  fields: Record<string, string>;
}

/** Why an overlay did not reach a card (registry-level defect or a
 *  merge-time rejection) — recorded in the staging receipt, never silent. */
export interface OverlayRejection {
  card?: string;
  overlay_id: string;
  field?: string;
  class?: OverlayFieldClass;
  reason: string;
}

export interface OverlayRegistry {
  overlays: Map<string, Overlay>;
  rejections: OverlayRejection[];
}

/** Load every <id>.json in the overlays dir into the registry. An
 *  UNREADABLE dir (e.g. mode-000: existsSync passes, readdirSync throws)
 *  degrades to absence — an honest registry-level rejection record, never
 *  a staging failure (the funnel invariant, review F3). Malformed files,
 *  version/id mismatches, and non-string field values are rejection records
 *  too — the rest of the registry still loads. */
export function loadOverlayRegistry(overlaysDir: string): OverlayRegistry {
  const overlays = new Map<string, Overlay>();
  const rejections: OverlayRejection[] = [];
  let entries: string[];
  try {
    if (!fs.existsSync(overlaysDir) || !fs.statSync(overlaysDir).isDirectory()) {
      return { overlays, rejections };
    }
    entries = fs.readdirSync(overlaysDir);
  } catch (e) {
    rejections.push({
      overlay_id: "",
      reason: `overlays dir unreadable (${overlaysDir}): ${(e as Error).message}`,
    });
    return { overlays, rejections };
  }
  for (const f of entries.filter((x) => x.endsWith(".json")).sort()) {
    const id = f.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(overlaysDir, f), "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        rejections.push({ overlay_id: id, reason: "overlay file is not a JSON object" });
        continue;
      }
      const o = parsed as Record<string, unknown>;
      if (o.overlay_version !== 1) {
        rejections.push({ overlay_id: id, reason: `unsupported overlay_version ${JSON.stringify(o.overlay_version)}` });
        continue;
      }
      if (o.id !== id) {
        rejections.push({ overlay_id: id, reason: `overlay id ${JSON.stringify(o.id)} does not match file name` });
        continue;
      }
      const fields: Record<string, string> = {};
      let fieldsOk = true;
      if (typeof o.fields === "object" && o.fields !== null) {
        for (const [k, v] of Object.entries(o.fields as Record<string, unknown>)) {
          if (typeof v !== "string") {
            rejections.push({ overlay_id: id, field: k, reason: "field value is not a string" });
            fieldsOk = false;
            continue;
          }
          fields[k] = v;
        }
      }
      if (!fieldsOk) continue;
      overlays.set(id, { id, fields });
    } catch (e) {
      rejections.push({ overlay_id: id, reason: `malformed overlay JSON: ${(e as Error).message}` });
    }
  }
  return { overlays, rejections };
}

// ── The overlay merge (anchored, method-class only) ─────────────────────────

/** A card's `dispatch:` frontmatter scalar — the overlay it names. Undefined
 *  when the card carries no dispatch field (the directors). */
export function cardDispatch(text: string): string | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return undefined;
  const m = /^dispatch:[ \t]*(.+)$/m.exec(text.slice(4, end));
  return m ? m[1].trim() : undefined;
}

/** Dispatch-target well-formedness (a base-card defect is loud): a target is
 *  a lowercase slug. Resolution against the registry is the validator's
 *  other half — an unresolvable target stages the card alone, no error. */
export function validateDispatchTarget(card: string, target: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(target)) {
    throw new Error(`card ${card}: malformed dispatch target ${JSON.stringify(target)}`);
  }
}

/** The Method section's slice: from the `## Method` heading to the next
 *  `## ` heading (end of card when none follows). Every merge anchor and
 *  every overlay value lives INSIDE this slice — the frozen Output contract
 *  and the frontmatter are structurally out of reach (review F1). */
function methodSlice(text: string): { start: number; end: number } | null {
  const heading = /^## Method[^\n]*$/m.exec(text);
  if (!heading || heading.index === undefined) return null;
  const start = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(start));
  return { start, end: next && next.index !== undefined ? start + next.index : text.length };
}

/** Merge one method-class field into the card body at its pinned anchor —
 *  scoped to the Method slice. A missing or out-of-order anchor throws: the
 *  base card's Method section must cover every dimension its overlay tunes
 *  (ADR decision 6 — overlays are deltas on a working default). */
function mergeMethodField(
  text: string,
  field: MethodClassField,
  value: string,
  cardName: string,
): string {
  const anchorMissing = (what: string): Error =>
    new Error(
      `overlay merge (${cardName}): base card lacks the "${what}" anchor for method field "${field}"`,
    );
  const slice = methodSlice(text);
  if (slice === null) throw anchorMissing("## Method");
  const method = text.slice(slice.start, slice.end);
  const mergedMethod = (() => {
    switch (field) {
      case "prompt_body": {
        // the default-procedure block, up to the routing paragraph
        const start = method.search(/^Default procedure/m);
        const routingStart = method.search(/^Model routing, /m);
        if (start === -1 || routingStart === -1) throw anchorMissing("Default procedure");
        if (start >= routingStart) throw anchorMissing("Default procedure");
        return method.slice(0, start) + value + "\n\n" + method.slice(routingStart);
      }
      case "model_routing": {
        const s = method.search(/^Model routing, /m);
        if (s === -1) throw anchorMissing("Model routing, ");
        const blank = method.indexOf("\n\n", s);
        const end = blank === -1 ? method.length : blank;
        return method.slice(0, s) + `Model routing, tuned: ${value}` + method.slice(end);
      }
      case "iteration_budget": {
        const s = method.search(/^Iteration budget, /m);
        if (s === -1) throw anchorMissing("Iteration budget, ");
        const blank = method.indexOf("\n\n", s);
        const end = blank === -1 ? method.length : blank;
        return method.slice(0, s) + `Iteration budget, tuned: ${value}` + method.slice(end);
      }
      case "example_brief": {
        const caption = /^Example brief[^\n]*$/m.exec(method);
        if (!caption || caption.index === undefined) throw anchorMissing("Example brief");
        const after = method.slice(caption.index + caption[0].length);
        const open = after.indexOf("```text");
        if (open === -1) throw anchorMissing("Example brief fence");
        const close = after.indexOf("```", open + "```text".length);
        if (close === -1) throw anchorMissing("Example brief fence close");
        return (
          method.slice(0, caption.index + caption[0].length) +
          after.slice(0, open) +
          "```text\n" +
          value +
          "\n" +
          after.slice(close)
        );
      }
    }
  })();
  return text.slice(0, slice.start) + mergedMethod + text.slice(slice.end);
}

export interface OverlayMergeResult {
  text: string;
  mergedFields: string[];
}

/** Merge an overlay into a base card. Interface-class and unclassified field
 *  names throw (the freeze is loud for the premium slice's CI); the staging
 *  loop catches, records the rejection, and stages the base card alone. */
export function mergeOverlayIntoCard(
  baseText: string,
  overlay: Overlay,
  cardName: string,
): OverlayMergeResult {
  const offenders = Object.keys(overlay.fields)
    .map((name) => ({ name, class: classifyOverlayField(name) }))
    .filter((x) => x.class !== "method");
  if (offenders.length > 0) {
    const first = offenders[0]!;
    throw new Error(
      `overlay ${overlay.id} (${cardName}): field "${first.name}" is ${first.class}-class — ` +
        `interface fields and unclassified names are never merged`,
    );
  }
  let text = baseText;
  const mergedFields: string[] = [];
  for (const field of METHOD_CLASS_FIELDS) {
    if (!(field in overlay.fields)) continue;
    text = mergeMethodField(text, field, overlay.fields[field] as string, cardName);
    mergedFields.push(field);
  }
  return { text, mergedFields };
}

/** The global opencode agents directory where mode cards land. */
export function globalAgentsDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "agents");
}

/** The global opencode CONFIG root — the parent of `agents/` and the staging
 *  root of the #804 mode bundles (`<root>/modes/<mode>/…`): the deployed
 *  layout mirrors the source (modes/ and agents/ siblings), so the bundles'
 *  declared `../../agents/…` paths resolve identically deployed-side. */
export function opencodeGlobalConfigRoot(): string {
  return path.join(os.homedir(), ".config", "opencode");
}

/** Every mode-card markdown file shipped in <extensionPath>/agents/, sorted.
 *  #761: staging covers every card in the package's agents directory — the
 *  fixed two-file list is gone; a new shipped card stages automatically. */
export function listModeCardFiles(extensionPath: string): string[] {
  const srcDir = path.join(extensionPath, "agents");
  let entries: string[];
  try {
    entries = fs.readdirSync(srcDir);
  } catch {
    throw new Error(
      `no mode cards found in ${srcDir} — the extension bundle must ship ` +
        `autodev.md, autoresearch.md, and the worker cards ` +
        `(packaging dropped the agents dir: .vscodeignore?)`,
    );
  }
  const cards = entries.filter((f) => f.endsWith(".md")).sort();
  if (cards.length === 0) {
    throw new Error(
      `no mode cards found in ${srcDir} — the extension bundle must ship ` +
        `autodev.md, autoresearch.md, and the worker cards ` +
        `(packaging dropped the agents dir: .vscodeignore?)`,
    );
  }
  return cards;
}

/** One staged card's provenance record (the merge record when an overlay
 *  merged; base-alone otherwise). Provenance lives HERE, never in the card. */
export interface StagedCardRecord {
  card: string;
  base_sha256: string;
  overlay_id: string | null;
  merged_fields: string[];
  merged_at?: string;
}

export interface StagingResult {
  dir: string;
  staged: string[];
  merges: Array<{ card: string; overlay_id: string; merged_fields: string[] }>;
  rejections: OverlayRejection[];
  receiptPath: string;
}

/** Copy the shipped mode cards into ~/.config/opencode/agents/ — precedence
 *  staging: every base card always lands; when the premium entitlement is
 *  present and an overlay source resolves, each card's `dispatch:` target
 *  resolves against the overlay registry and method-class fields merge in.
 *  Provenance lands in the staging receipt next to the cards, never in a
 *  staged card. Returns what landed where (for the activation log line). */
export function stageModCards(
  extensionPath: string,
  destDir: string = globalAgentsDir(),
  opts: StageOptions = {},
): StagingResult {
  const srcDir = path.join(extensionPath, "agents");
  fs.mkdirSync(destDir, { recursive: true });
  const nowIso = opts.now ?? (() => new Date().toISOString());

  // entitlement gate (#761): overlays resolve ONLY when the premium
  // entitlement is present; without it, base cards stage alone — no overlay
  // fields, no missing-target errors. The resolution pattern is the
  // extension's own LocalEntitlementProvider (scores/entitlements.ts).
  const configDir = opts.entitlementConfigDir ?? path.join(os.homedir(), ".amico", "amicode");
  const entitlements = opts.entitlements ?? readLocalEntitlements(configDir).entitlements;
  const entitled = entitlements.includes(PREMIUM_ENTITLEMENT);

  // overlay source ladder: explicit config → env overrides → known checkout
  // location → absent (a missing dir is absence, never an error).
  let registry: OverlayRegistry | null = null;
  if (entitled) {
    const root = resolveOverlaySource(opts.overlaySource);
    registry = root ? loadOverlayRegistry(overlayDirOf(root)) : null;
  }

  const staged: string[] = [];
  const cardRecords: StagedCardRecord[] = [];
  const rejections: OverlayRejection[] = registry ? [...registry.rejections] : [];
  for (const f of listModeCardFiles(extensionPath)) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src))
      throw new Error(
        `mode card missing from the extension: ${src} — packaging dropped it (.vscodeignore)`,
      );
    const baseBytes = fs.readFileSync(src);
    const base = baseBytes.toString("utf8");

    // dispatch-target validator: a present target must be well-formed (loud —
    // a base-card defect); it resolves against the staged registry when
    // present, and the card validates and stages alone when absent.
    let text = base;
    let overlayId: string | null = null;
    let mergedFields: string[] = [];
    let mergedAt: string | undefined;
    const target = cardDispatch(base);
    if (target !== undefined) {
      validateDispatchTarget(f, target);
      const overlay = registry?.overlays.get(target);
      if (overlay) {
        try {
          const merged = mergeOverlayIntoCard(base, overlay, f);
          text = merged.text;
          overlayId = target;
          mergedFields = merged.mergedFields;
          mergedAt = nowIso();
        } catch (e) {
          // freeze violation or a missing anchor: honest rejection record,
          // base card stages alone (staging must never dead-end)
          rejections.push({ card: f, overlay_id: target, reason: (e as Error).message });
        }
      }
    }

    fs.writeFileSync(path.join(destDir, f), text);
    staged.push(f);
    cardRecords.push({
      card: f,
      base_sha256: "sha256:" + createHash("sha256").update(baseBytes).digest("hex"),
      overlay_id: overlayId,
      merged_fields: mergedFields,
      ...(mergedAt !== undefined ? { merged_at: mergedAt } : {}),
    });
  }
  const receiptPath = path.join(destDir, ".staging-receipt.json");
  fs.writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        receipt_version: 1,
        staged_at: nowIso(),
        dir: destDir,
        cards: cardRecords,
        rejections,
      },
      null,
      2,
    ) + "\n",
  );
  return {
    dir: destDir,
    staged,
    merges: cardRecords
      .filter((r) => r.overlay_id !== null)
      .map((r) => ({ card: r.card, overlay_id: r.overlay_id!, merged_fields: r.merged_fields })),
    rejections,
    receiptPath,
  };
}

// ============================================================================
// mode_block.ts — the `## Active mode` block (#808, spec-20260905-063000 D4):
// posture-aware context injection. Pure logic, unit-testable in one place —
// loaded inside opencode's embedded Bun runtime via amicode_context.ts, and
// directly by test/mode_block.test.ts.
//
// RUNTIME CONTRACT: same as every plugin sibling — node builtins + sibling
// modules ONLY (the plugin is dependency-free by contract; it canNOT import
// @amicode/schema's validator — so every constant it duplicates from the
// shared validator is PARITY-PINNED by test/mode_block.test.ts: the supported
// bundle version, the version compare, the floor-gap render, and the
// ledger-discovery-rule markers are asserted byte-equal to the schema's).
//
// THE SESSION-API AVAILABILITY FIXTURE (test/mode_block.test.ts, H4 FIRST)
// proved the primary contract LIVE against the vendored pinned binary before
// this module was built: the plugin factory input carries the server-bound
// engine client; experimental.chat.system.transform fires per LLM request
// with { sessionID }; client.session.get resolves from INSIDE the hook; the
// returned Session.Info carries the session's `agent`. Its recorded outcome
// (contract=primary) is what licenses the primary path below.
//
// ── D4 semantics implemented here ────────────────────────────────────────────
//
// POSTURE BINDING IS A MAP, NOT A HEURISTIC: each staged mode bundle's
// manifest declares the agent id that binds its mode (`agent` in mode.toml —
// typed data since the #808 schema change); the map is built from those
// declarations. EVERY other agent id — plan, build, the role agents
// (implementer, hypothesizer, experimenter, analyzer, librarian, …), custom
// agents — binds the COPILOT posture and emits NOTHING. No mode name is
// hardcoded anywhere in this module; the modes-are-data invariant holds.
//
// THE BLOCK, complete: a resolved director posture emits `## Active mode` —
// posture name, the mode's phase/gate summary read from the staged registry
// bundle (pack.toml), the ledger path convention (the card's generated
// ledger-discovery-rule region — the SAME bytes the shared validator emits,
// never a hardcoded copy), and a stamp of the resolved agent id + registry
// digest. Emitted PER REQUEST: it survives compaction for the session by
// construction — the primary path reads session state (session.get), never
// the message history, so a post-compaction request re-emits it unchanged.
//
// NAMED OUTCOMES ONLY (the block never guesses):
//   - unresolvable  — a staged registry exists but the session's agent could
//                    not be resolved: the explicit `posture: unresolvable —
//                    re-bind from the ledger` line (byte-exact the spec text).
//   - version gap  — a staged bundle's plugin floor is above this plugin's
//                    supported version: the loud failure IS the unresolvable
//                    block (the two vocabularies name one outcome, byte-parity
//                    with the shared validator's render) — NEVER silence, even
//                    for a session that would otherwise bind copilot, because
//                    an over-floor registry makes the binding map itself
//                    untrustable.
//   - degraded     — the posture resolves but bundle parts the block reads
//                    are missing: the block is still emitted, with a DEGRADED
//                    line NAMING the missing parts and nothing fabricated.
//   - silent       — copilot (every agent id outside the declared mode
//                    agents), a pre-registry machine (no staged registry), a
//                    missing sessionID, or a bundle whose manifest is
//                    missing/unparseable (mid-staging prefix or corruption —
//                    the doctor owns that verdict; the plugin does not turn a
//                    transient staging state into noise on every session).
//
// THE FALLBACK (last assistant message's agent) exists ONLY for runtime
// resolution failures — compaction is NOT one of them (session state survives
// compaction; the fallback's message-history read is never the mechanism that
// survives it). It DECLINES exactly where it would lie: when the agent-
// switched record shows a switch NEWER than the message the fallback would
// read — newer on the MONOTONIC message id from the SAME store (lexicographic
// compare of ascending MessageIDs; never wall-clock — no timestamp is read
// anywhere in this module; never prose matching — no message text is read
// anywhere). Decline → the unresolvable line: the fallback never arbitrates a
// just-switched posture.
//
// TWO BOUNDARIES, stated because they are easy to miss (and they are DOCS,
// not new runtime): the compactor runs OUTSIDE the splice and is NOT
// posture-aware — its summary is audited against the ledger per the LEDGER
// DISCOVERY RULE (the block says so, every request); dispatched role casts
// may not receive the transform at all — role cards re-bind the parent
// posture from the LEDGER on cast, never from this splice (the block says so
// too). The block cannot observe mid-conversation vault writes (D6's seed
// writes are reported by the agent in-chat per the skill procedure) and does
// not pretend to.
// ============================================================================

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unwrap } from "./session_spawn";

/** The mode-bundle contract version THIS build's plugin supports. Duplicated
 *  from the schema package by the dependency-free contract; PARITY-PINNED by
 *  test/mode_block.test.ts (drift fails the suite loudly). */
export const PLUGIN_SUPPORTED_MODE_BUNDLE_VERSION = "1";

/** The explicit unresolvable line — byte-exact the spec's D4 text. */
export const UNRESOLVABLE_HEADLINE = "posture: unresolvable — re-bind from the ledger";

/** The ledger-discovery-rule generated region's delimiters — duplicated from
 *  the schema generator (the plugin cannot import it); the parity is pinned
 *  by construction (test fixtures build their cards with the REAL generator,
 *  so marker drift fails the region extraction cells loudly). */
const RULE_REGION_BEGIN = "<!-- AMICO-GENERATED: region=ledger-discovery-rule";
const RULE_REGION_END = "<!-- AMICO-GENERATED: region=ledger-discovery-rule end -->";

/** The deployed mode registry's staging root — the mirror of the extension's
 *  opencodeGlobalConfigRoot() + modeBundleStagingRoot() (`<config>/modes`).
 *  The extension stages there at activation; the plugin reads it per request. */
export function deployedModesRoot(): string {
  return join(homedir(), ".config", "opencode", "modes");
}

/** Natural version compare — the same algorithm as the schema's
 *  compareModeVersions (digits numeric, runs lexicographic). Duplicated by
 *  the dependency-free contract; parity-pinned over a corpus by the tests. */
export function compareModeVersionsPlugin(a: string, b: string): number {
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

// ── the minimal TOML reader ──────────────────────────────────────────────────
//
// The plugin cannot import smol-toml (dependency-free contract), so it carries
// a strictly-scoped TOML-subset parser for the fields it reads (manifest:
// schema_version/mode/agent/card/pack/consumer_floors; pack: phases[].name +
// phases[].gates[].name/kind). The REAL staged bundles are parsed by the H4
// parity cells against the shipped registry, so reader-vs-validator drift
// fails the suite. Quoted strings, string arrays (single- or multi-line),
// [table] and [[array-of-table]] headers (one nesting level, e.g.
// [[phases.gates]] attaching to the last [[phases]]) — everything else throws
// (a named parse failure, never a silent misread).

type TomlValue = string | string[] | TomlTable | TomlTable[];
interface TomlTable {
  [k: string]: TomlValue;
}

function stripTomlComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    if (c === "#" && !inStr) return line.slice(0, i);
  }
  return line;
}

function parseTomlString(raw: string): string {
  const s = raw.trim();
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) {
    throw new Error(`not a quoted string: ${raw.trim().slice(0, 40)}`);
  }
  return s.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** Parse a value that may span multiple lines (arrays). `takeLines` pulls
 *  more source lines until the value is complete. */
function parseTomlValue(first: string, takeLines: () => string): TomlValue {
  let v = first.trim();
  if (v.startsWith("[")) {
    // array — may span lines until the brackets balance (outside strings)
    while (!arrayComplete(v)) {
      const next = takeLines();
      if (next === undefined) throw new Error("unterminated array");
      v += "\n" + next;
    }
    const inner = v.trim().slice(1, -1).trim();
    if (inner === "") return [];
    return splitArrayItems(inner).map((it) => parseTomlString(it));
  }
  return parseTomlString(v);
}

function arrayComplete(v: string): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '"' && v[i - 1] !== "\\") inStr = !inStr;
    if (inStr) continue;
    if (c === "[") depth += 1;
    if (c === "]") {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

function splitArrayItems(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && inner[i - 1] !== "\\") inStr = !inStr;
    if (c === "," && !inStr) {
      if (cur.trim() !== "") items.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== "") items.push(cur);
  return items;
}

/** The TOML subset parser. Throws with a named message on anything outside
 *  the subset — a parse failure is a loud named outcome, never a guess. */
export function parseTomlSubset(text: string): TomlTable {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const root: TomlTable = {};
  let cur: TomlTable = root;
  const takeLines = (): string => {
    const next = lines[i] ?? "";
    i += 1;
    return next;
  };
  while (i < lines.length) {
    const raw = stripTomlComment(lines[i]).trim();
    i += 1;
    if (raw === "") continue;
    if (raw.startsWith("[[")) {
      if (!raw.endsWith("]]")) throw new Error(`malformed array-of-table header: ${raw.slice(0, 40)}`);
      const path = raw.slice(2, -2).trim().split(".");
      if (path.some((p) => p === "")) throw new Error(`malformed header path: ${raw.slice(0, 40)}`);
      let walk: TomlTable = root;
      for (let d = 0; d < path.length - 1; d++) {
        const seg = path[d];
        const next = walk[seg];
        if (Array.isArray(next)) {
          // nested under the LAST element of the parent array ([[phases.gates]])
          walk = next[next.length - 1] as TomlTable;
        } else if (next !== undefined && !Array.isArray(next)) {
          walk = next as TomlTable;
        } else {
          throw new Error(`header path escapes a non-table: ${raw.slice(0, 40)}`);
        }
      }
      const leaf = path[path.length - 1];
      const arr = walk[leaf];
      if (arr === undefined) {
        walk[leaf] = [] as TomlTable[];
      } else if (!Array.isArray(arr) || typeof arr[0] === "string") {
        throw new Error(`header redeclares a non-array: ${leaf}`);
      }
      const holder = walk[leaf] as TomlTable[];
      const el: TomlTable = {};
      holder.push(el);
      cur = el;
      continue;
    }
    if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) throw new Error(`malformed table header: ${raw.slice(0, 40)}`);
      const path = raw.slice(1, -1).trim().split(".");
      if (path.some((p) => p === "")) throw new Error(`malformed table path: ${raw.slice(0, 40)}`);
      let walk: TomlTable = root;
      for (const seg of path) {
        const next = walk[seg];
        if (next === undefined) {
          const t: TomlTable = {};
          walk[seg] = t;
          walk = t;
        } else if (!Array.isArray(next)) {
          walk = next as TomlTable;
        } else {
          throw new Error(`table header hits an array: ${seg}`);
        }
      }
      cur = walk;
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq === -1) throw new Error(`not a key = value line: ${raw.slice(0, 40)}`);
    const key = raw.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`malformed key: ${key}`);
    cur[key] = parseTomlValue(raw.slice(eq + 1), takeLines);
  }
  return root;
}

// ── the staged registry reader ───────────────────────────────────────────────

interface StagedBundle {
  mode: string;
  /** The DECLARED binding agent (the posture-binding map's datum). */
  agent: string;
  bundleDir: string;
  /** The ledger-discovery-rule body extracted from the card (undefined when
   *  the card or its region is missing). */
  ledgerRule?: string;
  packPhases?: Array<{ name: string; gates: Array<{ name: string; kind?: string }> }>;
  pluginFloor?: string;
  /** The parts this block reads that are missing/unreadable, NAMED. */
  missingParts: string[];
  digest: string;
}

interface StagedRegistry {
  /** Bundles with a parseable manifest — the binding map's data. Bundles whose
   *  manifest is missing/unparseable are SKIPPED (mid-staging or corrupt; the
   *  doctor owns that verdict). */
  bundles: StagedBundle[];
  /** A bundle floor above this plugin's supported version (the loud gap). */
  versionGap: { mode: string; floor: string } | null;
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** sha256 over the bundle's existing files (sorted relative paths, each
 *  `rel:sha256` line) — the content digest the block's stamp carries. */
function bundleDigest(bundleDir: string): string {
  const files: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(bundleDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) walk(rel === "" ? e.name : `${rel}/${e.name}`);
      else if (e.isFile()) files.push(rel === "" ? e.name : `${rel}/${e.name}`);
    }
  };
  walk("");
  const h = createHash("sha256");
  for (const f of files.sort()) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(bundleDir, f));
    } catch {
      continue;
    }
    h.update(`${f}:${sha256hex(bytes)}\n`);
  }
  return `sha256:${h.digest("hex")}`;
}

/** Extract the ledger-discovery-rule body from a card (between the generated
 *  region's delimiters, fences stripped). Null when the region is absent. */
function extractLedgerRule(card: string): string | null {
  const begin = card.indexOf(RULE_REGION_BEGIN);
  if (begin === -1) return null;
  const end = card.indexOf(RULE_REGION_END, begin);
  if (end === -1) return null;
  let body = card.slice(begin + RULE_REGION_BEGIN.length, end);
  // drop the begin marker's tail (generator=… begin -->)
  body = body.replace(/^[^\n]*-->\n?/, "");
  // strip the fences the generator emits around the rule text
  body = body.replace(/^\s*```text\n?/, "").replace(/\n?```\s*$/, "");
  return body.trim() === "" ? null : body.trim();
}

function readStagedRegistry(root: string): StagedRegistry {
  const registry: StagedRegistry = { bundles: [], versionGap: null };
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return registry; // no staged registry (pre-registry machine) — the caller goes silent
  }
  for (const mode of dirs) {
    const bundleDir = join(root, mode);
    const manifestPath = join(bundleDir, "mode.toml");
    if (!isFile(manifestPath)) continue; // mid-staging prefix or corrupt — skipped, the doctor names it
    let manifest: TomlTable;
    try {
      manifest = parseTomlSubset(readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // unparseable manifest: no binding exists for this bundle
    }
    const str = (v: TomlValue | undefined): string | undefined =>
      typeof v === "string" && v.trim() !== "" ? v : undefined;
    const agent = str(manifest.agent);
    const modeName = str(manifest.mode);
    if (agent === undefined || modeName === undefined) continue; // an un-declared binding binds nothing
    const floors = manifest.consumer_floors as TomlTable | undefined;
    const pluginFloor = str(floors?.plugin);
    const missingParts: string[] = [];
    // the pack: the phase/gate summary's source
    let packPhases: StagedBundle["packPhases"];
    const packPath = join(bundleDir, str(manifest.pack) ?? "pack.toml");
    if (!isFile(packPath)) {
      missingParts.push("pack.toml (missing)");
    } else {
      try {
        const pack = parseTomlSubset(readFileSync(packPath, "utf8"));
        packPhases = ((pack.phases as TomlTable[] | undefined) ?? []).map((p) => ({
          name: str(p.name) ?? "(unnamed phase)",
          gates: ((p.gates as TomlTable[] | undefined) ?? []).map((g) => ({
            name: str(g.name) ?? "(unnamed gate)",
            kind: str(g.kind),
          })),
        }));
        if (packPhases.length === 0) missingParts.push("pack.toml (no phases declared)");
      } catch (e) {
        missingParts.push(`pack.toml (unreadable: ${(e as Error).message.slice(0, 60)})`);
      }
    }
    // the card: the ledger-discovery rule's source
    let ledgerRule: string | undefined;
    const cardPath = join(bundleDir, str(manifest.card) ?? "card.md");
    if (!isFile(cardPath)) {
      missingParts.push("card.md (missing)");
    } else {
      const rule = extractLedgerRule(readFileSync(cardPath, "utf8"));
      if (rule === null) missingParts.push("ledger-discovery-rule region (card.md carries no generated region)");
      else ledgerRule = rule;
    }
    registry.bundles.push({
      mode: modeName,
      agent,
      bundleDir,
      ledgerRule,
      packPhases,
      pluginFloor,
      missingParts,
      digest: bundleDigest(bundleDir),
    });
    if (pluginFloor !== undefined && registry.versionGap === null) {
      if (compareModeVersionsPlugin(PLUGIN_SUPPORTED_MODE_BUNDLE_VERSION, pluginFloor) < 0) {
        registry.versionGap = { mode: modeName, floor: pluginFloor };
      }
    }
  }
  return registry;
}

// ── the engine-client seam (shaped exactly like the fixture-proven contract) ──

export interface ModeBlockClient {
  session: {
    get: (o: unknown) => Promise<unknown>;
    messages?: (o: unknown) => Promise<unknown>;
  };
}

export interface ModeBlockDeps {
  sessionID: string | null;
  /** The engine client the plugin factory captured (input.client) — null on
   *  legacy load paths that hand the plugin nothing. */
  engineClient: ModeBlockClient | null;
  /** The deployed registry root (deployedModesRoot() in production). */
  registryRoot: string;
  /** The session's directory (the plugin factory's input.directory) — passed
   *  as the client's routing query, the same call shape amicode_tools.ts uses. */
  directory?: string | null;
}

interface FakeMessageInfo {
  id?: unknown;
  role?: unknown;
  agent?: unknown;
}

type ResolutionOk = { ok: true; agent: string; via: "session.get" };
type ResolutionFailed = { ok: false; reason: string };
type Resolution = ResolutionOk | ResolutionFailed;

async function resolveAgent(deps: ModeBlockDeps): Promise<Resolution> {
  if (deps.engineClient === null) {
    return { ok: false, reason: "the engine did not hand this plugin a server client (legacy load path)" };
  }
  try {
    const res = await deps.engineClient.session.get({
      path: { id: deps.sessionID },
      query: typeof deps.directory === "string" ? { directory: deps.directory } : undefined,
    });
    const info = unwrap<{ agent?: unknown } | null | undefined>(res);
    if (typeof info?.agent === "string" && info.agent.trim() !== "") {
      return { ok: true, agent: info.agent, via: "session.get" };
    }
    return { ok: false, reason: "session.get returned no agent (Session.Info.agent absent)" };
  } catch (e) {
    return { ok: false, reason: `session.get failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

type Fallback =
  | { outcome: "resolved"; agent: string }
  | { outcome: "declined"; reason: string }
  | { outcome: "failed"; reason: string };

/** The last-assistant-message fallback — ONLY for runtime resolution failures.
 *  Declines where it would lie: a switch record newer than the message it
 *  would read (monotonic message id, same store; no timestamps, no prose). */
async function fallbackResolve(deps: ModeBlockDeps): Promise<Fallback> {
  const messagesFn = deps.engineClient?.session?.messages;
  if (deps.engineClient === null || typeof messagesFn !== "function") {
    return { outcome: "failed", reason: "no message stream on this client (older engine client)" };
  }
  let raw: unknown;
  try {
    raw = await messagesFn({
      path: { id: deps.sessionID },
      query: typeof deps.directory === "string" ? { directory: deps.directory } : undefined,
    });
  } catch (e) {
    return { outcome: "failed", reason: `session.messages failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const list = unwrap<Array<{ info?: FakeMessageInfo }> | null | undefined>(raw);
  if (!Array.isArray(list)) return { outcome: "failed", reason: "session.messages returned no list" };
  const infos = list.map((m) => m?.info).filter((x): x is FakeMessageInfo => typeof x === "object" && x !== null);
  // the message the fallback would read: the LAST assistant message that carries an agent
  let last: { id: string; agent: string } | null = null;
  for (const info of infos) {
    if (info.role === "assistant" && typeof info.agent === "string" && info.agent.trim() !== "" && typeof info.id === "string") {
      last = { id: info.id, agent: info.agent };
    }
  }
  if (last === null) {
    return { outcome: "failed", reason: "no assistant message carrying an agent exists to read" };
  }
  // the decline rule: ANY record newer on the monotonic key carrying a
  // DIFFERENT agent is a switch the fallback must not arbitrate
  for (const info of infos) {
    if (typeof info.id !== "string") continue;
    if (info.id <= last.id) continue; // same store, ascending MessageIDs — lexicographic compare IS the monotonic key
    if (typeof info.agent === "string" && info.agent.trim() !== "" && info.agent !== last.agent) {
      return {
        outcome: "declined",
        reason: `an agent switch (${info.id} → ${info.agent}) is newer than the last assistant message (${last.id}) — the fallback never arbitrates a just-switched posture`,
      };
    }
  }
  return { outcome: "resolved", agent: last.agent };
}

// ── the block renderers (named outcomes only) ────────────────────────────────

function phaseSummary(b: StagedBundle): string {
  return b.packPhases!
    .map((p) => {
      const gates = p.gates.map((g) => (g.kind !== undefined ? `${g.name} (${g.kind})` : g.name)).join(", ");
      return `- ${p.name} — gates: ${gates || "(none declared)"}`;
    })
    .join("\n");
}

function stampLine(b: StagedBundle, agent: string, resolvedVia: "primary" | "fallback"): string {
  return `posture stamp: agent=${agent} mode=${b.mode} resolved=${resolvedVia} registry-digest=${b.digest}`;
}

const BOUNDARY_NOTE =
  "This block is emitted per request from session state, so it survives compaction by construction. " +
  "The compactor runs outside the splice and is not posture-aware: audit any compaction summary against the session ledger per the discovery rule before acting. " +
  "Dispatched role casts re-bind the parent posture from the ledger — never from this splice (casts may not receive the transform at all).";

function fullBlock(b: StagedBundle, agent: string, resolvedVia: "primary" | "fallback"): string {
  return [
    "## Active mode",
    "",
    `posture: \`${b.mode}\` — this session runs the ${b.mode} director mode. ${BOUNDARY_NOTE}`,
    "",
    "Phases/gates (read from the mode registry bundle):",
    phaseSummary(b),
    "",
    "Session ledger (the mode's ledger discovery rule, from the bundle card):",
    b.ledgerRule!,
    "",
    stampLine(b, agent, resolvedVia),
    "",
  ].join("\n");
}

function degradedBlock(b: StagedBundle, agent: string, resolvedVia: "primary" | "fallback"): string {
  const lines = [
    "## Active mode",
    "",
    `posture: \`${b.mode}\` — this session runs the ${b.mode} director mode. ${BOUNDARY_NOTE}`,
    "",
    `DEGRADED — missing bundle parts: ${b.missingParts.join("; ")}. The staged bundle is incomplete; nothing below is fabricated.`,
    "",
  ];
  if (b.packPhases !== undefined) {
    lines.push("Phases/gates (read from the mode registry bundle):", phaseSummary(b), "");
  }
  if (b.ledgerRule !== undefined) {
    lines.push("Session ledger (the mode's ledger discovery rule, from the bundle card):", b.ledgerRule, "");
  }
  lines.push(stampLine(b, agent, resolvedVia), "");
  return lines.join("\n");
}

function unresolvableBlock(reason: string): string {
  return [
    "## Active mode",
    "",
    UNRESOLVABLE_HEADLINE,
    "",
    `This machine carries a staged mode registry, so a director posture almost certainly applies — but this session's agent could not be resolved (reason: ${reason}).`,
    "Re-read the session ledger from disk (the personal vault's sessions/session-<YYYYMMDD>-<slug>.md) and re-bind your posture from what it says — never guess one, and never assume copilot.",
    "",
  ].join("\n");
}

function versionGapBlock(gap: { mode: string; floor: string }): string {
  // byte-parity with the shared validator's plugin render (the two
  // vocabularies name one outcome — D1; parity-pinned by the H4 cells)
  const render = `posture: unresolvable — mode-registry version gap: plugin at v${PLUGIN_SUPPORTED_MODE_BUNDLE_VERSION} is below the bundle's floor v${gap.floor}`;
  return [
    "## Active mode",
    "",
    render,
    "",
    `This plugin build (mode-bundle contract v${PLUGIN_SUPPORTED_MODE_BUNDLE_VERSION}) cannot safely read the staged registry — mode "${gap.mode}" requires at least v${gap.floor}. The per-consumer floor map failed loudly, as designed.`,
    "Re-bind the posture from the session ledger (the personal vault's sessions/session-<YYYYMMDD>-<slug>.md); do not guess one. Upgrading the extension closes the gap.",
    "",
  ].join("\n");
}

// ── the orchestrator ─────────────────────────────────────────────────────────

/** Build the `## Active mode` block for one request. Returns the block text,
 *  or null for the silent outcomes (copilot, pre-registry, no sessionID).
 *  NEVER throws — the caller (amicode_context.ts) additionally guards, but
 *  this function is total by construction. */
export async function buildModeBlock(deps: ModeBlockDeps): Promise<string | null> {
  if (typeof deps.sessionID !== "string" || deps.sessionID.trim() === "") return null;
  const registry = readStagedRegistry(deps.registryRoot);
  if (registry.bundles.length === 0) return null; // pre-registry machine, or every manifest is mid-staging/corrupt — silent
  if (registry.versionGap !== null) return versionGapBlock(registry.versionGap); // the loud failure, never silence
  const resolution = await resolveAgent(deps);
  let agent: string;
  let resolvedVia: "primary" | "fallback";
  if (resolution.ok) {
    agent = resolution.agent;
    resolvedVia = "primary";
  } else {
    // the fallback exists ONLY for runtime resolution failures (compaction is
    // not one — session state survives it; see the header). Decline → the
    // unresolvable line, never a wrong posture.
    const fb = await fallbackResolve(deps);
    if (fb.outcome === "declined") return unresolvableBlock(`${resolution.reason}; the last-assistant-message fallback declined: ${fb.reason}`);
    if (fb.outcome === "failed") return unresolvableBlock(`${resolution.reason}; the last-assistant-message fallback failed: ${fb.reason}`);
    agent = fb.agent;
    resolvedVia = "fallback";
  }
  // the posture-binding MAP: registry mode agents bind their mode; every other
  // agent id binds copilot and is SILENT
  const bound = registry.bundles.find((b) => b.agent === agent);
  if (bound === undefined) return null; // copilot posture — silent, whatever resolved the id
  return bound.missingParts.length === 0
    ? fullBlock(bound, agent, resolvedVia)
    : degradedBlock(bound, agent, resolvedVia);
}

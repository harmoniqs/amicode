// editor_carry.ts — the always-local companion's CROSS-SCHEME EDITOR-URI CARRY
// (#1278, ADR 0025 P3; part of #1269). It is the piece that makes the posture
// switch (auto-DOWN #1276 / prompt-UP #1277) keep your place: a window reopen
// changes the file SCHEME, so open editors do not survive the flip unless their
// URIs are translated across it.
//
// ── THE TWO HOST-FILE SCHEMES (same logical path, different scheme) ────────────
// The SAME logical host path is addressed two ways depending on the window's
// posture:
//   · under the thin-client lifeboat: `amico-host:/<hostpath>` — the #1267
//     FileSystemProvider scheme (HOST_SCHEME, imported below so this file cannot
//     drift from the provider's own constant).
//   · under Remote-SSH:               `vscode-remote://ssh-remote+<alias>/<hostpath>`
//     — the Remote-SSH file scheme, built exactly as reopen.ts's
//     resolveRemoteSshReopenTarget builds the window target (single slash, the
//     path's leading slash absorbed into the authority separator), so a carried
//     editor URI is coherent with the window the switch reopens into.
//
// ── THE KEY DECISION: carry by LOGICAL PATH, honesty over silent loss ──────────
// The translator is PURE and directional. It carries the logical path VERBATIM
// across the two schemes — it does NOT reconcile the FSP's mount-id addressing
// against the host's real absolute path (that mapping is not pure and is out of
// this slice's scope; the switch triggers #1276/#1277 own the path semantics).
// Three outcomes, one per Acceptance Criterion:
//   · `carried`      (AC1) — a host editor, mapped to the same logical path under
//                            the target scheme.
//   · `skip`         (AC3) — NOT a host editor (local `file:`/`untitled:` scratch,
//                            a non-ssh `vscode-remote:`), or already in the target
//                            scheme: left EXACTLY as-is, silently and correctly.
//   · `cannot-carry` (AC2) — a host editor we could not map (no Remote-SSH alias
//                            to map it to, or a malformed URI with no usable path).
//                            It is REPORTED to the user, never silently dropped —
//                            the issue's "No silent state loss" invariant.
// A `cannot-carry` is deliberately DISTINCT from a `skip`: bucketing an
// un-mappable host editor with the untouched scratch editors would be exactly the
// silent drop the invariant forbids.

import { HOST_SCHEME } from "../../extension/src/fleet_host_fs/mount_policy";

/** The Remote-SSH scheme + the ssh-remote authority prefix. String literals here
 *  (not shared constants) mirror reopen.ts's own builder — reopen.ts already
 *  duplicates these from the main extension as a documented spike judgment call;
 *  a local constant is consistent with that established pattern. */
const REMOTE_SCHEME = "vscode-remote";
const SSH_AUTHORITY_PREFIX = "ssh-remote+";

/** The carry TARGET — the scheme the switch is reopening INTO. auto-DOWN
 *  (remote→local) carries to `amico-host`; prompt-UP (local→remote) carries to
 *  `vscode-remote`. Directional (not auto-detected from the source) so the
 *  switch's intent is honored and an already-target editor is a clean no-op. */
export type CarryTarget = "amico-host" | "vscode-remote";

/** The typed outcome of translating one editor URI (one per Acceptance Criterion —
 *  see the module header). */
export type EditorCarryOutcome =
  | { kind: "carried"; direction: "to-local" | "to-remote"; to: string } // AC1
  | { kind: "skip"; reason: "not-host" | "already-target" } // AC3 (untouched)
  | { kind: "cannot-carry"; reason: "no-ssh-alias" | "unparseable"; detail: string }; // AC2 (reported)

interface ParsedUri {
  scheme: string;
  authority: string;
  path: string;
}

/** A minimal, robust URI parse into scheme + authority + path — enough for the
 *  scheme/authority swap the carry performs. Handles `scheme://authority/path`,
 *  `scheme:/path`, and opaque `scheme:rest` (e.g. `untitled:Untitled-1`). Query
 *  and fragment are dropped for logical-path purposes. Returns null for a string
 *  that is not a URI (no scheme). */
function parseUri(raw: string): ParsedUri | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  const colon = s.indexOf(":");
  if (colon <= 0) return null;
  const scheme = s.slice(0, colon).toLowerCase();
  let rest = s.slice(colon + 1);
  let authority = "";
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      authority = rest;
      rest = "";
    } else {
      authority = rest.slice(0, slash);
      rest = rest.slice(slash);
    }
  }
  const path = rest.split(/[?#]/)[0] ?? "";
  return { scheme, authority, path };
}

/** Is this a well-formed ssh-remote host authority (`ssh-remote+<non-empty>`)?
 *  A bare `ssh-remote+` (empty alias) or any other `vscode-remote` authority
 *  (dev-container/wsl/codespaces) is NOT the host scheme we mirror. */
function isSshRemoteAuthority(authority: string): boolean {
  return authority.startsWith(SSH_AUTHORITY_PREFIX) && authority.length > SSH_AUTHORITY_PREFIX.length;
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith("/") ? p : "/" + p;
}

function cannotCarry(reason: "no-ssh-alias" | "unparseable"): EditorCarryOutcome {
  const detail =
    reason === "no-ssh-alias"
      ? "no Remote-SSH alias to map it to"
      : "its address could not be mapped across schemes";
  return { kind: "cannot-carry", reason, detail };
}

/**
 * Translate ONE open-editor URI for the carry across a posture switch.
 *
 * @param rawUri  the open editor's URI, as a string (production: `uri.toString()`)
 * @param target  the scheme the switch is reopening INTO
 * @param opts    `alias` is the hub's Remote-SSH alias — REQUIRED only when
 *                carrying a host editor UP to `vscode-remote` (unused to-local)
 */
export function translateHostEditorUri(
  rawUri: string,
  target: CarryTarget,
  opts: { alias?: string } = {},
): EditorCarryOutcome {
  const parsed = parseUri(rawUri);
  if (parsed === null) return { kind: "skip", reason: "not-host" }; // not a URI → leave it (AC3)

  const { scheme, authority, path } = parsed;
  const isAmicoHost = scheme === HOST_SCHEME;
  const isSshRemote = scheme === REMOTE_SCHEME && isSshRemoteAuthority(authority);

  // Neither of the two host-file schemes → a local scratch / foreign editor.
  // Untouched, silently and correctly (AC3).
  if (!isAmicoHost && !isSshRemote) return { kind: "skip", reason: "not-host" };

  if (target === "amico-host") {
    // Carrying DOWN to the local lifeboat (auto-DOWN, remote→local).
    if (isAmicoHost) return { kind: "skip", reason: "already-target" };
    const logicalPath = path; // the ssh-remote path component (leading-slash rooted)
    if (logicalPath === "") return cannotCarry("unparseable"); // AC2 — never dropped
    return { kind: "carried", direction: "to-local", to: `${HOST_SCHEME}:${ensureLeadingSlash(logicalPath)}` };
  }

  // target === "vscode-remote": carrying UP to Remote-SSH (prompt-UP, local→remote).
  if (isSshRemote) return { kind: "skip", reason: "already-target" };
  // The amico-host logical path: fold a (defensive) two-slash authority back into
  // the path so `amico-host://mount/rel` and `amico-host:/mount/rel` agree.
  const logicalPath = (authority ? "/" + authority : "") + path;
  if (logicalPath === "") return cannotCarry("unparseable"); // AC2 — never dropped
  const alias = (opts.alias ?? "").trim();
  if (alias === "") return cannotCarry("no-ssh-alias"); // AC2 — the named missing-alias case
  return {
    kind: "carried",
    direction: "to-remote",
    to: `${REMOTE_SCHEME}://${SSH_AUTHORITY_PREFIX}${alias}/${logicalPath.replace(/^\/+/, "")}`,
  };
}

/** The honest not-carried report (AC2). Names the editor and WHY, and states
 *  plainly that it was left as-is rather than silently dropped. */
export function notCarriedMessage(from: string, detail: string): string {
  return (
    `Amicode Companion: couldn't carry an open editor across the posture switch — ${from} (${detail}). ` +
    "It was left as-is, not silently dropped; reopen it by hand if you still need it."
  );
}

/** The injectable seam the switch orchestrators use to drive the carry without a
 *  live editor host (mirrors reopen.ts's openFolder/showError injection). */
export interface EditorCarryDeps {
  /** Capture the currently-open editor URIs, as strings. Production:
   *  `vscode.window.visibleTextEditors.map((e) => e.document.uri.toString())`
   *  (with `vscode.workspace.textDocuments` as the broader alternative). */
  listOpenEditors: () => string[];
  /** Carry ONE translated editor under the target scheme (production: queue it to
   *  reopen after the window reload). */
  carryEditor: (uri: string) => void | Promise<void>;
  /** Report a host editor that could not be carried (AC2 — never silent).
   *  Production: `vscode.window.showWarningMessage`. */
  reportNotCarried: (message: string) => void;
}

/** What the carry did — assertable without reading side effects alone. */
export interface CarrySummary {
  /** Target-scheme URIs that were carried (AC1). */
  carried: string[];
  /** Host editors that could not be carried — REPORTED, never dropped (AC2). */
  notCarried: Array<{ from: string; reason: string; detail: string }>;
  /** Non-host / already-target editors, left untouched (AC3). */
  skipped: string[];
}

/**
 * The switch's carry step: capture the open editors, translate each to the
 * target scheme, carry the host editors, REPORT the un-carryable ones, and leave
 * the scratch editors untouched. Pure but for the three injected seams — the
 * switch orchestrators (#1276/#1277) call it around their window reopen.
 */
export async function carryOpenEditors(
  target: CarryTarget,
  deps: EditorCarryDeps,
  opts: { alias?: string } = {},
): Promise<CarrySummary> {
  const carried: string[] = [];
  const notCarried: CarrySummary["notCarried"] = [];
  const skipped: string[] = [];
  for (const from of deps.listOpenEditors()) {
    const outcome = translateHostEditorUri(from, target, opts);
    if (outcome.kind === "carried") {
      await deps.carryEditor(outcome.to);
      carried.push(outcome.to);
    } else if (outcome.kind === "cannot-carry") {
      deps.reportNotCarried(notCarriedMessage(from, outcome.detail));
      notCarried.push({ from, reason: outcome.reason, detail: outcome.detail });
    } else {
      skipped.push(from);
    }
  }
  return { carried, notCarried, skipped };
}

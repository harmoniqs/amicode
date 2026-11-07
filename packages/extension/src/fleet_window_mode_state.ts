// #1272 — the WINDOW-MODE state file. Window mode (Remote-SSH vs editor-local)
// is an axis ORTHOGONAL to the link-health posture (#780): which machine the
// editor WINDOW sits on, distinct from whether the hub is reachable. It gets
// its OWN field, its OWN writer + transition signature, and its OWN state file
// — deliberately NOT folded into fleet_posture_state.ts.
//
// WHY A SEPARATE WRITER (the Key Decision): the posture writer's signature is
// the link-health tuple (mode/reachable/hub). A window-mode-only change (the
// user re-opens the same workspace over Remote-SSH while the hub stays
// reachable) does NOT move that signature, so the single posture writer would
// SILENTLY SWALLOW it. "Own field" alone is insufficient — the transition
// signature must be independent too. So this module mirrors #780's writer
// shape but keys its signature on the WINDOW-MODE VALUE alone (AC2). It never
// touches the posture writer, whose transition-only contract stays unchanged
// (AC4).
//
// VOCABULARY (AC1): the field values are `remote-ssh | local`, NEVER the
// link-health `standalone` token (FleetPostureMode) — the two axes must not be
// conflated. `remote-ssh` = the editor window is attached to a Remote-SSH host;
// `local` = the editor is running locally (including WSL / dev-container /
// tunnel remotes, which are not Remote-SSH).
//
// Node builtins only — imported by the extension host; the context plugin reads
// the same file shape-tolerantly (never this module) to stay dep-free. This is
// the peer of fleet_posture_state.ts.
import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** The state-file schema version. Bumped only on a breaking field change. */
export const FLEET_WINDOW_MODE_STATE_VERSION = 1;

/** The window mode the editor is in — an axis orthogonal to link-health
 *  posture. Deliberately DISJOINT from FleetPostureMode's `standalone` (AC1):
 *  - "remote-ssh" — the editor window is attached to a Remote-SSH host;
 *  - "local"      — the editor is running locally (or on a non-SSH remote). */
export type WindowMode = "remote-ssh" | "local";

/** The persisted record. `remote_name` is the raw editor remote indicator the
 *  mode was derived from (provenance) — explicit null when the window is local. */
export interface WindowModeStateFile {
  schema_version: number;
  /** This machine's hostname (os.hostname()). */
  hostname: string;
  /** The window mode: remote-ssh | local (NEVER the posture `standalone`). */
  window_mode: WindowMode;
  /** The raw remote indicator (vscode.env.remoteName) the mode derived from,
   *  e.g. "ssh-remote+<hash>"; null when the window is local. */
  remote_name: string | null;
  /** ISO instant THIS record was written (i.e. the transition instant). */
  updated_at: string;
}

/** What the wiring observes each tick. `remote_name` is optional: absent →
 *  recorded as explicit null (never a guess). */
export interface WindowModeFacts {
  hostname: string;
  window_mode: WindowMode;
  remote_name?: string | null;
}

/** The PURE derivation from the editor's remote indicator. VS Code exposes the
 *  window's remote via `vscode.env.remoteName`: an `ssh-remote…` string under
 *  Remote-SSH, `undefined` when the editor is local. Only an `ssh-remote`
 *  prefix is Remote-SSH; every other remote (wsl, dev-container, tunnel) and
 *  the absent/empty case are `local`. Emits ONLY the two window-mode tokens —
 *  NEVER `standalone` (AC1). Keeping it pure means it is TDD'd with no live
 *  editor. */
export function windowModeFromRemoteName(remoteName: string | undefined): WindowMode {
  return typeof remoteName === "string" && remoteName.startsWith("ssh-remote") ? "remote-ssh" : "local";
}

/** Build the facts from the machine hostname + the raw editor remote indicator.
 *  The mode is derived (windowModeFromRemoteName); the raw indicator is
 *  preserved as remote_name provenance (null when local). Pure. */
export function windowModeFacts(hostname: string, remoteName: string | undefined): WindowModeFacts {
  const window_mode = windowModeFromRemoteName(remoteName);
  return {
    hostname,
    window_mode,
    remote_name: window_mode === "remote-ssh" ? (remoteName ?? null) : null,
  };
}

/** The state-file path: the env override (tests / relocation) then the
 *  ops-fleet default beside fleet.json — DISTINCT from posture-state.json
 *  (own field, own file). */
export function fleetWindowModeStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_FLEET_WINDOW_MODE_STATE;
  if (v && v.trim() !== "") return v.trim();
  return path.join(homedir(), ".amico", "ops", "fleet", "window-mode.json");
}

/** Build the record from the facts. Pure — the clock is injectable. */
export function buildWindowModeRecord(
  facts: WindowModeFacts,
  now: () => string = () => new Date().toISOString(),
): WindowModeStateFile {
  return {
    schema_version: FLEET_WINDOW_MODE_STATE_VERSION,
    hostname: facts.hostname,
    window_mode: facts.window_mode,
    remote_name: facts.remote_name ?? null,
    updated_at: now(),
  };
}

export interface WindowModeStateWriterOptions {
  /** Target file; default fleetWindowModeStateFile(). */
  file?: string;
  /** Injectable clock. */
  now?: () => string;
  /** Injectable sink (tests / alt transports); default = atomic fs write. */
  writeFile?: (file: string, text: string) => void;
  /** Optional log sink for a swallowed write failure. */
  log?: (msg: string) => void;
}

/** The window-mode-defining signature: the WINDOW-MODE VALUE ALONE. This is the
 *  whole point of a separate writer — it is INDEPENDENT of the posture
 *  signature (mode/reachable/hub), so a window-mode-only transition writes even
 *  when link-health posture is unchanged (AC2). `remote_name` is provenance
 *  churn, deliberately excluded — re-attaching to a different SSH host at the
 *  same window mode must not rewrite the file. */
function signatureOf(facts: WindowModeFacts): string {
  return facts.window_mode;
}

/** Atomic default write: mkdir -p, write a temp, rename over the target. */
function atomicWriteFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * The SOLE writer of the window-mode state file. TRANSITION-ONLY by
 * construction: `record(facts)` writes iff the window-mode value changed since
 * the last successful write. Its signature is INDEPENDENT of the posture
 * writer's, so a window-mode-only change is written (never swallowed — AC2) and
 * a link-health-only change writes nothing here. It NEVER throws — a dead disk
 * must not crash the attach loop. Mirrors #780's FleetPostureStateWriter.
 */
export class WindowModeStateWriter {
  private lastSignature: string | null = null;
  private readonly file: string;
  private readonly now: () => string;
  private readonly writeImpl: (file: string, text: string) => void;
  private readonly log?: (msg: string) => void;

  constructor(opts: WindowModeStateWriterOptions = {}) {
    this.file = opts.file ?? fleetWindowModeStateFile();
    this.now = opts.now ?? (() => new Date().toISOString());
    this.writeImpl = opts.writeFile ?? atomicWriteFile;
    this.log = opts.log;
  }

  /** Record a window-mode observation. Returns whether it wrote and the record. */
  record(facts: WindowModeFacts): { wrote: boolean; record: WindowModeStateFile | null } {
    const sig = signatureOf(facts);
    if (sig === this.lastSignature) return { wrote: false, record: null };
    const record = buildWindowModeRecord(facts, this.now);
    try {
      this.writeImpl(this.file, JSON.stringify(record, null, 2) + "\n");
    } catch (e) {
      this.log?.(`[fleet] window-mode write failed: ${e instanceof Error ? e.message : String(e)}`);
      return { wrote: false, record: null }; // swallow — never crash the loop; retry next transition
    }
    this.lastSignature = sig;
    return { wrote: true, record };
  }
}

import * as path from "node:path";

// ============================================================================
// Bug-report orchestration (amicode#250, lifecycle spec: docs/adr/0004).
//
// The extension owns the bug session end-to-end — no reverse lookup, no
// app-reported ids. `reportBug()` creates the session (title "Bug report",
// metadata envelope `bug_report: {project, run_pointer?, origin_session_id}`),
// arms it with the report-a-bug slash command (the session command API idiom:
// create + command), and tells the app to open the dock. The lifecycle is
// machine-managed: `bug-filed` → archive (the soft hide) + close the dock;
// `bug-report-closed` before filing → abort the in-flight turn, then hard
// delete; a partial orchestration failure deletes the session it created (no
// orphans). One bug session at a time per window: a second invocation reveals
// (re-posts open-bug-report with the EXISTING id — the dock treats a same-id
// open as reveal) instead of creating.
//
// Bridge contract (mirrored by the fork slices #116/#117):
//   DOWN {source:"amicode", kind:"open-bug-report",  sessionID}
//   DOWN {source:"amicode", kind:"close-bug-report", sessionID}
//   UP   {source:"amicode", kind:"bug-filed",         sessionID, url}
//   UP   {source:"amicode", kind:"bug-report-closed", sessionID}
//
// Sanitization invariant: run context travels as run-id POINTERS only (never
// an absolute path, never a payload); the originating session id is a
// provenance pointer — it is only ever READ (the list call) and embedded, never
// mutated, navigated, or closed (AC6).
// ============================================================================

export const REPORT_BUG_COMMAND = "amicode.reportBug";
export const BUG_REPORT_TITLE = "Bug report";
/** The staged skill whose name is also its slash-command (opencode command
 *  API: skills register as commands under their frontmatter `name`). */
export const REPORT_A_BUG_SKILL = "report-a-bug";

export const OPEN_BUG_REPORT_KIND = "open-bug-report";
export const CLOSE_BUG_REPORT_KIND = "close-bug-report";
export const BUG_FILED_KIND = "bug-filed";
export const BUG_REPORT_CLOSED_KIND = "bug-report-closed";
/** UP: the app posts this on boot when the bug-report flag is on — the
 *  catch-up half of the open contract. A one-shot open-bug-report can land
 *  before the app's listener mounts (cold window, webview reload), so a live
 *  bug session re-opens its dock on every app boot until it terminates. */
export const BUG_REPORT_POKE_KIND = "bug-report-poke";

/** The DOWN envelopes this module ever posts. */
export interface BugReportDownMessage {
  source: "amicode";
  kind: typeof OPEN_BUG_REPORT_KIND | typeof CLOSE_BUG_REPORT_KIND;
  sessionID: string;
}

/** The `amicode_bug_report=1` boot param is set iff the staged skill set
 *  includes report-a-bug (AC5) — the composer button never renders without the
 *  skill that answers it. Staged paths are `<stageDir>/<name>/SKILL.md` and the
 *  library/package layouts share the name-matches-folder rule, so the parent
 *  dir basename IS the skill name. */
export function bugReportSkillStaged(skillPaths: readonly string[]): boolean {
  return skillPaths.some((p) => path.basename(path.dirname(p)) === REPORT_A_BUG_SKILL);
}

/** The running local opencode server + the #163 boot credential header value. */
export interface BugReportServer {
  url: string;
  authorization: string;
}

export interface BugReportDeps {
  /** undefined while the server is down — the command then fails actionably. */
  server(): BugReportServer | undefined;
  /** The VS Code workspace folder (the project the app's sessions live in);
   *  undefined in a no-folder window (→ the server's own cwd scope). */
  workspaceDir(): string | undefined;
  /** The active (inspector-selected) run's POINTER — the registry runId,
   *  relative to the runs root, never an absolute path; undefined when none. */
  activeRunPointer(): string | undefined;
  /** DOWN lane to the main app surface (the dock's host). */
  postDown(msg: BugReportDownMessage): void;
  showError(message: string): void;
  log?(line: string): void;
  fetchImpl?: typeof fetch;
  /** The session-level model pin as `provider/model`, or undefined to let the
   *  server resolve its own default. Same rule as everywhere else in the
   *  extension: ONLY an explicit `amicode.defaultModel` pins (see
   *  extension.ts's boot/restart pins) — we never guess a model.
   *
   *  This is the SESSION-level half of the model handoff. The COMPOSER-level
   *  half — carrying the user's live in-chat selection onto the command, via
   *  `extractReportBugModel` in chat_bridge.ts — is deliberately not wired
   *  here; it crosses the iframe boundary and is tracked separately. */
  defaultModel?(): string | undefined;
}

/** The bridge sink the chat/deck panels wire into their BridgeIo — the two
 *  up-kinds, shape-validated by the bridge before they reach here. */
export interface BugReportBridgeSink {
  filed(sessionID: string, url: string): void;
  closed(sessionID: string): void;
  poke(): void;
}

export class BugReportManager {
  /** The one live bug session (single-open invariant). Cleared BEFORE the
   *  terminal call on both lifecycle paths, so a late/duplicate message for
   *  the same id reads as unknown and is dropped. */
  private current?: string;
  /** In-flight create+arm — concurrent invocations join it, never double-create. */
  private opening?: Promise<void>;

  constructor(private readonly deps: BugReportDeps) {}

  /** Stable sink object for BridgeIo wiring. */
  readonly sink: BugReportBridgeSink = {
    filed: (sessionID, url) => void this.onBugFiled(sessionID, url),
    closed: (sessionID) => void this.onBugReportClosed(sessionID),
    poke: () => void this.onPoke(),
  };

  /** The app's boot catch-up: it pokes on every boot with the flag on, so a
   *  lost open-bug-report (cold-boot race, webview reload) self-heals — a live
   *  bug session re-posts its open; no live session is silence (cheap, once
   *  per app frame boot). A poke during an in-flight create joins it, exactly
   *  like a second command invocation. */
  private async onPoke(): Promise<void> {
    if (this.opening) await this.opening;
    if (!this.current) {
      this.deps.log?.(`[bug] poke — no live bug session`);
      return;
    }
    this.deps.log?.(`[bug] poke — re-opening the dock for ${this.current}`);
    this.deps.postDown({ source: "amicode", kind: OPEN_BUG_REPORT_KIND, sessionID: this.current });
  }

  /** The `amicode.reportBug` command: reveal the open bug session, else
   *  create + arm + open a new one. Never two bug sessions. */
  async reportBug(): Promise<void> {
    if (this.current) {
      // Verify before revealing (amicode#249 QA): a session closed while the
      // bridge was down (disposed webview, dead window) leaves `current`
      // pinned to a ghost — every later click would reveal nothing and never
      // create. A dead memory clears itself here.
      const server = this.deps.server();
      const alive = server ? await this.sessionExists(server, this.current) : true;
      if (alive) {
        this.deps.postDown({ source: "amicode", kind: OPEN_BUG_REPORT_KIND, sessionID: this.current });
        return;
      }
      this.deps.log?.(`[bug] remembered session ${this.current} is gone — clearing`);
      this.current = undefined;
    }
    if (this.opening) {
      // A concurrent invocation joins the in-flight open, then reveals.
      await this.opening;
      if (this.current) {
        this.deps.postDown({ source: "amicode", kind: OPEN_BUG_REPORT_KIND, sessionID: this.current });
      }
      return;
    }
    this.opening = this.open();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  /** Cheap liveness probe for the reveal path (read-only, 404-tolerant). */
  private async sessionExists(server: BugReportServer, sessionID: string): Promise<boolean> {
    try {
      const res = await this.fetch(new URL(`/session/${sessionID}`, server.url), server, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Pre-flight: does the server's command set include `name`?
   *  Fail-open: a network error returns true (let the arm path handle it). */
  private async serverHasCommand(server: BugReportServer, name: string): Promise<boolean> {
    try {
      const res = await this.fetch(new URL("/command", server.url), server, { method: "GET" });
      if (!res.ok) return true; // optimistic on probe failure — fall through to arm
      const commands = (await res.json()) as { name?: string }[];
      if (!Array.isArray(commands)) return true;
      return commands.some((c) => c.name === name);
    } catch {
      return true; // network failure: let the arm path handle it
    }
  }

  // -------- internal --------

  private async open(): Promise<void> {
    const server = this.deps.server();
    if (!server) {
      this.deps.showError(
        "Amicode: opencode server isn't ready yet. Check the 'Amicode — opencode' output channel.",
      );
      return;
    }
    // Pre-flight: verify the server's staged skills include report-a-bug.
    // The arm step POSTs against the SERVER's command set, not the
    // extension's skill paths — a stale server (launchd canonical instance
    // that predates the skill) fails silently. Fail-open: a probe failure
    // (network, server busy) falls through to the existing arm-failure path.
    if (!(await this.serverHasCommand(server, REPORT_A_BUG_SKILL))) {
      this.deps.showError(
        "Amicode: the opencode server's staged skills are stale (missing report-a-bug). " +
        "Restart or re-stage the server.",
      );
      return;
    }
    // Context envelope (pointer-only): assembled BEFORE create so the new bug
    // session can never be picked as its own origin. Each field degrades to
    // absent rather than failing the report.
    const envelope = await this.buildEnvelope(server);
    let sessionID: string | undefined;
    try {
      sessionID = await this.createSession(server, envelope);
      await this.armSession(server, sessionID);
    } catch (e) {
      // No orphans: a created-but-unarmed (or ambiguous) session is deleted.
      if (sessionID) await this.deleteSession(server, sessionID);
      this.deps.showError(`Amicode: couldn't start the bug report — ${(e as Error).message}`);
      return;
    }
    this.current = sessionID;
    this.deps.log?.(`[bug] opened ${sessionID} — posting open-bug-report`);
    this.deps.postDown({ source: "amicode", kind: OPEN_BUG_REPORT_KIND, sessionID });
  }

  private async buildEnvelope(server: BugReportServer): Promise<Record<string, string>> {
    const envelope: Record<string, string> = {};
    const dir = this.deps.workspaceDir();
    if (dir) envelope.project = path.basename(dir);
    const runPointer = this.deps.activeRunPointer();
    if (runPointer && !path.isAbsolute(runPointer)) envelope.run_pointer = runPointer;
    const origin = await this.findOriginSession(server);
    if (origin) envelope.origin_session_id = origin;
    return envelope;
  }

  /** Session-collection URL scoped to the app's project (the VS Code workspace
   *  folder) — without it the server defaults to its OWN cwd scope, where the
   *  user's sessions don't live. Member routes (/session/:id/…) need no scope:
   *  the server routes those by the session's own directory. */
  private collectionUrl(server: BugReportServer): URL {
    const url = new URL("/session", server.url);
    const dir = this.deps.workspaceDir();
    if (dir) url.searchParams.set("directory", dir);
    return url;
  }

  /** The originating session, best-effort: the most recently updated root
   *  session in the app's project scope that isn't itself a bug session (the
   *  list is updated-DESC and excludes archived). READ-ONLY provenance — this
   *  id is never a mutation target (AC6). undefined when unknowable. */
  private async findOriginSession(server: BugReportServer): Promise<string | undefined> {
    try {
      const res = await this.fetch(this.collectionUrl(server), server, { method: "GET" });
      if (!res.ok) return undefined;
      const sessions = (await res.json()) as Array<{
        id?: unknown;
        parentID?: unknown;
        metadata?: unknown;
      }>;
      if (!Array.isArray(sessions)) return undefined;
      const origin = sessions.find(
        (s) =>
          typeof s?.id === "string" &&
          !s.parentID &&
          !(s.metadata && typeof s.metadata === "object" && "bug_report" in s.metadata),
      );
      return origin?.id as string | undefined;
    } catch {
      return undefined; // best-effort: a failed list never blocks the report
    }
  }

  private async createSession(server: BugReportServer, envelope: Record<string, string>): Promise<string> {
    const res = await this.fetch(this.collectionUrl(server), server, {
      method: "POST",
      body: {
        title: BUG_REPORT_TITLE,
        metadata: { bug_report: envelope },
        // Hard guardrail: the question tool is hidden from the model for
        // bug sessions (amicode#249). The bug dock handles dialogue via the
        // permanent textarea + session.prompt, not the question tool's
        // structured Q&A. Same pattern as the CLI's non-interactive mode.
        permission: [{ permission: "question", pattern: "*", action: "deny" }],
      },
    });
    const body = res.ok ? ((await res.json()) as { id?: unknown }) : undefined;
    if (!body || typeof body.id !== "string" || body.id === "") {
      throw new Error(`session create failed (HTTP ${res.status})`);
    }
    return body.id;
  }

  /** Arm: the report-a-bug slash command as the session's first turn.
   *
   *  `model` is optional on POST /session/:id/command (a `provider/model`
   *  string; the route also takes `variant`). We send it only when
   *  `amicode.defaultModel` is explicitly set — otherwise the field is omitted
   *  entirely and the server resolves its own default, which is the documented
   *  behaviour for an unpinned install. */
  private async armSession(server: BugReportServer, sessionID: string): Promise<void> {
    const model = this.deps.defaultModel?.()?.trim();
    const res = await this.fetch(new URL(`/session/${sessionID}/command`, server.url), server, {
      method: "POST",
      body: { command: REPORT_A_BUG_SKILL, arguments: "", ...(model ? { model } : {}) },
    });
    if (!res.ok) throw new Error(`couldn't arm the report-a-bug skill (HTTP ${res.status})`);
  }

  /** Filed → archive (the soft hide, restorable) and close the dock. Unknown
   *  ids — including a late bug-filed for an already-terminal session — drop. */
  private async onBugFiled(sessionID: string, url: string): Promise<void> {
    if (sessionID !== this.current) return;
    this.current = undefined; // terminal latch: later messages for this id are unknown
    // The url rides the log only; it is app-supplied (LLM-adjacent) — bound it.
    this.deps.log?.(`[bug] filed (${url.slice(0, 300)}) — archiving ${sessionID}`);
    const server = this.deps.server();
    if (server) {
      try {
        const res = await this.fetch(new URL(`/session/${sessionID}`, server.url), server, {
          method: "PATCH",
          body: { time: { archived: Date.now() } },
        });
        if (!res.ok) this.deps.log?.(`[bug] archive failed (HTTP ${res.status}) — closing the dock anyway`);
      } catch (e) {
        this.deps.log?.(`[bug] archive failed (${(e as Error).message}) — closing the dock anyway`);
      }
    }
    this.deps.postDown({ source: "amicode", kind: CLOSE_BUG_REPORT_KIND, sessionID });
  }

  /** Closed before filing → abort the in-flight turn, then hard delete. */
  private async onBugReportClosed(sessionID: string): Promise<void> {
    // Join a concurrent open (amicode#249 QA): the dock's sync watch can
    // open the dock before arm completes, and a close arriving in that
    // window races open() — this.current is still undefined, the zombie
    // guard would reap the in-flight session as an orphan, and open()
    // finishes on a deleted session ("opening" + "reaping" in the logs).
    // Joining the open first means close always sees the post-open state.
    if (this.opening) await this.opening;
    if (sessionID !== this.current) {
      // Zombie guard (QA: amicode#249 preview): the dock's sync watch can
      // surface a bug session ORPHANED by a dead extension host (killed
      // mid-session — its manager state died with it). If the user closes
      // that dock, dropping the message as "unknown id" would leave an
      // immortal session the watch keeps resurrecting. The envelope is the
      // ground truth: a session carrying bug_report metadata IS a bug
      // session, so the abandon path applies — abort + hard delete.
      await this.reapOrphan(sessionID);
      return;
    }
    this.current = undefined;
    const server = this.deps.server();
    if (!server) return;
    // Abort is best-effort (an idle session may 400 — nothing to abort); the
    // hard delete is the guarantee.
    try {
      await this.fetch(new URL(`/session/${sessionID}/abort`, server.url), server, { method: "POST" });
    } catch (e) {
      this.deps.log?.(`[bug] abort failed (${(e as Error).message}) — deleting anyway`);
    }
    await this.deleteSession(server, sessionID);
  }

  /** Close-of-unknown-id: reaps the session iff it proves to be a bug
   *  session (bug_report metadata) that is NOT archived — an archived one is
   *  filed and restorable, never a delete target. Genuinely foreign ids drop
   *  silently. */
  private async reapOrphan(sessionID: string): Promise<void> {
    const server = this.deps.server();
    if (!server) return;
    let isBug = false;
    try {
      const res = await this.fetch(new URL(`/session/${sessionID}`, server.url), server, { method: "GET" });
      if (res.ok) {
        const info = (await res.json()) as { metadata?: unknown; time?: { archived?: unknown } };
        isBug =
          !!info.metadata &&
          typeof info.metadata === "object" &&
          "bug_report" in info.metadata &&
          !info.time?.archived;
      }
    } catch {
      return; // a read failure never guesses at deletion
    }
    if (!isBug) return;
    this.deps.log?.(`[bug] reaping orphaned bug session ${sessionID}`);
    try {
      await this.fetch(new URL(`/session/${sessionID}/abort`, server.url), server, { method: "POST" });
    } catch {
      /* an idle orphan may have nothing to abort */
    }
    await this.deleteSession(server, sessionID);
  }

  private async deleteSession(server: BugReportServer, sessionID: string): Promise<void> {
    try {
      const res = await this.fetch(new URL(`/session/${sessionID}`, server.url), server, { method: "DELETE" });
      if (!res.ok) this.deps.log?.(`[bug] delete ${sessionID} failed (HTTP ${res.status})`);
    } catch (e) {
      this.deps.log?.(`[bug] delete ${sessionID} failed (${(e as Error).message})`);
    }
  }

  private fetch(url: URL, server: BugReportServer, init: { method: string; body?: unknown }): Promise<Response> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    return fetchImpl(url.toString(), {
      method: init.method,
      headers: {
        Authorization: server.authorization,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }
}

// -------- module singleton (per-window; the extension host IS the window) --------

let active: BugReportManager | undefined;

/** Register the window's manager (extension activation). Returns it for the
 *  command wiring. */
export function registerBugReport(deps: BugReportDeps): BugReportManager {
  active = new BugReportManager(deps);
  return active;
}

export function getBugReport(): BugReportManager | undefined {
  return active;
}

export function unregisterBugReport(): void {
  active = undefined;
}

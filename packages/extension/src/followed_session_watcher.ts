// ============================================================================
// FOLLOWED SESSION WATCHER (#1788, S3 of #1785) — passive notifications on
// FOLLOWED sessions: a session this client has OPENED or PINNED (a live chat
// tab showing it — no new follow-management surface in this slice). The
// extension host's existing SSE connection (sseClient) already sees every
// hub event; the watcher is the sink that finally tells a human. The panel
// taps you; you stop watching the panel.
//
// Observe-only by contract: the watcher consumes PARSED events handed to it
// and never touches the stream, its cursor handling, or the connection
// lifecycle. Dependency-injected (no direct vscode import — the neighbor
// pattern from amicode_service/remote_activity_notifier.ts) so the POLICY —
// who, when, how often — is testable under vitest without the VS Code host.
// ============================================================================
import type { OpencodeStreamEvent } from "./sse_client";

export interface FollowedSessionWatcherDeps {
  /** The follow set — session ids this client has opened or pinned, derived
   *  live at each arrival (a chat tab showing the session IS the follow). */
  followedSessions: () => ReadonlySet<string>;
  /** True when a VISIBLE live panel shows this session — "you're already
   *  there"; the arrival is observed but never notified. #1948: visibility,
   *  not focus — a panel on screen while focus sits in another editor group,
   *  the terminal, or a sidebar is still being watched. The watcher also asks
   *  this of every cached ANCESTOR of the arriving session, so a subagent's
   *  question under a visible parent is equally silent. */
  isSessionVisible: (sessionID: string) => boolean;
  /** vscode.window.showInformationMessage — injected for testability. */
  showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
  /** Fired when the user activates a notification's action — the wiring
   *  focuses the panel on that session. */
  onFocusSession: (sessionID: string) => void;
  /** Injectable clock for the turn-bracket and flash window. Default: Date.now. */
  now?: () => number;
  /** A turn that ends within this window of its busy frame reads as a flash —
   *  not a completion worth a ping. Default: FINISHED_MIN_TURN_MS. */
  minTurnMs?: number;
  /** Diagnostic sink (the extension's output channel). */
  log?: (line: string) => void;
}

/** The flash window: turns shorter than this do not raise a "finished"
 *  notification (no flash spam from aborted or instantly-failing turns —
 *  and a reconnect replay's compressed busy→idle bracket reads the same
 *  way, so a replayed turn never re-notifies). */
export const FINISHED_MIN_TURN_MS = 30_000;

/** A plain, non-array object (the wire payloads the watcher validates). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The session's display name for a notification — the stream-taught title,
 *  else the raw session id (honest, never invented). */
function sessionName(titles: ReadonlyMap<string, string>, sessionID: string): string {
  return titles.get(sessionID) ?? sessionID;
}

export class FollowedSessionWatcher {
  /** Question request ids ever OBSERVED (dedupe keys on the request id, never
   *  the arrival: the stream replays its gap on reconnect (#1264), and the
   *  same question.asked must not re-notify — only the FIRST arrival of a
   *  request id is ever eligible to notify). */
  private readonly seenQuestions = new Set<string>();
  /** sessionID → when its busy status frame arrived (the turn bracket). */
  private readonly busySince = new Map<string, number>();
  /** sessionID → max status seq seen (#1636): stale/replayed status frames
   *  are dropped exactly as the app's #1637 guard drops them. */
  private readonly statusSeq = new Map<string, number>();
  /** sessionID → title, learned from the stream's session.created/updated. */
  private readonly titles = new Map<string, string>();
  /** #1948: sessionID → parentID, learned from the same session.created/
   *  updated frames (Session.Info carries parentID; question.asked does NOT —
   *  its payload is id/sessionID/questions/tool only). A session whose
   *  creation the stream never showed has no cached parent, so suppression
   *  falls back to the direct match. */
  private readonly parents = new Map<string, string>();
  private disposed = false;

  constructor(private readonly deps: FollowedSessionWatcherDeps) {}

  /** Observe one parsed stream event. Never throws, never mutates anything
   *  upstream — a passive sink on the sseClient's dispatch path. */
  observe(event: OpencodeStreamEvent): void {
    if (this.disposed) return;
    const props = event.properties ?? {};
    switch (event.type) {
      case "question.asked":
        this.onQuestionAsked(props);
        return;
      case "session.status":
        this.onStatus(props);
        return;
      case "session.created":
      case "session.updated": {
        // Title + parent learning only — the notification needs the session's
        // name, and the suppression needs its ancestry (#1948).
        if (isRecord(props.info) && typeof props.info.id === "string") {
          if (typeof props.info.title === "string") this.titles.set(props.info.id, props.info.title);
          if (typeof props.info.parentID === "string" && props.info.parentID !== "") {
            this.parents.set(props.info.id, props.info.parentID);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.seenQuestions.clear();
    this.busySince.clear();
    this.statusSeq.clear();
    this.titles.clear();
    this.parents.clear();
  }

  /** #1948: "you're already there" — the session itself, or any cached
   *  ancestor of it, is shown by a visible panel. Cycle-safe. */
  private isViewed(sessionID: string): boolean {
    const seen = new Set<string>();
    for (let id: string | undefined = sessionID; id !== undefined && !seen.has(id); id = this.parents.get(id)) {
      seen.add(id);
      if (this.deps.isSessionVisible(id)) return true;
    }
    return false;
  }

  /** The turn bracket: a busy frame starts it, an idle frame ends it. The
   *  #1636 seq is honored locally exactly as the app's #1637 guard honors it,
   *  so a replayed/reordered status is a no-op. A turn that ends inside the
   *  flash window of its busy frame never notifies (no flash spam — and a
   *  reconnect replay's compressed bracket reads the same way); an idle with
   *  no observed busy cannot be measured and stays silent. */
  private onStatus(props: Record<string, unknown>): void {
    const sessionID = typeof props.sessionID === "string" ? props.sessionID : "";
    const status = isRecord(props.status) ? props.status : undefined;
    if (sessionID === "" || !status) return;
    const seq = typeof props.seq === "number" ? props.seq : undefined;
    if (seq !== undefined) {
      const seen = this.statusSeq.get(sessionID);
      if (seen !== undefined && seq <= seen) return;
      this.statusSeq.set(sessionID, seq);
    }
    const type = typeof status.type === "string" ? status.type : "idle";
    if (type === "busy") {
      this.busySince.set(sessionID, (this.deps.now ?? Date.now)());
      return;
    }
    if (type !== "idle") return; // retry — the turn is still in flight
    const startedAt = this.busySince.get(sessionID);
    this.busySince.delete(sessionID);
    if (startedAt === undefined) return;
    const turnMs = (this.deps.now ?? Date.now)() - startedAt;
    if (turnMs < (this.deps.minTurnMs ?? FINISHED_MIN_TURN_MS)) return;
    if (!this.deps.followedSessions().has(sessionID)) return;
    if (this.isViewed(sessionID)) return;
    this.deps.log?.(`[notify] turn finished on followed session ${sessionID}`);
    this.raise(sessionID, "finished its turn");
  }

  private onQuestionAsked(props: Record<string, unknown>): void {
    const requestID = typeof props.id === "string" ? props.id : "";
    const sessionID = typeof props.sessionID === "string" ? props.sessionID : "";
    if (requestID === "" || sessionID === "") return;
    if (this.seenQuestions.has(requestID)) return; // replayed — never re-notify
    this.seenQuestions.add(requestID);
    if (!this.deps.followedSessions().has(sessionID)) return;
    if (this.isViewed(sessionID)) return; // you're already there (#1948)
    const header =
      Array.isArray(props.questions) && isRecord(props.questions[0]) && typeof props.questions[0].header === "string"
        ? props.questions[0].header
        : "a question";
    this.deps.log?.(`[notify] question ${requestID} on followed session ${sessionID}`);
    this.raise(sessionID, `is waiting on a question — ${header}`);
  }

  /** Raise one native notification for the session; its action focuses the
   *  panel on that session. */
  private raise(sessionID: string, detail: string): void {
    const name = sessionName(this.titles, sessionID);
    void Promise.resolve(this.deps.showInformationMessage(`Amico: session "${name}" ${detail}`, "View")).then(
      (action) => {
        if (action === "View") this.deps.onFocusSession(sessionID);
      },
    );
  }
}

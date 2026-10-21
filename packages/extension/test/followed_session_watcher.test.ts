// followed_session_watcher.test.ts — #1788 (S3 of #1785): passive
// notifications on FOLLOWED sessions (a session this client has opened or
// pinned). The watcher is a pure observer over the sseClient's parsed stream
// events with every effect injected (no vscode import — the neighbor pattern
// from remote_activity_notifier.ts), so the POLICY — who, when, how often —
// is the tested surface, never the OS toast.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FollowedSessionWatcher,
  type FollowedSessionWatcherDeps,
} from "../src/followed_session_watcher";

// The stream's parsed event shape (sse_client.ts): `data: {"type":..., "properties":{...}}`.

function makeDeps(overrides?: Partial<FollowedSessionWatcherDeps>): FollowedSessionWatcherDeps {
  return {
    followedSessions: () => new Set(["ses_followed"]),
    isSessionFocused: () => false,
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    onFocusSession: vi.fn(),
    now: () => 0,
    minTurnMs: 30_000,
    ...overrides,
  };
}

/** A question.asked frame, wire-shaped (properties = the QuestionRequest). */
function questionAsked(requestID: string, sessionID: string, header = "Which solver?") {
  return {
    type: "question.asked",
    properties: { id: requestID, sessionID, questions: [{ question: "Pick one.", header, options: [{ label: "A" }, { label: "B" }] }] },
  };
}

/** The session-info frame that teaches the watcher the session's name. */
function sessionUpdated(sessionID: string, title: string) {
  return { type: "session.updated", properties: { info: { id: sessionID, title } } };
}

/** A #1636-wire-shaped status frame. */
function sessionStatus(sessionID: string, type: "busy" | "idle" | "retry", seq: number) {
  return { type: "session.status", properties: { sessionID, status: { type }, seq } };
}

describe("#1788 — followed session watcher (notification policy)", () => {
  let deps: FollowedSessionWatcherDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("AC1 — question.asked on a followed, unfocused session notifies with the session name and question header; activating it focuses the panel", async () => {
    (deps.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue("View");
    const watcher = new FollowedSessionWatcher(deps);
    watcher.observe(sessionUpdated("ses_followed", "Fix the flaky e2e"));

    watcher.observe(questionAsked("req_1", "ses_followed", "Which solver?"));

    expect(deps.showInformationMessage).toHaveBeenCalledOnce();
    const [msg, action] = (deps.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    // The session NAME and the question HEADER ride the notification (AC1).
    expect(msg).toContain("Fix the flaky e2e");
    expect(msg).toContain("Which solver?");
    expect(action).toBe("View");

    // Activating the notification focuses the panel on that session.
    await vi.waitFor(() => expect(deps.onFocusSession).toHaveBeenCalledWith("ses_followed"));
  });

  it("AC2 — a turn-idle on a followed session that was busy raises a finished notification; a turn ending inside the flash window does not", async () => {
    let clock = 10_000;
    deps = makeDeps({ now: () => clock });
    (deps.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue("View");
    const watcher = new FollowedSessionWatcher(deps);
    watcher.observe(sessionUpdated("ses_followed", "Long turn"));

    // A LONG turn: busy at t=10s, idle at t=10s + 45s — past the flash window.
    watcher.observe(sessionStatus("ses_followed", "busy", 1));
    clock += 45_000;
    watcher.observe(sessionStatus("ses_followed", "idle", 2));

    expect(deps.showInformationMessage).toHaveBeenCalledOnce();
    const [msg, action] = (deps.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain("Long turn");
    expect(msg).toContain("finished");
    expect(action).toBe("View");
    await vi.waitFor(() => expect(deps.onFocusSession).toHaveBeenCalledWith("ses_followed"));

    // A SHORT turn (a flash): busy at t, idle 5s later — inside the 30s
    // window — must not notify.
    watcher.observe(sessionStatus("ses_followed", "busy", 3));
    clock += 5_000;
    watcher.observe(sessionStatus("ses_followed", "idle", 4));
    expect(deps.showInformationMessage).toHaveBeenCalledOnce(); // still just the long turn

    // An idle with NO observed busy (the watcher attached mid-turn) cannot
    // measure the turn and stays silent — never a guess.
    watcher.observe(sessionStatus("ses_followed", "idle", 5));
    expect(deps.showInformationMessage).toHaveBeenCalledOnce();
  });

  it("AC3 — the same question never notifies twice: a replayed question.asked (reconnect gap replay) is deduped by request id, and a genuinely new question still notifies", () => {
    const watcher = new FollowedSessionWatcher(deps);

    watcher.observe(questionAsked("req_1", "ses_followed"));
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);

    // The stream replays its cursor gap on reconnect (#1264) — the SAME
    // question.asked arrives again. The dedupe keys on the REQUEST id, never
    // the arrival, so the replay passes silently.
    watcher.observe(questionAsked("req_1", "ses_followed"));
    watcher.observe(questionAsked("req_1", "ses_followed"));
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);

    // A different question (a new request id) is a new arrival — it notifies.
    watcher.observe(questionAsked("req_2", "ses_followed"));
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it("AC4 — notifications only fire for followed sessions; an unfollowed session's events pass silently", () => {
    let clock = 10_000;
    deps = makeDeps({ now: () => clock });
    const watcher = new FollowedSessionWatcher(deps);

    // A question, a long busy turn, and an idle — all on a session this
    // client has NOT opened or pinned. All pass silently.
    watcher.observe(questionAsked("req_other", "ses_unfollowed"));
    watcher.observe(sessionStatus("ses_unfollowed", "busy", 1));
    clock += 60_000;
    watcher.observe(sessionStatus("ses_unfollowed", "idle", 2));
    expect(deps.showInformationMessage).not.toHaveBeenCalled();

    // The follow set is read LIVE at each arrival: the moment the client
    // opens (or pins) the session, its next events notify.
    deps.followedSessions = () => new Set(["ses_unfollowed"]);
    watcher.observe(questionAsked("req_now_followed", "ses_unfollowed"));
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("AC5 — no notification when the panel has that session open and focused (you're already there) — and the arrival is still deduped", () => {
    deps = makeDeps({ isSessionFocused: (id) => id === "ses_followed" });
    const watcher = new FollowedSessionWatcher(deps);

    // You're watching the session when the question lands — no ping.
    watcher.observe(questionAsked("req_watched", "ses_followed"));
    expect(deps.showInformationMessage).not.toHaveBeenCalled();

    // The arrival was still OBSERVED and deduped by request id: the replay
    // after you navigate away (reconnect gap replay) never re-notifies for
    // a question you were there to see.
    deps.isSessionFocused = () => false;
    watcher.observe(questionAsked("req_watched", "ses_followed"));
    expect(deps.showInformationMessage).not.toHaveBeenCalled();

    // A finished LONG turn while focused is equally silent.
    deps.isSessionFocused = () => true;
    let clock = 10_000;
    deps.now = () => clock;
    watcher.observe(sessionStatus("ses_followed", "busy", 1));
    clock += 60_000;
    watcher.observe(sessionStatus("ses_followed", "idle", 2));
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
  });

  it("replayed statuses are order-safe (#1636/#1637 lineage): a stale replayed idle must not kill a live turn bracket", () => {
    let clock = 10_000;
    deps = makeDeps({ now: () => clock });
    const watcher = new FollowedSessionWatcher(deps);

    // A real busy frame opens the turn bracket…
    watcher.observe(sessionStatus("ses_followed", "busy", 1));
    // …and a REPLAYED idle carrying the SAME (stale) seq arrives mid-turn
    // (reconnect gap replay). The local seq guard drops it, so the bracket
    // survives and the REAL idle still notifies.
    clock += 5_000;
    watcher.observe(sessionStatus("ses_followed", "idle", 1));
    clock += 60_000;
    watcher.observe(sessionStatus("ses_followed", "idle", 2));
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("a session whose title was never observed falls back to its raw id in the notification", () => {
    const watcher = new FollowedSessionWatcher(deps);
    watcher.observe(questionAsked("req_untitled", "ses_followed"));
    const [msg] = (deps.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain("ses_followed");
  });

  it("activation wiring — EVERY sseClient construction rides the watcher on the existing stream, and the watcher reads ChatPanel's live follow set", () => {
    // Source-level wiring assertion (the chat_panel relay-test precedent):
    // the extension holds ONE sseClient per posture branch (hub, fleet,
    // local, adopted) — each must pass the watcher as its observe-only
    // onEvent sink, so no posture can silently lose notifications.
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "..", "src", "extension.ts"),
      "utf8",
    );
    const sites = source.match(/new OpencodeEventClient\(\{[^}]*\}\)/gs) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(4);
    for (const site of sites) expect(site).toContain("onEvent:");
    // The watcher is built once from ChatPanel's live follow state and its
    // activation focuses the panel on the session.
    expect(source).toContain("ChatPanel.followedSessionIds()");
    expect(source).toContain("ChatPanel.focusedSessionId()");
    expect(source).toContain("ChatPanel.revealSession");
  });
});

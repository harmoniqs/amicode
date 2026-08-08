import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { BugReportManager, bugReportSkillStaged, type BugReportDeps } from "../src/bug_report";

// ============================================================================
// amicode#250 — the extension owns the bug session end-to-end: create (title
// "Bug report" + the context-envelope metadata), arm (the report-a-bug slash
// command), open (open-bug-report down the bridge), and the machine-managed
// lifecycle (archive on filed, abort+delete on abandon, delete on partial
// failure). The server API is mocked at the fetch seam (cloud_key precedent).
// ============================================================================

const SERVER_URL = "http://127.0.0.1:43117/";
const BOOT_AUTH = "Basic b3BlbmNvZGU6dGVzdC1ib290LXBhc3N3b3Jk";

type Call = { method: string; url: string; body?: unknown };

/** Fetch stub routing per (method, path-prefix); records every call. */
function mockFetch(routes: Record<string, { status?: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  // The pre-flight GET /command must always succeed for open() to proceed.
  const defaultRoutes: Record<string, { status?: number; body?: unknown }> = {
    "GET /command": { status: 200, body: [{ name: "report-a-bug" }] },
    ...routes,
  };
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    const path = new URL(url).pathname;
    const route = defaultRoutes[`${method} ${path}`];
    const status = route?.status ?? 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(overrides: Partial<BugReportDeps>, fetchImpl: typeof fetch) {
  const posted: unknown[] = [];
  const errors: string[] = [];
  const d: BugReportDeps = {
    server: () => ({ url: SERVER_URL, authorization: BOOT_AUTH }),
    workspaceDir: () => "/home/researcher/emerald-q3",
    activeRunPointer: () => undefined,
    postDown: (m) => posted.push(m),
    showError: (m) => errors.push(m),
    fetchImpl,
    defaultModel: () => "opencode/deepseek-v4-pro",
    ...overrides,
  };
  return { d, posted, errors };
}

describe("amicode.reportBug — create, arm, open (AC1)", () => {
  it("creates exactly one session with the title + metadata envelope, arms it, and sends one open-bug-report", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [{ id: "ses_origin", time: { created: 1, updated: 2 } }] },
      "POST /session": { status: 200, body: { id: "ses_bug1" } },
      "POST /session/ses_bug1/command": { status: 200, body: {} },
    });
    const { d, posted } = deps({ activeRunPointer: () => "default/20260803-104655-x-gate" }, fetchImpl);

    await new BugReportManager(d).reportBug();

    const creates = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session");
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toEqual({
      title: "Bug report",
      metadata: {
        bug_report: {
          project: "emerald-q3",
          run_pointer: "default/20260803-104655-x-gate",
          origin_session_id: "ses_origin",
        },
      },
      // The question tool is denied for bug sessions (ADR-0004): the dock owns
      // dialogue via its textarea + session.prompt, not the question tool's
      // structured Q&A. Production has sent this since #251; the assertion
      // simply had not caught up.
      permission: [{ permission: "question", pattern: "*", action: "deny" }],
    });
    const arm = calls.filter((c) => c.url.endsWith("/session/ses_bug1/command"));
    expect(arm).toHaveLength(1);
    // No model field: the arm rides the server's configured default model —
    // a hardcoded model was deliberately removed (amicode#249 follow-up).
    expect(arm[0].body).toEqual({ command: "report-a-bug", arguments: "" });
    expect(posted).toEqual([{ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug1" }]);
  });

  it("omits model entirely when amicode.defaultModel is unset — the server resolves its own", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 200, body: { id: "ses_bug_nm" } },
      "POST /session/ses_bug_nm/command": { status: 200, body: {} },
    });
    const { d } = deps({ defaultModel: () => undefined }, fetchImpl);

    await new BugReportManager(d).reportBug();

    const arm = calls.filter((c) => c.url.endsWith("/session/ses_bug_nm/command"));
    expect(arm).toHaveLength(1);
    // Omitted, not sent as empty/null: `model` is optional on the route, and an
    // empty string would pin the session to a nonexistent model.
    expect(arm[0].body).toEqual({ command: "report-a-bug", arguments: "" });
  });

  it("treats a whitespace-only defaultModel as unset", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 200, body: { id: "ses_bug_ws" } },
      "POST /session/ses_bug_ws/command": { status: 200, body: {} },
    });
    const { d } = deps({ defaultModel: () => "   " }, fetchImpl);

    await new BugReportManager(d).reportBug();

    const arm = calls.filter((c) => c.url.endsWith("/session/ses_bug_ws/command"));
    expect(arm[0].body).toEqual({ command: "report-a-bug", arguments: "" });
  });

  it("omits run_pointer when no run is active, and never sends an absolute path", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 200, body: { id: "ses_bug2" } },
      "POST /session/ses_bug2/command": { status: 200, body: {} },
    });
    const { d } = deps({ activeRunPointer: () => undefined }, fetchImpl);

    await new BugReportManager(d).reportBug();

    const create = calls.find((c) => c.method === "POST" && new URL(c.url).pathname === "/session");
    const meta = (create?.body as { metadata: { bug_report: Record<string, unknown> } }).metadata.bug_report;
    expect("run_pointer" in meta).toBe(false);
    expect(String(meta.run_pointer ?? "")).not.toMatch(/^\//);
  });

  it("authenticates every server call with the per-boot credential (#163)", async () => {
    const authed: Array<string | undefined> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      authed.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      const path = new URL(String(input)).pathname;
      let body: unknown = {};
      if (path === "/command" && (init?.method ?? "GET") === "GET") body = [{ name: "report-a-bug" }];
      else if (path === "/session" && init?.method === "POST") body = { id: "ses_bug3" };
      else if (path === "/session") body = [];
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    const { d } = deps({}, fetchImpl);

    await new BugReportManager(d).reportBug();

    expect(authed.length).toBeGreaterThan(0);
    expect(new Set(authed)).toEqual(new Set([BOOT_AUTH]));
  });

  it("pre-flights the arm: shows an actionable error when GET /command lacks report-a-bug (#296)", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /command": { status: 200, body: [{ name: "other-skill" }] },
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 200, body: { id: "ses_bug" } },
      "POST /session/ses_bug/command": { status: 200, body: {} },
    });
    const { d, posted, errors } = deps({}, fetchImpl);
    const manager = new BugReportManager(d);

    await manager.reportBug();

    // No session was created — the pre-flight blocked it.
    expect(calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session")).toHaveLength(0);
    expect(posted).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("staged skills are stale");
  });

  it("pre-flight is fail-open: a network error on GET /command does NOT block the button (#296)", async () => {
    let commandProbed = false;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/command" && (init?.method ?? "GET") === "GET") {
        commandProbed = true;
        throw new Error("network down");
      }
      let body: unknown = {};
      if (path === "/session" && init?.method === "POST") body = { id: "ses_bug" };
      else if (path === "/session") body = [];
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    const { d, posted } = deps({}, fetchImpl);
    const manager = new BugReportManager(d);

    await manager.reportBug();

    expect(commandProbed).toBe(true);
    // Despite the probe failure, the open succeeded (fail-open).
    expect(posted).toEqual([
      { source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" },
    ]);
  });
});

/** Drive a manager to the open state with bug session `ses_bug`; returns the
 *  recorded traffic for the lifecycle assertions. */
async function openBugSession(overrides: Partial<BugReportDeps> = {}, extraRoutes: Record<string, { status?: number; body?: unknown }> = {}) {
  const { fetchImpl, calls } = mockFetch({
    "GET /session": { status: 200, body: [] },
    "GET /session/ses_bug": { status: 200, body: { id: "ses_bug" } },
    "POST /session": { status: 200, body: { id: "ses_bug" } },
    "POST /session/ses_bug/command": { status: 200, body: {} },
    "PATCH /session/ses_bug": { status: 200, body: { id: "ses_bug" } },
    "POST /session/ses_bug/abort": { status: 200, body: true },
    "DELETE /session/ses_bug": { status: 200, body: true },
    ...extraRoutes,
  });
  const { d, posted, errors } = deps(overrides, fetchImpl);
  const manager = new BugReportManager(d);
  await manager.reportBug();
  calls.length = 0;
  posted.length = 0;
  return { manager, calls, posted, errors };
}

describe("bug-session lifecycle (AC2)", () => {
  it("bug-filed for the known id archives the session (soft hide) and tells the app to close the dock", async () => {
    const { manager, calls, posted } = await openBugSession();

    manager.sink.filed("ses_bug", "https://github.com/harmoniqs/amicode/issues/251");
    await new Promise((r) => setTimeout(r, 0));

    const archive = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/session/ses_bug"));
    expect(archive).toHaveLength(1);
    const archived = (archive[0].body as { time: { archived: unknown } }).time.archived;
    expect(typeof archived).toBe("number"); // ms epoch — the soft-hide timestamp
    // No abort, no delete on the filed path — the transcript stays restorable.
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith("/abort"))).toEqual([]);
    expect(posted).toEqual([
      { source: "amicode", kind: "close-bug-report", sessionID: "ses_bug" },
    ]);
  });

  it("bug-report-closed before any filing aborts, then deletes, the session", async () => {
    const { manager, calls, posted } = await openBugSession();

    manager.sink.closed("ses_bug");
    await new Promise((r) => setTimeout(r, 0));

    const methods = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(methods).toEqual(["POST /session/ses_bug/abort", "DELETE /session/ses_bug"]);
    // Never archived on the abandon path; the dock already dismissed itself.
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe("the originating session is never modified, navigated, or closed (AC6)", () => {
  it("no path mutates the origin session — it is only ever READ (the list call) and embedded as a pointer", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": {
        status: 200,
        body: [
          { id: "ses_origin", time: { created: 1, updated: 9 } },
          { id: "ses_older", time: { created: 1, updated: 2 } },
        ],
      },
      "POST /session": { status: 200, body: { id: "ses_bug" } },
      "POST /session/ses_bug/command": { status: 200, body: {} },
      "PATCH /session/ses_bug": { status: 200, body: { id: "ses_bug" } },
      "POST /session/ses_bug/abort": { status: 200, body: true },
      "DELETE /session/ses_bug": { status: 200, body: true },
    });
    const { d, posted } = deps({}, fetchImpl);
    const manager = new BugReportManager(d);

    // Full lifecycle coverage: open → filed; open again → abandoned.
    await manager.reportBug();
    manager.sink.filed("ses_bug", "https://github.com/harmoniqs/amicode/issues/251");
    await new Promise((r) => setTimeout(r, 0));
    await manager.reportBug();
    manager.sink.closed("ses_bug");
    await new Promise((r) => setTimeout(r, 0));

    // The envelope DID carry the origin pointer (provenance works)…
    const creates = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session");
    for (const create of creates) {
      expect((create.body as { metadata: { bug_report: { origin_session_id?: string } } }).metadata.bug_report.origin_session_id).toBe(
        "ses_origin",
      );
    }
    // …but the only call that so much as NAMES a non-bug session is the
    // read-only list. Every mutation targets the bug session alone.
    const foreign = calls.filter((c) => c.url.includes("ses_origin") || c.url.includes("ses_older"));
    expect(foreign).toEqual([]);
    for (const c of calls.filter((c) => c.method !== "GET")) {
      // POST /session is the bug-session CREATE (the one session we may make);
      // every other mutation carries the bug id and nothing else.
      expect(new URL(c.url).pathname).toMatch(/^\/session(\/ses_bug(\/command|\/abort)?)?$/);
    }
    // And nothing reaches for a navigation/session-switch command — the main
    // chat continues uninterrupted while the dock lives (and dies).
    expect((vscode.commands as unknown as { executed: string[] }).executed ?? []).toEqual([]);
    // The down lane carries ONLY dock open/close for the bug session — never
    // an instruction about the origin.
    for (const m of posted) {
      expect((m as { sessionID: string }).sessionID).toBe("ses_bug");
      expect(["open-bug-report", "close-bug-report"]).toContain((m as { kind: string }).kind);
    }
  });
});

describe("bugReportSkillStaged — the boot-param gate (AC5)", () => {
  it("true iff a staged skill path belongs to report-a-bug (library or package layout)", () => {
    expect(
      bugReportSkillStaged([
        "/ext/vendor/skills-public/skills/transmon/SKILL.md",
        "/ext/vendor/skills-public/skills/report-a-bug/SKILL.md",
      ]),
    ).toBe(true);
    expect(bugReportSkillStaged(["/home/dev/harmoniqs/packages/Piccolissimo.jl/skills/report-a-bug/SKILL.md"])).toBe(true);
    expect(bugReportSkillStaged(["/ext/vendor/skills-public/skills/transmon/SKILL.md"])).toBe(false);
    expect(bugReportSkillStaged([])).toBe(false);
  });
});

describe("single-open invariant (AC3)", () => {
  it("a second invocation while a bug session is open reveals with the SAME id — never a second create", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "GET /session/ses_bug": { status: 200, body: { id: "ses_bug" } },
      "POST /session": { status: 200, body: { id: "ses_bug" } },
      "POST /session/ses_bug/command": { status: 200, body: {} },
    });
    const { d, posted } = deps({}, fetchImpl);
    const manager = new BugReportManager(d);

    await manager.reportBug();
    await manager.reportBug();
    await manager.reportBug();

    expect(calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session")).toHaveLength(1);
    expect(posted).toEqual([
      { source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" },
      { source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" },
      { source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" },
    ]);
  });

  it("concurrent invocations join the in-flight open — exactly one session created", async () => {
    let releaseCreate: (() => void) | undefined;
    const gate = new Promise<void>((r) => (releaseCreate = r));
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      calls.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST" && path === "/session") await gate; // hold the create
      let body: unknown = [];
      if (path === "/command" && (init?.method ?? "GET") === "GET") body = [{ name: "report-a-bug" }];
      else if (path === "/session" && init?.method === "POST") body = { id: "ses_bug" };
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    const { d, posted } = deps({}, fetchImpl);
    const manager = new BugReportManager(d);

    const first = manager.reportBug();
    const second = manager.reportBug();
    releaseCreate!();
    await Promise.all([first, second]);

    expect(calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session")).toHaveLength(1);
    // Both callers end at the open dock: one create-post, one reveal-post.
    expect(posted).toEqual([
      { source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" },
      { source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" },
    ]);
  });
});

describe("failure cleanup + unknown-id drops (AC4)", () => {
  it("an arming failure deletes the partial session and surfaces an error — no orphan, no open message", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 200, body: { id: "ses_bug" } },
      "POST /session/ses_bug/command": { status: 500, body: { error: "boom" } },
      "DELETE /session/ses_bug": { status: 200, body: true },
    });
    const { d, posted, errors } = deps({}, fetchImpl);

    await new BugReportManager(d).reportBug();

    expect(calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/session/ses_bug"))).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("couldn't start the bug report");
    expect(posted).toEqual([]);
  });

  it("a create failure surfaces an error and never opens; a network throw on create also notifies", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 503, body: {} },
    });
    const { d, posted, errors } = deps({}, fetchImpl);

    await new BugReportManager(d).reportBug();

    expect(errors).toHaveLength(1);
    expect(posted).toEqual([]);
    // Nothing was created — there is no id to delete, and none is attempted.
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);

    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const second = deps({}, throwing);
    await new BugReportManager(second.d).reportBug();
    expect(second.errors).toHaveLength(1);
    expect(second.posted).toEqual([]);
  });

  it("with the server down the command fails actionably and touches nothing", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const { d, posted, errors } = deps({ server: () => undefined }, fetchImpl);

    await new BugReportManager(d).reportBug();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("isn't ready");
    expect(calls).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("bridge messages for unknown session ids are dropped — no archive, no abort, no delete, no down-post", async () => {
    const { manager, calls, posted } = await openBugSession();

    manager.sink.filed("ses_someone_else", "https://github.com/x/issues/9");
    manager.sink.closed("ses_someone_else");
    await new Promise((r) => setTimeout(r, 0));

    // The zombie guard may READ an unknown closed session (metadata probe) —
    // but a 404/foreign session is never mutated, and nothing posts down.
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("a bug-report-closed arriving AFTER filing (the filed end-state's close) is already-terminal — dropped", async () => {
    const { manager, calls, posted } = await openBugSession({}, {
      // The session now reads archived (filed): the zombie guard must NOT
      // reap it — archived bug sessions are restorable, never delete targets.
      "GET /session/ses_bug": { status: 200, body: { id: "ses_bug", metadata: { bug_report: {} }, time: { archived: 1700000000000 } } },
    });

    manager.sink.filed("ses_bug", "filed-via-browser");
    await new Promise((r) => setTimeout(r, 0));
    calls.length = 0;
    posted.length = 0;

    manager.sink.closed("ses_bug"); // late close for the archived session
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.filter((c) => c.method !== "GET")).toEqual([]); // no abort, no delete — the filed session is never hard-deleted
    expect(posted).toEqual([]);
  });

  it("a duplicate bug-filed for the same id archives exactly once", async () => {
    const { manager, calls, posted } = await openBugSession();

    manager.sink.filed("ses_bug", "https://github.com/x/issues/1");
    manager.sink.filed("ses_bug", "https://github.com/x/issues/1");
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });
});

describe("bug-report-poke — the app's boot catch-up (QA: lost-open race)", () => {  it("a poke with a live bug session re-posts open-bug-report for it", async () => {
    const { manager, posted } = await openBugSession();

    manager.sink.poke();
    await new Promise((r) => setTimeout(r, 0));

    expect(posted).toEqual([{ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" }]);
  });

  it("a poke with no live bug session is silence (no posts, no server calls)", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const { d, posted } = deps({}, fetchImpl);

    new BugReportManager(d).sink.poke();
    await new Promise((r) => setTimeout(r, 0));

    expect(posted).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a poke after the session terminated is silence (the dock stays gone)", async () => {
    const { manager, posted } = await openBugSession();
    manager.sink.filed("ses_bug", "https://github.com/x/issues/1");
    await new Promise((r) => setTimeout(r, 0));
    posted.length = 0;

    manager.sink.poke();
    await new Promise((r) => setTimeout(r, 0));

    expect(posted).toEqual([]);
  });

  it("a poke during an in-flight create joins it — one create, every open for the new id", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 200, body: { id: "ses_bug" } },
      "POST /session/ses_bug/command": { status: 200, body: {} },
    });
    const { d, posted } = deps({}, fetchImpl);
    const manager = new BugReportManager(d);
    const opening = manager.reportBug(); // in flight — the poke must not double-create
    manager.sink.poke();
    await opening;
    await new Promise((r) => setTimeout(r, 0));

    const creates = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session");
    expect(creates).toHaveLength(1);
    const opens = posted.filter((m) => (m as { kind?: unknown }).kind === "open-bug-report");
    // The open from create+arm plus the poke's re-post — same id, idempotent
    // app-side (same-id open is a reveal).
    expect(opens).toHaveLength(2);
    expect(opens.every((m) => (m as { sessionID?: unknown }).sessionID === "ses_bug")).toBe(true);
  });
});

describe("zombie guard — closing an orphaned bug session (QA: amicode#249 preview)", () => {
  it("an unknown-id close reaps the session when it carries the bug_report envelope", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session/ses_orphan": { status: 200, body: { id: "ses_orphan", metadata: { bug_report: { project: "x" } } } },
      "POST /session/ses_orphan/abort": { status: 200, body: true },
      "DELETE /session/ses_orphan": { status: 200, body: true },
    });
    const { d } = deps({}, fetchImpl);

    new BugReportManager(d).sink.closed("ses_orphan");
    await new Promise((r) => setTimeout(r, 0));

    const methods = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(methods).toEqual(["GET /session/ses_orphan", "POST /session/ses_orphan/abort", "DELETE /session/ses_orphan"]);
  });

  it("an unknown-id close for a genuinely foreign session is dropped — never a delete", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session/ses_chat": { status: 200, body: { id: "ses_chat", metadata: {} } },
    });
    const { d } = deps({}, fetchImpl);

    new BugReportManager(d).sink.closed("ses_chat");
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith("/abort"))).toEqual([]);
  });
});

describe("the ghost-session guard (amicode#249 QA: closed while the bridge was down)", () => {
  it("a remembered session that 404s clears itself and creates fresh", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 200, body: { id: "ses_old" } },
      "POST /session/ses_old/command": { status: 200, body: {} },
      // ses_old is NOT registered as GET-able → 404 on the reveal probe
    });
    const { d, posted } = deps({}, fetchImpl);
    const manager = new BugReportManager(d);
    await manager.reportBug(); // opens ses_old

    posted.length = 0;
    calls.length = 0;
    // Second click: the remembered session is gone (the GET 404s) → a fresh
    // session must be created, never a reveal of the ghost.
    const { fetchImpl: f2, calls: calls2 } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "POST /session": { status: 200, body: { id: "ses_new" } },
      "POST /session/ses_new/command": { status: 200, body: {} },
    });
    (d as { fetchImpl?: typeof fetch }).fetchImpl = f2;
    await manager.reportBug();

    expect(calls2.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session")).toHaveLength(1);
    expect(posted).toEqual([{ source: "amicode", kind: "open-bug-report", sessionID: "ses_new" }]);
  });

  it("a live remembered session reveals as before (probe 200 → no create)", async () => {
    const { manager, calls, posted } = await openBugSession();

    await manager.reportBug();

    expect(posted).toEqual([{ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" }]);
    expect(calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session")).toEqual([]);
    // The liveness probe is the only new call — read-only.
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

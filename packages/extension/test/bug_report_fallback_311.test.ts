import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BugReportManager, type BugReportDeps } from "../src/bug_report";

// ============================================================================
// amicode#311 — the browser-fallback failure path. When the sentinel token
// arriving over the bridge is NOT a verifiable GitHub issue URL (the nonsense
// `issues/created_by/<N>` link, the skill's `filed-via-browser` token, or an
// empty token), the report was NOT verifiably filed: the bug session must stay
// alive and interactive, the failure must surface visibly, the report content
// must be persisted to disk and its path pointed to, and the nonsense URL must
// never be treated as a filing. The server API is mocked at the fetch seam
// (bug_report.test.ts precedent); the transcript dump lands in a real tmp dir.
// ============================================================================

const SERVER_URL = "http://127.0.0.1:43117/";
const BOOT_AUTH = "Basic b3BlbmNvZGU6dGVzdC1ib290LXBhc3N3b3Jk";

type Call = { method: string; url: string; body?: unknown };

/** Fetch stub routing per (method, path); records every call. */
function mockFetch(routes: Record<string, { status?: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
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

function deps(
  overrides: Partial<BugReportDeps>,
  fetchImpl: typeof fetch,
  saveDir: string,
): { d: BugReportDeps; posted: unknown[]; errors: string[] } {
  const posted: unknown[] = [];
  const errors: string[] = [];
  const d: BugReportDeps = {
    server: () => ({ url: SERVER_URL, authorization: BOOT_AUTH }),
    workspaceDir: () => "/home/researcher/emerald-q3",
    activeRunPointer: () => undefined,
    postDown: (m) => posted.push(m),
    showError: (m) => errors.push(m),
    reportSaveDir: () => saveDir,
    fetchImpl,
    ...overrides,
  };
  return { d, posted, errors };
}

/** Open a live bug session (the standard pre-filing state) and clear the
 *  create/open traffic so assertions see only the filed-path calls. */
async function openBugSession(
  routes: Record<string, { status?: number; body?: unknown }>,
  saveDir: string,
): Promise<{ manager: BugReportManager; calls: Call[]; posted: unknown[]; errors: string[] }> {
  const fullRoutes = {
    "GET /session": { status: 200, body: [] },
    "POST /session": { status: 200, body: { id: "ses_bug" } },
    "POST /session/ses_bug/command": { status: 200, body: {} },
    ...routes,
  };
  const { fetchImpl: routed, calls } = mockFetch(fullRoutes);
  const { d, posted, errors } = deps({}, routed, saveDir);
  const manager = new BugReportManager(d);
  await manager.reportBug();
  calls.length = 0;
  posted.length = 0;
  return { manager, calls, posted, errors };
}

/** The filed path is fire-and-forget (`void`): the promise chain runs
 *  fetch → fs write → showError. `settle` polls until the LOAD-BEARING effect
 *  lands — `showError` fires after the transcript write, so it is a completion
 *  barrier for every assertion after it (a fixed sleep flaked under
 *  full-suite parallel load; polling does not). */
function settle(fn: () => void, timeout = 5000): Promise<void> {
  return vi.waitFor(fn, { timeout, interval: 10 });
}

/** A single macrotask — enough for a synchronous-effect call like poke. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe("BUG #311: a non-verifiable filed token keeps the bug session alive", () => {
  it("the nonsense issues/created_by/<N> link is NOT a filing: no archive, no close, session stays interactive, error surfaced", async () => {
    const saveDir = await mkdtemp(join(tmpdir(), "bug311-"));
    const { manager, calls, posted, errors } = await openBugSession({}, saveDir);

    manager.sink.filed("ses_bug", "https://github.com/harmoniqs/amicode/issues/created_by/99");
    await settle(() => expect(errors).toHaveLength(1)); // completion barrier

    // No archive (the soft hide) — the session was NOT verifiably filed.
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    // No close-bug-report — the dock must not be torn down.
    expect(posted.filter((m) => (m as { kind?: string }).kind === "close-bug-report")).toEqual([]);
    // The failure surfaces visibly, and says no issue was created.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no issue was created");
    // The session stays alive: the app's boot poke still re-opens its dock.
    manager.sink.poke();
    await flush();
    expect(posted).toContainEqual({ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" });
  });

  it("the report content is persisted to disk before the failure message points at it", async () => {
    const saveDir = await mkdtemp(join(tmpdir(), "bug311-"));
    const transcript = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "The dock froze when the browser fallback failed." }],
      },
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "Composing the intake draft… nothing posted." }],
      },
    ];
    const { manager, calls, posted, errors } = await openBugSession(
      { "GET /session/ses_bug/message": { status: 200, body: transcript } },
      saveDir,
    );

    manager.sink.filed("ses_bug", "https://github.com/harmoniqs/amicode/issues/created_by/99");
    await settle(() => expect(errors).toHaveLength(1)); // completion barrier

    // The transcript was fetched read-only from the server…
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/session/ses_bug/message"))).toBe(true);
    // …and written to the staging dir as the report's durable copy.
    const saved = await readFile(join(saveDir, "ses_bug.md"), "utf8");
    expect(saved).toContain("The dock froze when the browser fallback failed.");
    expect(saved).toContain("Composing the intake draft… nothing posted.");
    // The visible error points at the REAL file — nothing silently lost.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(join(saveDir, "ses_bug.md"));
    // Still no close — the failure never tears the dock down.
    expect(posted.filter((m) => (m as { kind?: string }).kind === "close-bug-report")).toEqual([]);
  });

  it("the skill's filed-via-browser token is also unverified — the session survives until the user closes it", async () => {
    const saveDir = await mkdtemp(join(tmpdir(), "bug311-"));
    const transcript = [{ info: { role: "user" }, parts: [{ type: "text", text: "browser handoff draft" }] }];
    const { manager, calls, posted, errors } = await openBugSession(
      { "GET /session/ses_bug/message": { status: 200, body: transcript } },
      saveDir,
    );

    manager.sink.filed("ses_bug", "filed-via-browser");
    await settle(() => expect(errors).toHaveLength(1)); // completion barrier

    // Not a filing: no archive, no dock teardown.
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(posted.filter((m) => (m as { kind?: string }).kind === "close-bug-report")).toEqual([]);
    // Honest messaging: the browser may have opened, but no issue exists yet.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no issue was created");
    expect(errors[0]).toContain(join(saveDir, "ses_bug.md"));
    // The report content is on disk.
    const saved = await readFile(join(saveDir, "ses_bug.md"), "utf8");
    expect(saved).toContain("browser handoff draft");
    // And the session is still live for the poke contract.
    manager.sink.poke();
    await flush();
    expect(posted).toContainEqual({ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" });
  });
});

describe("BUG #311 guards: the verified-filing path and the degradation branches", () => {
  it("a REAL issue URL still files exactly as before — archive, close, no error, no transcript fetch", async () => {
    const saveDir = await mkdtemp(join(tmpdir(), "bug311-"));
    const { manager, calls, posted, errors } = await openBugSession(
      // If the failure path ever bled into the success path, this transcript
      // route would be hit — the guard asserts it never is.
      { "GET /session/ses_bug/message": { status: 200, body: [] } },
      saveDir,
    );

    manager.sink.filed("ses_bug", "https://github.com/harmoniqs/amicode/issues/123");
    await settle(() =>
      expect(posted).toEqual([{ source: "amicode", kind: "close-bug-report", sessionID: "ses_bug" }]),
    ); // completion barrier

    expect(calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/session/ses_bug"))).toHaveLength(1);
    expect(posted).toEqual([{ source: "amicode", kind: "close-bug-report", sessionID: "ses_bug" }]);
    expect(errors).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/session/ses_bug/message"))).toBe(false);
  });

  it("when the transcript fetch fails the session still stays alive — and no phantom path is claimed", async () => {
    const saveDir = await mkdtemp(join(tmpdir(), "bug311-"));
    const { manager, calls, posted, errors } = await openBugSession(
      { "GET /session/ses_bug/message": { status: 500, body: "boom" } },
      saveDir,
    );

    manager.sink.filed("ses_bug", "https://github.com/harmoniqs/amicode/issues/created_by/99");
    await settle(() => expect(errors).toHaveLength(1)); // completion barrier

    // Still not a filing: no archive, no close, session alive.
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(posted.filter((m) => (m as { kind?: string }).kind === "close-bug-report")).toEqual([]);
    manager.sink.poke();
    await flush();
    expect(posted).toContainEqual({ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" });
    // The error still surfaces, still honest — and points at NO file.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no issue was created");
    expect(errors[0]).not.toContain(".md");
    // Nothing was written: the staging dir (which mkdtemp created) stays empty.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(saveDir)).toEqual([]); // no phantom .md file
  });

  it("the staging dir is created on demand — the first failure must not die on a missing directory", async () => {
    const saveRoot = await mkdtemp(join(tmpdir(), "bug311-root-"));
    const saveDir = join(saveRoot, "bug-reports"); // does NOT exist yet
    const transcript = [{ info: { role: "user" }, parts: [{ type: "text", text: "draft body" }] }];
    const { manager, errors } = await openBugSession(
      { "GET /session/ses_bug/message": { status: 200, body: transcript } },
      saveDir,
    );

    manager.sink.filed("ses_bug", "filed-via-browser");
    await settle(() => expect(errors).toHaveLength(1)); // completion barrier

    const saved = await readFile(join(saveDir, "ses_bug.md"), "utf8");
    expect(saved).toContain("draft body");
    expect(errors[0]).toContain(join(saveDir, "ses_bug.md"));
  });
});

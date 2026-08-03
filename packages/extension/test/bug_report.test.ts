import { describe, it, expect } from "vitest";
import { BugReportManager, type BugReportDeps } from "../src/bug_report";

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
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    const path = new URL(url).pathname;
    const route = routes[`${method} ${path}`];
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
    });
    const arm = calls.filter((c) => c.url.endsWith("/session/ses_bug1/command"));
    expect(arm).toHaveLength(1);
    expect(arm[0].body).toEqual({ command: "report-a-bug", arguments: "" });
    expect(posted).toEqual([{ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug1" }]);
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
      const body = path === "/session" && init?.method === "POST" ? { id: "ses_bug3" } : path === "/session" ? [] : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    const { d } = deps({}, fetchImpl);

    await new BugReportManager(d).reportBug();

    expect(authed.length).toBeGreaterThan(0);
    expect(new Set(authed)).toEqual(new Set([BOOT_AUTH]));
  });
});

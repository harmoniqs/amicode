import { describe, it, expect } from "vitest";
import { BugReportManager, type BugReportDeps } from "../src/bug_report";

const SERVER_URL = "http://127.0.0.1:43117/";
const BOOT_AUTH = "Basic b3BlbmNvZGU6dGVzdC1ib290LXBhc3N3b3Jk";

type Call = { method: string; url: string; body?: unknown };

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

// Regression for #476: clicking bug icon while dock open should NOT be swallowed
describe("BUG #476: second reportBug while dock open", () => {
  it("second invocation should prompt and, if user chooses new report, close old and create new", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "GET /session/ses_bug": { status: 200, body: { id: "ses_bug" } },
      "GET /session/ses_bug2": { status: 200, body: { id: "ses_bug2" } },
      "POST /session": { status: 200, body: { id: "ses_bug" } },
      "POST /session/ses_bug/command": { status: 200, body: {} },
      "POST /session/ses_bug2/command": { status: 200, body: {} },
      "POST /session/ses_bug/abort": { status: 200, body: true },
      "DELETE /session/ses_bug": { status: 200, body: true },
    });
    // Need to handle dynamic POST /session returning different ids sequentially
    let createCount = 0;
    const dynamicFetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/session") {
        createCount++;
        if (createCount === 1) {
          calls.push({ method, url, body: JSON.parse(init?.body as string) });
          return { ok: true, status: 200, json: async () => ({ id: "ses_bug" }) } as Response;
        } else {
          calls.push({ method, url, body: JSON.parse(init?.body as string) });
          return { ok: true, status: 200, json: async () => ({ id: "ses_bug2" }) } as Response;
        }
      }
      // delegate to mock
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;

    const showInformationMessage = async (msg: string, ...items: string[]) => {
      expect(msg).toContain("already open");
      expect(items).toContain("Start new report");
      return "Start new report";
    };

    const { d, posted } = deps({ showInformationMessage } as unknown as Partial<BugReportDeps>, dynamicFetch);

    const manager = new BugReportManager(d);
    await manager.reportBug(); // first open ses_bug
    expect(posted).toEqual([{ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" }]);
    posted.length = 0;
    calls.length = 0;

    // Second invocation while dock open — should prompt and create new session
    await manager.reportBug();

    // Should have closed old session and opened new one
    const methods = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(methods).toContain("POST /session/ses_bug/abort");
    expect(methods).toContain("DELETE /session/ses_bug");
    // Should have created second session
    expect(posted.some((p: unknown) => (p as { sessionID?: string }).sessionID === "ses_bug2")).toBe(true);
    // Should have posted close for old and open for new
    expect(posted).toContainEqual({ source: "amicode", kind: "close-bug-report", sessionID: "ses_bug" });
    expect(posted).toContainEqual({ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug2" });
  });

  it("second invocation with 'Show current report' choice just reveals existing", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /session": { status: 200, body: [] },
      "GET /session/ses_bug": { status: 200, body: { id: "ses_bug" } },
      "POST /session": { status: 200, body: { id: "ses_bug" } },
      "POST /session/ses_bug/command": { status: 200, body: {} },
    });
    const showInformationMessage = async () => "Show current report";
    const { d, posted } = deps({ showInformationMessage } as unknown as Partial<BugReportDeps>, fetchImpl);
    const manager = new BugReportManager(d);
    await manager.reportBug();
    posted.length = 0;
    calls.length = 0;

    await manager.reportBug();

    // Should NOT create new session, just reveal
    expect(calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/session")).toHaveLength(0);
    expect(posted).toEqual([{ source: "amicode", kind: "open-bug-report", sessionID: "ses_bug" }]);
  });
});

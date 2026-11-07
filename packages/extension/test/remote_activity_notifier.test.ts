// remote_activity_notifier.test.ts — #1569 (B2): host auto-focus notification
// when a remote machine starts driving a local session. The notifier is
// dependency-injected (no direct vscode import) so it is testable in vitest.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RemoteActivityNotifier,
  type RemoteActivityEvent,
  type RemoteActivityNotifierDeps,
} from "../src/amicode_service/remote_activity_notifier";

function makeDeps(overrides?: Partial<RemoteActivityNotifierDeps>): RemoteActivityNotifierDeps {
  return {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    onViewSession: vi.fn(),
    now: overrides?.now ?? (() => Date.now()),
    ...overrides,
  };
}

function event(overrides?: Partial<RemoteActivityEvent>): RemoteActivityEvent {
  return {
    sessionId: "ses-1",
    sessionTitle: "My session",
    controllerMachineId: "mac-studio-1",
    controllerMachineName: "JJ's Mac Studio",
    ...overrides,
  };
}

describe("#1569 — remote activity notifier", () => {
  let deps: RemoteActivityNotifierDeps;
  let notifier: RemoteActivityNotifier;

  beforeEach(() => {
    deps = makeDeps();
    notifier = new RemoteActivityNotifier(deps);
  });

  it("fires a notification with machine name and session title (AC1 + AC2)", () => {
    notifier.notify(event());
    expect(deps.showInformationMessage).toHaveBeenCalledOnce();
    const [msg, action] = (deps.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain("JJ's Mac Studio");
    expect(msg).toContain("My session");
    expect(action).toBe("View");
  });

  it("suppresses duplicate notification within cooldown (AC5)", () => {
    let clock = 1000;
    deps = makeDeps({ now: () => clock });
    notifier = new RemoteActivityNotifier(deps);

    notifier.notify(event());
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);

    // 30 seconds later — within the 60s cooldown
    clock += 30_000;
    notifier.notify(event());
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1); // still 1 — suppressed
  });

  it("fires again after cooldown expires (AC5)", () => {
    let clock = 1000;
    deps = makeDeps({ now: () => clock });
    notifier = new RemoteActivityNotifier(deps);

    notifier.notify(event());
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);

    // 61 seconds later — past the 60s cooldown
    clock += 61_000;
    notifier.notify(event());
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it("clearCache resets the rate limiter", () => {
    let clock = 1000;
    deps = makeDeps({ now: () => clock });
    notifier = new RemoteActivityNotifier(deps);

    notifier.notify(event());
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);

    // 10 seconds — still in cooldown, but clear the cache
    clock += 10_000;
    notifier.clearCache();
    notifier.notify(event());
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(2); // fires — cache was cleared
  });

  it("clicking 'View' calls onViewSession with the session id (AC3)", async () => {
    deps = makeDeps({
      showInformationMessage: vi.fn().mockResolvedValue("View"),
    });
    notifier = new RemoteActivityNotifier(deps);

    notifier.notify(event({ sessionId: "ses-abc" }));
    // The Promise.resolve().then chain is microtask — flush it
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.onViewSession).toHaveBeenCalledWith("ses-abc");
  });

  it("does NOT call onViewSession when user dismisses (AC3 negative)", async () => {
    deps = makeDeps({
      showInformationMessage: vi.fn().mockResolvedValue(undefined), // dismissed
    });
    notifier = new RemoteActivityNotifier(deps);

    notifier.notify(event());
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.onViewSession).not.toHaveBeenCalled();
  });

  it("falls back to sessionId when sessionTitle is absent", () => {
    notifier.notify(event({ sessionTitle: undefined }));
    const [msg] = (deps.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain("ses-1");
  });

  it("rate-limits per session — different sessions fire independently", () => {
    let clock = 1000;
    deps = makeDeps({ now: () => clock });
    notifier = new RemoteActivityNotifier(deps);

    notifier.notify(event({ sessionId: "ses-1" }));
    notifier.notify(event({ sessionId: "ses-2" }));
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(2);

    // Still within cooldown for ses-1 — suppressed; ses-2 — suppressed
    clock += 30_000;
    notifier.notify(event({ sessionId: "ses-1" }));
    notifier.notify(event({ sessionId: "ses-2" }));
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(2); // no new ones
  });
});

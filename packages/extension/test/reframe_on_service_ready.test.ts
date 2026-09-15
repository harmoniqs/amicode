import { describe, it, expect } from "vitest";
import { shouldReframe } from "../src/amicode_service_wiring";

// ============================================================================
// #1188 — re-frame decision. On reload a panel can end up framed at the ENGINE
// origin (stock opencode) when the amicode service isn't ready yet. Once the
// service is up, a live panel on the engine origin must re-frame to the service
// shelf; a panel already on the service origin must be left alone; and with no
// service the panel stays degraded (never crash, never churn).
// ============================================================================

const ENGINE = "http://127.0.0.1:43117/";
const SERVICE = "http://127.0.0.1:43118/";

describe("#1188 shouldReframe — engine-origin panel switches to the service shelf", () => {
  it("re-frames when the panel is on the engine origin and a service origin exists", () => {
    expect(shouldReframe(ENGINE, SERVICE)).toBe(true);
  });

  it("does NOT re-frame a panel already on the service origin", () => {
    expect(shouldReframe(SERVICE, SERVICE)).toBe(false);
  });

  it("does NOT re-frame when there is no service (honest degraded stays degraded)", () => {
    expect(shouldReframe(ENGINE, undefined)).toBe(false);
  });

  it("does NOT re-frame when nothing is framed yet (panel-create handles that)", () => {
    expect(shouldReframe(undefined, SERVICE)).toBe(false);
  });

  it("does NOT crash on a malformed current href", () => {
    expect(shouldReframe("not a url", SERVICE)).toBe(false);
  });

  it("compares by ORIGIN, not full href (path/query differences don't force a re-frame)", () => {
    expect(shouldReframe("http://127.0.0.1:43118/session/abc?x=1", SERVICE)).toBe(false);
  });
});

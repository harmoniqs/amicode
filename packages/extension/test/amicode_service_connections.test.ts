// amicode-service connections unit tests (#451, M1 slice 6) — the shapes the
// golden fixtures cannot pin: the /amicode/connections/auth route and the
// token auth_methods entry both landed in fork source AFTER the vendored pin
// (v1.18.10-amicode.11), so the recorded binary serves the SPA catch-all for
// them. These tests pin the ported SOURCE behavior; both join the golden arc
// at the next pin bump.
import { describe, it, expect } from "vitest";
import { startAuthResponse } from "../src/amicode_service/connections";

describe("startAuthResponse — refusal shapes (post-pin route, source-level parity)", () => {
  it("non-google ids refuse browser auth", async () => {
    const body = await startAuthResponse(JSON.stringify({ id: "slack", method: "browser" }));
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("browser auth is only for google connections");
  });

  it("bad body refuses", async () => {
    const body = await startAuthResponse(JSON.stringify({}));
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("body must be JSON {id, method}");
  });

  it("bad method refuses", async () => {
    const body = await startAuthResponse(JSON.stringify({ id: "google", method: "carrier-pigeon" }));
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("method must be browser or device-code");
  });

  it("non-JSON body refuses", async () => {
    const body = await startAuthResponse("not json");
    expect(JSON.parse(body).ok).toBe(false);
  });
});

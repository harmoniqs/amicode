// frameOriginUrl (#823, the M3 cutover consumer flip): the pure origin-picker
// every engine-origin UI consumer (chat panel iframe, deck panes, the
// connections bridge's server target) goes through at cutover — the amicode
// service origin when the service booted, else the engine origin (the honest
// degraded path: the chat keeps working against the engine's own UI when the
// service failed to boot).
import { describe, it, expect } from "vitest";
import { frameOriginUrl } from "../src/amicode_service_wiring";

describe("frameOriginUrl — the consumers' origin at the M3 cutover (#823)", () => {
  const engineUrl = new URL("http://127.0.0.1:43117");
  const service = { url: "http://127.0.0.1:54321/", authHeader: "Basic x" }; // trailing slash on purpose

  it("the service origin WINS whenever the service booted (the cutover: the framed app comes from the shelf)", () => {
    expect(frameOriginUrl(service, engineUrl)).toEqual(new URL("http://127.0.0.1:54321/"));
  });

  it("the engine origin is the degraded fallback when the service is down", () => {
    expect(frameOriginUrl(undefined, engineUrl)).toBe(engineUrl);
  });

  it("neither up → undefined (the caller's not-ready path)", () => {
    expect(frameOriginUrl(undefined, undefined)).toBeUndefined();
  });

  it("the service origin is preserved verbatim when no engine is ready yet (the panel can open ahead of the engine; the proxy answers honest 503s)", () => {
    // The service is STATELESS across engine restarts — a frame bound to it
    // survives the engine gap, which is the point of framing the service.
    expect(frameOriginUrl(service, undefined)).toEqual(new URL("http://127.0.0.1:54321/"));
  });
});

import { describe, expect, it } from "vitest";
import { applyHarmoniqsHeaders } from "../opencode-plugin/harmoniqs_transport";

describe("Harmoniqs AI request transport", () => {
  it("adds a stable session header and a per-request idempotency key", () => {
    const headers: Record<string, string> = {};

    applyHarmoniqsHeaders(
      { sessionID: "ses-1", model: { providerID: "harmoniqs" }, message: { id: "msg-1" } },
      { headers },
    );

    expect(headers["X-Session-Id"]).toBe("ses-1");
    expect(headers["Idempotency-Key"]).toMatch(/^amicode:ses-1:[0-9a-f-]{36}$/);
  });

  it("does not reuse a key across tool-loop requests for one user message", () => {
    const first: Record<string, string> = {};
    const second: Record<string, string> = {};
    const input = { sessionID: "ses-1", model: { providerID: "harmoniqs" }, message: { id: "msg-1" } };

    applyHarmoniqsHeaders(input, { headers: first });
    applyHarmoniqsHeaders(input, { headers: second });

    expect(first["Idempotency-Key"]).not.toBe(second["Idempotency-Key"]);
  });

  it("does not alter other providers' requests", () => {
    const headers = { Existing: "value" };

    applyHarmoniqsHeaders(
      { sessionID: "ses-1", model: { providerID: "anthropic" }, message: { id: "msg-1" } },
      { headers },
    );

    expect(headers).toEqual({ Existing: "value" });
  });
});

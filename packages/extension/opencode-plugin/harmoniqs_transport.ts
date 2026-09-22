/** Adds the gateway's routing contract only to Harmoniqs AI requests. */
export function applyHarmoniqsHeaders(
  input: { sessionID: string; model: { providerID: string }; message: { id: string } },
  output: { headers: Record<string, string> },
): void {
  if (input.model.providerID !== "harmoniqs") return;
  output.headers["X-Session-Id"] = input.sessionID;
  output.headers["Idempotency-Key"] = `amicode:${input.sessionID}:${crypto.randomUUID()}`;
}

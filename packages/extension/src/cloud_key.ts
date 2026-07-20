// Cloud API-key onboarding (amicode.setCloudKey). Pure, testable helpers for
// validating a cloud credential against the live Solve Service and shaping the
// ~/.amico/cloud.json file that packages/amico-run/src/remote_config.ts reads.
//
// SECURITY (remote_config.ts stance): the token value must never appear in any
// returned error/outcome string, log line, or the request URL. It rides ONLY in
// the Authorization header — nowhere else. The tests assert this adversarially.

/** Production Solve Service base URL — the default for the `amicode.cloudUrl`
 *  setting (so it's configurable, not hardcoded-only). */
export const DEFAULT_CLOUD_URL = "https://qy2gwqy5s5.execute-api.us-east-1.amazonaws.com";

export type ValidationOutcome =
  | { kind: "valid" }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string };

/** Strip trailing slashes — keep aligned with remote_config.ts's
 *  `base_url.replace(/\/+$/, "")` so both halves normalize identically. */
function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Classify the probe's HTTP status into a validation outcome.
 *
 *  The Solve Service runs its authorizer BEFORE the handler, so:
 *    - 401 → the bearer was rejected: the key is INVALID (don't save).
 *    - 403/404 → auth PASSED (authorizer accepted); the handler then rejected
 *      the fake probe task (not the caller's / doesn't exist). That proves the
 *      key is VALID.
 *    - 2xx → auth passed and the handler answered: VALID.
 *    - anything else (5xx, gateway/network-shaped) → we can't tell: ERROR, no save.
 *  No branch ever includes the token in its message. */
export function classifyValidation(status: number): ValidationOutcome {
  if (status === 401) return { kind: "invalid", message: "cloud key rejected (401) — check the key and try again" };
  if (status === 403 || status === 404 || (status >= 200 && status < 300)) return { kind: "valid" };
  return { kind: "error", message: `unexpected response from the Solve Service (HTTP ${status})` };
}

/** The EXACT shape remote_config.ts reads: non-empty string keys base_url + token,
 *  and nothing else (its readers key off these two only). base_url is trimmed to
 *  match remote_config's own normalization. */
export function buildCloudConfig(baseUrl: string, token: string): { base_url: string; token: string } {
  return { base_url: trimUrl(baseUrl), token };
}

/** Validate `token` against the live poll API BEFORE saving. Probes a fake task
 *  so a good bearer reaches the handler (404/403) while a bad one is 401'd by the
 *  authorizer. `fetchImpl` is injectable so unit tests never touch the network.
 *  The token rides only in the Authorization header — never in the URL. */
export async function validateCloudKey(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidationOutcome> {
  const url = `${trimUrl(baseUrl)}/solves/__validate__/status`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    // Never interpolate the caller-supplied error verbatim — it could echo the
    // token (adversarial test). Report a fixed, token-free reason.
    void e;
    return { kind: "error", message: "could not reach the Solve Service (network error)" };
  }
  return classifyValidation(res.status);
}

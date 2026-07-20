// Cloud API-key onboarding (amicode.setCloudKey) — the command half of the
// connections seam (#171). The command no longer validates, writes, or flips
// anything itself: it POSTs the credential to the LOCAL opencode server's
// connections submit route and renders the returned terminal state. The server
// (fork routes; #165 write, #167 flip) owns validate → write ~/.amico/cloud.json
// → HP entitlement + switch, so the panel and this command share ONE write path
// and ONE flip path (ADR 0001). There is deliberately no fallback to a direct
// file write here — if the server is down, the command fails actionably (AC4).
//
// SECURITY (remote_config.ts stance, unchanged): the cloud token must never
// appear in any returned outcome string, log line, or request URL. It rides
// ONLY in the JSON body of the one POST to the local server — a call
// authenticated with the #163 per-boot credential (server_auth.ts), NOT with
// the cloud token. Server-provided error text is token-redacted before it can
// surface (the tests assert this adversarially).

/** Production Solve Service base URL — the single source (review finding 6).
 *  package.json's `amicode.cloudUrl` default is "" and its description points
 *  here ("the built-in production endpoint"); a test pins the non-duplication. */
export const DEFAULT_CLOUD_URL = "https://qy2gwqy5s5.execute-api.us-east-1.amazonaws.com";

/** The one credential the command manages — the same connection id the panel
 *  submits, so both entry points converge on the same server-side record. */
export const CLOUD_CONNECTION_ID = "company-compute";

/** The fork's one-round-trip submit route: validate → write → flip, answering
 *  {ok, connection:{id, state, …}, error}. */
export const CREDENTIAL_ROUTE = "/amicode/connections/credential";

/** AC4 copy — the actionable failure when the LOCAL server can't be reached.
 *  Fixed and token-free by construction (never interpolates a caught error). */
export const SERVER_DOWN_MESSAGE = "Amico server not running — open the Amico panel first";

export type SubmitOutcome =
  | { kind: "connected" } // the #167 warning-free path: saved AND flipped
  | { kind: "connected-warning"; message: string } // saved, but the HP flip warned (finding 1)
  | { kind: "invalid"; message: string } // key rejected — not saved
  | { kind: "error"; message: string } // unreachable / server error — not saved
  | { kind: "server-down"; message: string }; // could not reach the LOCAL server at all

/** Strip trailing slashes — keep aligned with remote_config.ts's
 *  `base_url.replace(/\/+$/, "")` so the server stores what its reader expects. */
function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Server-provided text can adversarially echo the token (it shouldn't, but we
 *  don't trust it) — strip every occurrence before the text can reach a toast. */
function redactToken(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

interface CredentialRouteResponse {
  ok?: boolean;
  connection?: { id?: string; state?: string };
  error?: string;
}

/** POST the credential to the local server's connections submit route and map
 *  the one-round-trip response to a terminal outcome. `fetchImpl` is injectable
 *  so unit tests never touch the network. This is the command's ONLY side
 *  effect — no filesystem write, no entitlement grant, no switch request. */
export async function submitCloudCredential(opts: {
  /** Local opencode server base URL (extension.ts's opencodeReadyUrl). */
  serverUrl: string;
  /** The #163 boot credential header value (serverAuthHeader(serverPassword)). */
  authorization: string;
  /** Solve Service base URL to store (resolved amicode.cloudUrl setting). */
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<SubmitOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL(CREDENTIAL_ROUTE, opts.serverUrl).toString();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: opts.authorization },
      body: JSON.stringify({ id: CLOUD_CONNECTION_ID, base_url: trimUrl(opts.baseUrl), token: opts.token }),
    });
  } catch {
    // Never interpolate the caught error — it could echo the request body
    // (adversarial test). Fixed, actionable, token-free copy only.
    return { kind: "server-down", message: SERVER_DOWN_MESSAGE };
  }

  let body: CredentialRouteResponse | undefined;
  try {
    body = (await res.json()) as CredentialRouteResponse;
  } catch {
    body = undefined;
  }
  if (body === undefined || typeof body !== "object") {
    // The route always answers JSON; anything else is the local server
    // misbehaving (or a 401/403 from the #163 auth middleware).
    const auth = res.status === 401 || res.status === 403 ? " — the boot credential was refused; try \"Amicode: Restart opencode server\"" : "";
    return { kind: "error", message: `unexpected response from the Amico server (HTTP ${res.status})${auth}` };
  }

  const state = body.connection?.state;
  const detail = typeof body.error === "string" && body.error !== "" ? redactToken(body.error, opts.token) : undefined;
  if (state === "connected") {
    // #167: a saved key whose HP flip warned rides back as state "connected"
    // WITH an error field — that is not a clean success (review finding 1: the
    // old command showed the success toast over a failed flip).
    return detail ? { kind: "connected-warning", message: detail } : { kind: "connected" };
  }
  if (state === "invalid") {
    return { kind: "invalid", message: "cloud key rejected — check the key and try again" };
  }
  if (state === "unreachable") {
    return { kind: "error", message: `Solve Service unreachable${detail ? `: ${detail}` : " — check amicode.cloudUrl and your network"}` };
  }
  return { kind: "error", message: detail ?? `connection failed (HTTP ${res.status}${state ? `, state: ${state}` : ""})` };
}

/** The vscode.window surface the command touches — injected so the command core
 *  (UX contract included) is unit-testable without the VS Code host. */
export interface CloudKeyUi {
  showInputBox(options: { prompt: string; password: boolean; ignoreFocusOut: boolean }): Thenable<string | undefined>;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T> | Thenable<T>;
  showInformationMessage(message: string): void;
  showWarningMessage(message: string): void;
  showErrorMessage(message: string): void;
}

export interface SetCloudKeyDeps {
  ui: CloudKeyUi;
  /** Raw `amicode.cloudUrl` setting value; ""/blank → DEFAULT_CLOUD_URL. */
  cloudUrl: string;
  /** The running local server, or undefined when it isn't up (→ AC4 copy). */
  server: { url: string; authorization: string } | undefined;
  fetchImpl?: typeof fetch;
  /** Token-free output-channel logging. */
  log?: (line: string) => void;
}

/** Command core for amicode.setCloudKey: same UX as the merged command
 *  (password-masked input, progress notification, per-class copy), but the
 *  terminal state comes from the connections seam, not from local work. */
export async function runSetCloudKeyCommand(deps: SetCloudKeyDeps): Promise<void> {
  const { ui } = deps;
  // Fail fast BEFORE asking for the key: with the server down there is nothing
  // the command could do with it (and no direct-write fallback exists — AC4).
  if (!deps.server) {
    ui.showErrorMessage(`Amicode: ${SERVER_DOWN_MESSAGE}.`);
    return;
  }
  const server = deps.server;

  const key = await ui.showInputBox({
    prompt: "Paste your Amico cloud API key",
    password: true,
    ignoreFocusOut: true,
  });
  if (!key || key.trim() === "") return; // empty / cancel → no-op
  const token = key.trim();
  const cloudUrl = deps.cloudUrl.trim() || DEFAULT_CLOUD_URL;

  const outcome = await ui.withProgress("Amicode: connecting cloud…", () =>
    submitCloudCredential({ serverUrl: server.url, authorization: server.authorization, baseUrl: cloudUrl, token, fetchImpl: deps.fetchImpl }),
  );

  switch (outcome.kind) {
    case "connected":
      deps.log?.(`[cloud] connected via ${CREDENTIAL_ROUTE} (server owns write + HP flip); base_url=${trimUrl(cloudUrl)}`);
      ui.showInformationMessage("Cloud connected — HP mode enabled (Piccolissimo + Altissimo solves).");
      return;
    case "connected-warning":
      // Key saved, HP flip warned — a WARNING, never the success toast (finding 1).
      deps.log?.(`[cloud] key saved, but the HP flip warned: ${outcome.message}`);
      ui.showWarningMessage(`Amicode: cloud key saved, but HP enable needs attention — ${outcome.message}`);
      return;
    case "invalid":
      ui.showErrorMessage(`Amicode: ${outcome.message}`);
      return;
    case "server-down":
      ui.showErrorMessage(`Amicode: ${outcome.message}.`);
      return;
    case "error":
      ui.showErrorMessage(`Amicode: cloud key not saved — ${outcome.message}`);
      return;
  }
}

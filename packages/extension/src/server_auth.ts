import { randomBytes } from "node:crypto";

// ============================================================================
// Per-boot server password (#163, ADR 0002 graft 1).
//
// The vendored fork's route auth (packages/opencode/src/server/auth.ts @
// v1.17.3-amicode.5) only engages when OPENCODE_SERVER_PASSWORD is set in the
// server's env — without it, every route (including the amicode mutation
// routes) is open to any localhost page. The extension therefore mints a
// cryptographically random password once per activation and injects it into
// EVERY `opencode serve` spawn env.
//
// Carriage (all three read base64("opencode:<password>"), verified at the tag):
//   - the extension's own HTTP/SSE calls → `Authorization: Basic …` header
//   - the chat iframe / fork app        → `?auth_token=…` query param, which
//     the app's entry consumes for its authenticated-fetch path and strips
//     from the URL bar (history.replaceState) before rendering
//
// Lifetime: in-memory only for the life of the activation — never persisted,
// never logged. Respawns within one activation (solver-mode switch, vault
// refresh, restartServer) REUSE the value: the open chat iframe holds the
// boot credential, so a mid-session rotation would strand it on 401s. A new
// activation mints a new value.
// ============================================================================

/** The fork resolves its Basic-auth username from OPENCODE_SERVER_USERNAME ??
 *  "opencode" — and the spawned server INHERITS the host env, so a dev override
 *  there must shape our credential too or every extension call 401s. */
function serverUsername(): string {
  return process.env.OPENCODE_SERVER_USERNAME || "opencode";
}

/** Mint the per-boot server password: 32 random bytes, base64url so it rides
 *  env vars and the auth_token query param unescaped. */
export function mintServerPassword(): string {
  return randomBytes(32).toString("base64url");
}

/** The `?auth_token=` value the fork's auth middleware and the app's entry
 *  bootstrap both decode: base64("opencode:<password>"). */
export function serverAuthToken(password: string): string {
  return Buffer.from(`${serverUsername()}:${password}`).toString("base64");
}

/** The `Authorization` header for the extension's own calls to the server —
 *  mirrors the fork's ServerAuth.header (Basic, username "opencode"). */
export function serverAuthHeader(password: string): string {
  return `Basic ${serverAuthToken(password)}`;
}

/** Build the env the extension ADDS to the opencode server spawn (the server
 *  inherits the host env underneath — ServerManager spreads process.env):
 *    PATH                     — amico-run launcher dir prepended, so solves run
 *    OPENCODE_CONFIG_CONTENT  — the amico instructions/permission merge
 *    OPENCODE_SERVER_PASSWORD — arms the fork's route auth (this module)
 *  One builder for all spawn sites so no respawn path can drop the password. */
/** Non-secret path/config overrides passed THROUGH to the server when set in
 *  the extension host's env. The minimal-env discipline stands — this is a
 *  fixed allowlist of amico state locations (never a process.env spread), so a
 *  sandbox launch (`AMICO_PASQAL_FILE=… code …`) can isolate its ~/.amico +
 *  keychain from the real install. None of these are secrets; unset vars never
 *  appear. */
const SANDBOX_ENV_PASSTHROUGH = [
  "AMICO_CLOUD_FILE",
  "AMICO_PASQAL_FILE",
  "AMICODE_CONNECTIONS_FILE",
  "AMICODE_OPS_DIR",
  "AMICO_PASQAL_KEYCHAIN_SERVICE",
  "AMICO_PASQAL_VALIDATOR",
  "AMICO_PYTHON",
] as const

// ============================================================================
// Run-corpus telemetry env (feat/telemetry-env-injection).
//
// opencode ships an OTLP/HTTP exporter that stays fully DORMANT unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set (its exporter layer resolves empty
// otherwise). We route that exporter at OUR ingest endpoint by ADDING env vars
// to the spawn — but ONLY behind the consent gate. The var names, header names
// (x-amicode-*) and resource-attribute keys (amicode.*) below are a BINDING
// interface contract with the AWS ingest Lambda (RUN_CORPUS_SPEC.md); do not
// rename or reorder-encode them.
// ============================================================================

/** The env keys buildTelemetryEnv can emit — the full set the live-env
 *  reconcile deletes before re-applying (extension.ts). Contract's three, plus
 *  OTEL_EXPORTER_OTLP_COMPRESSION pinned "none": the OTel JS exporters silently
 *  honor an inherited compression var, and a wire-gzip'd body would be double-
 *  gzip'd in storage and unrecoverable on replay (only Content-Type is kept). */
export const TELEMETRY_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_COMPRESSION",
] as const;

/** Everything the OTLP env needs, already resolved from settings / SecretStorage
 *  / globalState / the active workspace by the extension host (telemetry.ts).
 *  Values are RAW (un-encoded) — buildTelemetryEnv does the contract's per-value
 *  URL-encoding of the resource attributes. */
export interface TelemetryContext {
  /** `amicode.telemetry.enabled` setting (default true). */
  enabled: boolean;
  /** Has the first-run consent modal been answered (either way)? Default-ON must
   *  NOT mean transmit-before-consent, so this gates INDEPENDENTLY of `enabled`
   *  — before the user answers, nothing is emitted even though enabled is true. */
  consentAnswered: boolean;
  /** `amicode.telemetry.endpoint`, trailing slash already stripped; "" = unset. */
  endpoint: string;
  /** Ingest key from SecretStorage; "" = not set (rides as an empty header value,
   *  which the ingest Lambda 401s — the gate itself does not require the key). */
  key: string;
  /** Resource + header identity (RAW values). */
  sessionId: string;
  userId: string;
  repo: string;
  gitRef: string;
}

/** The OTLP env vars per the INTERFACE CONTRACT — or {} when the consent gate is
 *  closed. GATE: telemetry enabled AND consent answered AND an endpoint set.
 *  Missing ANY one → ALL keys omitted, so opencode's exporter stays dormant. */
export function buildTelemetryEnv(t: TelemetryContext | undefined): Record<string, string> {
  if (!t || !t.enabled || !t.consentAnswered || !t.endpoint) return {};
  const enc = encodeURIComponent;
  return {
    // Base URL only — opencode appends /v1/traces and /v1/logs itself.
    OTEL_EXPORTER_OTLP_ENDPOINT: t.endpoint,
    // Comma-separated key=value; opencode forwards each as an HTTP header
    // VERBATIM (the contract does NOT URL-encode headers). A blank key still
    // rides — the Lambda answers 401, which is the honest signal.
    OTEL_EXPORTER_OTLP_HEADERS: [
      `x-amicode-key=${t.key}`,
      `x-amicode-session=${t.sessionId}`,
      `x-amicode-user=${t.userId}`,
    ].join(","),
    // Comma-separated; VALUES URL-encoded — opencode does decodeURIComponent
    // per value, so a branch ref like "feat/x" (its "/") survives the list.
    // amicode.client is the fixed literal `vscode` per the contract.
    OTEL_RESOURCE_ATTRIBUTES: [
      `amicode.user=${enc(t.userId)}`,
      `amicode.session=${enc(t.sessionId)}`,
      `amicode.repo=${enc(t.repo)}`,
      `amicode.git_ref=${enc(t.gitRef)}`,
      `amicode.client=vscode`,
    ].join(","),
    // Keep stored bodies single-gzip + byte-faithfully replayable (see above).
    OTEL_EXPORTER_OTLP_COMPRESSION: "none",
  };
}

export function buildServerSpawnEnv(opts: {
  /** amico-run launcher bin dir; undefined = launcher missing (boot warns). */
  amicoRunBinDir: string | undefined;
  /** buildOpencodeConfigContent(...) output for this spawn. */
  configContent: string;
  /** The per-boot password from mintServerPassword(). */
  serverPassword: string;
  /** Interpreter for the fork's Pasqal validator spawn ($AMICO_PYTHON →
   *  bare `python3`); the provisioned venv python, or a host override.
   *  Undefined = not provisioned: the key stays ABSENT (never empty) so the
   *  fork's fallback is byte-identical to pre-provisioning behavior.
   *  Deliberate, recorded S37 exception: this is server-child plumbing for
   *  the validator, NOT amico-run env propagation (which stays argv-only). */
  amicoPython?: string;
  /** Resolved run-corpus telemetry context, or undefined to omit OTLP entirely.
   *  buildTelemetryEnv applies the consent gate, so an un-gated context still
   *  yields zero OTLP vars — the exporter only wakes when the gate is open. */
  telemetry?: TelemetryContext;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${opts.amicoRunBinDir ? opts.amicoRunBinDir + ":" : ""}${process.env.PATH ?? ""}`,
    OPENCODE_CONFIG_CONTENT: opts.configContent,
    OPENCODE_SERVER_PASSWORD: opts.serverPassword,
    ...(opts.amicoPython ? { AMICO_PYTHON: opts.amicoPython } : {}),
    // Gated OTLP env (contract). {} unless enabled + consent + endpoint all hold.
    ...buildTelemetryEnv(opts.telemetry),
  };
  for (const key of SANDBOX_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

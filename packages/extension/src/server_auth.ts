import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  "AMICO_GITHUB_FILE",
  "AMICO_GITHUB_TOKEN_FILE",
] as const

// ============================================================================
// Run-corpus telemetry env (feat/telemetry-env-injection).
//
// opencode ships an OTLP/HTTP exporter that stays fully DORMANT unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set (its exporter layer resolves empty
// otherwise). We route that exporter at OUR ingest endpoint by ADDING env vars
// to the spawn — but ONLY behind the consent gate. The var names, the token
// header (`x-amicode-token: <cloud token>`), the `x-amicode-session` grouping
// header and the resource-attribute keys (amicode.*) below are a BINDING
// interface contract with the AWS ingest Lambda (BEARER_AUTH_SPEC.md); do not
// rename or reorder-encode them. The token rides `x-amicode-token`, NOT
// `Authorization: Bearer`, because the ingest now sits behind CloudFront with
// Origin Access Control: OAC signs each origin request with SigV4 in the
// `Authorization` header, so a token placed there is overwritten before it
// reaches the Lambda. Identity is the VERIFIED submitter the ingest derives from
// the token server-side — the client no longer sends x-amicode-key or
// x-amicode-user.
// ============================================================================

/** The env keys buildTelemetryEnv can emit — the full set the live-env reconcile
 *  deletes before re-applying (extension.ts). The contract's three, plus three
 *  operational pins, ALL verified honored by the vendored fork's tracer
 *  (@effect/opentelemetry NodeSdk → @opentelemetry/sdk-trace-base@2.6.1):
 *    - OTEL_EXPORTER_OTLP_COMPRESSION="none" — the exporter honors an inherited
 *      compression var; a wire-gzip'd body would be double-gzip'd in storage and
 *      unrecoverable on replay (ingest keeps only the raw body + Content-Type).
 *    - OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT — reconfigureLimits() folds it into the
 *      provider's spanLimits and Span truncates each attribute value to it, so a
 *      giant tool output can't blow a span past the ingest's 6 MB request cap.
 *    - OTEL_BSP_MAX_EXPORT_BATCH_SIZE — the BatchSpanProcessor (constructed with
 *      no config) reads it, keeping each OTLP request small under that 6 MB cap. */
export const TELEMETRY_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_COMPRESSION",
  "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
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
  /** The user's Solve/cloud bearer token (from ~/.amico/cloud.json); "" = not
   *  connected → the gate stays CLOSED. A token-less spawn would still LOOK on
   *  (endpoint set) while every batch 401s at the ingest and the exporter spams
   *  retries, capturing nothing — so no token means dormant, not a spawn that
   *  transmits with no token header. Rides ONLY the OTLP x-amicode-token header;
   *  never logged. */
  token: string;
  /** Resource + header identity (RAW values). */
  sessionId: string;
  userId: string;
  repo: string;
  gitRef: string;
}

/** The single gate predicate: telemetry enabled AND consent answered AND an
 *  endpoint set AND a non-empty bearer token. Both the exporter env (buildTelemetryEnv)
 *  and the span-generation config flag (experimental.openTelemetry, set in
 *  opencode_config.ts) key off THIS so they can never diverge — arming the
 *  exporter without generating spans (or vice versa) is the whole-pipeline bug
 *  this predicate prevents. */
export function telemetryGateOpen(t: TelemetryContext | undefined): t is TelemetryContext {
  return !!t && t.enabled && t.consentAnswered && !!t.endpoint && !!t.token;
}

/** The OTLP env vars per the INTERFACE CONTRACT — or {} when the consent gate is
 *  closed. Gate closed → ALL keys omitted, so opencode's exporter stays dormant
 *  (a keyless spawn would only 401-spam, never capture). */
export function buildTelemetryEnv(t: TelemetryContext | undefined): Record<string, string> {
  if (!telemetryGateOpen(t)) return {};
  const enc = encodeURIComponent;
  return {
    // Base URL only — opencode appends /v1/traces and /v1/logs itself.
    OTEL_EXPORTER_OTLP_ENDPOINT: t.endpoint,
    // Comma-separated key=value; opencode forwards each as an HTTP header
    // VERBATIM (the contract does NOT URL-encode headers). The token is guaranteed
    // non-empty here (gated above) and header-safe (amico_<hex>), so the ingest
    // always authenticates it against the shared credentials table and derives
    // the verified submitter. It rides x-amicode-token, NOT Authorization: Bearer
    // — CloudFront OAC owns Authorization for its SigV4 origin signature and would
    // clobber it. x-amicode-session groups the run (S3 prefix). No x-amicode-key /
    // x-amicode-user: the token IS the identity now.
    OTEL_EXPORTER_OTLP_HEADERS: [
      `x-amicode-token=${t.token}`,
      `x-amicode-session=${t.sessionId}`,
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
    // Size caps for the ingest's hard 6 MB Function-URL request limit — without
    // them a big run's batch (huge tool outputs) is rejected WHOLESALE before the
    // Lambda runs = silent data loss. Both are honored by the fork's tracer (see
    // TELEMETRY_ENV_KEYS). 16 KiB tames a single giant attribute value; a 64-span
    // batch (vs the SDK's 512 default) keeps each request comfortably small.
    OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: "16384",
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "64",
  };
}

/** GitHub App connection state file — path contract SHARED with amico-run's
 *  github_app.ts (githubAppConfigFile); duplicated here because the extension
 *  spawns the CLI package, it does not import it (the pasqal_devices.ts
 *  precedent for ~/.amico defaults). */
export function githubAppConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_GITHUB_FILE;
  if (v && v.trim() !== "") return v;
  return join(homedir(), ".amico", "github.json");
}

/** GIT_CONFIG env (git's documented config-in-env mechanism) registering the
 *  bundled credential helper for https github.com ONLY when the GitHub App
 *  connection is configured (issue #399) — absent file → zero vars, so git
 *  behavior is byte-identical to pre-#399 when unconfigured. ssh remotes are
 *  untouched: the helper only serves the https URL space, and commit
 *  authorship never reads transport credentials. */
export function buildGitCredentialHelperEnv(
  amicoRunBinDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!amicoRunBinDir) return {};
  if (!existsSync(githubAppConfigFile(env))) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.helper",
    GIT_CONFIG_VALUE_0: `!"${join(amicoRunBinDir, "amico-git-credential")}"`,
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
  /** Env the sandbox passthrough + the #399 credential-helper gate read.
   *  Default: the host env (the spawn inherits it underneath anyway). Tests
   *  pass a controlled env so key-set assertions stay machine-independent. */
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const envSource = opts.env ?? process.env;
  const env: Record<string, string> = {
    PATH: `${opts.amicoRunBinDir ? opts.amicoRunBinDir + ":" : ""}${process.env.PATH ?? ""}`,
    OPENCODE_CONFIG_CONTENT: opts.configContent,
    OPENCODE_SERVER_PASSWORD: opts.serverPassword,
    // Agent-run plotting must stay INSIDE the extension: a script calling
    // plt.show() (or Julia GR opening a GKS terminal) pops a native window
    // over the editor. Headless backends make show() a no-op — scripts save
    // figures to files, which the chat renders inline. Inherited by every
    // tool the server spawns.
    MPLBACKEND: "Agg",
    GKSwstype: "nul",
    ...(opts.amicoPython ? { AMICO_PYTHON: opts.amicoPython } : {}),
    // Gated OTLP env (contract). {} unless enabled + consent + endpoint all hold.
    ...buildTelemetryEnv(opts.telemetry),
    // Gated git credential helper (issue #399). {} unless the GitHub App
    // connection file exists AND the launcher dir resolved.
    ...buildGitCredentialHelperEnv(opts.amicoRunBinDir, envSource),
  };
  for (const key of SANDBOX_ENV_PASSTHROUGH) {
    const value = envSource[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

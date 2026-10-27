// packages/amico-run/src/gh_identity.ts — A15 agent identity separation
// (#1928, spec-20261026-101500-rd-system-v2-1 decision A15 + A10's reviewer App).
//
// #399 made the gh shim and git credential helper ALL-OR-NOTHING: if
// ~/.amico/github.json existed, every shimmed call became the App — which
// would turn the director's own `--admin` merges into App calls. Identity is
// now chosen PER CALL by the principal, never by file presence:
//
//   AMICO_GH_IDENTITY unset / "" / "person" → the human's own gh login,
//       byte-identical passthrough (no config read, no env change);
//   AMICO_GH_IDENTITY=agent → the `amico-agent` App, with
//       - the principal bound AT MINT: every fresh token appends one line to
//         <apps>/mints.jsonl — {ts, app_id, installation_id, principal:
//         {kind:"agent", on_behalf_of, campaign, session}, token_fp,
//         expires_at}; no on_behalf_of → refused (no mint, no token);
//       - a SCRUBBED gh config: the real gh child runs with a private empty
//         GH_CONFIG_DIR and GH_TOKEN = the App token as its only token var,
//         so it can never fall back to the human's hosts.yml;
//   anything else → ConfigError (fail closed; the reviewer App is never
//       env-selectable — only `amico review post-check` mints it).
//
// <apps> = $AMICO_GITHUB_APPS_DIR or ~/.amico/github-apps (agent.json,
// reviewer.json — {app_id, installation_id, pem_path, slug…}; PEMs beside;
// dir 700, files 600). ~/.amico/github.json stays a back-compat alias for the
// agent App config ($AMICO_GITHUB_FILE overrides, as in #399).
//
// on_behalf_of = the human's gh login, captured ONCE (the real gh, run as
// person: `gh api user --jq .login`) and cached at <apps>/principal.json.
// campaign = $AMICO_CAMPAIGN (ledger slug). session = $AMICO_SESSION_ID: the
// engine does NOT export its session id to the bash tool env today (it only
// sets OPENCODE=1 / OPENCODE_PID; the session id is reachable solely through
// the `shell.env` plugin hook), so a launcher or plugin must set it.
//
// SECURITY: token bytes never appear in a record (only an 8-hex sha256
// prefix), a log, an error, or argv. Honest limit: agents still run as the
// human's OS user, so the human's ~/.config/gh is on disk and reachable by a
// deliberate read; the scrub only guarantees gh never USES it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureInstallationToken,
  launcherDirFor,
  readGithubAppConfigFile,
  resolveRealGh,
  type FetchImpl,
  type GithubAppConfig,
  type InstallationToken,
} from "./github_app.js";
import { ConfigError } from "./types.js";

export type GhIdentity = "person" | "agent";

export interface AgentPrincipal {
  kind: "agent";
  on_behalf_of: string;
  campaign: string | null;
  session: string | null;
}

export interface MintRecord {
  ts: string;
  app_id: string;
  installation_id: string;
  principal: AgentPrincipal;
  token_fp: string;
  expires_at: string;
}

/** Fail-closed parse of $AMICO_GH_IDENTITY. */
export function resolveGhIdentity(env: NodeJS.ProcessEnv = process.env): GhIdentity {
  const v = env.AMICO_GH_IDENTITY;
  if (v === undefined || v === "" || v === "person") return "person";
  if (v === "agent") return "agent";
  throw new ConfigError(`AMICO_GH_IDENTITY must be "person" (the default) or "agent" — refusing an unknown identity rather than guessing`);
}

export function githubAppsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const v = env.AMICO_GITHUB_APPS_DIR;
  if (v && v.trim() !== "") return v;
  return join(home, ".amico", "github-apps");
}

/** Agent App config: $AMICO_GITHUB_FILE (explicit, #399) → <apps>/agent.json →
 *  ~/.amico/github.json (the #399 back-compat alias). A sandboxed apps dir
 *  ($AMICO_GITHUB_APPS_DIR) never falls back to the real home alias. */
export function agentConfigFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const explicit = env.AMICO_GITHUB_FILE;
  if (explicit && explicit.trim() !== "") return explicit;
  const primary = join(githubAppsDir(env, home), "agent.json");
  if (existsSync(primary)) return primary;
  if (env.AMICO_GITHUB_APPS_DIR && env.AMICO_GITHUB_APPS_DIR.trim() !== "") return primary;
  const legacy = join(home, ".amico", "github.json");
  return existsSync(legacy) ? legacy : primary;
}

export function reviewerConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(githubAppsDir(env), "reviewer.json");
}

/** Per-role token caches; $AMICO_GITHUB_TOKEN_FILE keeps overriding the agent's (#399). */
export function agentTokenCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_GITHUB_TOKEN_FILE;
  if (v && v.trim() !== "") return v;
  return join(githubAppsDir(env), "agent-token.json");
}

export function reviewerTokenCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(githubAppsDir(env), "reviewer-token.json");
}

export function mintsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(githubAppsDir(env), "mints.jsonl");
}

export function principalCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(githubAppsDir(env), "principal.json");
}

/** 8-hex sha256 prefix: enough to join a record to a token, useless to replay it. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}

/** GitHub login grammar: alnum + single hyphens, ≤39 chars. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export interface IdentityDeps {
  fetchImpl?: FetchImpl;
  nowMs?: () => number;
  readPem?: (path: string) => string;
  /** The human's gh login; default: the real gh, run as person. */
  captureLogin?: (env: NodeJS.ProcessEnv) => string | undefined;
  /** The bundle URL whose sibling launcher dir the real-gh hunt skips. */
  bundleUrl?: string;
}

/** The human's login via the REAL gh (skipping our shim), forced to the
 *  person identity so a capture can never ride an App token. */
export function captureHumanLogin(env: NodeJS.ProcessEnv, bundleUrl: string = import.meta.url): string | undefined {
  const gh = resolveRealGh(env.PATH, launcherDirFor(bundleUrl));
  if (!gh) return undefined;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  childEnv.AMICO_GH_IDENTITY = "person";
  const r = spawnSync(gh, ["api", "user", "--jq", ".login"], { encoding: "utf8", env: childEnv, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
  return r.stdout.trim();
}

function atomicWrite0600(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** on_behalf_of: the cached capture, else capture once + cache. Undefined
 *  when no valid login can be established — the caller refuses. */
export async function resolveOnBehalfOf(env: NodeJS.ProcessEnv = process.env, deps: IdentityDeps = {}): Promise<string | undefined> {
  const file = principalCacheFile(env);
  if (existsSync(file)) {
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof d.on_behalf_of === "string" && GITHUB_LOGIN.test(d.on_behalf_of)) return d.on_behalf_of;
    } catch {
      // corrupt cache → re-capture below
    }
  }
  const login = (deps.captureLogin ?? ((e) => captureHumanLogin(e, deps.bundleUrl)))(env);
  if (!login || !GITHUB_LOGIN.test(login)) return undefined;
  atomicWrite0600(file, JSON.stringify({ on_behalf_of: login, captured_at: new Date().toISOString(), source: "gh api user" }, null, 2) + "\n");
  return login;
}

function nonEmpty(v: string | undefined): string | null {
  return v !== undefined && v.trim() !== "" ? v : null;
}

/** The principal an agent call would bind (or null on_behalf_of). */
export async function agentPrincipal(env: NodeJS.ProcessEnv, deps: IdentityDeps = {}): Promise<{ kind: "agent"; on_behalf_of: string | null; campaign: string | null; session: string | null }> {
  return {
    kind: "agent",
    on_behalf_of: (await resolveOnBehalfOf(env, deps)) ?? null,
    campaign: nonEmpty(env.AMICO_CAMPAIGN),
    session: nonEmpty(env.AMICO_SESSION_ID),
  };
}

export function appendMintRecord(rec: MintRecord, env: NodeJS.ProcessEnv = process.env): void {
  const file = mintsFile(env);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    throw new ConfigError(`agent token refused: could not append the mint record to ${file} — a mint without its principal record is never handed out`);
  }
}

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): GithubAppConfig {
  return readGithubAppConfigFile(agentConfigFile(env));
}

/** The agent lane's single entry point: principal first (refuse without
 *  on_behalf_of — even on a warm cache), then cache-or-mint; every fresh mint
 *  is recorded before the token leaves this function. */
export async function ensureAgentToken(
  deps: IdentityDeps & { env?: NodeJS.ProcessEnv } = {},
): Promise<InstallationToken & { principal: AgentPrincipal; config: GithubAppConfig }> {
  const env = deps.env ?? process.env;
  const config = readAgentConfig(env);
  const p = await agentPrincipal(env, deps);
  if (p.on_behalf_of === null)
    throw new ConfigError(
      "agent identity refused: no on_behalf_of — the human's gh login could not be captured (run `gh auth login` as yourself, then retry); an agent token is never minted without the person it acts for",
    );
  const principal: AgentPrincipal = { ...p, on_behalf_of: p.on_behalf_of };
  const now = deps.nowMs ?? Date.now;
  const tok = await ensureInstallationToken({
    env,
    nowMs: now,
    fetchImpl: deps.fetchImpl,
    readPem: deps.readPem,
    config,
    cacheFile: agentTokenCacheFile(env),
    onMint: (t, cfg) =>
      appendMintRecord(
        {
          ts: new Date(now()).toISOString(),
          app_id: cfg.appId,
          installation_id: cfg.installationId,
          principal,
          token_fp: tokenFingerprint(t.token),
          expires_at: t.expiresAt,
        },
        env,
      ),
  });
  return { ...tok, principal, config };
}

export function readReviewerConfig(env: NodeJS.ProcessEnv = process.env): GithubAppConfig {
  const file = reviewerConfigFile(env);
  if (!existsSync(file))
    throw new ConfigError(`no reviewer App credential at ${file} — the dispatcher host needs github-apps/reviewer.json (app_id, installation_id, pem_path)`);
  return readGithubAppConfigFile(file);
}

/** The reviewer App token — for `amico review post-check` ONLY. */
export async function ensureReviewerToken(
  deps: IdentityDeps & { env?: NodeJS.ProcessEnv } = {},
): Promise<InstallationToken & { config: GithubAppConfig }> {
  const env = deps.env ?? process.env;
  const config = readReviewerConfig(env);
  const tok = await ensureInstallationToken({
    env,
    nowMs: deps.nowMs,
    fetchImpl: deps.fetchImpl,
    readPem: deps.readPem,
    config,
    cacheFile: reviewerTokenCacheFile(env),
  });
  return { ...tok, config };
}

/** Env vars gh (or tools it spawns) would read a human credential or config from. */
const HUMAN_GH_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "GH_HOST"];

/** The agent child env: everything else verbatim, every human token var and
 *  gh config pointer removed, then GH_TOKEN = App token + the private dir. */
export function scrubbedGhEnv(env: NodeJS.ProcessEnv, token: string, privateConfigDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !HUMAN_GH_VARS.includes(k)) out[k] = v;
  out.GH_TOKEN = token; // the token's ONLY carriage
  out.GH_CONFIG_DIR = privateConfigDir;
  return out;
}

/** The env an AGENT launcher adds (AFK/night/subagent): the identity, plus
 *  git config-in-env that RESETS every inherited github.com credential helper
 *  (an empty helper value clears the list — so the human's osxkeychain /
 *  `gh auth git-credential` are never consulted) and registers ours. Appends
 *  after any GIT_CONFIG_* entries already present. */
export function withAgentGitConfig(env: NodeJS.ProcessEnv, helperPath: string): Record<string, string> {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const base = Number.isFinite(n) && n > 0 ? n : 0;
  const out: Record<string, string> = {};
  for (let i = 0; i < base; i++) {
    const k = env[`GIT_CONFIG_KEY_${i}`];
    const v = env[`GIT_CONFIG_VALUE_${i}`];
    if (k !== undefined) out[`GIT_CONFIG_KEY_${i}`] = k;
    if (v !== undefined) out[`GIT_CONFIG_VALUE_${i}`] = v;
  }
  const key = "credential.https://github.com.helper";
  out.AMICO_GH_IDENTITY = "agent";
  out[`GIT_CONFIG_KEY_${base}`] = key;
  out[`GIT_CONFIG_VALUE_${base}`] = "";
  out[`GIT_CONFIG_KEY_${base + 1}`] = key;
  out[`GIT_CONFIG_VALUE_${base + 1}`] = `!"${helperPath}"`;
  out.GIT_CONFIG_COUNT = String(base + 2);
  return out;
}

/** Why this env looks like an engine session (bash tool env), or undefined.
 *  OPENCODE/OPENCODE_PID are set by the engine on itself and inherited by
 *  every tool child; OPENCODE_SERVER_PASSWORD rides the extension's server
 *  spawn env; AMICO_SESSION_ID is ours. Honest limit: same OS user — a
 *  session that deliberately unsets these is a finding, not a prevention. */
export function engineSessionMarker(env: NodeJS.ProcessEnv): string | undefined {
  for (const k of ["OPENCODE", "OPENCODE_PID", "OPENCODE_SERVER_PASSWORD", "AMICO_SESSION_ID"]) {
    const v = env[k];
    if (v !== undefined && v !== "") return k;
  }
  return undefined;
}

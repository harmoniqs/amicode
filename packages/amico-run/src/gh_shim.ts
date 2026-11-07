// packages/amico-run/src/gh_shim.ts — the `gh` shim logic (issue #399).
//
// Staged as `launcher/gh` in the bin dir the extension prepends to the
// server's PATH, so EVERY gh invocation in an agent session — issue/PR
// creation, the handoff verb, repo-sync — runs as the App identity when the
// GitHub App connection is configured, and byte-identically as the user's own
// gh when it is not (config absent → argv/env untouched passthrough).
//
// #1928 (A15): identity is chosen PER CALL by $AMICO_GH_IDENTITY, never by
// config-file presence. person (unset/""/"person", the default) is the #399
// unconfigured lane — byte-identical passthrough, no file read, no env change,
// even when an App config exists. agent mints (or reuses) the agent App token
// with its principal bound at mint (gh_identity.ts) and runs the real gh with
// a SCRUBBED env: a private, empty, per-call GH_CONFIG_DIR and GH_TOKEN as the
// only token var, so gh can never fall back to the human's hosts.yml.
//
// SECURITY: the installation token rides ONLY the child env (GH_TOKEN) — never
// argv, never an error, never a log line. Config-class faults are the
// pasqal-launcher stance: one token-free actionable line on stderr, exit 64.
import { spawn } from "node:child_process";
import { constants as osConstants, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launcherDirFor, resolveRealGh } from "./github_app.js";
import { ensureAgentToken, resolveGhIdentity, scrubbedGhEnv, type IdentityDeps } from "./gh_identity.js";
import { ConfigError } from "./types.js";

function signalCode(signal: NodeJS.Signals | null): number {
  const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (n ?? 1);
}

/** This bundle is <launcherDir>/../dist/gh.js — the launcher dir is the one
 *  PATH entry we must skip when hunting the REAL gh (recursion guard). */
export function ownLauncherDir(bundleUrl: string): string | undefined {
  return launcherDirFor(bundleUrl);
}

/** Exec the real gh with stdio inherited (gh's interactive prompts must work)
 *  and signals forwarded; exit code passes through verbatim. `token` set →
 *  GH_TOKEN added to the (otherwise verbatim) env; `childEnvOverride` set →
 *  that env is used AS IS (the agent lane's scrubbed env). */
export async function runRealGh(
  argv: string[],
  env: NodeJS.ProcessEnv,
  token: string | undefined,
  bundleUrl: string,
  childEnvOverride?: Record<string, string>,
): Promise<number> {
  const gh = resolveRealGh(env.PATH, ownLauncherDir(bundleUrl));
  if (!gh) {
    console.error("gh: command not found (amico-gh shim: real gh not on PATH after its own dir — install the GitHub CLI)");
    return 127;
  }
  let childEnv: Record<string, string>;
  if (childEnvOverride) childEnv = childEnvOverride;
  else {
    childEnv = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
    if (token !== undefined) childEnv.GH_TOKEN = token; // the token's ONLY carriage
  }
  return new Promise<number>((resolve) => {
    const child = spawn(gh, argv, { stdio: "inherit", env: childEnv });
    const onInt = () => child.kill("SIGINT");
    const onTerm = () => child.kill("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const done = (c: number) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(c);
    };
    child.on("error", (e) => {
      console.error(`amico-gh: failed to start gh: ${(e as NodeJS.ErrnoException).code ?? "spawn error"}`);
      done(127);
    });
    child.on("close", (code, signal) => done(code ?? signalCode(signal)));
  });
}

/** person → transparent passthrough (no file read, no env change — the #399
 *  unconfigured lane, whatever config exists); agent → principal-bound
 *  mint/reuse of the agent App token, then the real gh under a scrubbed env
 *  with a private empty GH_CONFIG_DIR that does not outlive the call. */
export async function ghShimMain(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  bundleUrl: string = import.meta.url,
  deps: Omit<IdentityDeps, "bundleUrl"> = {},
): Promise<number> {
  let privateDir: string | undefined;
  try {
    if (resolveGhIdentity(env) === "person") return await runRealGh(argv, env, undefined, bundleUrl);
    const { token } = await ensureAgentToken({ ...deps, env, bundleUrl });
    privateDir = mkdtempSync(join(tmpdir(), "amico-gh-agent-")); // 0700, empty
    return await runRealGh(argv, env, undefined, bundleUrl, scrubbedGhEnv(env, token, privateDir));
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`amico-gh: ${e.message}`);
      return 64;
    }
    throw e;
  } finally {
    if (privateDir) rmSync(privateDir, { recursive: true, force: true });
  }
}

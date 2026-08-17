// packages/amico-run/src/gh_shim.ts — the `gh` shim logic (issue #399).
//
// Staged as `launcher/gh` in the bin dir the extension prepends to the
// server's PATH, so EVERY gh invocation in an agent session — issue/PR
// creation, the handoff verb, repo-sync — runs as the App identity when the
// GitHub App connection is configured, and byte-identically as the user's own
// gh when it is not (config absent → argv/env untouched passthrough).
//
// SECURITY: the installation token rides ONLY the child env (GH_TOKEN) — never
// argv, never an error, never a log line. Config-class faults are the
// pasqal-launcher stance: one token-free actionable line on stderr, exit 64.
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureInstallationToken, githubAppConfigFile, resolveRealGh } from "./github_app.js";
import { ConfigError } from "./types.js";

function signalCode(signal: NodeJS.Signals | null): number {
  const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (n ?? 1);
}

/** This bundle is <launcherDir>/../dist/gh.js — the launcher dir is the one
 *  PATH entry we must skip when hunting the REAL gh (recursion guard). */
export function ownLauncherDir(bundleUrl: string): string | undefined {
  try {
    return join(dirname(dirname(fileURLToPath(bundleUrl))), "launcher");
  } catch {
    return undefined;
  }
}

/** Exec the real gh with stdio inherited (gh's interactive prompts must work)
 *  and signals forwarded; exit code passes through verbatim. */
export async function runRealGh(
  argv: string[],
  env: NodeJS.ProcessEnv,
  token: string | undefined,
  bundleUrl: string,
): Promise<number> {
  const gh = resolveRealGh(env.PATH, ownLauncherDir(bundleUrl));
  if (!gh) {
    console.error("gh: command not found (amico-gh shim: real gh not on PATH after its own dir — install the GitHub CLI)");
    return 127;
  }
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  if (token !== undefined) childEnv.GH_TOKEN = token; // the token's ONLY carriage
  return new Promise<number>((resolve) => {
    const child = spawn(gh, argv, { stdio: "inherit", env: childEnv });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    process.on("SIGINT", forward("SIGINT"));
    process.on("SIGTERM", forward("SIGTERM"));
    child.on("error", (e) => {
      console.error(`amico-gh: failed to start gh: ${(e as NodeJS.ErrnoException).code ?? "spawn error"}`);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? signalCode(signal)));
  });
}

/** Unconfigured → transparent passthrough (no file read, no env change);
 *  configured → mint/reuse an installation token and arm GH_TOKEN. */
export async function ghShimMain(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  bundleUrl: string = import.meta.url,
): Promise<number> {
  if (!existsSync(githubAppConfigFile(env))) return runRealGh(argv, env, undefined, bundleUrl);
  try {
    const { token } = await ensureInstallationToken({ env });
    return await runRealGh(argv, env, token, bundleUrl);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`amico-gh: ${e.message}`);
      return 64;
    }
    throw e;
  }
}

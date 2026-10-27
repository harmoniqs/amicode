// packages/amico-run/src/gh_verb.ts — `amico gh whoami` (#1928, A15).
//
// Prints the EFFECTIVE GitHub identity a shimmed `gh` / `git push` would use
// from this env, never a token:
//   person (default) → {identity:"person", login} — the human's gh login,
//       asked of the REAL gh (our shim skipped) forced to the person lane;
//   agent → {identity:"agent", app:{slug, app_id, installation_id, verified},
//       principal:{kind, on_behalf_of, campaign, session}} — the App is
//       verified live with an App JWT (GET /app; NO installation token is
//       minted, so whoami writes no mint record). `--offline` skips the live
//       check (verified:false, slug from the config). A principal without
//       on_behalf_of means every agent write would be refused → exit 1.
import { readFileSync } from "node:fs";
import { mintAppJwt, MINT_TIMEOUT_MS, type FetchImpl } from "./github_app.js";
import { agentPrincipal, captureHumanLogin, readAgentConfig, resolveGhIdentity, type IdentityDeps } from "./gh_identity.js";
import { ConfigError } from "./types.js";
import type { VerbResult } from "./verbs.js";

const USAGE = "amico gh whoami [--offline]  — the effective GitHub identity (person login, or agent App slug + principal); never prints a token";

export interface GhVerbCtx extends IdentityDeps {
  env?: NodeJS.ProcessEnv;
}

/** GET /app with the App JWT → the App's slug (undefined on any failure). */
async function liveAppSlug(appId: string, pem: string, fetchImpl: FetchImpl, nowMs: number): Promise<string | undefined> {
  const jwt = mintAppJwt(appId, pem, nowMs);
  try {
    const res = await fetchImpl("https://api.github.com/app", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`, // secret: header carriage ONLY
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    if (res.status !== 200) return undefined;
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body.slug === "string" && body.slug !== "" ? body.slug : undefined;
  } catch {
    return undefined;
  }
}

export async function ghVerb(argv: string[], ctx: GhVerbCtx = {}): Promise<VerbResult> {
  const env = ctx.env ?? process.env;
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h") return { json: { usage: USAGE }, code: 0 };
  if (sub !== "whoami") return { json: { error: `unknown gh subcommand ${JSON.stringify(sub ?? "")}`, usage: USAGE }, code: 64 };
  const offline = rest.includes("--offline");
  try {
    if (resolveGhIdentity(env) === "person") {
      const login = (ctx.captureLogin ?? ((e) => captureHumanLogin(e, ctx.bundleUrl)))(env);
      if (!login) return { json: { identity: "person", login: null, error: "the real gh reports no login — run `gh auth login`" }, code: 1 };
      return { json: { identity: "person", login }, code: 0 };
    }
    const cfg = readAgentConfig(env);
    const principal = await agentPrincipal(env, ctx);
    let slug: string | undefined;
    let verified = false;
    if (!offline) {
      let pem: string;
      try {
        pem = (ctx.readPem ?? ((p: string) => readFileSync(p, "utf8")))(cfg.pemPath);
      } catch {
        throw new ConfigError(`PEM private key not found or unreadable at ${cfg.pemPath}`);
      }
      slug = await liveAppSlug(cfg.appId, pem, ctx.fetchImpl ?? (fetch as unknown as FetchImpl), (ctx.nowMs ?? Date.now)());
      verified = slug !== undefined;
    }
    const app = { slug: slug ?? cfg.slug ?? null, app_id: cfg.appId, installation_id: cfg.installationId, verified };
    if (principal.on_behalf_of === null)
      return {
        json: {
          identity: "agent",
          app,
          principal,
          writes: "refused — no on_behalf_of: the human's gh login could not be captured (run `gh auth login` as yourself)",
        },
        code: 1,
      };
    if (!offline && !verified)
      return { json: { identity: "agent", app, principal, error: "the App JWT was not accepted by GET /app — check app_id and that the PEM matches the App" }, code: 1 };
    return { json: { identity: "agent", app, principal }, code: 0 };
  } catch (e) {
    if (e instanceof ConfigError) return { json: { error: e.message }, code: 64 };
    throw e;
  }
}

// packages/amico-run/src/git_credential.ts — git credential helper logic
// (issue #399). Registered for github.com https remotes via GIT_CONFIG env
// the extension injects ONLY when the GitHub App connection is configured,
// so `git push` authenticates as the App while commit AUTHORSHIP stays the
// researcher's (the bot-PRs/human-commits split).
//
// Protocol (git-credential(7)): git feeds key=value lines on stdin until a
// blank line; a helper answers by PRINTING username=/password= lines. Silence
// + exit 0 means "no opinion" — git falls through to the next helper / ssh,
// which is exactly what we do when unconfigured, when the remote is not
// https github.com, or when minting fails (a credential helper must never
// BLOCK auth; a stderr note is the honest trace, stdout stays protocol-clean).
//
// #1928 (A15): only the AGENT identity ($AMICO_GH_IDENTITY=agent) answers —
// person (the default) is silence, whatever config exists, so git falls
// through to the human's own helpers. The agent answer is the agent App token,
// principal-bound at mint (gh_identity.ts); an agent launcher pairs this with
// withAgentGitConfig(), which RESETS inherited github.com helpers so a refused
// mint never falls back to the human's credential.
import { existsSync } from "node:fs";
import { agentConfigFile, ensureAgentToken, resolveGhIdentity, type IdentityDeps } from "./gh_identity.js";
import { ConfigError } from "./types.js";

/** Parse the helper request: protocol + host are all we route on. */
export function parseCredentialRequest(input: string): { protocol?: string; host?: string } {
  const out: { protocol?: string; host?: string } = {};
  for (const raw of input.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") break; // blank line ends the request
    const m = line.match(/^(protocol|host)=(.*)$/);
    if (m) out[m[1] as "protocol" | "host"] = m[2];
  }
  return out;
}

export async function credentialMain(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  operation: string | undefined = "get",
  deps: IdentityDeps = {},
): Promise<{ stdout: string; code: number }> {
  // git calls store/erase too; only `get` may produce credentials.
  if (operation !== "get") return { stdout: "", code: 0 };
  const req = parseCredentialRequest(input);
  if (req.protocol !== "https" || req.host !== "github.com") return { stdout: "", code: 0 };
  try {
    if (resolveGhIdentity(env) === "person") return { stdout: "", code: 0 };
    if (!existsSync(agentConfigFile(env))) return { stdout: "", code: 0 }; // unconfigured: no opinion
    const { token } = await ensureAgentToken({ ...deps, env });
    // The token's stdout carriage IS the protocol contract — nothing else may print.
    return { stdout: `username=x-access-token\npassword=${token}\n`, code: 0 };
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`amico-git-credential: ${e.message}`);
      return { stdout: "", code: 0 }; // fall through, never block auth
    }
    throw e;
  }
}

// packages/amico-run/src/remote_config.ts
// Cloud solve-service config (Δ8) — the authoring.ts idiom (env override →
// ~/.amico file). SECURITY: the token value must never appear in an error
// message or log line (llm_creds.mjs stance — the secret never enters
// amico's surfaces beyond the Authorization header itself).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./types.js";

export interface RemoteConfig {
  baseUrl: string; // e.g. https://solves.staging.harmoniqs.co (no trailing slash)
  token: string; // per-user Δ2 credential
}

/** $AMICO_CLOUD_FILE overrides the path (tests) — authoring.ts:37-41 idiom. */
export function cloudConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_CLOUD_FILE;
  if (v && v.trim() !== "") return v;
  return join(homedir(), ".amico", "cloud.json");
}

/** Resolution order: AMICO_CLOUD_URL+AMICO_CLOUD_TOKEN env pair → cloud.json.
 *  Any failure is ConfigError — exit-64 class (types.ts:50): nothing ran. */
export function readRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const url = env.AMICO_CLOUD_URL;
  const token = env.AMICO_CLOUD_TOKEN;
  if (url && token) return { baseUrl: url.replace(/\/+$/, ""), token };
  if (url || token)
    throw new ConfigError(
      "cloud config: set BOTH AMICO_CLOUD_URL and AMICO_CLOUD_TOKEN (or neither, to use cloud.json)",
    );
  const file = cloudConfigFile(env);
  if (!existsSync(file))
    throw new ConfigError(
      `cloud config not found: ${file} (write {"base_url","token"} or set AMICO_CLOUD_URL/AMICO_CLOUD_TOKEN)`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ConfigError(`malformed cloud config at ${file}`);
  }
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof d.base_url !== "string" || d.base_url === "" || typeof d.token !== "string" || d.token === "")
    throw new ConfigError(`cloud config at ${file} needs non-empty string keys "base_url" and "token"`);
  return { baseUrl: d.base_url.replace(/\/+$/, ""), token: d.token };
}

/** Presence check only: is a cloud connection configured (env pair or a
 *  well-formed cloud.json)? The hpc-tier gate uses this to reject a cloud-tier
 *  solve when no key is connected, WITHOUT throwing or reading the token value.
 *  Never returns or logs the token. */
export function hasCloudConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readRemoteConfig(env);
    return true;
  } catch {
    return false;
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { Score } from "./loader";

// D3 *interface* — the access-code redemption service (separate plan) implements
// EntitlementProvider later; the extension never needs to know which one it got.
export interface EntitlementResult {
  entitlements: string[];
  error?: "invalid_code" | "expired_code";
}

export interface EntitlementProvider {
  resolve(): Promise<EntitlementResult>;
}

// v1 local stub: reads <configDir>/entitlements.toml — `codes = [...]` (+ optional
// `expired = [...]`). Missing file = public-only, silently. Malformed = named error
// with public fallback: an entitlement failure must never dead-end the session.
// Sync core so the (synchronous) session-prep path can use it; the async
// EntitlementProvider interface is what the future redemption service implements.
export function readLocalEntitlements(configDir: string): EntitlementResult {
  const file = path.join(configDir, "entitlements.toml");
  if (!fs.existsSync(file)) return { entitlements: [] };
  let parsed: { codes?: string[]; expired?: string[] };
  try {
    parsed = parseToml(fs.readFileSync(file, "utf8")) as typeof parsed;
  } catch {
    return { entitlements: [], error: "invalid_code" };
  }
  const result: EntitlementResult = { entitlements: parsed.codes ?? [] };
  if ((parsed.expired ?? []).length > 0) result.error = "expired_code";
  return result;
}

export class LocalEntitlementProvider implements EntitlementProvider {
  constructor(private readonly configDir: string) {}

  async resolve(): Promise<EntitlementResult> {
    return readLocalEntitlements(this.configDir);
  }
}

// Empty/absent entitlements = public score, always visible (spec §5).
export function filterRepertoire(scores: Score[], ents: string[]): Score[] {
  return scores.filter(
    (s) => (s.manifest.entitlements ?? []).length === 0 || s.manifest.entitlements!.some((e) => ents.includes(e)),
  );
}

// Entitlement → Harmoniqs package allowlist (spec C). Reads the [packages]
// table of entitlements.toml: `default` (public base) plus each held
// entitlement's package list. Feeds the resolver + the amico-run import scan —
// SEPARATE from filterRepertoire (score visibility). Missing file / malformed
// table → public defaults, never throws (an entitlement failure must not
// dead-end authoring).
const PUBLIC_PACKAGES = ["Piccolo", "Legato", "Intonato", "NamedTrajectories", "DirectTrajOpt"];

export function packageAllowlist(registryFile: string, ents: string[]): string[] {
  let packages: { default?: string[] } & Record<string, string[]> = {};
  try {
    const parsed = parseToml(fs.readFileSync(registryFile, "utf8")) as { packages?: typeof packages };
    if (parsed.packages && typeof parsed.packages === "object") packages = parsed.packages;
  } catch {
    // missing/malformed → public defaults below
  }
  const base = Array.isArray(packages.default) ? packages.default : PUBLIC_PACKAGES;
  const out = [...base];
  for (const ent of ents) {
    const extra = packages[ent];
    if (Array.isArray(extra)) for (const p of extra) if (!out.includes(p)) out.push(p);
  }
  return out;
}

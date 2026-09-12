export * as ProviderPermission from "./provider-permission"

import { Schema } from "effect"

export const Effect = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "ProviderPermission.Effect" })
export type Effect = typeof Effect.Type

export const DirectoryPermissions = Schema.Struct({
  read: Effect,
  write: Effect,
  execute: Effect,
  network: Effect,
}).annotate({ identifier: "ProviderPermission.DirectoryPermissions" })
export type DirectoryPermissions = typeof DirectoryPermissions.Type

export const TrustTier = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  directories: Schema.Record(Schema.String, DirectoryPermissions),
}).annotate({ identifier: "ProviderPermission.TrustTier" })
export type TrustTier = typeof TrustTier.Type

export const Config = Schema.Struct({
  defaultTier: Schema.String,
  tiers: Schema.Array(TrustTier),
  assignments: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "ProviderPermission.Config" })
export type Config = typeof Config.Type

// Default tiers as described in spec
export const DEFAULT_TIERS: TrustTier[] = [
  {
    id: "trusted",
    label: "Trusted",
    directories: {
      "**": { read: "allow", write: "allow", execute: "allow", network: "allow" },
    },
  },
  {
    id: "limited",
    label: "Limited",
    directories: {
      "**": { read: "allow", write: "deny", execute: "deny", network: "deny" },
      "~/secrets/**": { read: "deny", write: "deny", execute: "deny", network: "deny" },
    },
  },
  {
    id: "untrusted",
    label: "Untrusted",
    directories: {
      "**": { read: "deny", write: "deny", execute: "deny", network: "deny" },
    },
  },
  {
    id: "unassigned",
    label: "Unassigned",
    directories: {
      "**": { read: "ask", write: "ask", execute: "ask", network: "ask" },
    },
  },
]

export const DEFAULT_CONFIG: Config = {
  defaultTier: "unassigned",
  tiers: DEFAULT_TIERS,
  assignments: {},
}

// Action group mapping
export const ACTION_GROUPS = {
  read: ["read", "glob", "grep"] as const,
  write: ["write", "edit"] as const,
  execute: ["bash"] as const,
  network: ["webfetch", "websearch"] as const,
} as const

export type ActionGroup = keyof typeof ACTION_GROUPS

export function actionToGroup(action: string): ActionGroup | undefined {
  for (const [group, actions] of Object.entries(ACTION_GROUPS) as Array<[ActionGroup, readonly string[]]>) {
    if ((actions as readonly string[]).includes(action)) return group
  }
  return undefined
}

// Summary badge logic
export type TierSummary = "Full Access" | "Read Only" | "No Access" | "Ask Everything" | "Custom"

export function tierSummary(tier: TrustTier): TierSummary {
  const all = Object.values(tier.directories)
  if (all.length === 0) return "Ask Everything"
  // Simple heuristic: check ** pattern if exists, otherwise aggregate
  const wildcard = tier.directories["**"]
  if (wildcard) {
    const vals = Object.values(wildcard)
    if (vals.every((v) => v === "allow")) return "Full Access"
    if (vals.every((v) => v === "ask")) return "Ask Everything"
    if (vals.every((v) => v === "deny")) return "No Access"
    if (wildcard.read === "allow" && wildcard.write === "deny" && wildcard.execute === "deny" && wildcard.network === "deny")
      return "Read Only"
  }
  // fallback
  const flat = all.flatMap((d) => Object.values(d))
  if (flat.every((v) => v === "allow")) return "Full Access"
  if (flat.every((v) => v === "deny")) return "No Access"
  if (flat.every((v) => v === "ask")) return "Ask Everything"
  // check read-only pattern across all directories
  const allReadAllow = all.every((d) => d.read === "allow")
  const allOtherDeny = all.every((d) => d.write === "deny" && d.execute === "deny" && d.network === "deny")
  if (allReadAllow && allOtherDeny) return "Read Only"
  return "Custom"
}

// Glob specificity: longer/more-specific pattern wins
export function mostSpecificMatch(
  path: string,
  directories: Record<string, DirectoryPermissions>,
): { pattern: string; permissions: DirectoryPermissions } | undefined {
  let best: { pattern: string; permissions: DirectoryPermissions } | undefined
  let bestScore = -1
  for (const [pattern, perms] of Object.entries(directories)) {
    if (!globMatch(path, pattern)) continue
    const score = globSpecificity(pattern)
    if (score > bestScore) {
      bestScore = score
      best = { pattern, permissions: perms }
    }
  }
  return best
}

function globSpecificity(pattern: string): number {
  // Higher score = more specific. Count non-wildcard chars + segments
  let score = pattern.length * 10
  // penalize wildcards
  const wildcards = (pattern.match(/\*/g) || []).length
  score -= wildcards * 5
  // bonus for segments
  score += pattern.split("/").length
  return score
}

function globMatch(input: string, pattern: string): boolean {
  // Normalize ~/ to home-like prefix (treated as literal prefix)
  // Replace ~ with placeholder, expand **, *, ?
  const normalized = input.replaceAll("\\", "/")
  let regex = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "###DOUBLE###")
    .replace(/\*/g, "[^/]*")
    .replace(/###DOUBLE###/g, ".*")
    .replace(/\?/g, "[^/]")
  // Handle trailing /** = optional deeper
  // Already covered by .* expansion
  return new RegExp("^" + regex + "$").test(normalized)
}

export function resolveEffect(
  config: Config,
  modelId: string,
  action: string,
  resource: string,
): Effect | undefined {
  const tierId = config.assignments[modelId] ?? config.defaultTier
  const tier = config.tiers.find((t) => t.id === tierId) ?? config.tiers.find((t) => t.id === config.defaultTier)
  if (!tier) return undefined
  const group = actionToGroup(action)
  if (!group) return undefined
  const match = mostSpecificMatch(resource, tier.directories)
  // If resource is empty (e.g., network tool without path), use ** rule
  const perms = match?.permissions ?? tier.directories["**"]
  if (!perms) return undefined
  return perms[group]
}

// Decoded config with defaults applied
export function withDefaults(input?: Partial<Config> | undefined): Config {
  if (!input) return DEFAULT_CONFIG
  return {
    defaultTier: input.defaultTier ?? DEFAULT_CONFIG.defaultTier,
    tiers: input.tiers ?? DEFAULT_TIERS,
    assignments: input.assignments ?? {},
  }
}

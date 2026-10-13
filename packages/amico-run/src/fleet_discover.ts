// fleet_discover.ts (#1320) — the read-only discovery helper behind the
// `/create-a-fleet` orchestrator skill. It is deliberately SMALL and PURE: the
// skill gathers the raw inputs (a `tailscale status` peer list, the parsed
// `~/.ssh/config` hosts, the #1318 roster rows via GET /amicode/roster) and
// hands them here; this helper only REASONS over them — it enumerates the
// candidate machines, dedupes across the three sources, and marks which are
// already enrolled. No filesystem, no network, no mutation of the inputs (the
// drift-lint no-side-effects doctrine): everything the skill DOES — per-machine
// confirm, guide-and-resume, driving `amico fleet enroll` — is LLM-followed
// prose in the SKILL.md, never re-implemented here.
import type { RosterRow, RosterHealth } from "@amicode/schema";

/** A tailnet peer as `tailscale status` reports it (the fields discovery uses). */
export interface TailnetPeer {
  /** The peer's machine name (tailscale "HostName"). */
  hostName: string;
  /** The MagicDNS name, e.g. "mini.tail-abcd.ts.net." — first label ≈ hostName. */
  dnsName?: string;
  /** The peer's tailnet address (100.x.y.z). */
  tailscaleIP?: string;
  /** Whether tailscale currently sees the peer online. */
  online?: boolean;
}

/** One `~/.ssh/config` host block, already parsed to its alias + HostName. */
export interface SshHostEntry {
  /** The `Host` alias (the ssh target you'd type: `ssh mini`). */
  alias: string;
  /** The `HostName` value (an address or a `.local` name), when declared. */
  hostName?: string;
}

/** The three discovery sources, each already gathered by the skill. Every field
 *  is optional so a caller can pass only what it has (an empty fleet, a machine
 *  with no tailnet, etc.). */
export interface DiscoverInput {
  tailnet?: TailnetPeer[];
  sshConfig?: SshHostEntry[];
  roster?: RosterRow[];
}

/** Which of the three sources a candidate was seen in. */
export type DiscoverySource = "roster" | "ssh-config" | "tailnet";

/** One discovered candidate machine — the deduped union of what the sources
 *  know about it. */
export interface FleetCandidate {
  /** The dedup identity: the normalized machine name (lowercased first DNS
   *  label). Machines that share this token across sources are ONE candidate. */
  id: string;
  /** The best human-facing display name seen for the machine. */
  name: string;
  /** The sources this machine was discovered in (canonical order, deduped). */
  sources: DiscoverySource[];
  /** The ssh target to reach it, when a source carried one. */
  sshAlias?: string;
  /** A reachable address (tailnet IP or ssh HostName), when known. */
  address?: string;
  /** Whether a host-owned roster row (#1318) exists for this machine. */
  inRoster: boolean;
  /** Whether the machine is ENROLLED — a roster row whose reachability is
   *  `reachable`, i.e. its enroll's verify-attach passed (#1319's honesty bar:
   *  never reported enrolled until `verify_attach.ok`). A discovered machine
   *  with no row, or a row still `down`/`degraded`, is NOT enrolled. */
  enrolled: boolean;
  /** The roster row's reconciled serve-stance ("server"/"client"), when known. */
  serverMode?: string;
  /** The roster row's reachability tri-state, when known. */
  health?: RosterHealth;
}

/** Normalize a raw machine name to its dedup identity: trim, drop a trailing
 *  dot (DNS names end with one), take the FIRST DNS label, lowercase. So
 *  "mini", "mini.local", and "mini.tail-abcd.ts.net." all fold to "mini". */
function normalizeIdentity(raw: string): string {
  return raw.trim().replace(/\.$/, "").split(".")[0]!.toLowerCase();
}

/** Canonical source order — the order sources appear in a candidate's list. */
const SOURCE_ORDER: DiscoverySource[] = ["roster", "ssh-config", "tailnet"];

/** Fold a source into a candidate accumulator, keyed by identity. Merges the
 *  source tag (deduped) and fills reach hints/display name without clobbering a
 *  value an earlier source already supplied — except `address`, where a
 *  `preferAddress` source (the tailnet IP is the canonical routable address)
 *  wins over a `.local`/alias an earlier source left. */
function fold(
  acc: Map<string, FleetCandidate>,
  id: string,
  source: DiscoverySource,
  fields: {
    name: string;
    sshAlias?: string;
    address?: string;
    preferAddress?: boolean;
    inRoster?: boolean;
    enrolled?: boolean;
    serverMode?: string;
    health?: RosterHealth;
  },
): void {
  const existing = acc.get(id);
  if (existing === undefined) {
    acc.set(id, {
      id,
      name: fields.name,
      sources: [source],
      sshAlias: fields.sshAlias,
      address: fields.address,
      inRoster: fields.inRoster ?? false,
      enrolled: fields.enrolled ?? false,
      serverMode: fields.serverMode,
      health: fields.health,
    });
    return;
  }
  if (!existing.sources.includes(source)) existing.sources.push(source);
  existing.sshAlias ??= fields.sshAlias;
  if (fields.address !== undefined && (fields.preferAddress || existing.address === undefined)) {
    existing.address = fields.address;
  }
  // Roster facts (only the roster fold supplies these, and it folds first, so
  // these are normally set at creation). Never downgrade a fact already set.
  if (fields.inRoster) existing.inRoster = true;
  if (fields.enrolled) existing.enrolled = true;
  existing.serverMode ??= fields.serverMode;
  existing.health ??= fields.health;
}

/**
 * Enumerate the candidate machines from the three discovery sources, deduped by
 * normalized machine name, mutating nothing. Read-only: the returned candidates
 * are fresh objects; the inputs are never touched.
 */
export function discoverFleetCandidates(input: DiscoverInput): FleetCandidate[] {
  const acc = new Map<string, FleetCandidate>();

  // Fold in canonical source order so a candidate's `sources` list is already
  // ordered and its display name/reach hints prefer the richer roster source.
  for (const row of input.roster ?? []) {
    fold(acc, normalizeIdentity(row.name), "roster", {
      name: row.name,
      sshAlias: row.sshAlias || undefined,
      inRoster: true,
      // The honesty bar (#1319): enrolled ONLY when verify-attach passed, which
      // the roster mirrors as health "reachable". A `down`/`degraded` row is a
      // machine that has a row but is not yet trustworthy — not enrolled.
      enrolled: row.health === "reachable",
      serverMode: row.server_mode,
      health: row.health,
    });
  }
  for (const host of input.sshConfig ?? []) {
    fold(acc, normalizeIdentity(host.alias), "ssh-config", {
      name: host.alias,
      sshAlias: host.alias,
      address: host.hostName,
    });
  }
  for (const peer of input.tailnet ?? []) {
    fold(acc, normalizeIdentity(peer.hostName), "tailnet", {
      name: peer.hostName,
      address: peer.tailscaleIP,
      preferAddress: true,
    });
  }

  for (const c of acc.values()) c.sources.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
  return [...acc.values()].sort((a, b) => a.id.localeCompare(b.id));
}
